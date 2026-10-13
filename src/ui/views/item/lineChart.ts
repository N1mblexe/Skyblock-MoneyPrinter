// Inline SVG line chart (time on x, price on y) with min/mid/max y labels, time ticks and a hover
// crosshair + tooltip. Always renders an <svg>: with fewer than 2 points it draws an empty frame and
// a message. Colors come from CSS classes (see item.css), so the chart follows the theme.
import { esc } from '../../dom.ts';

export interface ChartLine {
  key: string;
  label: string;
  /** CSS class for the stroke color (e.g. 'lc-bid') */
  cls: string;
  /** one value per ts; NaN = missing */
  values: number[];
}

export interface ChartData {
  ts: number[];
  lines: ChartLine[];
  emptyText: string;
  ariaLabel: string;
  fmtY(n: number): string;
  fmtX(ts: number, spanMs: number): string;
  fmtTip(ts: number): string;
}

export interface LineChart {
  el: HTMLElement;
  set(data: ChartData): void;
  destroy(): void;
}

const H = 240;
const PAD_T = 14;
const PAD_B = 28;
const PAD_R = 14;
const DEFAULT_W = 640;

const r1 = (n: number) => Math.round(n * 10) / 10;

interface Geo {
  w: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  tMin: number;
  tMax: number;
  vMin: number;
  vMax: number;
}

const xOf = (g: Geo, t: number) => (g.tMax > g.tMin ? g.x0 + ((t - g.tMin) / (g.tMax - g.tMin)) * (g.x1 - g.x0) : (g.x0 + g.x1) / 2);
const yOf = (g: Geo, v: number) => (g.vMax > g.vMin ? g.y1 - ((v - g.vMin) / (g.vMax - g.vMin)) * (g.y1 - g.y0) : (g.y0 + g.y1) / 2);

/** Median gap between timestamps; used to break lines over long holes (page was closed). */
function gapLimit(ts: number[]): number {
  if (ts.length < 3) return Infinity;
  const d: number[] = [];
  for (let i = 1; i < ts.length; i++) d.push(ts[i]! - ts[i - 1]!);
  d.sort((a, b) => a - b);
  const med = d[Math.floor(d.length / 2)]!;
  return Math.max(med * 4, 3 * 60_000);
}

const MIN = 60_000;
const STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880].map((m) => m * MIN);

/** Tick timestamps at round local times: the smallest step giving at most maxTicks ticks. */
export function timeTicks(tMin: number, tMax: number, maxTicks: number): number[] {
  const span = tMax - tMin;
  if (!(span > 0)) return [tMin];
  const step = STEPS.find((st) => span / st <= maxTicks) ?? Math.ceil(span / maxTicks / (1440 * MIN)) * 1440 * MIN;
  // align to local time (minutes/hours/midnight) using the zone offset at the start
  const off = new Date(tMin).getTimezoneOffset() * MIN;
  let t = Math.ceil((tMin - off) / step) * step + off;
  const out: number[] = [];
  for (; t <= tMax && out.length < 50; t += step) out.push(t);
  return out;
}

/** Pure SVG markup for the chart at a given width (exported for tests). */
export function lineChartSvg(data: ChartData, width: number): { svg: string; geo: Geo | null } {
  const w = Math.max(240, Math.round(width));
  const open = `<svg class="lc-svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="${esc(data.ariaLabel)}">`;
  const frame = (x0: number) =>
    `<rect class="lc-frame" x="${x0}" y="${PAD_T}" width="${w - PAD_R - x0}" height="${H - PAD_T - PAD_B}" rx="6"/>`;

  // usable points: at least one finite value
  let vMin = Infinity;
  let vMax = -Infinity;
  let nPts = 0;
  for (let i = 0; i < data.ts.length; i++) {
    let any = false;
    for (const l of data.lines) {
      const v = l.values[i];
      if (v == null || !Number.isFinite(v)) continue;
      any = true;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    if (any) nPts++;
  }

  if (nPts < 2) {
    const x0 = 12;
    return {
      svg:
        open +
        frame(x0) +
        `<text class="lc-empty" x="${r1((x0 + w - PAD_R) / 2)}" y="${r1(H / 2)}" text-anchor="middle">${esc(data.emptyText)}</text></svg>`,
      geo: null,
    };
  }

  const yLabels = [vMax, (vMin + vMax) / 2, vMin].map((v) => data.fmtY(v));
  const labelW = Math.max(...yLabels.map((s) => s.length)) * 7 + 14;
  const span = vMax - vMin;
  const pad = span > 0 ? span * 0.08 : Math.max(Math.abs(vMax) * 0.01, 0.1);
  const tMin = data.ts[0]!;
  const tMax = data.ts[data.ts.length - 1]!;
  const g: Geo = {
    w,
    x0: labelW,
    x1: w - PAD_R,
    y0: PAD_T,
    y1: H - PAD_B,
    tMin,
    tMax,
    vMin: vMin - pad,
    vMax: vMax + pad,
  };

  let s = open + frame(g.x0);

  // y grid + labels (max, mid, min of the data)
  [vMax, (vMin + vMax) / 2, vMin].forEach((v, i) => {
    if (i === 1 && span <= 0) return;
    const y = r1(yOf(g, v));
    s += `<line class="lc-grid" x1="${g.x0}" x2="${g.x1}" y1="${y}" y2="${y}"/>`;
    s += `<text class="lc-ylab" x="${g.x0 - 6}" y="${y}" text-anchor="end" dominant-baseline="middle">${esc(yLabels[i])}</text>`;
  });

  // x ticks at round local times (every 5 min … 2 days)
  const tSpan = tMax - tMin;
  const maxTicks = Math.max(2, Math.min(7, Math.floor((g.x1 - g.x0) / 90)));
  for (const t of timeTicks(tMin, tMax, maxTicks)) {
    const x = r1(xOf(g, t));
    const anchor = x - g.x0 < 24 ? 'start' : g.x1 - x < 24 ? 'end' : 'middle';
    s += `<line class="lc-tick" x1="${x}" x2="${x}" y1="${g.y1}" y2="${g.y1 + 4}"/>`;
    s += `<text class="lc-xlab" x="${x}" y="${H - 8}" text-anchor="${anchor}">${esc(data.fmtX(t, tSpan))}</text>`;
  }

  // lines, broken over gaps and missing values
  const limit = gapLimit(data.ts);
  for (const l of data.lines) {
    let d = '';
    let prevT = -Infinity;
    let pen = false;
    let last: [number, number] | null = null;
    for (let i = 0; i < data.ts.length; i++) {
      const v = l.values[i];
      const t = data.ts[i]!;
      if (v == null || !Number.isFinite(v)) {
        pen = false;
        continue;
      }
      const x = r1(xOf(g, t));
      const y = r1(yOf(g, v));
      d += `${pen && t - prevT <= limit ? 'L' : 'M'}${x} ${y}`;
      pen = true;
      prevT = t;
      last = [x, y];
    }
    if (!d) continue;
    s += `<path class="lc-line ${esc(l.cls)}" d="${d}" data-line="${esc(l.key)}"/>`;
    if (last) s += `<circle class="lc-end ${esc(l.cls)}" cx="${last[0]}" cy="${last[1]}" r="3.5"/>`;
  }

  // hover layer (positioned on pointer move)
  s += `<g class="lc-hover" visibility="hidden"><line class="lc-guide" x1="0" x2="0" y1="${g.y0}" y2="${g.y1}"/>`;
  for (const l of data.lines) s += `<circle class="lc-dot ${esc(l.cls)}" cx="0" cy="0" r="4" data-dot="${esc(l.key)}"/>`;
  s += `</g><rect class="lc-hit" x="${g.x0}" y="${g.y0}" width="${g.x1 - g.x0}" height="${g.y1 - g.y0}"/>`;

  return { svg: s + '</svg>', geo: g };
}

/** Index of the timestamp nearest to t (ts ascending). */
export function nearestIndex(ts: readonly number[], t: number): number {
  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(ts[hi]! - t) < Math.abs(ts[lo]! - t) ? hi : lo;
}

export function createLineChart(): LineChart {
  const el = document.createElement('div');
  el.className = 'lc';
  const plot = document.createElement('div');
  plot.className = 'lc-plot';
  const tip = document.createElement('div');
  tip.className = 'lc-tip';
  tip.hidden = true;
  tip.setAttribute('role', 'status');
  el.append(plot, tip);

  let data: ChartData | null = null;
  let geo: Geo | null = null;
  let lastW = 0;

  function width(): number {
    const w = plot.clientWidth || el.clientWidth;
    return w > 0 ? w : DEFAULT_W;
  }

  function render(): void {
    if (!data) return;
    lastW = width();
    const out = lineChartSvg(data, lastW);
    geo = out.geo;
    plot.innerHTML = out.svg;
    tip.hidden = true;
  }

  function hide(): void {
    tip.hidden = true;
    plot.querySelector('.lc-hover')?.setAttribute('visibility', 'hidden');
  }

  function onMove(ev: PointerEvent): void {
    if (!data || !geo || !data.ts.length) return;
    const svg = plot.querySelector('svg');
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const scale = box.width > 0 ? geo.w / box.width : 1;
    const px = (ev.clientX - box.left) * scale;
    if (px < geo.x0 - 8 || px > geo.x1 + 8) return hide();
    const t = geo.tMin + ((px - geo.x0) / Math.max(1, geo.x1 - geo.x0)) * (geo.tMax - geo.tMin);
    const i = nearestIndex(data.ts, t);
    const ts = data.ts[i]!;
    const x = r1(xOf(geo, ts));
    const hover = plot.querySelector('.lc-hover');
    if (!hover) return;
    hover.setAttribute('visibility', 'visible');
    const guide = hover.querySelector('.lc-guide');
    guide?.setAttribute('x1', String(x));
    guide?.setAttribute('x2', String(x));
    let rows = '';
    for (const l of data.lines) {
      const v = l.values[i];
      const dot = hover.querySelector(`[data-dot="${l.key}"]`);
      const ok = v != null && Number.isFinite(v);
      if (dot) {
        dot.setAttribute('visibility', ok ? 'visible' : 'hidden');
        if (ok) {
          dot.setAttribute('cx', String(x));
          dot.setAttribute('cy', String(r1(yOf(geo, v))));
        }
      }
      rows += `<div class="lc-tip-row"><span class="lc-sw ${esc(l.cls)}"></span><span>${esc(l.label)}</span><b>${ok ? esc(data.fmtY(v)) : '—'}</b></div>`;
    }
    tip.innerHTML = `<div class="lc-tip-time">${esc(data.fmtTip(ts))}</div>${rows}`;
    tip.hidden = false;
    // keep the tooltip inside the chart: flip to the left half when past the middle
    const cssX = x / scale;
    const right = x > (geo.x0 + geo.x1) / 2;
    tip.style.left = right ? '' : `${Math.round(cssX + 12)}px`;
    tip.style.right = right ? `${Math.round(box.width - cssX + 12)}px` : '';
  }

  plot.addEventListener('pointermove', onMove);
  plot.addEventListener('pointerdown', onMove);
  plot.addEventListener('pointerleave', hide);

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      if (data && Math.abs(width() - lastW) >= 2) render();
    });
    ro.observe(plot);
  }

  return {
    el,
    set(d) {
      data = d;
      render();
    },
    destroy() {
      ro?.disconnect();
      plot.removeEventListener('pointermove', onMove);
      plot.removeEventListener('pointerdown', onMove);
      plot.removeEventListener('pointerleave', hide);
      el.remove();
    },
  };
}
