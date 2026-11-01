// "Review due recurring" bottom sheet, opened from the Setup tab's recurring
// card (and, per the view contract, from the Add tab's due banner).
//
// Each due occurrence ends in one of three ways:
//   Post   — ticked when you press "Post N selected" (the amount can be edited first,
//            for bills that differ from the rule's amount)
//   Later  — left unticked: nothing happens, it is offered again next time
//   Skip   — the explicit "Skip this one" button, after a confirmation: dropped for good
// Leaving an item unticked must never make it disappear, so the rule's watermark only
// advances over items that were posted or skipped, never past one that is still due.

import { getSetup, listEntries, addEntries, bumpWatermark, addSkips } from '../store.js';
import { dueItems, settledThrough } from '../recurring.js';
import { fmtDate, fmtMoney, parseAmount, esc, toast } from '../util.js';

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
  const all = dueItems(setup, entries);          // oldest first; what was due when the sheet opened
  if (!all.length) { toast('Nothing due right now.'); return 0; }

  return new Promise((resolve) => {
    let postedCount = 0;
    let resolved = false;
    const finish = (n) => { if (resolved) return; resolved = true; resolve(n); };

    // Still-open rows (a skipped one leaves the list). `text` is the editable amount.
    const rows = all.map((it) => ({ it, checked: true, text: it.amount.toFixed(2) }));
    const settled = new Set();                   // ids posted or skipped during this review

    /** Advance each rule's watermark over the items settled so far — and no further,
     *  so an item left for later stays due. */
    async function settleWatermarks() {
      const byRule = new Map();
      for (const it of all) { if (!byRule.has(it.ruleId)) byRule.set(it.ruleId, []); byRule.get(it.ruleId).push(it); }
      for (const [ruleId, items] of byRule) {
        const mark = settledThrough(items, settled);
        if (mark) await bumpWatermark(ruleId, mark);
      }
    }

    openSheet((sheet) => {
      sheet.innerHTML = `
        <div class="sheet-head">
          <h2>Review due recurring</h2>
          <button class="icon-btn" type="button" data-close aria-label="Close">&#x2715;</button>
        </div>
        <div class="hint">Ticked items are posted. Unticked items stay due, so you can post them later. Edit an amount if this month's bill differs. <b>Skip</b> drops one for good.</div>
        <div class="due-list" id="dueList"></div>
        <div class="due-total" id="dueTotal"></div>
        <div class="field-error" id="dueError" role="alert"></div>
        <div class="btn-row">
          <button class="btn btn-secondary" type="button" id="notNowBtn">Not now</button>
          <button class="btn btn-primary" type="button" id="postBtn">Post</button>
        </div>
      `;
      const listEl = sheet.querySelector('#dueList');
      const totalEl = sheet.querySelector('#dueTotal');
      const errEl = sheet.querySelector('#dueError');
      const postBtn = sheet.querySelector('#postBtn');

      // Rebuilt only when the set of rows changes (a skip) — never while typing an amount.
      function renderList() {
        listEl.innerHTML = rows.map((r, i) => {
          const it = r.it, income = it.type === 'Income';
          const what = `${it.category} due ${fmtDate(it.date)}`;
          return `
        <div class="due-row">
          <input type="checkbox" id="dueChk${i}" data-index="${i}" ${r.checked ? 'checked' : ''} aria-label="Post ${esc(what)}">
          <div class="due-row-main">
            <div class="due-row-top">
              <label for="dueChk${i}" class="due-row-name">${esc(it.category)}</label>
              <span class="due-amt-wrap ${income ? 'amt-income' : 'amt-expense'}">
                <span aria-hidden="true">${income ? '+' : '−'}₹</span>
                <input class="due-amt" type="text" inputmode="decimal" autocomplete="off" data-index="${i}" value="${esc(r.text)}" aria-label="Amount for ${esc(what)}">
              </span>
            </div>
            <div class="due-row-sub muted">${fmtDate(it.date)} · ${esc(it.type)}${it.description ? ' · ' + esc(it.description) : ''}</div>
            <div class="due-row-actions">
              <span class="due-was muted" data-was="${i}"></span>
              <button type="button" class="link-btn" data-skip="${i}" aria-label="Skip ${esc(what)}">Skip this one</button>
            </div>
          </div>
        </div>`;
        }).join('');
        rows.forEach((_, i) => refreshRow(i));
      }

      function refreshRow(i) {
        const r = rows[i];
        const amt = parseAmount(r.text);
        const input = listEl.querySelector(`.due-amt[data-index="${i}"]`);
        const was = listEl.querySelector(`[data-was="${i}"]`);
        if (input) input.setAttribute('aria-invalid', String(amt === null));
        if (was) was.textContent = amt !== null && amt !== r.it.amount ? `Rule amount ${fmtMoney(r.it.amount)}` : '';
      }

      function refreshFooter() {
        const picked = rows.filter((r) => r.checked);
        const bad = picked.filter((r) => parseAmount(r.text) === null).length;
        const net = picked.reduce((s, r) => { const a = parseAmount(r.text); return a === null ? s : s + (r.it.type === 'Income' ? a : -a); }, 0);
        const later = rows.length - picked.length;
        totalEl.textContent = `Net total: ${fmtMoney(net)}`;
        errEl.textContent = bad ? 'Enter an amount above 0 for every ticked item.' : (later ? `${later} unticked item${later === 1 ? '' : 's'} will stay due.` : '');
        errEl.style.color = bad ? '' : 'var(--muted)';
        postBtn.textContent = picked.length ? `Post ${picked.length} selected` : 'Nothing ticked';
        postBtn.disabled = picked.length === 0 || bad > 0;
      }

      renderList();
      refreshFooter();

      listEl.addEventListener('change', (e) => {
        const cb = e.target.closest('input[type="checkbox"]');
        if (!cb) return;
        rows[Number(cb.dataset.index)].checked = cb.checked;
        refreshFooter();
      });

      listEl.addEventListener('input', (e) => {
        const inp = e.target.closest('.due-amt');
        if (!inp) return;
        const i = Number(inp.dataset.index);
        rows[i].text = inp.value;
        refreshRow(i);
        refreshFooter();
      });

      listEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-skip]');
        if (!btn) return;
        const i = Number(btn.dataset.skip);
        const r = rows[i];
        if (!r) return;
        if (!confirm(`Skip ${r.it.category} for ${fmtDate(r.it.date)}? It will not be offered again.`)) return;
        btn.disabled = true;
        try {
          await addSkips([{ ruleId: r.it.ruleId, date: r.it.date }]);
          settled.add(r.it.id);
          await settleWatermarks();
        } catch (err) {
          toast('Could not skip: ' + (err?.message || err));
          btn.disabled = false;
          return;
        }
        rows.splice(i, 1);
        toast('Skipped.');
        if (!rows.length) { finish(postedCount); closeSheet(); return; }
        renderList();
        refreshFooter();
      });

      sheet.querySelector('#notNowBtn').addEventListener('click', () => closeSheet());

      postBtn.addEventListener('click', async () => {
        const toPost = rows.filter((r) => r.checked).map((r) => ({
          id: r.it.id, type: r.it.type, date: r.it.date, category: r.it.category, amount: parseAmount(r.text), description: r.it.description,
        }));
        if (!toPost.length || toPost.some((x) => x.amount === null)) return;
        postBtn.disabled = true;
        try {
          await addEntries(toPost);
          for (const x of toPost) settled.add(x.id);
          await settleWatermarks();
        } catch (err) {
          toast('Could not post: ' + (err?.message || err));
          postBtn.disabled = false;
          return;
        }
        postedCount = toPost.length;
        const left = rows.length - toPost.length;
        toast(left ? `Posted ${toPost.length}. ${left} still due.` : `Posted ${toPost.length} item${toPost.length === 1 ? '' : 's'}.`);
        finish(postedCount);
        closeSheet();
      });
    }, () => finish(postedCount));
  });
}
