// Pure watchlist / alert-rule helpers: rule keys, defaults, import/export JSON.
import { ALERTS } from '../../../config.ts';
import { metricValue } from '../../../domain/alerts.ts';
import type { AlertMetric, AlertRule, CalcCtx, WatchEntry } from '../../../types/contracts.ts';
import { METRICS, isRatio } from './alertText.ts';

export const EXPORT_FORMAT = 'bazaarMasasi.watch';
export const EXPORT_VERSION = 1;
/** cooldowns above a week are rejected (same bound as storage) */
export const MAX_COOLDOWN_MIN = 7 * 24 * 60;

export interface WatchExport {
  format: typeof EXPORT_FORMAT;
  v: typeof EXPORT_VERSION;
  exportedAt: number;
  watchlist: WatchEntry[];
  alerts: AlertRule[];
}

/** A rule key not in `taken`: 'r' + time + random, base 36. */
export function newRuleKey(taken: ReadonlySet<string> | readonly AlertRule[], now = Date.now(), rnd: () => number = Math.random): string {
  const set = taken instanceof Set ? taken : new Set((taken as readonly AlertRule[]).map((r) => r.key));
  for (;;) {
    const k = `r${now.toString(36)}${Math.floor(rnd() * 36 ** 4).toString(36).padStart(4, '0')}`;
    if (!set.has(k)) return k;
    now++;
  }
}

/** Round a threshold to something a human would type (3 significant digits, at least 1 decimal for small coins). */
export function niceThreshold(metric: AlertMetric, v: number): number {
  if (!Number.isFinite(v) || v === 0) return 0;
  if (isRatio(metric)) return Math.round(v * 1000) / 1000; // 0.1% steps
  const mag = 10 ** Math.max(-1, Math.floor(Math.log10(Math.abs(v))) - 2);
  return Math.round(v / mag) * mag;
}

/**
 * Suggested threshold for a metric from its current value: 5% below for prices (catch a dip), 5% above for spread,
 * margin and profit (catch a widening). 0 when the value is unknown.
 */
export function suggestRule(metric: AlertMetric, current: number | null): { op: 'lt' | 'gt'; value: number } {
  const op = metric === 'ask' || metric === 'bid' ? 'lt' : 'gt';
  if (current == null || !Number.isFinite(current)) return { op, value: 0 };
  const v = op === 'lt' ? current * 0.95 : current >= 0 ? current * 1.05 : current * 0.95;
  return { op, value: niceThreshold(metric, v) };
}

/** A new enabled rule for `id` (default metric: ask), keyed uniquely against `rules`. */
export function makeRule(id: string, rules: readonly AlertRule[], ctx: CalcCtx | null, metric: AlertMetric = 'ask'): AlertRule {
  const cur = ctx ? metricValue(metric, id, ctx) : null;
  const { op, value } = suggestRule(metric, cur);
  return { key: newRuleKey(rules), id, metric, op, value, enabled: true, cooldownMin: ALERTS.defaultCooldownMin };
}

// ---------------------------------------------------------------- import / export

export function buildExport(watchlist: readonly WatchEntry[], alerts: readonly AlertRule[], now = Date.now()): WatchExport {
  return { format: EXPORT_FORMAT, v: EXPORT_VERSION, exportedAt: now, watchlist: [...watchlist], alerts: [...alerts] };
}

export const exportJson = (w: readonly WatchEntry[], a: readonly AlertRule[], now?: number): string =>
  JSON.stringify(buildExport(w, a, now), null, 2);

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const idStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 200;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function parseWatch(x: unknown): WatchEntry | null {
  if (idStr(x)) return { id: x.trim(), addedAt: 0 };
  if (!isObj(x) || !idStr(x.id)) return null;
  const w: WatchEntry = { id: x.id.trim(), addedAt: time(x.addedAt) ? x.addedAt : 0 };
  if (typeof x.note === 'string' && x.note !== '') w.note = x.note.slice(0, 500);
  return w;
}

function parseRule(x: unknown): AlertRule | null {
  if (!isObj(x)) return null;
  const { key, id, metric, op, value, enabled, cooldownMin, lastFiredAt } = x;
  if (!idStr(key) || !idStr(id) || !METRICS.includes(metric as AlertMetric) || (op !== 'lt' && op !== 'gt')) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const r: AlertRule = {
    key,
    id: id.trim(),
    metric: metric as AlertMetric,
    op,
    value,
    enabled: typeof enabled === 'boolean' ? enabled : true,
    cooldownMin: time(cooldownMin) && cooldownMin <= MAX_COOLDOWN_MIN ? cooldownMin : ALERTS.defaultCooldownMin,
  };
  if (time(lastFiredAt)) r.lastFiredAt = lastFiredAt;
  return r;
}

export type ImportResult =
  | { ok: true; watchlist: WatchEntry[]; alerts: AlertRule[] }
  | { ok: false; error: 'empty' | 'json' | 'nodata'; detail?: string };

/**
 * Parse pasted / uploaded JSON. Accepts the export object ({watchlist, alerts}), a bare array of watch entries or
 * ids, or a bare array of rules. Invalid entries are dropped; duplicates keep the first.
 */
export function parseImport(text: string): ImportResult {
  if (!text.trim()) return { ok: false, error: 'empty' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: 'json', detail: e instanceof Error ? e.message : String(e) };
  }
  let wl: unknown[] = [];
  let al: unknown[] = [];
  if (Array.isArray(raw)) {
    // bare array: rules if they look like rules, else watch entries
    if (raw.some((x) => isObj(x) && 'metric' in x)) al = raw;
    else wl = raw;
  } else if (isObj(raw)) {
    if (Array.isArray(raw.watchlist)) wl = raw.watchlist;
    if (Array.isArray(raw.alerts)) al = raw.alerts;
  }
  const watchlist: WatchEntry[] = [];
  const seenW = new Set<string>();
  for (const x of wl) {
    const w = parseWatch(x);
    if (w && !seenW.has(w.id)) {
      seenW.add(w.id);
      watchlist.push(w);
    }
  }
  const alerts: AlertRule[] = [];
  const seenR = new Set<string>();
  for (const x of al) {
    const r = parseRule(x);
    if (r && !seenR.has(r.key)) {
      seenR.add(r.key);
      alerts.push(r);
    }
  }
  if (!watchlist.length && !alerts.length) return { ok: false, error: 'nodata' };
  return { ok: true, watchlist, alerts };
}

const sameRule = (a: AlertRule, b: AlertRule) =>
  a.id === b.id && a.metric === b.metric && a.op === b.op && a.value === b.value && a.enabled === b.enabled && a.cooldownMin === b.cooldownMin;

/**
 * Merge imported data into the current lists. Watch entries are added when their id is new (existing order kept).
 * Rules with a new key are added; a rule whose key exists is replaced when it differs. Returns the new lists (the
 * same array objects when nothing changed) and how many entries were added or changed.
 */
export function mergeImport(
  cur: { watchlist: readonly WatchEntry[]; alerts: readonly AlertRule[] },
  data: { watchlist: readonly WatchEntry[]; alerts: readonly AlertRule[] },
): { watchlist: WatchEntry[]; alerts: AlertRule[]; items: number; rules: number } {
  const have = new Set(cur.watchlist.map((w) => w.id));
  const addW = data.watchlist.filter((w) => !have.has(w.id));
  const byKey = new Map(data.alerts.map((r) => [r.key, r]));
  let rules = 0;
  const kept = cur.alerts.map((r) => {
    const n = byKey.get(r.key);
    if (!n) return r;
    byKey.delete(r.key);
    if (sameRule(r, n)) return r;
    rules++;
    return n;
  });
  const addR = [...byKey.values()];
  rules += addR.length;
  return {
    watchlist: addW.length ? [...cur.watchlist, ...addW] : (cur.watchlist as WatchEntry[]),
    alerts: rules ? [...kept, ...addR] : (cur.alerts as AlertRule[]),
    items: addW.length,
    rules,
  };
}

/** File name for a download: bazaar-watchlist-YYYYMMDD-HHmm.json (local time). */
export function exportFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `bazaar-watchlist-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}
