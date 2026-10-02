// Local-first store. Every read the UI does comes from here, so the app works
// fully offline; sync.js reconciles it with the sheet.
//
// IndexedDB 'expense-tracker' v2
//   entries  keyPath 'id'   — the ledger (a cache of the sheet + local edits)
//   kv       keyPath 'key'  — 'setup', 'setupMeta', 'watermarks', 'lastSync'
//
// Entry: { id, type: 'Expense'|'Income', date: 'YYYY-MM-DD', category, amount,
//          description, updatedAt, dirty, deleted, serverKnown, syncError? }
//   dirty       — has a local change the sheet hasn't seen yet
//   deleted     — tombstone; kept until the delete has synced
//   serverKnown — the sheet has (or had) this row; a never-synced entry that is
//                 deleted can simply be dropped
//
// Setup: { expenseCategories: [{ name, group, budget }],   // max 15 (Setup!A5:C19)
//          incomeSources:     [{ name, target }],          // max 10 (Setup!E5:F14)
//          groups:            ['Fixed', ...],              // Setup!H5:H8, read-only
//          rules: [{ id, type, category, amount, frequency, day, start, end,
//                    description, active, lastPosted }] }  // max 20 (Setup!J5:S24)

import { uid } from './util.js';

const DB_NAME = 'expense-tracker';
const DB_VERSION = 2;

export const LIMITS = { expenseCategories: 15, incomeSources: 10, rules: 20 };
export const FREQUENCIES = ['Monthly', 'Fortnightly', 'Weekly', 'Quarterly', 'Yearly'];

export const DEFAULT_SETUP = {
  expenseCategories: [
    { name: 'Food', group: 'Variable', budget: null },
    { name: 'Travel', group: 'Variable', budget: null },
    { name: 'Rent', group: 'Fixed', budget: null },
    { name: 'Investments', group: 'Savings', budget: null },
    { name: 'Shopping', group: 'Variable', budget: null },
    { name: 'Entertainment', group: 'Variable', budget: null },
    { name: 'Others', group: 'Variable', budget: null },
  ],
  incomeSources: [{ name: 'Salary', target: null }, { name: 'Others', target: null }],
  groups: ['Fixed', 'Variable', 'Savings', 'Debt'],
  rules: [],
};

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
      // v1 -> v2: { synced, createdAt } becomes { dirty, serverKnown, updatedAt }
      if (ev.oldVersion === 1) {
        tx.objectStore('entries').openCursor().onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return;
          const v = cur.value;
          cur.update({
            id: v.id, type: v.type, date: v.date, category: v.category,
            amount: Number(v.amount), description: v.description || '',
            updatedAt: v.createdAt || Date.now(),
            dirty: !v.synced, deleted: false, serverKnown: !!v.synced,
          });
          cur.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const dbPromise = openDB();
/** The open IDBDatabase, for sync.js's single-transaction cache rewrite. */
export const rawDB = () => dbPromise;

async function tx(stores, mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const out = Promise.resolve(fn(t));
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

// ------------------------------------------------------------- change events

const listeners = new Set();
/** Subscribe to any data change (entries or setup). Returns an unsubscribe fn. */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emitChange(what = 'all') { for (const fn of listeners) { try { fn(what); } catch (e) { console.error(e); } } }

// ------------------------------------------------------------------ entries

/** Every live (non-deleted) entry, newest date first. */
export async function listEntries({ includeDeleted = false } = {}) {
  const all = await tx('entries', 'readonly', (t) => reqP(t.objectStore('entries').getAll()));
  const out = includeDeleted ? all : all.filter((e) => !e.deleted);
  out.sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : (b.updatedAt || 0) - (a.updatedAt || 0)));
  return out;
}

export async function getEntry(id) {
  return tx('entries', 'readonly', (t) => reqP(t.objectStore('entries').get(id)));
}

/** Create or update an entry. Pass no id to create. Marks it for sync.
 *  Caller is responsible for validation (parseAmount, category present). */
export async function saveEntry({ id, type, date, category, amount, description }) {
  const existing = id ? await getEntry(id) : null;
  const entry = {
    ...(existing || { serverKnown: false }),
    id: id || uid(),
    type, date, category,
    amount: Number(amount),
    description: String(description || '').trim(),
    updatedAt: Date.now(),
    dirty: true, deleted: false, syncError: undefined,
  };
  await tx('entries', 'readwrite', (t) => t.objectStore('entries').put(entry));
  emitChange('entries');
  return entry;
}

/** Delete an entry. Returns the previous entry so the caller can offer Undo
 *  via restoreEntry(). */
export async function deleteEntry(id) {
  const existing = await getEntry(id);
  if (!existing) return null;
  await tx('entries', 'readwrite', (t) => {
    const s = t.objectStore('entries');
    if (existing.serverKnown) s.put({ ...existing, deleted: true, dirty: true, updatedAt: Date.now() });
    else s.delete(id);
  });
  emitChange('entries');
  return existing;
}

/** Put back exactly what deleteEntry() returned. */
export async function restoreEntry(prev) {
  await tx('entries', 'readwrite', (t) => t.objectStore('entries').put({ ...prev, deleted: false, dirty: true, updatedAt: Date.now() }));
  emitChange('entries');
}

/** Insert several new entries in one go (used for posting recurring items). */
export async function addEntries(list) {
  await tx('entries', 'readwrite', (t) => {
    const s = t.objectStore('entries');
    for (const e of list) s.put({ serverKnown: false, ...e, updatedAt: Date.now(), dirty: true, deleted: false });
  });
  emitChange('entries');
}

export async function pendingCount() {
  const all = await tx('entries', 'readonly', (t) => reqP(t.objectStore('entries').getAll()));
  const meta = await getKV('setupMeta');
  return all.filter((e) => e.dirty).length + (meta && meta.dirty ? 1 : 0);
}

// ---------------------------------------------------------------------- kv

export async function getKV(key) {
  const row = await tx('kv', 'readonly', (t) => reqP(t.objectStore('kv').get(key)));
  return row ? row.value : undefined;
}

export async function setKV(key, value) {
  await tx('kv', 'readwrite', (t) => t.objectStore('kv').put({ key, value }));
}

// ------------------------------------------------------------------- setup

export async function getSetup() {
  return (await getKV('setup')) || structuredClone(DEFAULT_SETUP);
}

/** Save an edited setup. `renames` = [{ type: 'Expense'|'Income', from, to }] —
 *  a renamed category is also renamed on every existing ledger row and rule,
 *  locally now and on the sheet at next sync. */
export async function saveSetup(setup, renames = []) {
  const meta = (await getKV('setupMeta')) || { dirty: false, renames: [] };
  await setKV('setup', setup);
  await setKV('setupMeta', { dirty: true, renames: [...(meta.renames || []), ...renames], updatedAt: Date.now() });
  if (renames.length) {
    await tx('entries', 'readwrite', (t) => {
      const s = t.objectStore('entries');
      s.openCursor().onsuccess = (ev) => {
        const cur = ev.target.result;
        if (!cur) return;
        const e = cur.value;
        const r = renames.find((x) => x.type === e.type && x.from === e.category);
        if (r) cur.update({ ...e, category: r.to });   // not dirty: the server applies the same rename
        cur.continue();
      };
    });
  }
  emitChange('setup');
}

/** Category names for a ledger type, for dropdowns. */
export function categoryNames(setup, type) {
  return type === 'Income'
    ? setup.incomeSources.map((s) => s.name).filter(Boolean)
    : setup.expenseCategories.map((c) => c.name).filter(Boolean);
}

/** Record that recurring items up to `date` were posted from this phone, so the
 *  sheet's LAST POSTED watermark advances at next sync even if the user later
 *  deletes one of those entries before syncing. */
export async function bumpWatermark(ruleId, date) {
  const wm = (await getKV('watermarks')) || {};
  if (!wm[ruleId] || wm[ruleId] < date) wm[ruleId] = date;
  await setKV('watermarks', wm);
  const setup = await getSetup();
  const rule = setup.rules.find((r) => r.id === ruleId);
  if (rule && (!rule.lastPosted || rule.lastPosted < date)) {
    rule.lastPosted = date;
    await setKV('setup', setup);   // local display only; not a setup edit
  }
}
