import { ALERTS, LS_ALERT_LOG, LS_ALERTS, LS_FUSION, LS_SETTINGS, LS_WATCH } from '../config.ts';
import { sanitizeSettings } from '../state/appState.ts';
import type { AlertEvent, AlertRule, FusionRecipe, Settings, WatchEntry } from '../types/contracts.ts';

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

// ---- watchlist / alerts (Wave 0: shape checks only; history package hardens validation)
const arr = <T>(key: string, ok: (x: unknown) => boolean): T[] => {
  const raw = lsGet<unknown>(key, []);
  return Array.isArray(raw) ? (raw.filter(ok) as T[]) : [];
};
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';

export const loadWatchlist = (): WatchEntry[] => arr(LS_WATCH, (x) => isObj(x) && typeof x.id === 'string' && x.id !== '');
export const saveWatchlist = (w: WatchEntry[]): void => lsSet(LS_WATCH, w);
export const loadAlerts = (): AlertRule[] => arr(LS_ALERTS, (x) => isObj(x) && typeof x.key === 'string' && typeof x.id === 'string');
export const saveAlerts = (a: AlertRule[]): void => lsSet(LS_ALERTS, a);
export const loadAlertLog = (): AlertEvent[] => arr<AlertEvent>(LS_ALERT_LOG, isObj).slice(0, ALERTS.logMax);
export const saveAlertLog = (l: AlertEvent[]): void => lsSet(LS_ALERT_LOG, l.slice(0, ALERTS.logMax));

/** One-time migration of legacy single-file tool keys (fusion recipes, last tab). Wave 0 stub. */
export function migrateLegacy(): void {}
