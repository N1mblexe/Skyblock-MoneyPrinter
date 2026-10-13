// Small formatting helpers for the item view (prices keep their 0.1 granularity).
import { fmtCoins, fmtPct, locale } from '../../format.ts';

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function numFmt(key: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = `${locale()}|n|${key}`;
  let f = cache.get(k) as Intl.NumberFormat | undefined;
  if (!f) {
    f = new Intl.NumberFormat(locale(), opts);
    cache.set(k, f);
  }
  return f;
}

function dateFmt(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${locale()}|d|${key}`;
  let f = cache.get(k) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f = new Intl.DateTimeFormat(locale(), opts);
    cache.set(k, f);
  }
  return f;
}

/** Bazaar price: one decimal below 100k (prices move in 0.1 steps), otherwise like fmtCoins. */
export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || Math.abs(n) >= 100_000) return fmtCoins(n);
  return numFmt('p1', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
}

/** Ratio with an explicit sign: +5,0% / −3,2%. */
export function fmtSignedPct(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return fmtPct(ratio);
  const s = fmtPct(Math.abs(ratio));
  if (ratio > 0) return `+${s}`;
  if (ratio < 0) return `−${s}`;
  return s;
}

/** Axis tick label; spans over ~36h show the date, shorter spans the time of day. */
export function fmtTick(ts: number, spanMs: number): string {
  if (spanMs > 36 * 3600_000) return dateFmt('day', { day: 'numeric', month: 'short' }).format(ts);
  return dateFmt('hm', { hour: '2-digit', minute: '2-digit' }).format(ts);
}

/** Tooltip time: date + time. */
export function fmtStamp(ts: number): string {
  return dateFmt('stamp', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ts);
}

/** Recipe quantities: integers as-is, fractional NEU quantities with up to 2 decimals. */
export function fmtQty(n: number): string {
  return numFmt('qty', { maximumFractionDigits: 2 }).format(n);
}
