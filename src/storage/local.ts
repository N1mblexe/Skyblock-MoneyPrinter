import { ALERT_METRICS } from '../domain/alertMetrics.ts';
import {
  ALERTS,
  LS_ALERT_LOG,
  LS_ALERTS,
  LS_FUSION,
  LS_JOURNAL,
  LS_LAST_ROUTE,
  LS_LEGACY_FUSION,
  LS_LEGACY_TAB,
  LS_OPP_ALERTS,
  LS_ORDERS,
  LS_SETTINGS,
  LS_WATCH,
} from '../config.ts';
import { sanitizeSettings } from '../state/appState.ts';
import type {
  AlertEvent,
  AlertMetric,
  AlertRule,
  FusionRecipe,
  JournalEntry,
  MyOrder,
  OppAlertRule,
  OppHit,
  OpportunityKind,
  Settings,
  WatchEntry,
} from '../types/contracts.ts';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // e.g. SecurityError when storage is blocked
  }
}

/** JSON localStorage get; any failure -> fallback. */
export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = storage()?.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** JSON localStorage set; failures swallowed. */
export function lsSet(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded / blocked: ignore */
  }
}

/** Persisted settings merged over defaults via sanitizeSettings. */
export function loadSettings(): Settings {
  return sanitizeSettings(lsGet<unknown>(LS_SETTINGS, null));
}

export function saveSettings(s: Settings): void {
  lsSet(LS_SETTINGS, s);
}

// Empty names are allowed so a half-filled recipe in the editor survives a reload.
const str = (v: unknown): v is string => typeof v === 'string';
const qty = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function isFusionRecipe(x: unknown): x is FusionRecipe {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return str(r.a) && qty(r.qa) && str(r.b) && qty(r.qb) && str(r.out) && qty(r.qo);
}

/** Persisted fusion recipes; invalid entries dropped. */
export function loadFusion(): FusionRecipe[] {
  const raw = lsGet<unknown>(LS_FUSION, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFusionRecipe).map((r) => ({ a: r.a, qa: r.qa, b: r.b, qb: r.qb, out: r.out, qo: r.qo }));
}

export function saveFusion(r: FusionRecipe[]): void {
  lsSet(LS_FUSION, r);
}

// ---- watchlist / alerts: entries are validated field by field; invalid ones are dropped, duplicates keep the first
export const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export const idStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 200;
export const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const METRICS: ReadonlySet<unknown> = new Set<AlertMetric>(ALERT_METRICS);
/** cooldowns above a week are treated as invalid */
const MAX_COOLDOWN_MIN = 7 * 24 * 60;

/** Parse a stored array, keeping valid entries (cleaned by `parse`); with `key`, only the first one per key. */
export function loadList<T>(lsKey: string, parse: (x: Record<string, unknown>) => T | null, key?: (t: T) => string): T[] {
  const raw = lsGet<unknown>(lsKey, []);
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const v = isObj(x) ? parse(x) : null;
    if (!v) continue;
    if (key) {
      if (seen.has(key(v))) continue;
      seen.add(key(v));
    }
    out.push(v);
  }
  return out;
}

function parseWatch(x: Record<string, unknown>): WatchEntry | null {
  if (!idStr(x.id)) return null;
  const w: WatchEntry = { id: x.id, addedAt: time(x.addedAt) ? x.addedAt : 0 };
  if (typeof x.note === 'string' && x.note !== '') w.note = x.note.slice(0, 500);
  return w;
}

function parseRule(x: Record<string, unknown>): AlertRule | null {
  const { key, id, metric, op, value, enabled, cooldownMin, lastFiredAt } = x;
  if (!idStr(key) || !idStr(id) || !METRICS.has(metric) || (op !== 'lt' && op !== 'gt')) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const r: AlertRule = {
    key,
    id,
    metric: metric as AlertMetric,
    op,
    value,
    enabled: typeof enabled === 'boolean' ? enabled : true,
    cooldownMin: time(cooldownMin) && cooldownMin <= MAX_COOLDOWN_MIN ? cooldownMin : ALERTS.defaultCooldownMin,
  };
  if (time(lastFiredAt)) r.lastFiredAt = lastFiredAt;
  return r;
}

function parseEvent(x: Record<string, unknown>): AlertEvent | null {
  const { ruleKey, id, metric, value, at } = x;
  if (!idStr(ruleKey) || !idStr(id) || !METRICS.has(metric) || typeof value !== 'number' || !Number.isFinite(value) || !time(at)) {
    return null;
  }
  return { ruleKey, id, metric: metric as AlertMetric, value, at };
}

/** Persisted watchlist; entries without an id dropped, a bad addedAt becomes 0, one entry per id. */
export const loadWatchlist = (): WatchEntry[] => loadList(LS_WATCH, parseWatch, (w) => w.id);
export const saveWatchlist = (w: WatchEntry[]): void => lsSet(LS_WATCH, w);
/** Persisted alert rules; invalid rules dropped, missing enabled/cooldown get defaults, one rule per key. */
export const loadAlerts = (): AlertRule[] => loadList(LS_ALERTS, parseRule, (r) => r.key);
export const saveAlerts = (a: AlertRule[]): void => lsSet(LS_ALERTS, a);
/** Persisted alert log (newest first, capped at ALERTS.logMax); invalid events dropped. */
export const loadAlertLog = (): AlertEvent[] => loadList(LS_ALERT_LOG, parseEvent).slice(0, ALERTS.logMax);
export const saveAlertLog = (l: AlertEvent[]): void => lsSet(LS_ALERT_LOG, l.slice(0, ALERTS.logMax));

// ---- market alerts
const OPP_SCOPE = new Set(['flip', 'craft', 'forge', 'chain', 'book', 'npc', 'kat']);
const OPP_METRICS = new Set(['profitPerHour', 'profit', 'margin']);

export function parseOppRule(x: Record<string, unknown>): OppAlertRule | null {
  const { key, scope, metric, value } = x;
  if (!idStr(key) || !Array.isArray(scope) || !OPP_METRICS.has(metric as string) || typeof value !== 'number' || !Number.isFinite(value)) return null;
  const sc = [...new Set(scope.filter((k): k is OpportunityKind => OPP_SCOPE.has(k as string)))];
  if (!sc.length) return null;
  const hits = Array.isArray(x.hits)
    ? x.hits.flatMap((h): OppHit[] =>
        isObj(h) && idStr(h.key) && idStr(h.id) && OPP_SCOPE.has(h.kind as string) && typeof h.value === 'number' && time(h.at)
          ? [{ key: h.key, kind: h.kind as OpportunityKind, id: h.id, name: typeof h.name === 'string' ? h.name : h.id, value: h.value, at: h.at }]
          : [],
      )
    : [];
  return {
    key,
    scope: sc,
    metric: metric as OppAlertRule['metric'],
    value,
    maxRisk: x.maxRisk === 'caution' ? 'caution' : 'ok',
    enabled: x.enabled !== false,
    seen: Array.isArray(x.seen) ? x.seen.filter(idStr) : [],
    hits: hits.slice(0, 10),
    ...(time(x.lastFiredAt) ? { lastFiredAt: x.lastFiredAt } : {}),
  };
}

export const loadOppAlerts = (): OppAlertRule[] => loadList(LS_OPP_ALERTS, parseOppRule, (r) => r.key);
export const saveOppAlerts = (r: OppAlertRule[]): void => lsSet(LS_OPP_ALERTS, r);

// ---- trades: my orders and the trade journal
const posNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const note = (v: unknown) => (typeof v === 'string' && v.trim() ? { note: v.slice(0, 500) } : {});
const STATUSES = new Set(['top', 'tied', 'outbid', 'undercut', 'unknown']);

export function parseOrder(x: Record<string, unknown>): MyOrder | null {
  const { key, id, side, price, qty, placedAt } = x;
  if (!idStr(key) || !idStr(id) || (side !== 'buy' && side !== 'sell') || !posNum(price) || !posNum(qty)) return null;
  return {
    key,
    id,
    side,
    price,
    qty,
    placedAt: time(placedAt) ? placedAt : 0,
    ...(posNum(x.cost) ? { cost: x.cost } : {}),
    ...note(x.note),
    ...(STATUSES.has(x.lastStatus as string) ? { lastStatus: x.lastStatus as MyOrder['lastStatus'] } : {}),
  };
}

export function parseJournal(x: Record<string, unknown>): JournalEntry | null {
  const { key, id, qty, buy, sell, tax, fees, at, source } = x;
  if (!idStr(key) || !idStr(id) || !posNum(qty) || !nonNeg(buy) || !nonNeg(sell)) return null;
  return {
    key,
    id,
    qty,
    buy,
    sell,
    tax: nonNeg(tax) && tax < 1 ? tax : 0,
    fees: nonNeg(fees) ? fees : 0,
    at: time(at) ? at : 0,
    source: source === 'order' || source === 'plan' ? source : 'manual',
    ...note(x.note),
  };
}

export const loadOrders = (): MyOrder[] => loadList(LS_ORDERS, parseOrder, (o) => o.key);
export const saveOrders = (o: MyOrder[]): void => lsSet(LS_ORDERS, o);
export const loadJournal = (): JournalEntry[] => loadList(LS_JOURNAL, parseJournal, (e) => e.key);
export const saveJournal = (j: JournalEntry[]): void => lsSet(LS_JOURNAL, j);

// ---- legacy single-file tool (bazaar-masasi.html) migration
/** legacy tab -> route hash (the legacy tool only had these three tabs) */
const LEGACY_TABS: Record<string, string> = { flip: '#/flip', craft: '#/craft', fusion: '#/fusion' };

/** Legacy fusion entry {a, aq, b, bq, out, oq} -> FusionRecipe; null when invalid. */
export function convertLegacyFusion(x: unknown): FusionRecipe | null {
  if (!isObj(x)) return null;
  const r = { a: x.a, qa: x.aq, b: x.b, qb: x.bq, out: x.out, qo: x.oq };
  return isFusionRecipe(r) ? r : null;
}

/**
 * One-time migration of the legacy tool's keys; idempotent and never overwrites new data:
 *  - LS_LEGACY_FUSION ({a,aq,b,bq,out,oq}[]) -> LS_FUSION ({a,qa,b,qb,out,qo}[]) when LS_FUSION is absent
 *    (invalid entries dropped; the legacy key is kept),
 *  - LS_LEGACY_TAB ('flip' | 'craft' | 'fusion') -> LS_LAST_ROUTE hash when LS_LAST_ROUTE is absent.
 */
export function migrateLegacy(): void {
  const st = storage();
  if (!st) return;
  try {
    if (st.getItem(LS_FUSION) == null) {
      const legacy = lsGet<unknown>(LS_LEGACY_FUSION, null);
      if (Array.isArray(legacy)) {
        lsSet(LS_FUSION, legacy.map(convertLegacyFusion).filter((r): r is FusionRecipe => r !== null));
      }
    }
    if (st.getItem(LS_LAST_ROUTE) == null) {
      const raw = st.getItem(LS_LEGACY_TAB);
      // the legacy tool stored JSON ('"craft"'); accept a bare string too
      const tab = raw == null ? null : lsGet<unknown>(LS_LEGACY_TAB, raw);
      const hash = typeof tab === 'string' ? LEGACY_TABS[tab] : undefined;
      if (hash) lsSet(LS_LAST_ROUTE, hash);
    }
  } catch {
    /* blocked storage: nothing to migrate */
  }
}
