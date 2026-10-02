// Add tab: fast entry form + "this month" glance + recent entries.

import { $, esc, fmtMoney, fmtDate, toast, todayStr, monthKey } from '../util.js';
import { listEntries, getSetup, saveEntry, deleteEntry } from '../store.js';
import { buildEntryFields, openEntryEditor } from './entry-form.js';
import { countDue, openDueReview } from './due.js';

let app;
let root;
let fields;
let fieldsRoot;

function render(root) {
  root.innerHTML = `
    <div class="card due-banner" id="dueBanner" hidden>
      <span id="dueBannerText"></span>
      <button type="button" id="dueBannerBtn">Review</button>
    </div>

    <div class="card">
      <div class="card-title">Add entry</div>
      <div id="addFields"></div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" id="addSaveBtn">Save</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">This month</div>
      <div class="month-strip" id="monthStrip"></div>
    </div>

    <div class="card">
      <div class="card-title">Recent <button type="button" class="see-all" id="seeAllBtn">See all ›</button></div>
      <div class="recent-list" id="recentList"></div>
    </div>
  `;

  fieldsRoot = $('#addFields', root);
  mountFields();

  $('#addSaveBtn', root).addEventListener('click', onSave);
  $('#dueBannerBtn', root).addEventListener('click', async () => {
    await openDueReview();
    refreshDueBanner();
  });
  $('#seeAllBtn', root).addEventListener('click', () => app.navigate('history'));
}

function mountFields(preferType) {
  const type = preferType || (fields ? fields.getType() : undefined);
  fields = buildEntryFields(fieldsRoot, type ? { type } : {});
  fields.ready().then(() => {
    const saveBtn = root && $('#addSaveBtn', root);
    if (saveBtn) saveBtn.disabled = !fields.hasCategories();
  });
}

async function onSave() {
  if (!fields.validate()) return;
  const v = fields.getValue();
  if (!v || !v.category) return;
  const saveBtn = $('#addSaveBtn', root);
  saveBtn.disabled = true;
  try {
    const entry = await saveEntry(v);
    fields.rememberCategory();
    const keepType = fields.getType();
    mountFields(keepType);
    fields.focus();
    toast('Saved', { label: 'Undo', onClick: () => deleteEntry(entry.id) });
  } catch (err) {
    toast('Could not save: ' + (err?.message || err));
  } finally {
    saveBtn.disabled = false;
  }
}

async function refreshDueBanner() {
  const banner = $('#dueBanner', root);
  if (!banner) return;
  const n = await countDue();
  banner.hidden = n <= 0;
  if (n > 0) $('#dueBannerText', root).textContent = `${n} recurring item${n === 1 ? '' : 's'} due`;
}

async function refreshMonthStrip() {
  const strip = $('#monthStrip', root);
  if (!strip) return;
  const mk = monthKey(todayStr());
  const entries = await listEntries();
  let spent = 0, income = 0;
  for (const e of entries) {
    if (monthKey(e.date) !== mk) continue;
    if (e.type === 'Expense') spent += Number(e.amount) || 0;
    else income += Number(e.amount) || 0;
  }
  const setup = await getSetup();
  const budgetTotal = (setup.expenseCategories || []).reduce((s, c) => s + (Number(c.budget) || 0), 0);

  strip.innerHTML = `
    <div class="tile">
      <div class="n amt-expense">${fmtMoney(spent)}</div>
      <div class="lbl">Spent</div>
      ${budgetTotal > 0 ? `<div class="of-budget">of ${fmtMoney(budgetTotal)} budget</div>` : ''}
    </div>
    <div class="tile">
      <div class="n amt-income">${fmtMoney(income)}</div>
      <div class="lbl">Income</div>
    </div>
  `;
}

async function refreshRecent() {
  const list = $('#recentList', root);
  if (!list) return;
  const entries = (await listEntries()).slice(0, 5);
  if (!entries.length) {
    list.innerHTML = `<div class="empty">No entries yet. Add your first one above.</div>`;
    return;
  }
  list.innerHTML = entries.map((e) => `
    <button type="button" class="recent-row" data-id="${esc(e.id)}">
      <div class="meta">
        <div class="cat">${esc(e.category)}</div>
        <div class="desc">${esc(e.description || '')}</div>
      </div>
      <div>
        <div class="amt ${e.type === 'Income' ? 'amt-income' : 'amt-expense'}">${e.type === 'Income' ? '+' : '−'}${fmtMoney(e.amount)}</div>
        <div class="date">${fmtDate(e.date)}</div>
      </div>
    </button>
  `).join('');
  list.querySelectorAll('.recent-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const entry = entries.find((e) => e.id === row.dataset.id);
      if (entry) await openEntryEditor(entry);
    });
  });
}

async function refreshAll() {
  await Promise.all([refreshDueBanner(), refreshMonthStrip(), refreshRecent(), fields?.refreshCategories()]);
  const saveBtn = $('#addSaveBtn', root);
  if (saveBtn && fields) saveBtn.disabled = !fields.hasCategories();
}

export default {
  title: 'Add',
  mount(r, a) {
    app = a;
    root = r;
    render(root);
    refreshAll();
  },
  show() { refreshAll(); },
  refresh() { refreshAll(); },
};
