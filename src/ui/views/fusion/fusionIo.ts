// Fusion recipe JSON import/export. Import is validated like storage loadFusion() and also accepts the
// legacy single-file tool's shape {a, aq, b, bq, out, oq}.
import { convertLegacyFusion } from '../../../storage/local.ts';
import type { FusionRecipe } from '../../../types/contracts.ts';

/** Hard cap on imported recipes (protects localStorage and the editor). */
export const IMPORT_MAX = 500;

const str = (v: unknown): v is string => typeof v === 'string';
const qty = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** One entry in either shape -> FusionRecipe, or null when invalid. */
export function toRecipe(x: unknown): FusionRecipe | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (str(r.a) && qty(r.qa) && str(r.b) && qty(r.qb) && str(r.out) && qty(r.qo)) {
    return { a: r.a, qa: r.qa, b: r.b, qb: r.qb, out: r.out, qo: r.qo };
  }
  return convertLegacyFusion(x);
}

export type ImportResult =
  | { ok: true; recipes: FusionRecipe[]; skipped: number }
  | { ok: false; error: 'json' | 'shape' | 'empty'; detail?: string };

/**
 * Parse pasted/uploaded JSON: an array of recipes, or an object with a `recipes` (or legacy `bazaarMasasi.recipes`)
 * array. Invalid entries are skipped and counted; zero valid entries is an error.
 */
export function parseRecipesJson(text: string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, error: 'json', detail: e instanceof Error ? e.message : String(e) };
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    data = Array.isArray(o.recipes) ? o.recipes : Array.isArray(o['bazaarMasasi.recipes']) ? o['bazaarMasasi.recipes'] : toRecipe(o) ? [o] : null;
  }
  if (!Array.isArray(data)) return { ok: false, error: 'shape' };
  const recipes: FusionRecipe[] = [];
  let skipped = 0;
  for (const x of data) {
    const r = toRecipe(x);
    if (r && recipes.length < IMPORT_MAX) recipes.push(r);
    else skipped++;
  }
  if (!recipes.length) return { ok: false, error: 'empty' };
  return { ok: true, recipes, skipped };
}

/** Pretty JSON array of recipes (the same shape the app stores). */
export function recipesToJson(recipes: readonly FusionRecipe[]): string {
  return JSON.stringify(
    recipes.map((r) => ({ a: r.a, qa: r.qa, b: r.b, qb: r.qb, out: r.out, qo: r.qo })),
    null,
    2,
  );
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** `fusion-recipes-YYYYMMDD-HHmm.json` in local time. */
export function exportFileName(d: Date = new Date()): string {
  return `fusion-recipes-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.json`;
}

/** Trigger a browser download of the recipes; returns the file name. */
export function downloadRecipes(recipes: readonly FusionRecipe[], now: Date = new Date()): string {
  const file = exportFileName(now);
  const blob = new Blob([recipesToJson(recipes)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return file;
}
