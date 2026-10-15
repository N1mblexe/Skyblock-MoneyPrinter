// Locale-aware formatters; the Intl locale follows the active language (src/i18n/languages.ts).
import { locale, t } from '../i18n/index.ts';

export { locale };

const DASH = '—';
const cache = new Map<string, Intl.NumberFormat>();

function nf(kind: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const loc = locale();
  const key = `${loc}|${kind}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(loc, opts);
    cache.set(key, f);
  }
  return f;
}

/** Shared handling: null/undefined/NaN => "—", ±Infinity => "∞"/"-∞"; otherwise null (caller formats). */
function special(n: number | null | undefined): string | null {
  if (n == null || Number.isNaN(n)) return DASH;
  if (n === Infinity) return '∞';
  if (n === -Infinity) return '-∞';
  return null;
}

/** Coins: <10 => 1 decimal, otherwise 0 decimals, grouping; |n| >= 1e9 => compact. null/NaN => "—" */
export function fmtCoins(n: number | null | undefined): string {
  const s = special(n);
  if (s != null) return s;
  const v = n as number;
  const a = Math.abs(v);
  if (a >= 1e9) return nf('coinsBig', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
  if (a < 10) return nf('coins1', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
  return nf('coins0', { maximumFractionDigits: 0 }).format(v);
}

/** Ratio 0.123 => "%12,3" (tr) / "12.3%" (en). */
export function fmtPct(ratio: number | null | undefined, digits = 1): string {
  const s = special(ratio);
  if (s != null) return s;
  return nf(`pct${digits}`, { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
    ratio as number,
  );
}

/** Plain number with exactly `digits` decimals in the active locale: 1.234 => "1.23" (en) / "1,23" (tr). */
export function fmtNum(n: number | null | undefined, digits = 2): string {
  const s = special(n);
  if (s != null) return s;
  return nf(`num${digits}f`, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n as number);
}

export function fmtInt(n: number | null | undefined): string {
  const s = special(n);
  if (s != null) return s;
  return nf('int', { maximumFractionDigits: 0 }).format(n as number);
}

/** 1234567 => "1,2 Mn" (tr) / "1.2M" (en). */
export function fmtCompact(n: number | null | undefined): string {
  const s = special(n);
  if (s != null) return s;
  return nf('compact', { notation: 'compact', maximumFractionDigits: 1 }).format(n as number);
}

function num1(n: number): string {
  return nf('num1', { maximumFractionDigits: 1 }).format(n);
}

/** Age in ms => "12s" / "3m" / "2h" / "3d" (en), "12 sn" / "3 dk" / "2 sa" / "3 gün" (tr); units from common.u_*. */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return Number.isNaN(ms) ? DASH : '∞';
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return t('common.u_sec', { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t('common.u_min', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 48) return t('common.u_hour', { n: hr });
  return t('common.u_day', { n: Math.floor(hr / 24) });
}

/** Duration in hours => "45m" / "2.5h" / "3d" (en), "45 dk" / "2,5 sa" / "3 gün" (tr). Infinity => "∞". */
export function fmtHours(h: number): string {
  if (h == null || Number.isNaN(h)) return DASH;
  if (h === Infinity) return '∞';
  const v = Math.max(0, h);
  if (v * 60 < 59.5) {
    const m = Math.round(v * 60);
    return m < 1 ? t('common.u_lt1min') : t('common.u_min', { n: m });
  }
  if (v < 24) return t('common.u_hour', { n: num1(v) });
  return t('common.u_day', { n: num1(v / 24) });
}

/**
 * List in the active language: 'and' => "a, b and c" (Intl.ListFormat); 'tags' => "a, b, c" joined with
 * common.listSep (labels such as shard families). Falls back to a comma join.
 */
export function fmtList(items: readonly string[], kind: 'and' | 'tags' = 'and'): string {
  if (kind === 'tags') return items.join(t('common.listSep'));
  try {
    return new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}
