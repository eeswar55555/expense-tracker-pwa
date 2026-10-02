// Hand-written inline-SVG chart helpers. No chart library. Every chart is a
// viewBox-scaled <svg> so it reads at 360px and scales up on wider phones;
// `vector-effect="non-scaling-stroke"` keeps hairlines/strokes at a literal
// screen pixel width regardless of that scale. Money axis labels use
// fmtMoneyShort. Colour follows the dataviz skill: income/expense are the
// app's fixed semantic tokens (secondary-encoded — see dashboard.js header
// comment for the validator result), the heatmap is single-hue sequential.

import { MONTHS, fmtMoneyShort, esc } from './util.js';

const mShort = (mk) => MONTHS[Number(mk.slice(5, 7)) - 1];

/** Rounded-top bar path: 4px corners at the data end, square at the baseline. */
export function barPath(x, y, w, h, r = 4) {
  if (h <= 0.01 || w <= 0) return '';
  r = Math.min(r, w / 2, Math.max(h, 0.01));
  const top = y, bottom = y + h;
  return `M${x},${bottom} L${x},${top + r} Q${x},${top} ${x + r},${top} ` +
    `L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${bottom} Z`;
}

/** ~`count` round-number ticks from 0..max (always includes 0). */
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const out = [];
  for (let v = 0; v <= top + 1e-6; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/** Legend row (HTML, not SVG) — line-key for a line series, swatch for a bar. */
export function legendRow(items) {
  return `<div class="dash-legend">${items.map((it) => `
    <span class="legend-item"><span class="legend-swatch ${it.kind === 'line' ? 'legend-line' : 'legend-bar'}" style="${it.kind === 'line' ? `border-top-color:${it.color}` : `background:${it.color}`}"></span>${esc(it.label)}</span>`).join('')}</div>`;
}

/** Grouped income-vs-expense bars, one group per month. `income`/`expense` are
 *  arrays of numbers aligned to `months`. Tap/hover a month via the invisible
 *  `.bar-hit` rect (bigger than the bars) — dashboard.js reads the per-chart
 *  `data-points` JSON off the <svg> to build the tooltip. */
export function monthlyBarChart({ months, income, expense, selectedMk, id }) {
  const W = 600, H = 250, padTop = 26, padBottom = 34, padL = 2, padR = 2;
  const plotW = W - padL - padR, plotH = H - padTop - padBottom;
  const dataMax = Math.max(0, ...income, ...expense);
  const ticks = niceTicks(dataMax, 4);
  const top = Math.max(ticks[ticks.length - 1], 1);
  const y = (v) => padTop + plotH - (Math.max(0, v) / top) * plotH;
  const n = months.length;
  const groupW = plotW / n;
  const barW = Math.max(2, groupW * 0.32);
  const gap = Math.max(1.5, groupW * 0.06);

  let grid = '', bars = '', hits = '', xLabels = '';
  ticks.forEach((t) => {
    const ty = y(t);
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" class="grid-line"/>`;
    grid += `<text x="${padL}" y="${(ty - 4).toFixed(1)}" class="axis-label">${esc(fmtMoneyShort(t))}</text>`;
  });

  months.forEach((mk, i) => {
    const gx = padL + i * groupW;
    const cx = gx + groupW / 2;
    const isSel = mk === selectedMk;
    const ax = cx - barW - gap / 2, bx = cx + gap / 2;
    const incY = y(income[i]), expY = y(expense[i]);
    bars += `<path d="${barPath(ax, incY, barW, padTop + plotH - incY)}" fill="var(--income)" opacity="${isSel ? 1 : 0.8}"/>`;
    bars += `<path d="${barPath(bx, expY, barW, padTop + plotH - expY)}" fill="var(--expense)" opacity="${isSel ? 1 : 0.8}"/>`;
    if (isSel) bars += `<rect x="${(gx + 1).toFixed(1)}" y="${padTop}" width="${(groupW - 2).toFixed(1)}" height="${plotH}" fill="none" stroke="var(--ink)" stroke-width="1.5" vector-effect="non-scaling-stroke" rx="3"/>`;
    const showLabel = n <= 9 || i % 2 === 0 || isSel;
    if (showLabel) xLabels += `<text x="${cx.toFixed(1)}" y="${H - 9}" text-anchor="middle" class="axis-label${isSel ? ' axis-label-sel' : ''}">${mShort(mk)}</text>`;
    hits += `<rect class="bar-hit" tabindex="0" role="button" aria-label="${mShort(mk)}: income ${esc(fmtMoneyShort(income[i]))}, expense ${esc(fmtMoneyShort(expense[i]))}" data-i="${i}" x="${gx.toFixed(1)}" y="0" width="${groupW.toFixed(1)}" height="${H}" fill="transparent"/>`;
  });

  const points = months.map((mk, i) => ({ mk, income: income[i], expense: expense[i] }));
  const label = `Monthly income versus expense for ${months[0]} through ${months[n - 1]}`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(label)}" class="dash-chart" data-chart="${id}" data-points='${esc(JSON.stringify(points))}'>
    <g>${grid}</g><g>${bars}</g><g>${xLabels}</g><g>${hits}</g>
  </svg>`;
}

/** Two expense lines (this year vs last year) over Jan–Dec, one ₹ axis. A
 *  value of null breaks the line (used to stop "this year" at the current
 *  month). End-of-line direct labels; a shared legend covers identity. */
export function yoyLineChart({ seriesThis, seriesLast, yearThis, yearLast, id }) {
  const W = 600, H = 250, padTop = 26, padBottom = 34, padL = 22, padR = 84;
  const plotW = W - padL - padR, plotH = H - padTop - padBottom;
  const all = [...seriesThis, ...seriesLast].filter((v) => v != null);
  const dataMax = Math.max(0, ...all);
  const ticks = niceTicks(dataMax, 4);
  const top = Math.max(ticks[ticks.length - 1], 1);
  const n = 12;
  const x = (i) => padL + (plotW / (n - 1)) * i;
  const y = (v) => padTop + plotH - (Math.max(0, v) / top) * plotH;

  const pathFor = (arr) => {
    let d = '', open = false;
    arr.forEach((v, i) => {
      if (v == null) { open = false; return; }
      d += (open ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1) + ' ';
      open = true;
    });
    return d.trim();
  };
  const lastPoint = (arr) => {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return { i, v: arr[i] };
    return null;
  };

  let grid = '';
  ticks.forEach((t) => {
    const ty = y(t);
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" class="grid-line"/>`;
    grid += `<text x="${padL}" y="${(ty - 4).toFixed(1)}" class="axis-label">${esc(fmtMoneyShort(t))}</text>`;
  });

  let xLabels = '';
  for (let i = 0; i < 12; i++) if (i % 2 === 0) xLabels += `<text x="${x(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" class="axis-label">${MONTHS[i]}</text>`;

  const lineThis = `<path d="${pathFor(seriesThis)}" fill="none" stroke="var(--expense)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`;
  const lineLast = `<path d="${pathFor(seriesLast)}" fill="none" stroke="var(--muted)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 0"/>`;

  const ltp = lastPoint(seriesThis), llp = lastPoint(seriesLast);
  let markers = '', labels = '';
  if (llp) {
    markers += `<circle cx="${x(llp.i).toFixed(1)}" cy="${y(llp.v).toFixed(1)}" r="4" fill="var(--muted)" stroke="var(--card)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  }
  if (ltp) {
    markers += `<circle cx="${x(ltp.i).toFixed(1)}" cy="${y(ltp.v).toFixed(1)}" r="4" fill="var(--expense)" stroke="var(--card)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  }
  // End labels: nudge apart if they'd collide vertically.
  if (ltp && llp) {
    let ya = y(ltp.v), yb = y(llp.v);
    if (Math.abs(ya - yb) < 16) { if (ya < yb) { ya -= 8; yb += 8; } else { ya += 8; yb -= 8; } }
    labels += `<text x="${(x(ltp.i) + 6).toFixed(1)}" y="${(ya + 4).toFixed(1)}" class="line-end-label" fill="var(--expense)">${esc(fmtMoneyShort(ltp.v))}</text>`;
    labels += `<text x="${(x(llp.i) + 6).toFixed(1)}" y="${(yb + 4).toFixed(1)}" class="line-end-label" fill="var(--muted)">${esc(fmtMoneyShort(llp.v))}</text>`;
  } else if (ltp) {
    labels += `<text x="${(x(ltp.i) + 6).toFixed(1)}" y="${(y(ltp.v) + 4).toFixed(1)}" class="line-end-label" fill="var(--expense)">${esc(fmtMoneyShort(ltp.v))}</text>`;
  }

  let hits = '';
  for (let i = 0; i < 12; i++) {
    const vThis = seriesThis[i], vLast = seriesLast[i];
    if (vThis == null && vLast == null) continue;
    const parts = [];
    if (vThis != null) parts.push(`${yearThis} ${esc(fmtMoneyShort(vThis))}`);
    if (vLast != null) parts.push(`${yearLast} ${esc(fmtMoneyShort(vLast))}`);
    hits += `<rect class="bar-hit" tabindex="0" role="button" aria-label="${MONTHS[i]}: ${parts.join(', ')}" data-i="${i}" x="${(x(i) - plotW / 22).toFixed(1)}" y="0" width="${(plotW / 11).toFixed(1)}" height="${H}" fill="transparent"/>`;
  }

  const points = Array.from({ length: 12 }, (_, i) => ({ mk: `${MONTHS[i]}`, thisYear: seriesThis[i], lastYear: seriesLast[i] }));
  const label = `Monthly expense, ${yearThis} versus ${yearLast}`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(label)}" class="dash-chart" data-chart="${id}" data-points='${esc(JSON.stringify(points))}' data-years='${esc(JSON.stringify({ yearThis, yearLast }))}'>
    <g>${grid}</g>${lineLast}${lineThis}<g>${markers}</g><g>${labels}</g><g>${xLabels}</g><g>${hits}</g>
  </svg>`;
}

/** Single-hue sequential heat shading for a magnitude value against a max.
 *  Uses the --heat-rgb token (defined per theme in dashboard.css, tied to the
 *  app's ink colour) so it stays theme-correct without any JS theme check. */
export function heatStyle(value, max) {
  if (!(max > 0) || !(value > 0)) return { style: '', strong: false };
  const alpha = Math.min(0.9, 0.1 + 0.8 * (value / max));
  return { style: `background-color: rgba(var(--heat-rgb), ${alpha.toFixed(2)})`, strong: alpha > 0.45 };
}
