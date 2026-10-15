// Pieces shared by the flip and books views: cell helpers, detail-panel sections, legacy-prefs migration.
import { t } from '../../../i18n/index.ts';
import { lsGet, lsSet } from '../../../storage/local.ts';
import type { MarketStat, OrderLevel, Product, RiskReport, Throughput } from '../../../types/contracts.ts';
import { riskFlagText } from '../../cells.ts';
import { esc } from '../../dom.ts';
import { fmtCoins, fmtCompact, fmtHours, fmtInt, fmtPct, locale } from '../../format.ts';

/** 'pos' / 'neg' / '' for a signed number. */
export const signCls = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) || n === 0 ? '' : n > 0 ? 'pos' : 'neg');

/** Escaped text, wrapped in a span when cls is set. */
export const span = (cls: string, txt: string): string => (cls ? `<span class="${cls}">${esc(txt)}</span>` : esc(txt));

/** Signed percent change, '+' prefixed and colored. */
export function changeHtml(c: number | null | undefined): string {
  return span(signCls(c), c != null && c > 0 ? '+' + fmtPct(c) : fmtPct(c));
}

/** Translated "limited by" reason. */
export const limitedText = (why: Throughput['limitedBy']): string => t(`flip.lim_${why}`);
export const limitedHelp = (why: Throughput['limitedBy']): string => t(`flip.limHelp_${why}`);

/** "buy h + sell h" (falls back to total fill hours when the split is unknown). */
export function fillText(tp: Throughput): string {
  if (tp.buyHours == null || tp.sellHours == null) return fmtHours(tp.fillHours);
  return `${fmtHours(tp.buyHours)} + ${fmtHours(tp.sellHours)}`;
}

/** ★ toggle for a table row (kit rowActions; data-action="watch"). */
export function watchButton(watched: boolean, name: string): string {
  const label = t(watched ? 'common.unwatchItem' : 'common.watchItem', { name });
  return `<button type="button" class="btn btn-ghost btn-sm watch-btn${watched ? ' on' : ''}" data-action="watch" aria-pressed="${watched}" aria-label="${esc(label)}" title="${esc(label)}">${watched ? '★' : '☆'}</button>`;
}

/** Panel section with an h3 heading. */
export const section = (title: string, body: string, cls = ''): string =>
  `<section class="dp-sec${cls ? ' ' + cls : ''}"><h3>${esc(title)}</h3>${body}</section>`;

/** Key/value list; values are HTML. */
export function kv(pairs: [string, string][]): string {
  return `<dl class="kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

/** Risk flags, each with its explanation. */
export function riskListHtml(r: RiskReport): string {
  const flags = r.flags.filter((f) => f !== 'NO_HISTORY' || r.flags.length === 1);
  const head = `<p><span class="badge risk-${r.level}">${esc(t(`risk.${r.level}`))}</span></p>`;
  if (!flags.length) return head + `<p class="muted small">${esc(t('flip.riskNone'))}</p>`;
  return head + `<ul class="dp-flags">${flags.map((f) => `<li><code>${esc(f)}</code> ${esc(riskFlagText(f))}</li>`).join('')}</ul>`;
}

function levelsTable(caption: string, levels: readonly OrderLevel[], n: number): string {
  const rows = levels.slice(0, n);
  const body = rows.length
    ? rows.map((l) => `<tr><td class="num">${esc(fmtCoins(l.price))}</td><td class="num">${esc(fmtInt(l.amount))}</td><td class="num">${esc(fmtInt(l.orders))}</td></tr>`).join('')
    : `<tr><td colspan="3" class="empty">${esc(t('flip.bookEmpty'))}</td></tr>`;
  return (
    `<table class="tbl-plain dp-book-t"><caption>${esc(caption)}</caption>` +
    `<thead><tr><th scope="col" class="num">${esc(t('flip.bookPrice'))}</th><th scope="col" class="num">${esc(t('flip.bookAmount'))}</th><th scope="col" class="num">${esc(t('flip.bookOrders'))}</th></tr></thead>` +
    `<tbody>${body}</tbody></table>`
  );
}

/** Top-n buy orders and sell offers of a product (from the snapshot). */
export function orderBookHtml(p: Product | undefined, n = 5): string {
  return `<div class="dp-book">${levelsTable(t('flip.bookBids'), p?.bids ?? [], n)}${levelsTable(t('flip.bookAsks'), p?.asks ?? [], n)}</div>`;
}

const trend = (x: number | null): string => (x == null || !Number.isFinite(x) ? '—' : `${x.toLocaleString(locale(), { maximumFractionDigits: 2 })}×`);

/** Market stats key/values (volume trend labelled as an estimate). */
export function statsHtml(s: MarketStat | undefined): string {
  if (!s || s.n === 0) return `<p class="muted small">${esc(t('flip.statsNone'))}</p>`;
  return (
    kv([
      [t('flip.st_points'), esc(fmtInt(s.n))],
      [t('flip.st_change1h'), changeHtml(s.change1h)],
      [t('flip.st_change24h'), changeHtml(s.change24h)],
      [t('flip.st_vol'), esc(fmtPct(s.volatility))],
      [t('flip.st_spread'), esc(fmtPct(s.spreadMedian))],
      [t('flip.st_cons'), esc(fmtPct(s.consistency, 0))],
      [t('flip.st_buyTrend'), esc(trend(s.buyVolTrend))],
      [t('flip.st_sellTrend'), esc(trend(s.sellVolTrend))],
    ]) + `<p class="muted small">${esc(t('flip.st_trendNote'))}</p>`
  );
}

/** Throughput key/values shared by flip and book panels. */
export function tpPairs(tp: Throughput, orderSlots: number, pph: number): [string, string][] {
  return [
    [t('flip.batch'), esc(fmtInt(tp.batchQty))],
    [t('flip.capital'), esc(fmtCoins(tp.capitalUsed))],
    [t('flip.slots'), esc(t('flip.slotsVal', { n: fmtInt(tp.slots ?? 0), max: fmtInt(orderSlots) }))],
    [t('flip.fillTime'), esc(fillText(tp))],
    [t('flip.uph'), esc(fmtCompact(tp.unitsPerHour))],
    [t('flip.limitedBy'), `<span title="${esc(limitedHelp(tp.limitedBy))}">${esc(limitedText(tp.limitedBy))}</span>`],
    [t('flip.pph'), `<strong>${span(signCls(pph), fmtCoins(pph))}</strong>`],
  ];
}

/**
 * Round-1 views stored prefs as typed JSON ({minVol: 5, sort: {key, dir}}); bindQueryState expects URL-encoded
 * strings. Convert in place so old localStorage doesn't break decoding.
 */
export function migrateLegacyPrefs(key: string): void {
  const raw = lsGet<unknown>(key, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  let changed = false;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else {
      changed = true;
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v);
      else if (typeof v === 'boolean') out[k] = v ? '1' : '0';
      else if (v && typeof v === 'object') {
        const s = v as { key?: unknown; dir?: unknown };
        if (typeof s.key === 'string' && (s.dir === 'asc' || s.dir === 'desc')) out[k] = `${s.key}.${s.dir}`;
      }
    }
  }
  if (changed) lsSet(key, out);
}

/** Key of the focused table row inside `container`, if any. */
export function focusedRowKey(container: HTMLElement): string | null {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!a || !container.contains(a)) return null;
  return a.closest<HTMLElement>('[data-key]')?.dataset.key ?? null;
}
