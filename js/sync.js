// One-tap two-way sync with the Apps Script Web App (Code.gs, action 'sync').
//
// Request  { secret, action: 'sync',
//            ops: [ { op: 'upsert', id, type, date, category, amount, description }
//                 | { op: 'delete', id } ],
//            setup: <Setup> | null,        // only when edited on the phone
//            renames: [ { type, from, to } ],
//            setupBase: { expenseCategories: [name], incomeSources: [name], rules: [id] } | null,
//                       // keys as of the last pull, so the sheet can merge instead of overwrite
//            watermarks: { <ruleId>: 'YYYY-MM-DD' },   // "settled (posted or skipped) up to here"
//            skips: { <ruleId>: ['YYYY-MM-DD'] } }      // occurrences skipped for good (sheet: union)
// Response { ok: true, results: [ { id, status: 'ok'|'error', message? } ],
//            ledger: { Expense: [Row], Income: [Row] },   // Row = { id, date, category, amount, description }
//            setup: <Setup>, serverTime,
//            setupError: '' | 'why the sheet refused the Setup we sent',  // entries still synced; Setup stays pending
//            recurringApi: 2,                              // absent on a Code.gs that predates skips
//            recurringRun: { at, by, ok, posted, message } | null }   // last menu / daily run
//        | { error: '...' }
//
// The sheet is the source of truth: after the push, the local cache is replaced
// by what the sheet holds, except entries changed on the phone while the request
// was in flight (or whose op failed) — those stay dirty for the next sync.

import { getKV, updateKV, withPending, getSetup, emitChange, rawDB, snapshotUnsynced, listEntries, DEFAULT_SETUP } from './store.js';
import { validateCloudReply, summarizeCloud, unsyncedTokens } from './cloud.js';
import { rebaseOntoSheet, setupKeys } from './setup-rebase.js';

const LS = { url: 'etk.webAppUrl', secret: 'etk.secret' };

export function getConfig() {
  return { webAppUrl: localStorage.getItem(LS.url) || '', secret: localStorage.getItem(LS.secret) || '' };
}
export function setConfig(webAppUrl, secret) {
  localStorage.setItem(LS.url, webAppUrl.trim());
  localStorage.setItem(LS.secret, secret.trim());
}
export const isConfigured = () => { const c = getConfig(); return !!(c.webAppUrl && c.secret); };

let inFlight = null;
let reverting = false;

/** Run a sync. Resolves to { pushed, failed, pulled } or throws Error(message).
 *  Concurrent calls share one request. */
export function syncNow() {
  if (reverting) return Promise.reject(new Error('Reverting to the sheet’s version — try again in a moment.'));
  if (!inFlight) inFlight = doSync().finally(() => { inFlight = null; });
  return inFlight;
}

const NOT_CONNECTED = 'Not connected — add the Web App URL and secret in Settings.';

/** One round trip to the Apps Script Web App. Returns the reply once it is known to be a usable
 *  one; throws Error(message-safe-to-show) otherwise. Shared by sync and revert so both read
 *  the sheet's answers the same way. */
async function callSheet(cfg, payload) {
  // text/plain keeps this a CORS "simple request": Apps Script Web Apps can't
  // answer the OPTIONS preflight that application/json would trigger.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res, data;
  try {
    res = await fetch(cfg.webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: cfg.secret, action: 'sync', ...payload }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`The sheet answered with an error (HTTP ${res.status}) — check the Web App URL in Settings.`);
    try { data = await res.json(); }
    catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new Error('The sheet did not answer with data — is the Web App deployed with access “Anyone”?');
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Sync timed out — try again.');
    throw res ? err : new Error('Could not reach the sheet (offline?).');
  } finally {
    clearTimeout(timer);
  }
  if (data && data.error) throw new Error(data.error === 'bad secret' ? 'Secret rejected — check Settings.' : 'Sheet error: ' + data.error);
  if (!data || !data.ok || !data.ledger) throw new Error('Unexpected reply from the sheet — is Code.gs updated and re-deployed?');
  return data;
}

async function doSync() {
  const cfg = getConfig();
  if (!cfg.webAppUrl || !cfg.secret) throw new Error(NOT_CONNECTED);

  const db = await rawDB();
  await rebaseNeverPulledSetup(cfg, db);
  const all = await getAllRaw(db);
  const dirty = all.filter((e) => e.dirty);
  const sent = new Map(dirty.map((e) => [e.id, e]));
  const ops = dirty.map((e) => e.deleted
    ? { op: 'delete', id: e.id }
    : { op: 'upsert', id: e.id, type: e.type, date: e.date, category: e.category, amount: e.amount, description: e.description || '' });

  const setupMeta = (await getKV('setupMeta')) || { dirty: false, renames: [] };
  const setup = setupMeta.dirty ? await getSetup() : null;
  const watermarks = (await getKV('watermarks')) || {};
  const skips = (await getKV('skips')) || {};
  const setupBase = setup ? (await getKV('setupBase')) || null : null;

  const data = await callSheet(cfg, { ops, setup, renames: setupMeta.renames || [], setupBase, watermarks, skips });
  const { rows } = validateCloudReply(data);       // nothing below runs on a reply this app can't read

  const results = new Map((data.results || []).map((r) => [r.id, r]));
  const onSheet = new Set(rows.map((r) => r.id));

  // Rebuild the cache from the sheet, preserving anything still dirty. Read and
  // replace happen in ONE transaction so an edit can't slip in between.
  const { failed, pulled } = await rewriteEntries(db, (fresh) => {
    let failed = 0;
    const keep = new Map();
    for (const e0 of fresh) {
      if (!e0.dirty) continue;
      const e = onSheet.has(e0.id) ? { ...e0, serverKnown: true } : e0;
      const r = results.get(e.id);
      if (!sent.has(e.id) || sent.get(e.id).updatedAt !== e.updatedAt) { keep.set(e.id, e); continue; } // edited mid-sync
      if (r && r.status === 'error') { keep.set(e.id, { ...e, syncError: r.message || 'rejected' }); failed++; continue; }
      if (!r) { keep.set(e.id, e); failed++; }                                                          // no answer: retry
      // ok -> drop; the sheet's copy (below) replaces it
    }
    // A new entry this request carried, then deleted (or its Save undone) before the reply came:
    // the sheet has it now, so it needs a delete next time rather than coming back.
    const here = new Set(fresh.map((e) => e.id));
    for (const [id, e] of sent) {
      if (!here.has(id) && onSheet.has(id)) keep.set(id, { ...e, deleted: true, dirty: true, serverKnown: true, syncError: undefined, updatedAt: Date.now() });
    }
    const next = rows.filter((row) => !keep.has(row.id));
    for (const e of keep.values()) next.push(e);
    return { next, failed, pulled: next.length };
  });

  // One transaction from the checks to the writes: a Setup saved, or an item posted or skipped,
  // while the reply is being stored can't be overwritten by it.
  const setupRejected = !!(setup && data.setupError);
  const skipsPersisted = data.recurringApi >= 2;   // an older Code.gs ignores `skips`: keep them on the phone
  await updateKV(['setup', 'setupMeta', 'watermarks', 'skips'], (now) => {
    const out = { setupError: setupRejected ? String(data.setupError) : null, recurringRun: data.recurringRun || null, lastSync: Date.now() };
    // setup: take the sheet's, unless edited again while the request was in flight — or unless the
    // sheet REFUSED our Setup (`setupError`, e.g. a rule whose category is not on its Setup tab).
    // Then the phone keeps its edits, still pending, so nothing is lost and the next sync retries.
    const metaNow = now.setupMeta || {};
    let nextSetup = now.setup;
    if (!setupRejected && (!metaNow.dirty || metaNow.updatedAt === setupMeta.updatedAt)) {
      if (data.setup) nextSetup = data.setup;
      out.setupMeta = { dirty: false, renames: [] };
    }
    if (!setupRejected) out.setupBase = setupKeys(data.setup);
    // Forget only what this request carried. A review done while it was in flight added
    // newer watermarks/skips that the reply could not know about: keep those and lay them
    // back over the setup taken from the sheet.
    const wm = now.watermarks || {};
    for (const id of Object.keys(watermarks)) if (wm[id] && wm[id] <= watermarks[id]) delete wm[id];
    out.watermarks = wm;
    const sk = now.skips || {};
    if (skipsPersisted) {
      for (const id of Object.keys(skips)) {
        sk[id] = (sk[id] || []).filter((d) => !skips[id].includes(d));
        if (!sk[id].length) delete sk[id];
      }
      out.skips = sk;
    }
    if (nextSetup) out.setup = withPending(nextSetup, wm, sk);
    return out;
  });

  emitChange('sync');
  const runFailed = data.recurringRun && data.recurringRun.ok === false;
  return {
    pushed: ops.length - failed, failed, pulled,
    staleServer: !(data.recurringApi >= 2),
    recurringError: runFailed ? (data.recurringRun.message || 'unknown error') : '',
    setupError: setupRejected ? String(data.setupError) : '',
  };
}

/** Setup edited on a phone that has never pulled the sheet's Setup (no `setupBase`): pull it
 *  first and lay only the user's real edits over it (setup-rebase.js), so this sync can't blank
 *  the sheet's budgets with the starter list. Renames made against the starter list are dropped
 *  (the sheet's own rows keep their names). One kv transaction: a Setup save that lands while
 *  the pull is in flight makes this a no-op and the sync stops, to be tapped again. */
async function rebaseNeverPulledSetup(cfg, db) {
  const meta = await getKV('setupMeta');
  if (!meta || !meta.dirty || (await getKV('setupBase'))) return;
  const { setup: sheetSetup } = validateCloudReply(await callSheet(cfg, EMPTY_PULL));
  const applied = await new Promise((resolve, reject) => {
    const t = db.transaction('kv', 'readwrite');
    const kv = t.objectStore('kv');
    const rSetup = kv.get('setup'), rMeta = kv.get('setupMeta');
    let ok = false;
    rMeta.onsuccess = () => {
      const now = rMeta.result && rMeta.result.value;
      if (!now || now.updatedAt !== meta.updatedAt) return;
      const local = (rSetup.result && rSetup.result.value) || structuredClone(DEFAULT_SETUP);
      kv.put({ key: 'setup', value: rebaseOntoSheet(local, sheetSetup, DEFAULT_SETUP) });
      kv.put({ key: 'setupMeta', value: { ...now, renames: [] } });
      kv.put({ key: 'setupBase', value: setupKeys(sheetSetup) });
      ok = true;
    };
    t.oncomplete = () => resolve(ok);
    t.onerror = (ev) => reject(ev.target.error);
    t.onabort = (ev) => reject(ev.target.error || new Error('This phone’s storage refused the change.'));
  });
  if (!applied) throw new Error('Setup changed while syncing — tap Sync again.');
}

// fn(currentEntries) -> { next, ...extra }; `next` replaces the whole store.
function rewriteEntries(db, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('entries', 'readwrite');
    const s = t.objectStore('entries');
    let extra;
    const r = s.getAll();
    r.onsuccess = () => {
      const { next, ...rest } = fn(r.result);
      extra = rest;
      s.clear();
      for (const e of next) s.put(e);
    };
    t.oncomplete = () => resolve(extra);
    t.onerror = (ev) => reject(ev.target.error);
    t.onabort = (ev) => reject(ev.target.error || new Error('This phone’s storage refused the change.'));
  });
}
function getAllRaw(db) {
  return new Promise((resolve, reject) => {
    const r = db.transaction('entries', 'readonly').objectStore('entries').getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// ------------------------------------------- revert to the sheet's version (Settings > Advanced)
//
// Replaces everything on the phone with the sheet's current copy; whatever has not been synced
// is discarded. Built so that nothing is lost by accident or half-done:
//   * the sheet's copy is fetched and fully validated BEFORE the phone is touched (any failure,
//     offline, wrong secret, a reply that looks wrong: nothing changes);
//   * the swap is ONE IndexedDB transaction over entries + kv — all or nothing;
//   * inside that transaction the unsynced items are compared with the list the user confirmed
//     (`expectTokens`, from snapshotUnsynced()); anything NEW since then cancels the swap;
//   * sync and revert never overlap, and the Web App URL / secret are never touched.

const EMPTY_PULL = { ops: [], setup: null, renames: [], setupBase: null, watermarks: {}, skips: {} };

async function fetchCloud() {
  const cfg = getConfig();
  if (!cfg.webAppUrl || !cfg.secret) throw new Error(NOT_CONNECTED);
  const cloud = validateCloudReply(await callSheet(cfg, EMPTY_PULL));
  return { cloud, summary: summarizeCloud(cloud) };
}

/** Look at the sheet's copy without changing anything on the phone: what a revert would give you
 *  -> { entries, expenses, income, from, to, categories, sources, rules }. */
export async function peekCloud() {
  if (reverting) throw new Error('A revert is already running.');
  return (await fetchCloud()).summary;
}

/** Replace the phone with the sheet's copy. `expectTokens` = snapshotUnsynced().tokens as shown
 *  to (and confirmed by) the user. Resolves { applied: true, summary } or { applied: false,
 *  reason: 'changed' } (nothing was touched); throws on anything else. An error with
 *  `.committed` set means the swap itself went through but the final check did not match. */
export async function revertToCloud(expectTokens = []) {
  if (reverting) throw new Error('A revert is already running.');
  reverting = true;                                   // from here on syncNow() refuses to start
  try {
    if (inFlight) { try { await inFlight; } catch { /* that sync's failure is not ours */ } }
    const { cloud, summary } = await fetchCloud();
    const db = await rawDB();
    const outcome = await applyCloud(db, cloud, new Set(expectTokens));
    if (!outcome.applied) return { applied: false, reason: outcome.reason };
    emitChange('sync');
    const left = (await snapshotUnsynced()).counts.total;
    const stored = (await listEntries({ includeDeleted: true })).length;
    if (left !== 0 || stored !== cloud.rows.length) {
      const err = new Error('The revert went through, but the final check did not match. Tap Sync and look at History to be sure.');
      err.committed = true;
      throw err;
    }
    return { applied: true, summary };
  } finally {
    reverting = false;
  }
}

function applyCloud(db, cloud, expected) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(['entries', 'kv'], 'readwrite');
    const es = t.objectStore('entries'), kv = t.objectStore('kv');
    const rEntries = es.getAll(), rMeta = kv.get('setupMeta'), rWm = kv.get('watermarks'), rSk = kv.get('skips');
    const val = (r) => (r.result ? r.result.value : undefined);
    let outcome = { applied: false, reason: 'unknown' };

    rSk.onsuccess = () => {                           // requests finish in the order made: this is the last read
      const extra = unsyncedTokens(rEntries.result, val(rMeta), val(rWm), val(rSk)).filter((x) => !expected.has(x));
      if (extra.length) { outcome = { applied: false, reason: 'changed' }; return; }   // writes nothing

      es.clear();
      for (const row of cloud.rows) es.put(row);
      const set = (key, value) => kv.put({ key, value });
      set('setup', cloud.setup);
      set('setupMeta', { dirty: false, renames: [] });
      set('setupBase', setupKeys(cloud.setup));
      set('watermarks', {});
      set('skips', {});
      set('setupError', null);
      set('recurringRun', cloud.recurringRun);
      set('lastSync', Date.now());
      outcome = { applied: true };
    };
    t.oncomplete = () => resolve(outcome);
    t.onerror = (ev) => reject(ev.target.error);
    t.onabort = (ev) => reject(ev.target.error || new Error('This phone’s storage refused the change.'));
  });
}