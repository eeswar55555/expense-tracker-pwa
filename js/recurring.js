// Recurring rules -> due occurrences. Mirrors occurrences_() in Code.gs exactly,
// so the phone and the sheet agree on which dates a rule falls on.
//
// Every occurrence gets a deterministic id  'rec-<ruleId>-<YYYY-MM-DD>'. The sheet
// stores ids in column E and refuses to append an id it already has, so the same
// item posted from the phone AND by the sheet's own "Post due recurring" (or its
// daily trigger) still only lands once.

import { todayStr, strToDate, dateToStr, addDays } from './util.js';

const STEP = { Monthly: 1, Quarterly: 3, Yearly: 12, Weekly: 7, Fortnightly: 14 };
const WEEKLY = { Weekly: true, Fortnightly: true };

export const occurrenceId = (ruleId, date) => `rec-${ruleId}-${date}`;

const REC_ID = /^rec-([A-Za-z0-9]+)-(\d{4}-\d{2}-\d{2})$/;
/** 'rec-<ruleId>-<YYYY-MM-DD>' -> { ruleId, date }, or null for any other id. */
export function parseOccurrenceId(id) {
  const m = REC_ID.exec(String(id || ''));
  return m ? { ruleId: m[1], date: m[2] } : null;
}

// An occurrence is in one of three states, and only the first is ever offered:
//   due      neither of the below  -> shown in "Review due", stays due until settled
//   posted   a ledger entry with its id exists
//   skipped  listed in rule.skipped (an explicit "Skip" — leaving an item unticked is NOT a skip)
// rule.lastPosted ("watermark") means: everything up to this date is posted or skipped.

/** Every 'YYYY-MM-DD' this rule falls on within [from, to] (inclusive). */
export function occurrences(rule, from, to) {
  const out = [];
  const start = strToDate(rule.start);
  const f = strToDate(from), t = strToDate(to);
  if (!start || !f || !t || t < f || !STEP[rule.frequency]) return out;
  const day = Number(rule.day) || null;
  let guard = 0;

  if (WEEKLY[rule.frequency]) {
    let d = new Date(start);
    if (day >= 1 && day <= 7) {          // 1..7 = Mon..Sun -> getDay() 1..6,0
      const want = Math.floor(day) % 7;
      while (d.getDay() !== want && guard++ < 7) d.setDate(d.getDate() + 1);
    }
    guard = 0;
    while (d <= t && guard++ < 3000) {
      if (d >= f) out.push(dateToStr(d));
      d = new Date(d); d.setDate(d.getDate() + STEP[rule.frequency]);
    }
    return out;
  }

  const dom = day >= 1 && day <= 31 ? Math.floor(day) : start.getDate();
  let y = start.getFullYear(), m = start.getMonth();
  while (guard++ < 1500) {
    const lastDom = new Date(y, m + 1, 0).getDate();   // 31 -> 28/29/30 in short months
    const d = new Date(y, m, Math.min(dom, lastDom));
    if (d > t) break;
    if (d >= f && d >= start) out.push(dateToStr(d));
    m += STEP[rule.frequency];
    while (m > 11) { m -= 12; y++; }
  }
  return out;
}

/** Why a rule can't run, or '' if it's valid. */
export function ruleProblem(rule) {
  if (rule.type !== 'Expense' && rule.type !== 'Income') return 'Pick Expense or Income';
  if (!rule.category) return 'Pick a category';
  if (!(Number(rule.amount) > 0)) return 'Amount must be above 0';
  if (!STEP[rule.frequency]) return 'Pick a frequency';
  if (!strToDate(rule.start)) return 'Pick a start date';
  if (rule.end && rule.end < rule.start) return 'End date is before start date';
  return '';
}

/** Items that have come due (up to today) and aren't in the ledger yet.
 *  `entries` must include tombstones (listEntries({ includeDeleted: true })) so a
 *  deleted-but-unsynced occurrence isn't offered again. */
export function dueItems(setup, entries, today = todayStr()) {
  const have = new Set(entries.map((e) => e.id));
  // Same guard as the sheet's postRecurring: an item already typed in by hand (same
  // type, date, category and amount) counts as posted. Recurring rows (rec-...) are
  // left out: two rules with the same category, amount and day are two postings.
  const sig = (type, date, category, amount) => `${type}|${date}|${String(category).toLowerCase()}|${Number(amount).toFixed(2)}`;
  const typed = new Set(entries.filter((e) => !e.deleted && !parseOccurrenceId(e.id)).map((e) => sig(e.type, e.date, e.category, e.amount)));
  const out = [];
  for (const rule of setup.rules || []) {
    if (!rule.active || ruleProblem(rule)) continue;
    const skipped = new Set(rule.skipped || []);
    const from = rule.lastPosted ? addDays(rule.lastPosted, 1) : rule.start;
    const to = rule.end && rule.end < today ? rule.end : today;
    for (const date of occurrences(rule, from, to)) {
      const id = occurrenceId(rule.id, date);
      if (skipped.has(date) || have.has(id) || typed.has(sig(rule.type, date, rule.category, rule.amount))) continue;
      out.push({ id, ruleId: rule.id, type: rule.type, date, category: rule.category, amount: Number(rule.amount), description: rule.description || '' });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ruleId < b.ruleId ? -1 : 1));
  return out;
}

/** How far a rule's watermark may advance after a review. `items` = that rule's due items
 *  (oldest first) as they were offered; `settled` = ids posted or skipped so far. Walks
 *  forward over the settled ones and stops at the first still-due item, so an item left for
 *  later is never jumped over. Returns a 'YYYY-MM-DD' date, or '' when nothing can advance. */
export function settledThrough(items, settled) {
  let mark = '';
  for (const it of items) {
    if (!settled.has(it.id)) break;
    mark = it.date;
  }
  return mark;
}

/** Occurrences expected AFTER today and up to `days` days ahead, soonest first — what the
 *  dashboard's "Coming up" card shows. Same rules as dueItems (active, valid, not skipped,
 *  not already in the ledger), but looking forward instead of back. */
export function upcomingItems(setup, entries, today = todayStr(), days = 30) {
  const have = new Set(entries.map((e) => e.id));
  const horizon = addDays(today, days);
  const out = [];
  for (const rule of setup.rules || []) {
    if (!rule.active || ruleProblem(rule)) continue;
    const skipped = new Set(rule.skipped || []);
    const to = rule.end && rule.end < horizon ? rule.end : horizon;
    for (const date of occurrences(rule, addDays(today, 1), to)) {
      const id = occurrenceId(rule.id, date);
      if (skipped.has(date) || have.has(id)) continue;
      out.push({ id, ruleId: rule.id, type: rule.type, date, category: rule.category, amount: Number(rule.amount), description: rule.description || '' });
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ruleId < b.ruleId ? -1 : 1));
  return out;
}

/** The next date a rule will fire after today (for display), or ''. */
export function nextOccurrence(rule, today = todayStr()) {
  if (ruleProblem(rule)) return '';
  const from = addDays(today, 1);
  const horizon = addDays(today, 400);
  const to = rule.end && rule.end < horizon ? rule.end : horizon;
  return occurrences(rule, from, to)[0] || '';
}
