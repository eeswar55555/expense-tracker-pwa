// History tab: browse / search / edit past entries.

import { $, $$, esc, fmtMoney, fmtDateLong, monthKey, fmtMonth, shiftMonth, todayStr } from '../util.js';
import { listEntries, getSetup, categoryNames } from '../store.js';
import { openEntryEditor } from './entry-form.js';

const PAGE = 200;

let app;
let root;
let state = { month: monthKey(todayStr()), allTime: false, type: 'All', category: 'All', q: '', limit: PAGE };

function render(root) {
  root.innerHTML = `
    <div class="card hist-filters">
      <div class="month-nav">
        <button type="button" class="icon-btn" id="histPrev" aria-label="Previous month">&#x2039;</button>
        <button type="button" class="chip month-label" id="histMonthLabel"></button>
        <button type="button" class="icon-btn" id="histNext" aria-label="Next month">&#x203a;</button>
        <button type="button" class="chip" id="histAllTime">All time</button>
      </div>
      <div class="seg hist-type" role="group" aria-label="Filter by type">
        <button type="button" data-type="All" aria-pressed="true">All</button>
        <button type="button" data-type="Expense" aria-pressed="false">Expense</button>
        <button type="button" data-type="Income" aria-pressed="false">Income</button>
      </div>
      <div class="row hist-row-filters">
        <select id="histCategory" aria-label="Filter by category"></select>
        <input id="histSearch" type="search" placeholder="Search description or category" aria-label="Search">
      </div>
    </div>

    <div class="card hist-totals" id="histTotals"></div>

    <div id="histList"></div>
    <button type="button" class="btn btn-secondary" id="histShowMore" hidden>Show more</button>
  `;

  $('#histPrev', root).addEventListener('click', () => { state.allTime = false; state.month = shiftMonth(state.month, -1); state.limit = PAGE; renderAll(); });
  $('#histNext', root).addEventListener('click', () => { state.allTime = false; state.month = shiftMonth(state.month, 1); state.limit = PAGE; renderAll(); });
  $('#histAllTime', root).addEventListener('click', () => { state.allTime = !state.allTime; state.limit = PAGE; renderAll(); });
  $('.hist-type', root).addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;
    state.type = btn.dataset.type;
    state.category = 'All';
    state.limit = PAGE;
    renderAll();
  });
  $('#histCategory', root).addEventListener('change', (e) => { state.category = e.target.value; state.limit = PAGE; renderList(); });
  $('#histSearch', root).addEventListener('input', (e) => { state.q = e.target.value; state.limit = PAGE; renderList(); });
  $('#histShowMore', root).addEventListener('click', () => { state.limit += PAGE; renderList(); });
}

function updateFilterControls() {
  $('#histMonthLabel', root).textContent = state.allTime ? 'All time' : fmtMonth(state.month);
  $('#histAllTime', root).setAttribute('aria-pressed', String(state.allTime));
  $('#histPrev', root).disabled = state.allTime;
  $('#histNext', root).disabled = state.allTime;
  $$('.hist-type button', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === state.type)));
}

async function populateCategoryOptions() {
  const sel = $('#histCategory', root);
  const setup = await getSetup();
  const all = await listEntries();
  const names = new Set();
  if (state.type === 'All' || state.type === 'Expense') categoryNames(setup, 'Expense').forEach((n) => names.add(n));
  if (state.type === 'All' || state.type === 'Income') categoryNames(setup, 'Income').forEach((n) => names.add(n));
  for (const e of all) {
    if (state.type !== 'All' && e.type !== state.type) continue;
    if (e.category) names.add(e.category);
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const prevValue = state.category;
  sel.innerHTML = `<option value="All">All categories</option>` + sorted.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = sorted.includes(prevValue) ? prevValue : 'All';
  state.category = sel.value;
}

async function getFiltered() {
  const all = await listEntries();
  let rows = all;
  if (!state.allTime) rows = rows.filter((e) => monthKey(e.date) === state.month);
  if (state.type !== 'All') rows = rows.filter((e) => e.type === state.type);
  if (state.category !== 'All') rows = rows.filter((e) => e.category === state.category);
  const q = state.q.trim().toLowerCase();
  if (q) rows = rows.filter((e) => (e.description || '').toLowerCase().includes(q) || (e.category || '').toLowerCase().includes(q));
  return rows;
}

function statusBadge(e) {
  if (e.syncError) {
    const msg = `Sync failed: ${e.syncError}`;
    return `<span class="status-badge status-error" title="${esc(msg)}" aria-label="${esc(msg)}">&#9888; Sync failed</span>`;
  }
  if (e.dirty) {
    return `<span class="status-badge status-pending" title="Waiting to sync" aria-label="Waiting to sync">&#9679; Pending</span>`;
  }
  return '';
}

function renderTotals(rows) {
  let income = 0, expense = 0;
  for (const e of rows) { if (e.type === 'Income') income += Number(e.amount) || 0; else expense += Number(e.amount) || 0; }
  const net = income - expense;
  $('#histTotals', root).innerHTML = `
    <div class="totals-row">
      <div class="t-item"><div class="t-lbl">Income</div><div class="t-val amt-income">${fmtMoney(income)}</div></div>
      <div class="t-item"><div class="t-lbl">Expenses</div><div class="t-val amt-expense">${fmtMoney(expense)}</div></div>
      <div class="t-item"><div class="t-lbl">Net</div><div class="t-val ${net < 0 ? 'amt-expense' : 'amt-income'}">${fmtMoney(net)}</div></div>
    </div>
  `;
}

async function renderList() {
  const listEl = $('#histList', root);
  const showMoreBtn = $('#histShowMore', root);
  const rows = await getFiltered();
  renderTotals(rows);

  if (!rows.length) {
    listEl.innerHTML = `<div class="empty">${hasAnyFilter() ? 'No entries match your filters.' : 'No entries yet.'}</div>`;
    showMoreBtn.hidden = true;
    return;
  }

  const visible = rows.slice(0, state.limit);
  const groups = [];
  for (const e of visible) {
    let g = groups[groups.length - 1];
    if (!g || g.date !== e.date) { g = { date: e.date, items: [], expenseTotal: 0 }; groups.push(g); }
    g.items.push(e);
    if (e.type === 'Expense') g.expenseTotal += Number(e.amount) || 0;
  }

  listEl.innerHTML = groups.map((g) => `
    <div class="day-group">
      <div class="day-head">
        <span>${esc(fmtDateLong(g.date))}</span>
        ${g.expenseTotal > 0 ? `<span class="day-total" title="Spent this day">${fmtMoney(g.expenseTotal)}</span>` : ""}
      </div>
      <div class="card hist-card">
        ${g.items.map((e) => `
          <button type="button" class="hist-row" data-id="${esc(e.id)}">
            <div class="meta">
              <div class="cat-line">
                <span class="cat">${esc(e.category)}</span>
                ${statusBadge(e)}
              </div>
              ${e.description ? `<div class="desc">${esc(e.description)}</div>` : ''}
            </div>
            <div class="amt ${e.type === 'Income' ? 'amt-income' : 'amt-expense'}">${e.type === 'Income' ? '+' : '−'}${fmtMoney(e.amount)}</div>
          </button>
        `).join('')}
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.hist-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const entry = rows.find((e) => e.id === row.dataset.id);
      if (entry) {
        const outcome = await openEntryEditor(entry);
        if (outcome === 'saved' || outcome === 'deleted') renderList();
      }
    });
  });

  showMoreBtn.hidden = rows.length <= state.limit;
}

function hasAnyFilter() {
  return state.type !== 'All' || state.category !== 'All' || state.q.trim() !== '';
}

async function renderAll() {
  updateFilterControls();
  await populateCategoryOptions();
  updateFilterControls();
  await renderList();
}

export default {
  title: 'History',
  mount(r, a) {
    app = a;
    root = r;
    render(root);
    renderAll();
  },
  show(params = {}) {
    if (params.month) { state.month = params.month; state.allTime = false; }
    if (params.type) state.type = params.type;
    if (params.category) state.category = params.category;
    state.limit = PAGE;
    renderAll();
  },
  refresh() { renderAll(); },
};
