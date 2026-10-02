// Dashboard: monthly summary, budget vs actual, category breakdown, group
// roll-up, income performance, top expenses, a 12-month trend, year-over-year,
// and a multi-month comparison table — plus a Year scope with the annualized
// equivalents. See the view contract in app.js's header comment.
//
// Color note (dataviz skill): income/expense use the app-wide --income/--expense
// tokens (blue #1f73a0 / coral #c4452f light, #3d93cf / #e0654f dark, set in
// styles.css). That pair passes scripts/validate_palette.js in both modes
// (CVD ΔE ≥ 16, normal-vision ΔE ≥ 26, ≥ 3:1 on the card). Charts still add
// secondary encoding: fixed income-then-expense order, a text legend, direct
// labels/tooltips, and status rows that pair an icon + text with the color.

import { listEntries, getSetup } from '../store.js';
import {
  monthKey, fmtMonth, shiftMonth, todayStr, fmtDate, fmtMoney0, fmtMoneyShort, esc,
} from '../util.js';
import {
  indexByMonth, emptyBucket, bucketTotals, mergeBuckets, monthsOfYear, monthsElapsedIn,
  pace, budgetInfo, budgetStatus, delta, topN, last12, lastN,
} from '../analytics.js';
import { monthlyBarChart, yoyLineChart, legendRow, heatStyle } from '../charts.js';
import { openEntryEditor } from './entry-form.js';

const monShort = (mk) => fmtMonth(mk).slice(0, 3);

let rootEl = null, appRef = null;
let state = { scope: 'month', mk: null, year: null };
let entriesById = new Map();
let renderToken = 0;

// --------------------------------------------------------------- lifecycle

function loadScope() {
  try { const s = sessionStorage.getItem('etk.dash.scope'); if (s === 'month' || s === 'year') state.scope = s; } catch {}
}
function saveScope() { try { sessionStorage.setItem('etk.dash.scope', state.scope); } catch {} }

async function render() {
  const myToken = ++renderToken;
  const [entries, setup] = await Promise.all([listEntries(), getSetup()]);
  if (myToken !== renderToken || !rootEl) return;
  entriesById = new Map();
  const body = state.scope === 'month' ? renderMonth(entries, setup) : renderYear(entries, setup);
  rootEl.innerHTML = controlsHtml() + body;
}

export default {
  title: 'Dashboard',
  mount(root, app) {
    rootEl = root; appRef = app;
    root.style.position = 'relative';
    loadScope();
    const mk = monthKey(todayStr());
    state.mk = mk;
    state.year = Number(mk.slice(0, 4));
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
  },
  show(params = {}) {
    if (params && params.month) { state.mk = params.month; state.scope = 'month'; }
    render();
  },
  refresh() { render(); },
};

// -------------------------------------------------------------- controls

function controlsHtml() {
  const label = state.scope === 'month' ? fmtMonth(state.mk) : String(state.year);
  return `<div class="card dash-controls">
    <div class="period-nav">
      <button class="icon-btn" type="button" data-action="period-prev" aria-label="Previous ${state.scope}">&#8249;</button>
      <div class="period-label">${esc(label)}</div>
      <button class="icon-btn" type="button" data-action="period-next" aria-label="Next ${state.scope}">&#8250;</button>
    </div>
    <div class="seg" role="tablist" aria-label="Scope">
      <button type="button" aria-pressed="${state.scope === 'month'}" data-scope="month">Month</button>
      <button type="button" aria-pressed="${state.scope === 'year'}" data-scope="year">Year</button>
    </div>
  </div>`;
}

function shiftPeriod(dir) {
  if (state.scope === 'month') state.mk = shiftMonth(state.mk, dir);
  else state.year += dir;
  render();
}
function setScope(s) {
  if ((s !== 'month' && s !== 'year') || s === state.scope) return;
  if (s === 'year') state.year = Number(state.mk.slice(0, 4));
  else state.mk = `${state.year}-${state.mk.slice(5, 7)}`;
  state.scope = s;
  saveScope();
  render();
}

// ----------------------------------------------------------------- events

function onClick(e) {
  const setupLink = e.target.closest('[data-goto-setup]');
  if (setupLink) { e.preventDefault(); appRef.navigate('setup'); return; }
  const prevBtn = e.target.closest('[data-action="period-prev"]');
  if (prevBtn) { shiftPeriod(-1); return; }
  const nextBtn = e.target.closest('[data-action="period-next"]');
  if (nextBtn) { shiftPeriod(1); return; }
  const scopeBtn = e.target.closest('[data-scope]');
  if (scopeBtn) { setScope(scopeBtn.dataset.scope); return; }
  const navEl = e.target.closest('[data-nav]');
  if (navEl) { hideTip(); appRef.navigate('history', JSON.parse(navEl.dataset.nav)); return; }
  const entryEl = e.target.closest('[data-entry-id]');
  if (entryEl) { const entry = entriesById.get(entryEl.dataset.entryId); if (entry) openEntryEditor(entry); return; }
  const hit = e.target.closest('.bar-hit');
  if (hit) { toggleTip(hit); return; }
  hideTip();
}
function onKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const hit = e.target.closest && e.target.closest('.bar-hit');
  if (hit) { e.preventDefault(); toggleTip(hit); }
}

// ------------------------------------------------------------- tooltips

function ensureTip() {
  let tip = rootEl.querySelector('.dash-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'dash-tip';
    tip.setAttribute('role', 'status');
    tip.setAttribute('aria-live', 'polite');
    rootEl.appendChild(tip);
  }
  return tip;
}
function hideTip() {
  const tip = rootEl && rootEl.querySelector('.dash-tip');
  if (tip) tip.classList.remove('show');
}
function showTipAt(anchorEl, html) {
  const tip = ensureTip();
  tip.innerHTML = html;
  tip.classList.add('show');
  tip.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const ar = anchorEl.getBoundingClientRect();
    const rr = rootEl.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    // Clamp against the actual viewport, not the (tall, scrolled) root — the
    // anchor itself may already be partially scrolled past the top/bottom
    // edge, so root-local math alone can still place the tip off-screen.
    let viewportTop = ar.top - th - 10;
    if (viewportTop < 8) viewportTop = ar.bottom + 10;
    if (viewportTop + th > window.innerHeight - 8) viewportTop = Math.max(8, window.innerHeight - th - 8);
    let viewportLeft = ar.left + ar.width / 2 - tw / 2;
    viewportLeft = Math.max(8, Math.min(viewportLeft, window.innerWidth - tw - 8));
    tip.style.left = (viewportLeft - rr.left) + 'px';
    tip.style.top = (viewportTop - rr.top) + 'px';
    tip.style.visibility = 'visible';
  });
}
function toggleTip(hit) {
  const svg = hit.closest('svg[data-points]');
  if (!svg) return;
  const key = svg.dataset.chart + '-' + hit.dataset.i;
  const tip = ensureTip();
  if (tip.classList.contains('show') && tip.dataset.key === key) { hideTip(); return; }
  tip.dataset.key = key;
  const points = JSON.parse(svg.dataset.points);
  const point = points[Number(hit.dataset.i)];
  if (!point) return;
  let html;
  if ('income' in point) {
    html = `<div class="tip-title">${esc(fmtMonth(point.mk))}</div>
      <div class="tip-row"><span class="tip-swatch" style="background:var(--income)"></span>Income <b>${esc(fmtMoney0(point.income))}</b></div>
      <div class="tip-row"><span class="tip-swatch" style="background:var(--expense)"></span>Expense <b>${esc(fmtMoney0(point.expense))}</b></div>
      <div class="tip-row">Net <b>${esc(fmtMoney0(point.income - point.expense))}</b></div>`;
  } else {
    const years = JSON.parse(svg.dataset.years);
    html = `<div class="tip-title">${esc(point.mk)}</div>` +
      (point.thisYear != null ? `<div class="tip-row"><span class="tip-swatch" style="background:var(--expense)"></span>${years.yearThis} <b>${esc(fmtMoney0(point.thisYear))}</b></div>` : '') +
      (point.lastYear != null ? `<div class="tip-row"><span class="tip-swatch" style="background:var(--muted)"></span>${years.yearLast} <b>${esc(fmtMoney0(point.lastYear))}</b></div>` : '');
  }
  showTipAt(hit, html);
}

// --------------------------------------------------------------- tiles

function fmtDelta(curr, prev) {
  const d = delta(curr, prev);
  if (d.noPrev) return { noPrev: true, dir: d.dir };
  return { noPrev: false, dir: d.dir, pctText: `${Math.abs(d.pct * 100).toFixed(1)}%` };
}
function fmtDeltaPP(curr, prev, hadPrev) {
  if (!hadPrev) return { noPrev: true, dir: curr > 0 ? 1 : 0 };
  const diff = (curr - prev) * 100;
  const dir = diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0;
  return { noPrev: false, dir, pctText: `${Math.abs(diff).toFixed(1)}pp` };
}
function statTile(label, value, d, goodDir) {
  let deltaHtml;
  if (d.noPrev) deltaHtml = `<div class="tile-delta muted">No prior period to compare</div>`;
  else if (d.dir === 0) deltaHtml = `<div class="tile-delta muted">No change</div>`;
  else {
    const isGood = (d.dir === 1 && goodDir === 1) || (d.dir === -1 && goodDir === -1);
    deltaHtml = `<div class="tile-delta ${isGood ? 'good' : 'bad'}"><span aria-hidden="true">${d.dir === 1 ? '▲' : '▼'}</span> ${d.pctText} vs prior</div>`;
  }
  return `<div class="stat-tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${deltaHtml}</div>`;
}

// ------------------------------------------------------- budget/meter bits

function budgetBarHtml(label, actual, budget, expectedPct) {
  const pct = budget > 0 ? (actual / budget) * 100 : 0;
  const status = budgetStatus(actual, budget);
  const fillPct = Math.min(100, pct);
  const remaining = budget - actual;
  const subText = remaining >= 0 ? `${esc(fmtMoney0(remaining))} remaining` : `${esc(fmtMoney0(-remaining))} over`;
  const statusLabel = status === 'over' ? 'Over' : status === 'warn' ? 'Near limit' : 'On track';
  const statusIcon = status === 'over' ? '⚠' : status === 'warn' ? '●' : '✓';
  return `<div class="budget-line">
    <div class="budget-head"><span class="budget-name">${label}</span><span class="budget-status status-${status}">${statusIcon} ${statusLabel}</span></div>
    <div class="meter"><div class="meter-fill meter-${status}" style="width:${fillPct}%"></div>${expectedPct != null ? `<div class="meter-marker" style="left:${expectedPct}%"></div>` : ''}</div>
    <div class="budget-foot"><span>${esc(fmtMoney0(actual))} of ${esc(fmtMoney0(budget))}</span><span>${pct.toFixed(0)}% &middot; ${subText}</span></div>
  </div>`;
}
function incomeBarHtml(label, actual, target) {
  const pct = target > 0 ? (actual / target) * 100 : 0;
  const fillPct = Math.min(100, pct);
  return `<div class="budget-line">
    <div class="budget-head"><span class="budget-name">${label}</span><span class="budget-status">${pct.toFixed(0)}% of target</span></div>
    <div class="meter"><div class="meter-fill" style="width:${fillPct}%;background:var(--income)"></div></div>
    <div class="budget-foot"><span>${esc(fmtMoney0(actual))} of ${esc(fmtMoney0(target))}</span></div>
  </div>`;
}

// ----------------------------------------------------------- month scope

function renderMonth(entries, setup) {
  const idx = indexByMonth(entries);
  const mk = state.mk;
  const bucket = idx.get(mk) || emptyBucket();
  const prevBucket = idx.get(shiftMonth(mk, -1)) || emptyBucket();
  const t = bucketTotals(bucket), pt = bucketTotals(prevBucket);
  return [
    summarySection(t, pt),
    budgetSection(bucket, setup, mk),
    groupSection(bucket, setup),
    categorySection(bucket, setup, { month: mk, type: 'Expense' }, 'Category Breakdown', 'No expenses recorded this month.'),
    incomeSection(bucket, setup, 1, 'No income recorded this month.'),
    topExpensesSection(bucket, 'Top Expenses', 'No expenses this month.'),
    trendSection(idx, mk),
    yoySection(idx, mk, setup),
    multiMonthSection(idx, mk, setup),
  ].join('');
}

function summarySection(t, pt) {
  const tiles = [
    statTile('Income', fmtMoney0(t.income), fmtDelta(t.income, pt.income), 1),
    statTile('Expenses', fmtMoney0(t.expense), fmtDelta(t.expense, pt.expense), -1),
    statTile('Net savings', fmtMoney0(t.net), fmtDelta(t.net, pt.net), 1),
    statTile('Savings rate', `${(t.savingsRate * 100).toFixed(1)}%`, fmtDeltaPP(t.savingsRate, pt.savingsRate, pt.income > 0), 1),
  ].join('');
  return `<div class="card"><div class="card-title">Summary</div><div class="stat-grid">${tiles}</div></div>`;
}

function budgetRow(name, actual, budget, mk) {
  const nav = JSON.stringify({ month: mk, type: 'Expense', category: name });
  return `<div class="budget-row" data-nav='${esc(nav)}' role="button" tabindex="0">${budgetBarHtml(esc(name), actual, budget, null)}</div>`;
}

function budgetSection(bucket, setup, mk) {
  const spent = bucket.expenseCat;
  const withBudget = setup.expenseCategories.filter((c) => c.budget != null && c.budget > 0);
  if (!withBudget.length) {
    return `<div class="card"><div class="card-title">Budget vs Actual</div>
      <div class="empty">No budgets set yet. <a href="#" data-goto-setup>Set budgets in Setup</a> to track spending against a plan.</div></div>`;
  }
  const rows = withBudget.map((c) => budgetRow(c.name, spent.get(c.name) || 0, c.budget, mk)).join('');
  const totalBudget = withBudget.reduce((s, c) => s + c.budget, 0);
  const totalSpent = withBudget.reduce((s, c) => s + (spent.get(c.name) || 0), 0);
  // Only day-to-day (Variable) spending is extrapolated; rent, SIPs etc. land once
  // a month, so projecting them by the day would wildly overstate the month.
  const isVariable = (c) => (c.group || 'Variable') === 'Variable';
  const variableSpent = withBudget.filter(isVariable).reduce((s, c) => s + (spent.get(c.name) || 0), 0);
  const pc = pace(mk, variableSpent);
  const projected = totalSpent - variableSpent + pc.projected;
  const expectedPct = pc.isCurrent ? Math.min(100, (pc.day / pc.days) * 100) : null;
  const paceHtml = pc.isCurrent ? `<div class="hint pace-hint">Day ${pc.day} of ${pc.days} &middot; on pace for ${esc(fmtMoney0(projected))} of ${esc(fmtMoney0(totalBudget))}</div>` : '';
  const noBudgetCats = setup.expenseCategories.filter((c) => !(c.budget > 0) && (spent.get(c.name) || 0) > 0);
  const noBudgetHtml = noBudgetCats.map((c) => `<div class="nobudget-row"><span>${esc(c.name)}</span><span class="muted">No budget set &middot; ${esc(fmtMoney0(spent.get(c.name)))}</span></div>`).join('');
  return `<div class="card"><div class="card-title">Budget vs Actual</div>
    ${rows}
    <div class="budget-total-row">${budgetBarHtml('Total', totalSpent, totalBudget, expectedPct)}</div>
    ${paceHtml}
    ${noBudgetCats.length ? `<div class="section-label">No budget set</div>${noBudgetHtml}` : ''}
  </div>`;
}

function groupSection(bucket, setup) {
  const { byGroup, groupOf } = budgetInfo(setup);
  const spentByGroup = new Map((setup.groups || []).map((g) => [g, 0]));
  for (const [cat, amt] of bucket.expenseCat) {
    const g = groupOf.get(cat) || 'Other';
    spentByGroup.set(g, (spentByGroup.get(g) || 0) + amt);
  }
  const rows = (setup.groups || []).map((g) => {
    const budget = byGroup.get(g) || 0;
    const actual = spentByGroup.get(g) || 0;
    if (budget <= 0) return `<div class="group-row"><div class="budget-head"><span class="budget-name">${esc(g)}</span><span class="muted">${esc(fmtMoney0(actual))} spent &middot; no budget set</span></div></div>`;
    return `<div class="group-row">${budgetBarHtml(esc(g), actual, budget, null)}</div>`;
  }).join('');
  return `<div class="card"><div class="card-title">Spending by Group</div>${rows || '<div class="empty">No groups configured.</div>'}</div>`;
}

function categorySection(bucket, setup, navBase, title, emptyText) {
  const spent = bucket.expenseCat;
  const total = bucket.expense;
  const known = new Set(setup.expenseCategories.map((c) => c.name));
  const rows = [...spent.entries()].sort((a, b) => b[1] - a[1]).map(([name, amt]) => {
    const share = total > 0 ? (amt / total) * 100 : 0;
    const nav = JSON.stringify({ ...navBase, category: name });
    const nameLabel = esc(name) + (known.has(name) ? '' : ' <span class="muted">(not in Setup)</span>');
    return `<div class="cat-row" data-nav='${esc(nav)}' role="button" tabindex="0">
      <div class="cat-row-head"><span>${nameLabel}</span><span>${esc(fmtMoney0(amt))} &middot; ${share.toFixed(0)}%</span></div>
      <div class="meter"><div class="meter-fill" style="width:${share}%;background:var(--expense)"></div></div>
    </div>`;
  }).join('');
  if (!rows) return `<div class="card"><div class="card-title">${title}</div><div class="empty">${esc(emptyText)}</div></div>`;
  return `<div class="card"><div class="card-title">${title}</div>${rows}</div>`;
}

function incomeSection(bucket, setup, multiplier, emptyText) {
  const actual = bucket.incomeCat;
  const names = new Set([...setup.incomeSources.map((s) => s.name), ...actual.keys()]);
  let rows = '';
  for (const name of names) {
    const src = setup.incomeSources.find((s) => s.name === name);
    const amt = actual.get(name) || 0;
    const target = src && src.target > 0 ? src.target * multiplier : null;
    rows += target
      ? `<div class="group-row">${incomeBarHtml(esc(name), amt, target)}</div>`
      : `<div class="group-row"><div class="budget-head"><span class="budget-name">${esc(name)}</span><span class="muted">${esc(fmtMoney0(amt))}${src ? ' &middot; no target set' : ' &middot; not in Setup'}</span></div></div>`;
  }
  if (!rows) return `<div class="card"><div class="card-title">Income Performance</div><div class="empty">${esc(emptyText)}</div></div>`;
  return `<div class="card"><div class="card-title">Income Performance</div>${rows}</div>`;
}

function topExpensesSection(bucket, title, emptyText) {
  const top = topN(bucket.entries, 'Expense', 5);
  if (!top.length) return `<div class="card"><div class="card-title">${title}</div><div class="empty">${esc(emptyText)}</div></div>`;
  for (const e of top) entriesById.set(e.id, e);
  const rows = top.map((e) => `<div class="top-row" data-entry-id="${esc(e.id)}" role="button" tabindex="0">
    <div class="top-row-main"><span class="top-cat">${esc(e.category)}</span><span class="top-desc muted">${esc(e.description || '')}</span></div>
    <div class="top-row-side"><span class="top-date muted">${fmtDate(e.date)}</span><span class="amt-expense">${esc(fmtMoney0(e.amount))}</span></div>
  </div>`).join('');
  return `<div class="card"><div class="card-title">${title}</div>${rows}</div>`;
}

function trendSection(idx, mk) {
  const months = last12(mk);
  const income = months.map((m) => (idx.get(m)?.income) || 0);
  const expense = months.map((m) => (idx.get(m)?.expense) || 0);
  const chart = monthlyBarChart({ months, income, expense, selectedMk: mk, id: `trend-${mk}` });
  const legend = legendRow([{ label: 'Income', color: 'var(--income)', kind: 'bar' }, { label: 'Expense', color: 'var(--expense)', kind: 'bar' }]);
  return `<div class="card"><div class="card-title">12-Month Trend<span class="sub">Tap a month</span></div>${chart}${legend}</div>`;
}

function yoyCategoryTable(ytdThis, ytdLast) {
  const cats = new Set([...ytdThis.expenseCat.keys(), ...ytdLast.expenseCat.keys()]);
  const rows = [...cats].map((cat) => ({ cat, curr: ytdThis.expenseCat.get(cat) || 0, prev: ytdLast.expenseCat.get(cat) || 0 }))
    .sort((a, b) => b.curr - a.curr);
  if (!rows.length) return '<div class="empty">No expense data yet.</div>';
  const body = rows.map((r) => {
    const d = delta(r.curr, r.prev);
    const dText = d.noPrev ? (r.curr > 0 ? 'New' : '—') : `${d.dir > 0 ? '▲' : d.dir < 0 ? '▼' : '•'} ${Math.abs(d.pct * 100).toFixed(0)}%`;
    const dCls = d.noPrev ? '' : d.dir > 0 ? 'bad' : d.dir < 0 ? 'good' : '';
    return `<tr><td>${esc(r.cat)}</td><td>${esc(fmtMoneyShort(r.curr))}</td><td>${esc(fmtMoneyShort(r.prev))}</td><td class="${dCls}">${dText}</td></tr>`;
  }).join('');
  return `<div class="table-scroll"><table class="data-table"><thead><tr><th>Category</th><th>This</th><th>Last</th><th>&Delta;</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function yoySection(idx, mk, setup) {
  const selYear = Number(mk.slice(0, 4));
  const selMonthNum = Number(mk.slice(5, 7));
  const realNow = todayStr();
  const isRealCurrentYear = selYear === Number(realNow.slice(0, 4));
  const realMonthNum = Number(realNow.slice(5, 7));
  const thisMonths = monthsOfYear(selYear);
  const lastMonths = monthsOfYear(selYear - 1);
  // A month with no bucket at all (predates any recorded entry) is a gap in
  // the line, not a true ₹0 — otherwise history before the ledger started
  // reads as "spent nothing" instead of "no data".
  const seriesThis = thisMonths.map((m, i) => (isRealCurrentYear && (i + 1) > realMonthNum) ? null : (idx.has(m) ? idx.get(m).expense : null));
  const seriesLast = lastMonths.map((m) => (idx.has(m) ? idx.get(m).expense : null));
  const chart = yoyLineChart({ seriesThis, seriesLast, yearThis: selYear, yearLast: selYear - 1, id: `yoy-${mk}` });
  const legend = legendRow([{ label: String(selYear), color: 'var(--expense)', kind: 'line' }, { label: String(selYear - 1), color: 'var(--muted)', kind: 'line' }]);

  const ytdThis = mergeBuckets(idx, thisMonths.slice(0, selMonthNum));
  const ytdLast = mergeBuckets(idx, lastMonths.slice(0, selMonthNum));
  const tt = bucketTotals(ytdThis), lt = bucketTotals(ytdLast);
  const ytdTiles = [
    statTile('Income YTD', fmtMoney0(tt.income), fmtDelta(tt.income, lt.income), 1),
    statTile('Expense YTD', fmtMoney0(tt.expense), fmtDelta(tt.expense, lt.expense), -1),
    statTile('Net YTD', fmtMoney0(tt.net), fmtDelta(tt.net, lt.net), 1),
  ].join('');

  return `<div class="card"><div class="card-title">Year-over-Year<span class="sub">${selYear} vs ${selYear - 1}</span></div>
    ${chart}${legend}
    <div class="section-label">Year-to-date (Jan&ndash;${monShort(mk)})</div>
    <div class="stat-grid stat-grid-3">${ytdTiles}</div>
    <div class="section-label">By category</div>
    ${yoyCategoryTable(ytdThis, ytdLast)}
  </div>`;
}

function multiMonthSection(idx, mk, setup) {
  const months = lastN(mk, 6);
  const known = setup.expenseCategories.map((c) => c.name);
  const seen = new Set();
  for (const m of months) { const b = idx.get(m); if (b) for (const k of b.expenseCat.keys()) seen.add(k); }
  const allCats = [...new Set([...known, ...seen])];
  const rows = allCats.map((cat) => {
    const vals = months.map((m) => (idx.get(m)?.expenseCat.get(cat)) || 0);
    return { cat, vals, total: vals.reduce((a, b) => a + b, 0) };
  }).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  if (!rows.length) return `<div class="card"><div class="card-title">Multi-Month Comparison</div><div class="empty">No expense data in the last 6 months.</div></div>`;
  const max = Math.max(...rows.flatMap((r) => r.vals));
  const headerCells = months.map((m) => `<th>${monShort(m)}</th>`).join('');
  const bodyRows = rows.map((r) => {
    const cells = r.vals.map((v, i) => {
      const { style, strong } = heatStyle(v, max);
      const nav = JSON.stringify({ month: months[i], type: 'Expense', category: r.cat });
      return `<td class="heat-cell${strong ? ' heat-strong' : ''}" style="${style}" data-nav='${esc(nav)}' role="button" tabindex="0">${v > 0 ? esc(fmtMoneyShort(v)) : '—'}</td>`;
    }).join('');
    return `<tr><td class="heat-cat">${esc(r.cat)}</td>${cells}</tr>`;
  }).join('');
  return `<div class="card"><div class="card-title">Multi-Month Comparison</div>
    <div class="table-scroll"><table class="heat-table"><thead><tr><th>Category</th>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>
  </div>`;
}

// ------------------------------------------------------------ year scope

function renderYear(entries, setup) {
  const idx = indexByMonth(entries);
  const year = state.year;
  const elapsed = monthsElapsedIn(year);
  const isCurrentYear = elapsed < 12;
  const activeMonths = monthsOfYear(year).slice(0, elapsed);
  const bucket = mergeBuckets(idx, activeMonths);
  const prevBucket = mergeBuckets(idx, monthsOfYear(year - 1));
  const t = bucketTotals(bucket), pt = bucketTotals(prevBucket);
  return [
    yearSummarySection(t, pt, year, isCurrentYear),
    yearBudgetSection(bucket, setup, elapsed, isCurrentYear),
    categorySection(bucket, setup, { type: 'Expense' }, 'Category Breakdown', 'No expenses recorded this year.'),
    yearMonthlySection(idx, year),
    incomeSection(bucket, setup, elapsed, 'No income recorded this year.'),
    topExpensesSection(bucket, 'Top Expenses', 'No expenses this year.'),
  ].join('');
}

function yearSummarySection(t, pt, year, isCurrentYear) {
  const sub = isCurrentYear ? ' (YTD)' : '';
  const tiles = [
    statTile('Income' + sub, fmtMoney0(t.income), fmtDelta(t.income, pt.income), 1),
    statTile('Expenses' + sub, fmtMoney0(t.expense), fmtDelta(t.expense, pt.expense), -1),
    statTile('Net savings' + sub, fmtMoney0(t.net), fmtDelta(t.net, pt.net), 1),
    statTile('Savings rate' + sub, `${(t.savingsRate * 100).toFixed(1)}%`, fmtDeltaPP(t.savingsRate, pt.savingsRate, pt.income > 0), 1),
  ].join('');
  return `<div class="card"><div class="card-title">Summary<span class="sub">${year} vs ${year - 1}</span></div><div class="stat-grid">${tiles}</div></div>`;
}

function yearBudgetSection(bucket, setup, elapsed, isCurrentYear) {
  const withBudget = setup.expenseCategories.filter((c) => c.budget != null && c.budget > 0);
  if (!withBudget.length) {
    return `<div class="card"><div class="card-title">Annual Budget vs Actual</div>
      <div class="empty">No budgets set yet. <a href="#" data-goto-setup>Set budgets in Setup</a> to track spending against a plan.</div></div>`;
  }
  const hint = isCurrentYear
    ? `Monthly budget &times; ${elapsed} month${elapsed === 1 ? '' : 's'} elapsed this year.`
    : `Monthly budget &times; 12 months (full year).`;
  const rows = withBudget.map((c) => {
    const annualBudget = c.budget * elapsed;
    const actual = bucket.expenseCat.get(c.name) || 0;
    return `<div class="budget-row">${budgetBarHtml(esc(c.name), actual, annualBudget, null)}</div>`;
  }).join('');
  const totalBudget = withBudget.reduce((s, c) => s + c.budget * elapsed, 0);
  const totalActual = withBudget.reduce((s, c) => s + (bucket.expenseCat.get(c.name) || 0), 0);
  return `<div class="card"><div class="card-title">Annual Budget vs Actual</div>${rows}
    <div class="budget-total-row">${budgetBarHtml('Total', totalActual, totalBudget, null)}</div>
    <div class="hint">${hint}</div></div>`;
}

function yearMonthlySection(idx, year) {
  const months = monthsOfYear(year);
  const income = months.map((m) => (idx.get(m)?.income) || 0);
  const expense = months.map((m) => (idx.get(m)?.expense) || 0);
  const realNow = todayStr();
  const selectedMk = realNow.slice(0, 4) === String(year) ? monthKey(realNow) : null;
  const chart = monthlyBarChart({ months, income, expense, selectedMk, id: `year-${year}` });
  const legend = legendRow([{ label: 'Income', color: 'var(--income)', kind: 'bar' }, { label: 'Expense', color: 'var(--expense)', kind: 'bar' }]);
  return `<div class="card"><div class="card-title">Monthly Breakdown<span class="sub">${year}</span></div>${chart}${legend}</div>`;
}
