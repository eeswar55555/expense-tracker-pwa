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

import { getKV, setKV, getSetup, emitChange, rawDB, reapplyPending } from './store.js';

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

/** Run a sync. Resolves to { pushed, failed, pulled } or throws Error(message).
 *  Concurrent calls share one request. */
export function syncNow() {
  if (!inFlight) inFlight = doSync().finally(() => { inFlight = null; });
  return inFlight;
}

async function doSync() {
  const cfg = getConfig();
  if (!cfg.webAppUrl || !cfg.secret) throw new Error('Not connected — add the Web App URL and secret in Settings.');

  const db = await rawDB();
  const all = await getAllRaw(db);
  const dirty = all.filter((e) => e.dirty);
  const snapshot = new Map(dirty.map((e) => [e.id, e.updatedAt]));
  const ops = dirty.map((e) => e.deleted
    ? { op: 'delete', id: e.id }
    : { op: 'upsert', id: e.id, type: e.type, date: e.date, category: e.category, amount: e.amount, description: e.description || '' });

  const setupMeta = (await getKV('setupMeta')) || { dirty: false, renames: [] };
  const setup = setupMeta.dirty ? await getSetup() : null;
  const watermarks = (await getKV('watermarks')) || {};
  const skips = (await getKV('skips')) || {};
  const setupBase = setup ? (await getKV('setupBase')) || null : null;

  // text/plain keeps this a CORS "simple request": Apps Script Web Apps can't
  // answer the OPTIONS preflight that application/json would trigger.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let data;
  try {
    const res = await fetch(cfg.webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: cfg.secret, action: 'sync', ops, setup, renames: setupMeta.renames || [], setupBase, watermarks, skips }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'Sync timed out — try again.' : 'Could not reach the sheet (offline?).');
  } finally {
    clearTimeout(timer);
  }
  if (data.error) throw new Error(data.error === 'bad secret' ? 'Secret rejected — check Settings.' : 'Sheet error: ' + data.error);
  if (!data.ok || !data.ledger) throw new Error('Unexpected reply from the sheet — is Code.gs updated and re-deployed?');

  const results = new Map((data.results || []).map((r) => [r.id, r]));

  // Rebuild the cache from the sheet, preserving anything still dirty. Read and
  // replace happen in ONE transaction so an edit can't slip in between.
  const { failed, pulled } = await rewriteEntries(db, (fresh) => {
    let failed = 0;
    const keep = new Map();
    for (const e of fresh) {
      if (!e.dirty) continue;
      const r = results.get(e.id);
      if (!snapshot.has(e.id) || snapshot.get(e.id) !== e.updatedAt) { keep.set(e.id, e); continue; } // edited mid-sync
      if (r && r.status === 'error') { keep.set(e.id, { ...e, syncError: r.message || 'rejected' }); failed++; continue; }
      if (!r) { keep.set(e.id, e); failed++; }                                                          // no answer: retry
      // ok -> drop; the sheet's copy (below) replaces it
    }
    const next = [];
    for (const type of ['Expense', 'Income']) {
      for (const row of data.ledger[type] || []) {
        if (keep.has(row.id)) continue;
        next.push({ id: row.id, type, date: row.date, category: row.category, amount: Number(row.amount), description: row.description || '', updatedAt: 0, dirty: false, deleted: false, serverKnown: true });
      }
    }
    for (const e of keep.values()) next.push(e);
    return { next, failed, pulled: next.length };
  });

  // setup: take the sheet's, unless edited again while the request was in flight — or unless the
  // sheet REFUSED our Setup (`setupError`, e.g. a rule whose category is not on its Setup tab).
  // Then the phone keeps its edits, still pending, so nothing is lost and the next sync retries.
  const setupRejected = !!(setup && data.setupError);
  const metaNow = (await getKV('setupMeta')) || {};
  if (!setupRejected && (!metaNow.dirty || metaNow.updatedAt === setupMeta.updatedAt)) {
    if (data.setup) await setKV('setup', data.setup);
    await setKV('setupMeta', { dirty: false, renames: [] });
  }
  await setKV('setupError', setupRejected ? String(data.setupError) : null);
  if (data.setup && !setupRejected) {
    await setKV('setupBase', {
      expenseCategories: data.setup.expenseCategories.map((c) => c.name),
      incomeSources: data.setup.incomeSources.map((c) => c.name),
      rules: data.setup.rules.map((r) => r.id),
    });
  }
  // Forget only what this request carried. A review done while it was in flight added
  // newer watermarks/skips that the reply could not know about: keep those and lay them
  // back over the setup we just took from the sheet.
  const skipsPersisted = data.recurringApi >= 2;   // an older Code.gs ignores `skips`: keep them on the phone
  const wmNow = (await getKV('watermarks')) || {};
  for (const id of Object.keys(watermarks)) if (wmNow[id] && wmNow[id] <= watermarks[id]) delete wmNow[id];
  await setKV('watermarks', wmNow);
  if (skipsPersisted) {
    const skNow = (await getKV('skips')) || {};
    for (const id of Object.keys(skips)) {
      skNow[id] = (skNow[id] || []).filter((d) => !skips[id].includes(d));
      if (!skNow[id].length) delete skNow[id];
    }
    await setKV('skips', skNow);
  }
  await reapplyPending();
  await setKV('recurringRun', data.recurringRun || null);
  await setKV('lastSync', Date.now());

  emitChange('sync');
  const runFailed = data.recurringRun && data.recurringRun.ok === false;
  return {
    pushed: ops.length - failed, failed, pulled,
    staleServer: !(data.recurringApi >= 2),
    recurringError: runFailed ? (data.recurringRun.message || 'unknown error') : '',
    setupError: setupRejected ? String(data.setupError) : '',
  };
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
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
function getAllRaw(db) {
  return new Promise((resolve, reject) => {
    const r = db.transaction('entries', 'readonly').objectStore('entries').getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
