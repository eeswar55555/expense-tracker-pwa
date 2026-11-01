// Settings > Advanced > "Revert to the sheet's version".
//
// Replaces everything on the phone with the sheet's latest copy. It is destructive on purpose,
// so it is hard to do by accident:
//   1. hidden behind the collapsed "Advanced" section of Settings;
//   2. confirmation 1 spells out exactly which unsynced changes will be lost (and offers to save
//      a copy of them first);
//   3. only then does the phone contact the sheet, and confirmation 2 shows what the sheet holds
//      and needs the word REVERT typed in;
//   4. the swap itself (sync.js: revertToCloud) is all-or-nothing and cancels if anything new
//      appeared on the phone after the user reviewed the list.
// The dialog ignores backdrop taps; it closes only through Cancel, Escape or Back, and while the
// phone is working it cannot be closed at all.

import { snapshotUnsynced } from './store.js';
import { peekCloud, revertToCloud, isConfigured } from './sync.js';
import { buildUnsyncedExport } from './cloud.js';
import { esc, fmtDate, toast } from './util.js';

let active = null;     // { backdrop, el, busy, reviewed, snap, cloud, onDone, onKey, onPop, returnFocus }
let opening = false;

/** True while the dialog is on screen (so Escape in Settings leaves it alone). */
export const isRevertOpen = () => !!active || opening;

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const $ = (id) => active && active.el.querySelector('#' + id);

function lossItems(c) {
  const li = [];
  if (c.added) li.push(`${plural(c.added, 'new entry', 'new entries')} that never reached the sheet`);
  if (c.edited) li.push(`${plural(c.edited, 'edit')} to existing entries`);
  if (c.deleted) li.push(`${plural(c.deleted, 'deletion')} you made`);
  if (c.setup) li.push('your changes on the Setup tab (categories, sources, groups, recurring rules)');
  if (c.choices) li.push(`${plural(c.choices, 'recurring choice')} (items you posted or skipped)`);
  if (c.rejected) li.push(`${c.rejected} of the entries above were already refused by the sheet`);
  return li;
}

// ------------------------------------------------------------------ shell

export async function openRevertFlow({ onDone } = {}) {
  if (active || opening) return;
  if (!isConfigured()) { toast('Connect your Google Sheet first — there is nothing to revert to.'); return; }
  opening = true;
  let snap;
  try {
    snap = await snapshotUnsynced();
  } catch (err) {
    opening = false;
    toast('Could not read this phone’s data: ' + (err && err.message ? err.message : err));
    return;
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop revert-backdrop';
  backdrop.style.zIndex = '25';                     // above Settings (20), below the toast (30)
  const el = document.createElement('div');
  el.className = 'sheet revert-sheet';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'rvTitle');
  backdrop.appendChild(el);
  document.body.appendChild(backdrop);

  const returnFocus = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape') { if (!active.busy) close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...el.querySelectorAll('button, input, summary')].filter((n) => !n.disabled);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  };
  const onPop = () => {
    if (active && active.busy) { try { history.pushState({ etkSheet: true }, ''); } catch {} return; }   // can't leave mid-swap
    close(true);
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', onPop);
  try { history.pushState({ etkSheet: true }, ''); } catch {}

  active = { backdrop, el, busy: false, reviewed: snap.tokens, snap, cloud: null, onDone, onKey, onPop, returnFocus };
  opening = false;
  renderReview();
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    // focus only works once the dialog is displayed; start on the safe choice
    const cancel = el.querySelector('#rvCancel');
    if (cancel && active && active.backdrop === backdrop) cancel.focus();
  });
}

function close(fromPopstate) {
  if (!active) return;
  const a = active;
  active = null;
  a.backdrop.classList.remove('open');
  document.removeEventListener('keydown', a.onKey);
  window.removeEventListener('popstate', a.onPop);
  setTimeout(() => a.backdrop.remove(), 200);
  if (!fromPopstate) { try { history.back(); } catch {} }
  if (a.returnFocus && a.returnFocus.isConnected && a.returnFocus.focus) { try { a.returnFocus.focus(); } catch {} }
}

function finish(message) {
  const onDone = active && active.onDone;
  close();
  if (onDone) { try { onDone(); } catch {} }
  toast(message);
}

function setStatus(msg, isErr) {
  const s = $('rvStatus');
  if (!s) return;
  s.textContent = msg || '';
  s.classList.toggle('err', !!isErr);
}

function setBusy(on, msg = '', isErr = false) {
  const a = active;
  if (!a) return;
  a.busy = on;
  a.el.setAttribute('aria-busy', String(on));
  a.el.querySelectorAll('button, input').forEach((n) => { n.disabled = on; });
  setStatus(msg, isErr);
  if (!on) { const go = $('rvGo'); if (go) go.disabled = !typedOk(); }
}

const typedOk = () => { const i = $('rvType'); return !!i && i.value.trim().toUpperCase() === 'REVERT'; };

// ------------------------------------------------- confirmation 1: what will be lost

function renderReview(notice = '') {
  const a = active;
  const c = a.snap.counts;
  a.el.innerHTML = `
    <div class="sheet-head"><h2 id="rvTitle">Revert to the sheet’s version?</h2></div>
    <p>This replaces everything on this phone with the latest copy in your Google Sheet. The sheet itself is not changed.</p>
    ${c.total
      ? `<div class="revert-lose"><strong>You will lose these changes, which have not reached the sheet:</strong>
           <ul>${lossItems(c).map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
         <button class="btn btn-secondary btn-sm revert-save" type="button" id="rvSave">Save a copy of these changes first</button>`
      : `<div class="revert-lose safe"><strong>Nothing will be lost.</strong>Everything on this phone has already reached the sheet.</div>`}
    <p class="hint">Your Web App URL and secret stay as they are.</p>
    <div class="revert-status" id="rvStatus" role="status" aria-live="polite"></div>
    <div class="btn-row">
      <button class="btn btn-secondary" type="button" id="rvCancel">Cancel</button>
      <button class="btn btn-danger" type="button" id="rvNext">Continue…</button>
    </div>`;
  setStatus(notice, !!notice);
  $('rvCancel').addEventListener('click', () => { if (!a.busy) close(); });
  $('rvNext').addEventListener('click', onContinue);
  const save = $('rvSave');
  if (save) save.addEventListener('click', saveCopy);
  $('rvCancel').focus();
}

async function saveCopy() {
  const a = active;
  setBusy(true, 'Preparing the file…');
  try {
    const fresh = await snapshotUnsynced();
    const data = buildUnsyncedExport(fresh);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const link = document.createElement('a');
    link.href = url;
    link.download = `expense-tracker-unsynced-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (active === a) setBusy(false, 'A copy was saved to your downloads.');
  } catch (err) {
    if (active === a) setBusy(false, 'Could not save a copy: ' + (err && err.message ? err.message : err), true);
  }
}

async function onContinue() {
  const a = active;
  if (!a || a.busy) return;
  setBusy(true, 'Checking this phone and contacting the sheet…');
  try {
    const snap = await snapshotUnsynced();
    const seen = new Set(a.reviewed);
    if (snap.tokens.some((t) => !seen.has(t))) {
      // something new appeared since the list was shown: the user has to see the new list
      a.snap = snap; a.reviewed = snap.tokens;
      setBusy(false);
      renderReview('Something changed on this phone while this window was open. Please read the list again.');
      return;
    }
    a.snap = snap;
    a.cloud = await peekCloud();                    // read-only; nothing on the phone changes yet
    setBusy(false);
    renderFinal();
  } catch (err) {
    setBusy(false, err && err.message ? err.message : String(err), true);
  }
}

// ----------------------------------------- confirmation 2: type REVERT, then apply

function renderFinal() {
  const a = active;
  const s = a.cloud, total = a.snap.counts.total;
  a.el.innerHTML = `
    <div class="sheet-head"><h2 id="rvTitle">Final confirmation</h2></div>
    <div class="revert-facts"><strong>The sheet currently holds</strong><br>
      ${esc(plural(s.entries, 'entry', 'entries'))} (${s.expenses} expense${s.expenses === 1 ? '' : 's'}, ${s.income} income)${s.entries ? `, ${esc(fmtDate(s.from))} – ${esc(fmtDate(s.to))}` : ''}<br>
      ${esc(plural(s.categories, 'expense category', 'expense categories'))}, ${esc(plural(s.sources, 'income source'))}, ${esc(plural(s.rules, 'recurring rule'))}
      ${s.entries === 0 ? '<br><strong>The sheet has no entries, so History on this phone will be empty.</strong>' : ''}</div>
    <p>This phone will be replaced with exactly that${total ? `, and ${esc(plural(total, 'unsynced change'))} will be thrown away` : ''}. <strong>This cannot be undone.</strong></p>
    <label for="rvType">Type <strong>REVERT</strong> to confirm</label>
    <input id="rvType" type="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" aria-describedby="rvStatus">
    <div class="revert-status" id="rvStatus" role="status" aria-live="polite"></div>
    <div class="btn-row">
      <button class="btn btn-secondary" type="button" id="rvBack">Back</button>
      <button class="btn btn-danger" type="button" id="rvGo" disabled>Replace this phone’s data</button>
    </div>`;
  $('rvBack').addEventListener('click', () => { if (!a.busy) renderReview(); });
  $('rvType').addEventListener('input', () => { $('rvGo').disabled = !typedOk(); });
  $('rvType').addEventListener('keydown', (e) => { if (e.key === 'Enter' && typedOk()) onApply(); });
  $('rvGo').addEventListener('click', onApply);
  $('rvType').focus();
}

async function onApply() {
  const a = active;
  if (!a || a.busy || !typedOk()) return;
  setBusy(true, 'Replacing this phone’s data with the sheet’s copy…');
  try {
    const r = await revertToCloud(a.reviewed);
    if (!r.applied) {
      // nothing was touched: new unsynced work showed up after the list was reviewed
      const snap = await snapshotUnsynced();
      a.snap = snap; a.reviewed = snap.tokens;
      setBusy(false);
      renderReview('New changes appeared on this phone just now, so nothing was replaced. Please read the list again.');
      return;
    }
    finish(`Reverted — this phone now matches the sheet (${plural(r.summary.entries, 'entry', 'entries')}).`);
  } catch (err) {
    if (err && err.committed) { finish(err.message); return; }
    setBusy(false, err && err.message ? err.message : String(err), true);
  }
}
