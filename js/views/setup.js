// Setup tab: expense categories & budgets, income sources & targets, groups
// (read-only), and recurring transactions. Every edit saves immediately via
// saveSetup() — there is no global Save button.

import { getSetup, saveSetup, listEntries, categoryNames, LIMITS, FREQUENCIES } from '../store.js';
import { dueItems, ruleProblem, nextOccurrence, occurrences } from '../recurring.js';
import { fmtDate, fmtMoney, parseAmount, shortId, esc, toast, todayStr, addDays, strToDate } from '../util.js';
import { openDueReview } from './due.js';

let setup = null;
let entries = [];
let due = [];
let rootEl = null;

// --------------------------------------------------------------- sheet host

let activeSheet = null; // { backdrop, onKey, onPop }

function closeSheet(fromPopstate) {
  if (!activeSheet) return;
  const { backdrop, onKey, onPop } = activeSheet;
  activeSheet = null;
  backdrop.classList.remove('open');
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('popstate', onPop);
  setTimeout(() => backdrop.remove(), 200);
  if (!fromPopstate) { try { history.back(); } catch {} }
}

function openSheet(render) {
  if (activeSheet) closeSheet(true);
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheetEl = document.createElement('div');
  sheetEl.className = 'sheet';
  sheetEl.setAttribute('role', 'dialog');
  sheetEl.setAttribute('aria-modal', 'true');
  backdrop.appendChild(sheetEl);
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === 'Escape') closeSheet(); };
  const onPop = () => closeSheet(true);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-close]')) closeSheet(); });
  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', onPop);
  history.pushState({ etkSheet: true }, '');
  activeSheet = { backdrop, onKey, onPop };
  requestAnimationFrame(() => backdrop.classList.add('open'));
  render(sheetEl);
}

// -------------------------------------------------------------------- data

async function loadAndRender() {
  setup = await getSetup();
  entries = await listEntries({ includeDeleted: true });
  due = dueItems(setup, entries);
  if (rootEl) rootEl.innerHTML = renderView();
}

function sumField(list, field) {
  return list.reduce((s, x) => s + (x[field] ? Number(x[field]) : 0), 0);
}

function dayLabel(r) {
  const weekly = r.frequency === 'Weekly' || r.frequency === 'Fortnightly';
  if (weekly) {
    const names = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    let d = Number(r.day);
    if (!(d >= 1 && d <= 7)) {
      const sd = strToDate(r.start);
      d = sd ? (sd.getDay() === 0 ? 7 : sd.getDay()) : 1;
    }
    return names[d];
  }
  const d = Number(r.day);
  return d >= 1 && d <= 31 ? `day ${d}` : 'same as start date';
}

function nextOccurrencesPreview(rule, n) {
  if (ruleProblem(rule)) return [];
  const today = todayStr();
  const from = addDays(today, 1);
  const horizon = addDays(today, 3650);
  const to = rule.end && rule.end < horizon ? rule.end : horizon;
  return occurrences(rule, from, to).slice(0, n);
}

function backfillCount(rule) {
  if (ruleProblem(rule)) return 0;
  const today = todayStr();
  const from = rule.lastPosted ? addDays(rule.lastPosted, 1) : rule.start;
  const to = rule.end && rule.end < today ? rule.end : today;
  return occurrences(rule, from, to).length;
}

// ------------------------------------------------------------------ render

function renderView() {
  return `
    ${renderEntityCard('expense')}
    ${renderEntityCard('income')}
    ${renderGroupsCard()}
    ${renderRecurringCard()}
    <div class="hint setup-footer-hint">Changes are stored on this phone and reach the sheet's Setup tab on the next Sync — the sync pill in the header shows how many changes are waiting.</div>
  `;
}

function renderEntityCard(kind) {
  const isIncome = kind === 'income';
  const list = isIncome ? setup.incomeSources : setup.expenseCategories;
  const limit = isIncome ? LIMITS.incomeSources : LIMITS.expenseCategories;
  const atLimit = list.length >= limit;
  const amountField = isIncome ? 'target' : 'budget';
  const total = sumField(list, amountField);
  const rows = list.map((item, i) => `
    <div class="setup-row">
      <button class="setup-row-main" type="button" data-action="edit-${kind}" data-index="${i}" aria-label="Edit ${esc(item.name)}">
        <span class="setup-row-name">${esc(item.name)}</span>
        <span class="setup-row-meta">${isIncome ? '' : esc(item.group) + ' · '}${item[amountField] ? fmtMoney(item[amountField]) : 'No ' + (isIncome ? 'target' : 'budget')}</span>
      </button>
      <span class="setup-row-actions">
        <button type="button" class="row-move" data-action="${kind}-up" data-index="${i}" aria-label="Move ${esc(item.name)} up" ${i === 0 ? 'disabled' : ''}>&#x25B2;</button>
        <button type="button" class="row-move" data-action="${kind}-down" data-index="${i}" aria-label="Move ${esc(item.name)} down" ${i === list.length - 1 ? 'disabled' : ''}>&#x25BC;</button>
      </span>
    </div>`).join('');

  return `
    <div class="card">
      <div class="card-title">${isIncome ? 'Income sources &amp; targets' : 'Expense categories &amp; budgets'}<span class="sub">${list.length}/${limit}</span></div>
      ${rows || `<div class="empty">No ${isIncome ? 'income sources' : 'expense categories'} yet.</div>`}
      <div class="setup-total"><span>Total monthly ${isIncome ? 'target' : 'budget'}</span><strong>${fmtMoney(total)}</strong></div>
      <button class="btn btn-secondary btn-sm" type="button" data-action="add-${kind}" ${atLimit ? 'disabled' : ''}>+ Add ${isIncome ? 'income source' : 'category'}</button>
      ${atLimit ? `<div class="hint">Limit of ${limit} reached.</div>` : ''}
    </div>`;
}

function renderGroupsCard() {
  const chips = setup.groups.map((g) => `<span class="chip">${esc(g)}</span>`).join('');
  return `
    <div class="card">
      <div class="card-title">Groups</div>
      <div class="groups-chips">${chips}</div>
      <div class="hint">Groups are managed on the Google Sheet's Setup tab and shown here read-only.</div>
    </div>`;
}

function renderRecurringCard() {
  const atLimit = setup.rules.length >= LIMITS.rules;
  const banner = due.length ? `<button type="button" class="due-banner" data-action="review-due">${due.length} due · Review</button>` : '';
  const cards = setup.rules.map((r, i) => renderRuleCard(r, i)).join('');
  return `
    <div class="card">
      <div class="card-title">Recurring transactions<span class="sub">${setup.rules.length}/${LIMITS.rules}</span></div>
      ${banner}
      ${cards || '<div class="empty">No recurring rules yet.</div>'}
      <button class="btn btn-secondary btn-sm" type="button" data-action="add-rule" ${atLimit ? 'disabled' : ''}>+ Add recurring</button>
      ${atLimit ? `<div class="hint">Limit of ${LIMITS.rules} recurring rules reached.</div>` : ''}
      <div class="hint">Due items are posted when you review them here (tap Review), or automatically by the sheet's daily trigger if you have enabled one. An item can never be posted twice.</div>
    </div>`;
}

function renderRuleCard(r, i) {
  const problem = ruleProblem(r);
  const next = nextOccurrence(r);
  return `
    <div class="rule-card">
      <button class="rule-card-main" type="button" data-action="edit-rule" data-index="${i}" aria-label="Edit recurring rule for ${esc(r.category || 'rule')}">
        <div class="rule-card-top">
          <span>${esc(r.category || 'Untitled rule')}</span>
          <span class="${r.type === 'Income' ? 'amt-income' : 'amt-expense'}">${fmtMoney(r.amount)}</span>
        </div>
        <div class="rule-card-line muted">${esc(r.frequency || '')}${r.frequency ? ' · ' + esc(dayLabel(r)) : ''}</div>
        <div class="rule-card-line muted">Next: ${next ? fmtDate(next) : '—'} · Last posted: ${r.lastPosted ? fmtDate(r.lastPosted) : 'Never'}</div>
        ${r.description ? `<div class="rule-card-line muted">${esc(r.description)}</div>` : ''}
        ${problem ? `<div class="rule-warn">${esc(problem)}</div>` : ''}
      </button>
      <label class="switch" aria-label="${esc(r.category || 'Rule')} active">
        <input type="checkbox" role="switch" data-action="toggle-rule-active" data-index="${i}" ${r.active ? 'checked' : ''}>
        <span class="switch-track" aria-hidden="true"></span>
      </label>
    </div>`;
}

// --------------------------------------------------------------- entity CRUD

function openEntityEditor(kind, index) {
  const isIncome = kind === 'income';
  const list = isIncome ? setup.incomeSources : setup.expenseCategories;
  const limit = isIncome ? LIMITS.incomeSources : LIMITS.expenseCategories;
  const isNew = index == null;
  const amountField = isIncome ? 'target' : 'budget';
  const item = isNew ? { name: '', group: setup.groups[0] || '', budget: null, target: null } : list[index];

  openSheet((sheet) => {
    sheet.innerHTML = `
      <div class="sheet-head">
        <h2>${isNew ? 'Add' : 'Edit'} ${isIncome ? 'income source' : 'expense category'}</h2>
        <button class="icon-btn" type="button" data-close aria-label="Close">&#x2715;</button>
      </div>
      <label for="entName">Name</label>
      <input id="entName" maxlength="40" value="${esc(item.name)}" placeholder="e.g. ${isIncome ? 'Salary' : 'Food'}">
      ${!isIncome ? `
      <label for="entGroup">Group</label>
      <select id="entGroup">${setup.groups.map((g) => `<option value="${esc(g)}" ${item.group === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>` : ''}
      <label for="entAmount">Monthly ${isIncome ? 'target' : 'budget'} (optional)</label>
      <input id="entAmount" inputmode="decimal" placeholder="Leave blank for none" value="${item[amountField] ? item[amountField] : ''}">
      <div class="field-error" id="entError"></div>
      <div class="btn-row">
        ${!isNew ? '<button class="btn btn-danger" type="button" id="entDeleteBtn">Delete</button>' : ''}
        <button class="btn btn-primary" type="button" id="entSaveBtn">Save</button>
      </div>
    `;
    const q = (sel) => sheet.querySelector(sel);
    const errEl = q('#entError');

    q('#entSaveBtn').addEventListener('click', async () => {
      errEl.textContent = '';
      const name = q('#entName').value.trim();
      if (!name) { errEl.textContent = 'Name is required.'; return; }
      if (name.length > 40) { errEl.textContent = 'Name must be 40 characters or fewer.'; return; }
      const dup = list.some((x, i) => i !== index && x.name.toLowerCase() === name.toLowerCase());
      if (dup) { errEl.textContent = 'That name is already used.'; return; }
      const rawAmt = q('#entAmount').value.trim();
      let amt = null;
      if (rawAmt) {
        amt = parseAmount(rawAmt);
        if (amt == null) { errEl.textContent = 'Enter a valid amount above 0, or leave it blank.'; return; }
      }
      const group = !isIncome ? q('#entGroup').value : undefined;

      const newSetup = structuredClone(setup);
      const newList = isIncome ? newSetup.incomeSources : newSetup.expenseCategories;
      const renames = [];
      if (isNew) {
        if (newList.length >= limit) { errEl.textContent = `Limit of ${limit} reached.`; return; }
        newList.push(isIncome ? { name, target: amt } : { name, group, budget: amt });
      } else {
        const old = newList[index];
        if (old.name !== name) renames.push({ type: isIncome ? 'Income' : 'Expense', from: old.name, to: name });
        newList[index] = isIncome ? { name, target: amt } : { name, group, budget: amt };
      }
      if (renames.length) {
        for (const r of newSetup.rules) for (const rn of renames) if (r.type === rn.type && r.category === rn.from) r.category = rn.to;
      }
      await saveSetup(newSetup, renames);
      toast('Saved.');
      closeSheet();
      await loadAndRender();
    });

    if (!isNew) {
      q('#entDeleteBtn').addEventListener('click', async () => {
        const type = isIncome ? 'Income' : 'Expense';
        const usedEntries = entries.filter((e) => !e.deleted && e.type === type && e.category === item.name).length;
        const usedRules = setup.rules.filter((r) => r.type === type && r.category === item.name).length;
        const parts = [];
        if (usedEntries) parts.push(`${usedEntries} ${usedEntries === 1 ? 'entry uses' : 'entries use'} "${item.name}"`);
        if (usedRules) parts.push(`${usedRules} recurring rule${usedRules === 1 ? '' : 's'} reference${usedRules === 1 ? 's' : ''} it`);
        const msg = parts.length
          ? `${parts.join(' and ')} — they will keep the name, but it will not be offered in dropdowns anymore. Delete anyway?`
          : `Delete "${item.name}"?`;
        if (!confirm(msg)) return;
        const newSetup = structuredClone(setup);
        const newList = isIncome ? newSetup.incomeSources : newSetup.expenseCategories;
        newList.splice(index, 1);
        await saveSetup(newSetup);
        toast('Deleted.');
        closeSheet();
        await loadAndRender();
      });
    }
  });
}

async function moveEntity(kind, index, dir) {
  const isIncome = kind === 'income';
  const newSetup = structuredClone(setup);
  const list = isIncome ? newSetup.incomeSources : newSetup.expenseCategories;
  const j = index + dir;
  if (j < 0 || j >= list.length) return;
  [list[index], list[j]] = [list[j], list[index]];
  await saveSetup(newSetup);
  await loadAndRender();
}

// ----------------------------------------------------------------- rule CRUD

function openRuleEditor(index) {
  const isNew = index == null;
  const base = isNew
    ? { id: shortId(), type: 'Expense', category: categoryNames(setup, 'Expense')[0] || '', amount: '', frequency: 'Monthly', day: '', start: todayStr(), end: '', description: '', active: true, lastPosted: '' }
    : { ...setup.rules[index] };

  openSheet((sheet) => {
    let curType = base.type === 'Income' ? 'Income' : 'Expense';

    const weekdayOptions = () => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n, i) => `<option value="${i + 1}">${n}</option>`).join('');
    const domOptions = () => {
      let out = '<option value="">Same as start date</option>';
      for (let d = 1; d <= 31; d++) out += `<option value="${d}">${d}</option>`;
      return out;
    };
    const categoryOptions = (type) => {
      const names = categoryNames(setup, type);
      if (!names.length) return '<option value="">No categories yet</option>';
      return names.map((n) => `<option value="${esc(n)}" ${n === base.category ? 'selected' : ''}>${esc(n)}</option>`).join('');
    };

    sheet.innerHTML = `
      <div class="sheet-head">
        <h2>${isNew ? 'Add recurring' : 'Edit recurring'}</h2>
        <button class="icon-btn" type="button" data-close aria-label="Close">&#x2715;</button>
      </div>
      <div class="seg" role="group" aria-label="Type">
        <button type="button" data-type="Expense" aria-pressed="${curType === 'Expense'}">Expense</button>
        <button type="button" data-type="Income" aria-pressed="${curType === 'Income'}">Income</button>
      </div>
      <label for="ruleCategory">Category</label>
      <select id="ruleCategory">${categoryOptions(curType)}</select>
      <label for="ruleAmount">Amount</label>
      <input id="ruleAmount" inputmode="decimal" placeholder="0.00" value="${base.amount || ''}">
      <label for="ruleFrequency">Frequency</label>
      <select id="ruleFrequency">${FREQUENCIES.map((f) => `<option value="${f}" ${base.frequency === f ? 'selected' : ''}>${f}</option>`).join('')}</select>
      <div id="dayWeeklyField" hidden>
        <label for="ruleDayWeekly">Day of week</label>
        <select id="ruleDayWeekly">${weekdayOptions()}</select>
      </div>
      <div id="dayMonthlyField">
        <label for="ruleDayMonthly">Day of month</label>
        <select id="ruleDayMonthly">${domOptions()}</select>
      </div>
      <label for="ruleStart">Start date</label>
      <input id="ruleStart" type="date" value="${base.start || ''}">
      <div class="hint" id="ruleStartDisplay"></div>
      <label for="ruleEnd">End date (optional)</label>
      <input id="ruleEnd" type="date" value="${base.end || ''}">
      <button type="button" class="btn btn-secondary btn-sm" id="ruleEndClearBtn">Clear end date</button>
      <label for="ruleDescription">Description (optional)</label>
      <input id="ruleDescription" maxlength="60" value="${esc(base.description || '')}">
      <label class="switch-row">
        <span>Active</span>
        <span class="switch">
          <input type="checkbox" id="ruleActive" role="switch" ${base.active !== false ? 'checked' : ''}>
          <span class="switch-track" aria-hidden="true"></span>
        </span>
      </label>
      <div class="rule-preview" id="rulePreview"></div>
      <div class="field-error" id="ruleError"></div>
      <div class="btn-row">
        ${!isNew ? '<button class="btn btn-danger" type="button" id="ruleDeleteBtn">Delete</button>' : ''}
        <button class="btn btn-primary" type="button" id="ruleSaveBtn">Save</button>
      </div>
    `;

    const q = (sel) => sheet.querySelector(sel);
    const typeButtons = sheet.querySelectorAll('[data-type]');
    const categorySelect = q('#ruleCategory');
    const amountInput = q('#ruleAmount');
    const freqSelect = q('#ruleFrequency');
    const dayWeeklyField = q('#dayWeeklyField');
    const dayWeeklySelect = q('#ruleDayWeekly');
    const dayMonthlyField = q('#dayMonthlyField');
    const dayMonthlySelect = q('#ruleDayMonthly');
    const startInput = q('#ruleStart');
    const startDisplay = q('#ruleStartDisplay');
    const endInput = q('#ruleEnd');
    const descInput = q('#ruleDescription');
    const activeInput = q('#ruleActive');
    const preview = q('#rulePreview');
    const errEl = q('#ruleError');
    const saveBtn = q('#ruleSaveBtn');

    const isWeeklyFreq = (f) => f === 'Weekly' || f === 'Fortnightly';
    const startWeekday = () => { const d = strToDate(startInput.value); return d ? (d.getDay() === 0 ? 7 : d.getDay()) : 1; };

    const initialDay = Number(base.day);
    if (isWeeklyFreq(base.frequency)) dayWeeklySelect.value = String(initialDay >= 1 && initialDay <= 7 ? initialDay : startWeekday());
    else dayMonthlySelect.value = initialDay >= 1 && initialDay <= 31 ? String(initialDay) : '';

    function syncDayFieldVisibility() {
      const weekly = isWeeklyFreq(freqSelect.value);
      dayWeeklyField.hidden = !weekly;
      dayMonthlyField.hidden = weekly;
      if (weekly && !dayWeeklySelect.value) dayWeeklySelect.value = String(startWeekday());
    }
    syncDayFieldVisibility();

    function readCandidate() {
      const weekly = isWeeklyFreq(freqSelect.value);
      return {
        id: base.id,
        type: curType,
        category: categorySelect.value,
        amount: parseAmount(amountInput.value) ?? NaN,
        frequency: freqSelect.value,
        day: weekly ? Number(dayWeeklySelect.value) : (dayMonthlySelect.value === '' ? null : Number(dayMonthlySelect.value)),
        start: startInput.value,
        end: endInput.value || '',
        description: descInput.value.trim(),
        active: activeInput.checked,
        lastPosted: base.lastPosted || '',
      };
    }

    function updatePreview() {
      startDisplay.textContent = startInput.value ? ('Starts ' + fmtDate(startInput.value)) : '';
      const candidate = readCandidate();
      const problem = ruleProblem(candidate);
      if (problem) {
        preview.textContent = problem;
      } else {
        const next3 = nextOccurrencesPreview(candidate, 3).map(fmtDate);
        let text = next3.length ? ('Next 3: ' + next3.join(', ')) : 'No upcoming occurrences before the end date.';
        const backfill = backfillCount(candidate);
        if (candidate.start < todayStr() && backfill > 0) text += ` Will back-fill ${backfill} past occurrence${backfill === 1 ? '' : 's'} when you review.`;
        preview.textContent = text;
      }
    }

    typeButtons.forEach((b) => b.addEventListener('click', () => {
      curType = b.dataset.type;
      typeButtons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      categorySelect.innerHTML = categoryOptions(curType);
      updatePreview();
    }));
    [categorySelect, amountInput].forEach((el) => el.addEventListener('input', updatePreview));
    [categorySelect, amountInput].forEach((el) => el.addEventListener('change', updatePreview));
    freqSelect.addEventListener('change', () => { syncDayFieldVisibility(); updatePreview(); });
    [dayWeeklySelect, dayMonthlySelect].forEach((el) => el.addEventListener('change', updatePreview));
    startInput.addEventListener('change', () => { syncDayFieldVisibility(); updatePreview(); });
    endInput.addEventListener('change', updatePreview);
    descInput.addEventListener('input', updatePreview);
    q('#ruleEndClearBtn').addEventListener('click', () => { endInput.value = ''; updatePreview(); });

    updatePreview();

    saveBtn.addEventListener('click', async () => {
      const candidate = readCandidate();
      const problem = ruleProblem(candidate);
      if (problem) { errEl.textContent = problem; return; }
      errEl.textContent = '';
      const newSetup = structuredClone(setup);
      if (isNew) {
        if (newSetup.rules.length >= LIMITS.rules) { errEl.textContent = `Limit of ${LIMITS.rules} recurring rules reached.`; return; }
        newSetup.rules.push(candidate);
      } else {
        newSetup.rules[index] = candidate;
      }
      await saveSetup(newSetup);
      toast('Recurring rule saved.');
      closeSheet();
      await loadAndRender();
    });

    if (!isNew) {
      q('#ruleDeleteBtn').addEventListener('click', async () => {
        if (!confirm(`Delete this recurring rule (${base.category || 'rule'})?`)) return;
        const newSetup = structuredClone(setup);
        newSetup.rules.splice(index, 1);
        await saveSetup(newSetup);
        toast('Recurring rule deleted.');
        closeSheet();
        await loadAndRender();
      });
    }
  });
}

// ---------------------------------------------------------------- delegation

async function onClick(e) {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  const idx = t.dataset.index !== undefined ? Number(t.dataset.index) : null;
  if (action === 'edit-expense') openEntityEditor('expense', idx);
  else if (action === 'add-expense') openEntityEditor('expense', null);
  else if (action === 'expense-up') await moveEntity('expense', idx, -1);
  else if (action === 'expense-down') await moveEntity('expense', idx, 1);
  else if (action === 'edit-income') openEntityEditor('income', idx);
  else if (action === 'add-income') openEntityEditor('income', null);
  else if (action === 'income-up') await moveEntity('income', idx, -1);
  else if (action === 'income-down') await moveEntity('income', idx, 1);
  else if (action === 'edit-rule') openRuleEditor(idx);
  else if (action === 'add-rule') openRuleEditor(null);
  else if (action === 'review-due') { await openDueReview(); await loadAndRender(); }
}

async function onChange(e) {
  const t = e.target.closest('[data-action="toggle-rule-active"]');
  if (!t) return;
  const idx = Number(t.dataset.index);
  const newSetup = structuredClone(setup);
  newSetup.rules[idx].active = t.checked;
  await saveSetup(newSetup);
  toast(t.checked ? 'Rule activated.' : 'Rule paused.');
  await loadAndRender();
}

// --------------------------------------------------------------------- view

export default {
  title: 'Setup',
  mount(root) {
    rootEl = root;
    root.innerHTML = '<div class="empty">Loading…</div>';
    root.addEventListener('click', (e) => { onClick(e); });
    root.addEventListener('change', (e) => { onChange(e); });
  },
  async show() { await loadAndRender(); },
  async refresh() { await loadAndRender(); },
};
