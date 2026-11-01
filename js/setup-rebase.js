// A phone that has never pulled the sheet's Setup has only ever edited the built-in starter
// Setup (store.js DEFAULT_SETUP). Its first sync must not push that starter list as it is: the
// sheet's merge lets the phone win every field of a name both sides have, so untouched starter
// rows would blank the sheet's budgets and reset its groups. Instead the phone pulls first and
// rebaseOntoSheet() lays only what the user actually changed over the sheet's copy:
//   a starter field the user changed          -> the user's value
//   a starter field left as it was            -> the sheet's value
//   a category / source / rule the user added -> added (if the sheet has the name, the user's
//                                                fields win, as in any sync)
//   a starter row the user deleted or renamed -> kept if the sheet has it: a phone that never
//                                                saw the sheet does not get to remove from it
//   an untouched starter row the sheet lacks  -> not added
// Pure: no IndexedDB, DOM or network, so it is unit-tested in Node.

const key = (s) => String(s || '').trim().toLowerCase();
const norm = (v) => (v === undefined || v === '' ? null : v);

function rebaseList(local, sheet, starter, fields) {
  const out = (sheet || []).map((x) => ({ ...x }));
  const at = new Map(out.map((x, i) => [key(x.name), i]));
  const start = new Map((starter || []).map((x) => [key(x.name), x]));
  for (const mine of local || []) {
    const k = mine && key(mine.name);
    if (!k) continue;
    const base = start.get(k);
    const changed = base ? fields.filter((f) => norm(mine[f]) !== norm(base[f])) : fields;
    const i = at.get(k);
    if (i !== undefined) { for (const f of changed) out[i][f] = mine[f]; continue; }
    if (base && !changed.length) continue;
    at.set(k, out.push({ ...mine }) - 1);
  }
  return out;
}

/** local = this phone's Setup, sheet = the sheet's Setup, starter = DEFAULT_SETUP. */
export function rebaseOntoSheet(local, sheet, starter) {
  const sheetRules = (sheet.rules || []).map((r) => ({ ...r }));
  const ruleIds = new Set(sheetRules.map((r) => r.id));
  return {
    expenseCategories: rebaseList(local.expenseCategories, sheet.expenseCategories, starter.expenseCategories, ['group', 'budget']),
    incomeSources: rebaseList(local.incomeSources, sheet.incomeSources, starter.incomeSources, ['target']),
    groups: [...(sheet.groups || [])],
    rules: sheetRules.concat((local.rules || []).filter((r) => r && !ruleIds.has(r.id)).map((r) => ({ ...r }))),
  };
}

/** The names / ids of a Setup as last pulled: what the sheet's 3-way merge calls `setupBase`. */
export function setupKeys(setup) {
  return {
    expenseCategories: setup.expenseCategories.map((c) => c.name),
    incomeSources: setup.incomeSources.map((c) => c.name),
    rules: setup.rules.map((r) => r.id),
  };
}
