import { LS_FUSION, LS_SETTINGS } from '../config.ts';
import { sanitizeSettings } from '../state/appState.ts';
import type { FusionRecipe, Settings } from '../types/contracts.ts';

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
