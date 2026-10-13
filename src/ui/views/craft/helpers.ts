// Pure helpers for the craft view: persisted prefs, row filtering, rate formatting.
import { LS_VIEWPREFS } from '../../../config.ts';
import { matchesQuery } from '../../../domain/search.ts';
import { lsGet, lsSet } from '../../../storage/local.ts';
import type { Catalog, CraftRow } from '../../../types/contracts.ts';
import { locale } from '../../format.ts';
import type { SortState } from '../../table.ts';

export type KindFilter = 'all' | 'craft' | 'forge';

export interface CraftPrefs {
  /** min output volume, crafts/week (outCraftsPerHour * 168) */
  minVol: number;
  /** min margin, percent; null = no minimum */
  minMargin: number | null;
  kind: KindFilter;
  showUnpriced: boolean;
  sort: SortState;
}

export const PREFS_KEY = LS_VIEWPREFS + 'craft';

export const defaultPrefs = (): CraftPrefs => ({
  minVol: 1000,
  minMargin: 1,
  kind: 'all',
  showUnpriced: false,
  sort: { key: 'pph', dir: 'desc' },
});

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function loadPrefs(): CraftPrefs {
  const d = defaultPrefs();
  const raw = lsGet<unknown>(PREFS_KEY, null);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  if (fin(r.minVol) && r.minVol >= 0) d.minVol = r.minVol;
  if (fin(r.minMargin) || r.minMargin === null) d.minMargin = r.minMargin;
  if (r.kind === 'all' || r.kind === 'craft' || r.kind === 'forge') d.kind = r.kind;
  if (typeof r.showUnpriced === 'boolean') d.showUnpriced = r.showUnpriced;
  const s = r.sort as Record<string, unknown> | undefined;
  if (s && typeof s.key === 'string' && (s.dir === 'asc' || s.dir === 'desc')) d.sort = { key: s.key, dir: s.dir };
  return d;
}

export function savePrefs(p: CraftPrefs): void {
  lsSet(PREFS_KEY, p);
}

export interface FilterOpts {
  q: string;
  minVol: number;
  minMargin: number | null;
  kind: KindFilter;
  showUnpriced: boolean;
  /** hide rows whose risk level is 'suspect' */
  hideSuspect: boolean;
}

export interface FilterResult {
  rows: CraftRow[];
  /** suspect rows that matched every other filter but were hidden */
  hidden: number;
  /** suspect rows that matched every other filter (shown or hidden) */
  suspect: number;
}

/** Search hits the output or any ingredient (display name or id). */
export function rowMatchesQuery(catalog: Catalog | null, r: CraftRow, q: string): boolean {
  if (!q.trim()) return true;
  if (matchesQuery(catalog, r.id, q)) return true;
  return r.recipe.inputs.some((i) => matchesQuery(catalog, i.id, q));
}

/** Filter computed rows (cheap filters first, the text search last). */
export function filterCrafts(all: readonly CraftRow[], o: FilterOpts, catalog: Catalog | null): FilterResult {
  const rows: CraftRow[] = [];
  let hidden = 0;
  let suspect = 0;
  const minWeek = Number.isFinite(o.minVol) ? o.minVol : 0;
  const minM = o.minMargin != null && Number.isFinite(o.minMargin) ? o.minMargin / 100 : -Infinity;
  for (const r of all) {
    if (o.kind !== 'all' && r.recipe.kind !== o.kind) continue;
    if (r.unpriced.length > 0) {
      if (!o.showUnpriced) continue;
    } else {
      if (!(r.outCraftsPerHour * 168 >= minWeek)) continue;
      if (r.margin == null || r.margin < minM) continue;
    }
    if (!rowMatchesQuery(catalog, r, o.q)) continue;
    if (r.risk.level === 'suspect' && r.unpriced.length === 0) {
      suspect++;
      if (o.hideSuspect) {
        hidden++;
        continue;
      }
    }
    rows.push(r);
  }
  return { rows, hidden, suspect };
}

const rateFmt = new Map<string, Intl.NumberFormat>();

/** Crafts/hour: ∞ for unlimited, 2 significant digits below 10, grouped integers above. */
export function fmtRate(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (n === Infinity) return '∞';
  const loc = locale();
  const small = Math.abs(n) < 10;
  const key = `${loc}|${small}`;
  let f = rateFmt.get(key);
  if (!f) {
    f = new Intl.NumberFormat(loc, small ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 0 });
    rateFmt.set(key, f);
  }
  return f.format(n);
}
