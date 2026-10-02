// Pure aggregation helpers for the dashboard. No DOM, no store access — callers
// pass in listEntries()/getSetup() results. Kept pure so they're cheap to
// re-run on every refresh() and trivially testable in isolation.

import { monthKey, shiftMonth, daysInMonth, todayStr } from './util.js';

const num = (n) => Number(n) || 0;

/** Entries whose date falls in the given 'YYYY-MM' month. */
export function inMonth(entries, mk) {
  return entries.filter((e) => monthKey(e.date) === mk);
}

/** Entries whose date falls in the given calendar year (number or string). */
export function inYear(entries, year) {
  const y = String(year);
  return entries.filter((e) => e.date.slice(0, 4) === y);
}

/** { income, expense, net, savingsRate } for a set of entries. savingsRate is
 *  a ratio (0.23 = 23%); 0 when there's no income to divide by. */
export function totals(entries) {
  let income = 0, expense = 0;
  for (const e of entries) {
    if (e.type === 'Income') income += num(e.amount);
    else expense += num(e.amount);
  }
  return { income, expense, net: income - expense, savingsRate: income > 0 ? (income - expense) / income : 0 };
}

/** Map category/source name -> total amount, for one ledger type. */
export function sumByCategory(entries, type) {
  const m = new Map();
  for (const e of entries) {
    if (e.type !== type) continue;
    m.set(e.category, (m.get(e.category) || 0) + num(e.amount));
  }
  return m;
}

/** Largest N entries of one type, ties broken by most recent date. */
export function topN(entries, type, n) {
  return entries.filter((e) => e.type === type).sort((a, b) => b.amount - a.amount || (b.date < a.date ? -1 : 1)).slice(0, n);
}

/** 'YYYY-MM' keys for the 12 months ending at (and including) endMk, ascending. */
export function last12(endMk) {
  const out = [];
  for (let i = 11; i >= 0; i--) out.push(shiftMonth(endMk, -i));
  return out;
}

/** 'YYYY-MM' keys for the last n months ending at endMk, ascending (includes endMk). */
export function lastN(endMk, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftMonth(endMk, -i));
  return out;
}

/** 'YYYY-01'..'YYYY-12' for a calendar year. */
export function monthsOfYear(year) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

/** Delta vs a previous value. pct is a ratio (0.12 = 12%); null when there is
 *  nothing to compare against (prev is 0/absent). dir: 1 up / -1 down / 0 flat. */
export function delta(curr, prev) {
  if (!prev) return { pct: null, dir: curr > 0 ? 1 : 0, noPrev: true };
  const pct = (curr - prev) / Math.abs(prev);
  return { pct, dir: curr > prev ? 1 : curr < prev ? -1 : 0, noPrev: false };
}

/** Budget roll-ups from Setup: per-category map, per-group sum, category->group. */
export function budgetInfo(setup) {
  const byCategory = new Map();
  const byGroup = new Map((setup.groups || []).map((g) => [g, 0]));
  const groupOf = new Map();
  for (const c of setup.expenseCategories || []) {
    groupOf.set(c.name, c.group);
    if (c.budget != null) {
      byCategory.set(c.name, num(c.budget));
      byGroup.set(c.group, (byGroup.get(c.group) || 0) + num(c.budget));
    }
  }
  return { byCategory, byGroup, groupOf };
}

/** Current-month pace: { day, days, projected, isCurrent }. For a past/future
 *  month, day = days (fully elapsed) so "projected" collapses to actual-rate math
 *  being meaningless — callers should only show pace copy when isCurrent. */
export function pace(mk, spent) {
  const today = todayStr();
  const isCurrent = monthKey(today) === mk;
  const days = daysInMonth(mk);
  const day = isCurrent ? Number(today.slice(8, 10)) : days;
  const projected = day > 0 ? (spent / day) * days : spent;
  return { day, days, projected, isCurrent };
}

/** How many months of `year` have actually elapsed, for annualizing a monthly
 *  budget/target: the current month (inclusive) if `year` is this year, else 12. */
export function monthsElapsedIn(year) {
  const real = todayStr();
  return String(year) === real.slice(0, 4) ? Number(real.slice(5, 7)) : 12;
}

/** Status bucket for a budget/actual ratio. */
export function budgetStatus(actual, budget) {
  if (budget == null || budget <= 0) return 'none';
  const pct = actual / budget;
  if (pct > 1) return 'over';
  if (pct >= 0.8) return 'warn';
  return 'good';
}

// --------------------------------------------------------- one-pass index
//
// The dashboard touches the same (potentially several-thousand-row) entry
// list from nine-odd sections per render. `indexByMonth` walks it exactly
// once into per-month buckets; every section then reads from the index
// (O(1) map lookups + small merges) instead of re-filtering `entries`.

/** A fresh, empty per-month bucket. */
export function emptyBucket() {
  return { income: 0, expense: 0, incomeCat: new Map(), expenseCat: new Map(), entries: [] };
}

/** entries[] -> Map('YYYY-MM' -> bucket). One pass over the whole list. */
export function indexByMonth(entries) {
  const map = new Map();
  for (const e of entries) {
    const mk = monthKey(e.date);
    let b = map.get(mk);
    if (!b) { b = emptyBucket(); map.set(mk, b); }
    b.entries.push(e);
    const amt = num(e.amount);
    if (e.type === 'Income') { b.income += amt; b.incomeCat.set(e.category, (b.incomeCat.get(e.category) || 0) + amt); }
    else { b.expense += amt; b.expenseCat.set(e.category, (b.expenseCat.get(e.category) || 0) + amt); }
  }
  return map;
}

/** { income, expense, net, savingsRate } for a bucket (same shape as totals()). */
export function bucketTotals(b) {
  return { income: b.income, expense: b.expense, net: b.income - b.expense, savingsRate: b.income > 0 ? (b.income - b.expense) / b.income : 0 };
}

/** Combine several months' buckets (from indexByMonth) into one, e.g. for a
 *  year or a YTD range. Missing months are simply skipped. */
export function mergeBuckets(idx, mks) {
  const out = emptyBucket();
  for (const mk of mks) {
    const b = idx.get(mk);
    if (!b) continue;
    out.income += b.income; out.expense += b.expense;
    for (const [k, v] of b.expenseCat) out.expenseCat.set(k, (out.expenseCat.get(k) || 0) + v);
    for (const [k, v] of b.incomeCat) out.incomeCat.set(k, (out.incomeCat.get(k) || 0) + v);
    out.entries.push(...b.entries);
  }
  return out;
}
