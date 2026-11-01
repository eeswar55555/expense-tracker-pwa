// Pure helpers behind "Revert to the sheet's version" (Settings > Advanced). No IndexedDB, no
// DOM, no network — so every rule here can be unit-tested in Node and none of it can half-run.
//
// The idea: the phone is a cache of the sheet plus whatever it has not sent yet. Reverting means
// throwing away that "not sent yet" part and taking the sheet's copy. Three things must hold:
//   1. nothing is thrown away until a COMPLETE, well-formed copy of the sheet is in hand
//      (validateCloudReply — if anything looks off, the revert is refused, not guessed at);
//   2. the user is told exactly what will be lost, and only that is lost (unsyncedTokens: the
//      list they confirmed; if anything NEW appears before the swap, the swap is refused);
//   3. what is lost can be saved to a file first (buildUnsyncedExport).

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The sheet's reply to an empty sync -> { rows, setup, recurringRun } ready to store, or throws
 *  an Error whose message is safe to show. Ledger rows become the same entry objects a normal
 *  sync stores (clean: not dirty, not deleted). Strict on purpose: a revert replaces EVERYTHING,
 *  so a malformed reply must stop it, never be patched around. */
export function validateCloudReply(data) {
  const bad = (why) => new Error(`The sheet sent back data this app could not read (${why}).`);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('empty reply');
  if (data.ok !== true) throw bad('no confirmation from the sheet');
  const led = data.ledger;
  if (!led || !Array.isArray(led.Expense) || !Array.isArray(led.Income)) throw bad('the ledger is missing');
  const s = data.setup;
  if (!s || typeof s !== 'object' || !Array.isArray(s.expenseCategories) || !Array.isArray(s.incomeSources)
      || !Array.isArray(s.groups) || !Array.isArray(s.rules)) throw bad('the Setup tab is missing');

  const byId = new Map();     // like a normal sync, if an id were ever on both tabs the later one wins
  for (const type of ['Expense', 'Income']) {
    for (const r of led[type]) {
      const id = r && typeof r.id === 'string' ? r.id.trim() : '';
      const amount = r ? Number(r.amount) : NaN;
      if (!id) throw bad('a row has no id');
      if (!DATE.test(String(r.date))) throw bad('a row has a bad date');
      if (typeof r.category !== 'string') throw bad('a row has no category');
      const typed = typeof r.amount === 'number' || (typeof r.amount === 'string' && r.amount.trim() !== '');
      if (!typed || !Number.isFinite(amount)) throw bad('a row has a bad amount');
      byId.set(id, {
        id, type, date: r.date, category: r.category, amount,
        description: r.description === null || r.description === undefined ? '' : String(r.description),
        updatedAt: 0, dirty: false, deleted: false, serverKnown: true,
      });
    }
  }
  return { rows: [...byId.values()], setup: s, recurringRun: data.recurringRun || null };
}

/** What the sheet holds, in numbers the confirmation screen can show. */
export function summarizeCloud({ rows, setup }) {
  let from = '', to = '', expenses = 0, income = 0;
  for (const r of rows) {
    if (r.type === 'Income') income++; else expenses++;
    if (!from || r.date < from) from = r.date;
    if (!to || r.date > to) to = r.date;
  }
  return {
    entries: rows.length, expenses, income, from, to,
    categories: setup.expenseCategories.length, sources: setup.incomeSources.length, rules: setup.rules.length,
  };
}

/** One token per thing on the phone that the sheet has not seen. The set the user CONFIRMED is
 *  compared with the set that exists at swap time: anything extra (a new or re-edited entry, a
 *  Setup edit, a Review/Skip) means the confirmation no longer covers what would be lost. */
export function unsyncedTokens(entries, setupMeta, watermarks, skips) {
  const out = [];
  for (const e of entries || []) if (e && e.dirty) out.push(`e:${e.id}:${e.updatedAt || 0}:${e.deleted ? 'del' : 'live'}`);
  if (setupMeta && setupMeta.dirty) out.push(`s:${setupMeta.updatedAt || 0}`);
  for (const [id, d] of Object.entries(watermarks || {})) out.push(`w:${id}:${d}`);
  for (const [id, list] of Object.entries(skips || {})) for (const d of list || []) out.push(`k:${id}:${d}`);
  return out.sort();
}

/** Plain counts of what is unsynced (for the first confirmation screen). */
export function describeUnsynced(entries, setupMeta, watermarks, skips) {
  let added = 0, edited = 0, deleted = 0, rejected = 0;
  for (const e of entries || []) {
    if (!e || !e.dirty) continue;
    if (e.syncError) rejected++;
    if (e.deleted) deleted++;
    else if (e.serverKnown) edited++;
    else added++;
  }
  const setup = !!(setupMeta && setupMeta.dirty);
  const choices = Object.keys(watermarks || {}).length
    + Object.values(skips || {}).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  return { added, edited, deleted, rejected, setup, choices, total: added + edited + deleted + (setup ? 1 : 0) + choices };
}

/** A self-describing file of what a revert would discard, so it can be kept first. */
export function buildUnsyncedExport({ entries, setup, setupMeta, watermarks, skips }, now = new Date()) {
  return {
    kind: 'expense-tracker-unsynced-changes',
    version: 1,
    savedAt: now.toISOString(),
    note: 'Changes that were on this phone but had not reached the Google Sheet when it was reverted to the sheet\'s version.',
    entries: (entries || []).filter((e) => e && e.dirty).map((e) => ({
      id: e.id, type: e.type, date: e.date, category: e.category, amount: e.amount, description: e.description || '',
      deleted: !!e.deleted, newOnThisPhone: !e.serverKnown, rejectedBySheet: e.syncError || null,
    })),
    setup: setupMeta && setupMeta.dirty ? setup || null : null,
    renames: setupMeta && setupMeta.dirty ? setupMeta.renames || [] : [],
    recurringChoices: { settledThrough: watermarks || {}, skipped: skips || {} },
  };
}
