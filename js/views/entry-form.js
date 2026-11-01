// Entry form: a reusable field builder (used by both the Add view and this
// bottom-sheet editor) plus the editor itself.
//
//   buildEntryFields(container, initial) -> { getValue(), validate(), focus(), setType(type) }
//   openEntryEditor(entry, opts) -> Promise<'saved'|'deleted'|'cancelled'>

import { $, $$, esc, fmtDate, toast, todayStr, addDays, parseAmount } from '../util.js';
import { getSetup, categoryNames, saveEntry, deleteEntry, restoreEntry } from '../store.js';

const LAST_CATEGORY_KEY = 'etk.lastCategory';

function readLastCategory(type) {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_CATEGORY_KEY) || '{}');
    return raw[type] || null;
  } catch { return null; }
}
function writeLastCategory(type, category) {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_CATEGORY_KEY) || '{}');
    raw[type] = category;
    localStorage.setItem(LAST_CATEGORY_KEY, JSON.stringify(raw));
  } catch {}
}

/** Build the Type/Date/Category/Amount/Description fields inside `container`.
 *  `initial` = { type, date, category, amount, description } (all optional).
 *  Returns { getValue(), validate(), focus(), setType(type) }.
 *  `getValue()` returns null if invalid (after validate() has shown errors). */
let formSeq = 0;

export function buildEntryFields(container, initial = {}) {
  const type0 = initial.type === 'Income' ? 'Income' : 'Expense';
  const date0 = initial.date || todayStr();
  // The Add tab's form stays in the page while the editor sheet is open, so ids must differ per form.
  const p = `ef${++formSeq}`;

  container.innerHTML = `
    <div class="seg field-type" role="group" aria-label="Entry type">
      <button type="button" data-type="Expense" aria-pressed="${type0 === 'Expense'}">Expense</button>
      <button type="button" data-type="Income" aria-pressed="${type0 === 'Income'}">Income</button>
    </div>

    <label class="label" for="${p}-amount">Amount</label>
    <input id="${p}-amount" class="ef-amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${initial.amount != null ? esc(String(initial.amount)) : ''}">
    <div class="field-error ef-amount-error"></div>

    <div class="label">Date</div>
    <div class="date-row">
      <button type="button" class="chip date-btn ef-date-btn" aria-haspopup="true"></button>
      <button type="button" class="chip ef-date-today">Today</button>
      <button type="button" class="chip ef-date-yesterday">Yesterday</button>
      <input type="date" class="date-input ef-date-input" aria-label="Pick a date">
    </div>
    <div class="hint ef-date-hint" hidden>This date is in the future.</div>

    <label class="label" for="${p}-category">Category</label>
    <select id="${p}-category" class="ef-category"></select>
    <div class="hint ef-category-empty" hidden></div>

    <label class="label" for="${p}-description">Description <span class="muted">(optional)</span></label>
    <input id="${p}-description" class="ef-description" type="text" maxlength="200" autocomplete="off" placeholder="e.g. Groceries" value="${esc(initial.description || '')}">
  `;

  const typeSeg = $('.field-type', container);
  const amountInput = $('.ef-amount', container);
  const amountError = $('.ef-amount-error', container);
  const dateBtn = $('.ef-date-btn', container);
  const dateInput = $('.ef-date-input', container);
  const dateHint = $('.ef-date-hint', container);
  const todayBtn = $('.ef-date-today', container);
  const yestBtn = $('.ef-date-yesterday', container);
  const categorySelect = $('.ef-category', container);
  const categoryEmpty = $('.ef-category-empty', container);
  const descInput = $('.ef-description', container);

  let type = type0;
  let date = date0;
  let dateIsToday = !initial.date;   // "today" follows the calendar; a picked date stays put
  let setup = null;
  let firstPopulate = true; // use initial.category only the very first time

  function updateDateUI() {
    const isToday = date === todayStr();
    const isYest = date === addDays(todayStr(), -1);
    const label = isToday ? 'Today' : isYest ? 'Yesterday' : '';
    dateBtn.textContent = label ? `${label} · ${fmtDate(date)}` : fmtDate(date);
    dateInput.value = date;
    todayBtn.setAttribute('aria-pressed', String(isToday));
    yestBtn.setAttribute('aria-pressed', String(isYest));
    dateHint.hidden = date <= todayStr();
  }

  function setType(newType) {
    type = newType === 'Income' ? 'Income' : 'Expense';
    $$('button', typeSeg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === type)));
    populateCategories();
  }

  async function populateCategories() {
    if (!setup) setup = await getSetup();
    const names = categoryNames(setup, type);
    const useInitial = firstPopulate && initial.category && initial.type === type;
    firstPopulate = false;
    const currentlySelected = !categorySelect.hidden && categorySelect.value ? categorySelect.value : null;
    const wantCategory = useInitial ? initial.category
      : (currentlySelected && names.includes(currentlySelected)) ? currentlySelected
      : (readLastCategory(type) || names[0] || '');

    const opts = names.slice();
    let extra = null;
    if (useInitial && !opts.includes(initial.category)) {
      extra = initial.category;
      opts.push(extra);
    }

    if (!opts.length) {
      categorySelect.innerHTML = '';
      categorySelect.hidden = true;
      categoryEmpty.hidden = false;
      categoryEmpty.innerHTML = `No categories set up yet. <a href="#setup" class="ef-setup-link">Go to Setup</a>`;
      const link = $('.ef-setup-link', categoryEmpty);
      link?.addEventListener('click', (e) => {
        e.preventDefault();
        $('.tabbar [data-tab="setup"]')?.click();
      });
      return;
    }
    categorySelect.hidden = false;
    categoryEmpty.hidden = true;
    categorySelect.innerHTML = opts.map((n) => {
      const notInSetup = n === extra && !names.includes(n);
      return `<option value="${esc(n)}"${n === wantCategory ? ' selected' : ''}>${esc(n)}${notInSetup ? ' (not in Setup)' : ''}</option>`;
    }).join('');
    if (!opts.includes(wantCategory)) categorySelect.value = opts[0];
    else categorySelect.value = wantCategory;
  }

  typeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-type]');
    if (btn) setType(btn.dataset.type);
  });

  todayBtn.addEventListener('click', () => { date = todayStr(); dateIsToday = true; updateDateUI(); });
  yestBtn.addEventListener('click', () => { date = addDays(todayStr(), -1); dateIsToday = false; updateDateUI(); });

  function openPicker() {
    if (dateInput.showPicker) { try { dateInput.showPicker(); return; } catch {} }
    dateInput.focus();
    dateInput.click();
  }
  dateBtn.addEventListener('click', openPicker);
  dateInput.addEventListener('change', () => {
    if (dateInput.value) { date = dateInput.value; dateIsToday = date === todayStr(); updateDateUI(); }
  });

  amountInput.addEventListener('input', () => {
    if (amountError.textContent) validateAmount();
  });

  function validateAmount() {
    const v = parseAmount(amountInput.value);
    if (v === null && amountInput.value.trim() !== '') {
      amountError.textContent = 'Enter an amount greater than ₹0';
      amountInput.setAttribute('aria-invalid', 'true');
      return false;
    }
    if (v === null) {
      amountError.textContent = 'Enter an amount greater than ₹0';
      amountInput.setAttribute('aria-invalid', 'true');
      return false;
    }
    amountError.textContent = '';
    amountInput.removeAttribute('aria-invalid');
    return true;
  }

  updateDateUI();
  let ready = populateCategories();

  return {
    /** Resolves once the initial category list has loaded (async IndexedDB read). */
    ready: () => ready,
    getValue() {
      const amount = parseAmount(amountInput.value);
      if (amount === null) return null;
      return {
        type, date,
        category: categorySelect.value || '',
        amount,
        description: descInput.value.trim(),
      };
    },
    validate() {
      const amtOk = validateAmount();
      let catOk = true;
      if (!categorySelect.hidden && !categorySelect.value) catOk = false;
      return amtOk && catOk;
    },
    focus() { amountInput.focus(); },
    setType,
    getType: () => type,
    hasCategories: () => !categorySelect.hidden,
    rememberCategory() { writeLastCategory(type, categorySelect.value); },
    /** Re-fetch setup and refresh the category list (e.g. after Setup changed
     *  while this form stayed mounted). Preserves the current selection when
     *  it still exists. */
    async refreshCategories() { setup = null; ready = populateCategories(); await ready; },
    /** The form stayed open past midnight (a PWA resumed the next morning): move "today" on
     *  and re-label the chips. */
    refreshDate() {
      if (dateIsToday) date = todayStr();
      updateDateUI();
    },
  };
}

// --------------------------------------------------------------- the editor

let backdropEl = null;
let returnFocusEl = null;
let popStateHandler = null;
let pushedState = false;

function ensureBackdrop() {
  if (backdropEl) return backdropEl;
  backdropEl = document.createElement('div');
  backdropEl.className = 'sheet-backdrop';
  backdropEl.setAttribute('role', 'dialog');
  backdropEl.setAttribute('aria-modal', 'true');
  backdropEl.setAttribute('aria-labelledby', 'entrySheetTitle');
  backdropEl.innerHTML = `
    <div class="sheet">
      <div class="sheet-head">
        <h2 id="entrySheetTitle">Edit</h2>
        <button class="icon-btn" type="button" data-close aria-label="Close">&#x2715;</button>
      </div>
      <div id="entrySheetFields"></div>
      <div class="btn-row" id="entrySheetButtons"></div>
    </div>
  `;
  document.body.appendChild(backdropEl);
  return backdropEl;
}

/** Open the bottom-sheet editor. `entry` = existing entry to edit, or null to
 *  create (opts.type preselects Expense/Income). Resolves to 'saved' |
 *  'deleted' | 'cancelled'. */
export async function openEntryEditor(entry, opts = {}) {
  const el = ensureBackdrop();
  const isNew = !entry;
  const title = isNew ? 'New entry' : entry.type === 'Income' ? 'Edit income' : 'Edit expense';
  $('#entrySheetTitle', el).textContent = title;

  const fieldsRoot = $('#entrySheetFields', el);
  const buttonsRoot = $('#entrySheetButtons', el);

  const initial = entry
    ? { type: entry.type, date: entry.date, category: entry.category, amount: entry.amount, description: entry.description }
    : { type: opts.type === 'Income' ? 'Income' : 'Expense', date: opts.date };

  const fields = buildEntryFields(fieldsRoot, initial);

  returnFocusEl = document.activeElement;

  let resolveFn;
  const result = new Promise((resolve) => { resolveFn = resolve; });

  function cleanup() {
    el.classList.remove('open');
    document.removeEventListener('keydown', onKeydown);
    if (popStateHandler) { window.removeEventListener('popstate', popStateHandler); popStateHandler = null; }
    if (pushedState) { pushedState = false; try { history.back(); } catch {} }
    if (returnFocusEl && returnFocusEl.focus) { try { returnFocusEl.focus(); } catch {} }
  }

  function finish(outcome) {
    cleanup();
    resolveFn(outcome);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') finish('cancelled');
  }

  function showNormalButtons() {
    buttonsRoot.innerHTML = `
      ${!isNew ? '<button type="button" class="btn btn-danger" id="ef-delete">Delete</button>' : ''}
      <button type="button" class="btn btn-secondary" id="ef-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="ef-save">Save</button>
    `;
    if (!fields.hasCategories()) $('#ef-save', buttonsRoot).disabled = true;

    $('#ef-cancel', buttonsRoot).onclick = () => finish('cancelled');
    $('#ef-save', buttonsRoot).onclick = async () => {
      if (!fields.validate()) return;
      const v = fields.getValue();
      if (!v || !v.category) return;
      try {
        await saveEntry({ id: entry ? entry.id : undefined, ...v });
        fields.rememberCategory();
        finish('saved');
      } catch (err) {
        toast('Could not save: ' + (err?.message || err));
      }
    };
    const deleteBtn = $('#ef-delete', buttonsRoot);
    if (deleteBtn) deleteBtn.onclick = showDeleteConfirm;
  }

  function showDeleteConfirm() {
    buttonsRoot.innerHTML = `
      <div class="confirm-row">
        <span class="confirm-msg">Delete this entry?</span>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" id="ef-delete-no">Cancel</button>
        <button type="button" class="btn btn-danger" id="ef-delete-yes">Delete</button>
      </div>
    `;
    $('#ef-delete-no', buttonsRoot).onclick = showNormalButtons;
    $('#ef-delete-yes', buttonsRoot).onclick = async () => {
      let prev;
      try { prev = await deleteEntry(entry.id); }
      catch (err) { toast('Could not delete: ' + (err?.message || err)); return; }
      finish('deleted');
      if (prev) toast('Deleted', { label: 'Undo', onClick: () => restoreEntry(prev).catch((err) => toast('Could not undo: ' + (err?.message || err))) });
    };
  }

  showNormalButtons();
  fields.ready().then(() => {
    const saveBtn = $('#ef-save', buttonsRoot);
    if (saveBtn) saveBtn.disabled = !fields.hasCategories();
  });

  el.onclick = (e) => { if (e.target === el) finish('cancelled'); };
  $('[data-close]', el).onclick = () => finish('cancelled');

  document.addEventListener('keydown', onKeydown);
  popStateHandler = () => finish('cancelled');
  history.pushState({ entrySheet: true }, '');
  pushedState = true;
  window.addEventListener('popstate', popStateHandler);

  el.classList.add('open');
  setTimeout(() => fields.focus(), 30);

  return result;
}
