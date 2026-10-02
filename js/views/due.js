// "Review due recurring" bottom sheet, opened from the Setup tab's recurring
// card (and, per the view contract, from the Add tab's due banner).

import { getSetup, listEntries, addEntries, bumpWatermark } from '../store.js';
import { dueItems } from '../recurring.js';
import { fmtDate, fmtMoney, esc, toast } from '../util.js';

/** Number of recurring occurrences that have come due and aren't posted yet. */
export async function countDue() {
  return dueItems(await getSetup(), await listEntries({ includeDeleted: true })).length;
}

// --------------------------------------------------------------- sheet host

let activeSheet = null; // { backdrop, onKey, onPop }

function closeSheet(fromPopstate) {
  if (!activeSheet) return;
  const { backdrop, onKey, onPop, onClose } = activeSheet;
  activeSheet = null;
  backdrop.classList.remove('open');
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('popstate', onPop);
  setTimeout(() => backdrop.remove(), 200);
  if (!fromPopstate) { try { history.back(); } catch {} }
  if (onClose) onClose();
}

function openSheet(render, onClose) {
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
  activeSheet = { backdrop, onKey, onPop, onClose };
  requestAnimationFrame(() => backdrop.classList.add('open'));
  render(sheetEl);
}

// -------------------------------------------------------------------- sheet

/** Open the "Review due recurring" sheet. Resolves to the number posted. */
export async function openDueReview() {
  const setup = await getSetup();
  const entries = await listEntries({ includeDeleted: true });
  const items = dueItems(setup, entries);
  if (!items.length) { toast('Nothing due right now.'); return 0; }

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (n) => { if (resolved) return; resolved = true; resolve(n); };
    const checks = items.map(() => true);

    const computeTotal = () => items.reduce((s, it, i) => (checks[i] ? s + (it.type === 'Income' ? it.amount : -it.amount) : s), 0);
    const selectedCount = () => checks.filter(Boolean).length;

    openSheet((sheet) => {
      sheet.innerHTML = `
        <div class="sheet-head">
          <h2>Review due recurring</h2>
          <button class="icon-btn" type="button" data-close aria-label="Close">&#x2715;</button>
        </div>
        <div class="hint">Unticked items are skipped and will not be offered again.</div>
        <div class="due-list" id="dueList"></div>
        <div class="due-total" id="dueTotal"></div>
        <div class="btn-row">
          <button class="btn btn-secondary" type="button" id="notNowBtn">Not now</button>
          <button class="btn btn-primary" type="button" id="postBtn">Post</button>
        </div>
      `;
      const listEl = sheet.querySelector('#dueList');
      const totalEl = sheet.querySelector('#dueTotal');
      const postBtn = sheet.querySelector('#postBtn');

      listEl.innerHTML = items.map((it, i) => `
        <label class="due-row">
          <input type="checkbox" data-index="${i}" checked>
          <span class="due-row-main">
            <span class="due-row-top">
              <span>${esc(it.category)}</span>
              <span class="${it.type === 'Income' ? 'amt-income' : 'amt-expense'}">${it.type === 'Income' ? '+' : '−'}${fmtMoney(it.amount)}</span>
            </span>
            <span class="due-row-sub muted">${fmtDate(it.date)} · ${esc(it.type)}${it.description ? ' · ' + esc(it.description) : ''}</span>
          </span>
        </label>`).join('');

      function refreshFooter() {
        totalEl.textContent = `Net total: ${fmtMoney(computeTotal())}`;
        const n = selectedCount();
        postBtn.textContent = `Post ${n} selected`;
        postBtn.disabled = n === 0;
      }
      refreshFooter();

      listEl.addEventListener('change', (e) => {
        const cb = e.target.closest('input[type="checkbox"]');
        if (!cb) return;
        checks[Number(cb.dataset.index)] = cb.checked;
        refreshFooter();
      });

      sheet.querySelector('#notNowBtn').addEventListener('click', () => closeSheet());

      postBtn.addEventListener('click', async () => {
        postBtn.disabled = true;
        const toPost = items.filter((_, i) => checks[i]).map((it) => ({
          id: it.id, type: it.type, date: it.date, category: it.category, amount: it.amount, description: it.description,
        }));
        if (toPost.length) await addEntries(toPost);
        // Bump the watermark for every rule seen in this review — posted or
        // skipped — so a skipped occurrence is never offered again.
        const byRule = {};
        for (const it of items) { if (!byRule[it.ruleId] || byRule[it.ruleId] < it.date) byRule[it.ruleId] = it.date; }
        for (const ruleId of Object.keys(byRule)) await bumpWatermark(ruleId, byRule[ruleId]);
        toast(`Posted ${toPost.length} of ${items.length} due item(s).`);
        finish(toPost.length);
        closeSheet();
      });
    }, () => finish(0));
  });
}
