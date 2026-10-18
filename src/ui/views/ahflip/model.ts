// AH flips page model: URL schema and row filtering (no DOM or CSS, so scripts/smoke.ts can import it).
import { AH_FLIP } from '../../../config.ts';
import { isPetLevelKey, type AhFlipRow } from '../../../domain/ahFlips.ts';
import { matchesQuery } from '../../../domain/search.ts';
import type { AhSnapshot, AppState } from '../../../types/contracts.ts';
import type { QuerySchema, QueryValues } from '../../kit/index.ts';

/** BIN listings in a scan, each once (pet level keys, `@MAX` and the v4 bands, repeat listings of the plain pet id). */
export function ahListingCount(ah: AhSnapshot): number {
  let n = 0;
  for (const [id, a] of Object.entries(ah.lowestBin)) if (!isPetLevelKey(id)) n += a.count;
  return n;
}

const SORT_KEYS = ['name', 'buy', 'next', 'profit', 'margin', 'gap', 'count', 'hours', 'pph', 'risk'] as const;

/** 'relist': lowest BIN -> under the second-lowest; 'george': pets bought below George's price. */
export const AHFLIP_MODES = ['relist', 'george'] as const;
export type AhFlipMode = (typeof AHFLIP_MODES)[number];

export const AHFLIP_SCHEMA = {
  mode: { kind: 'enum', def: 'relist', values: AHFLIP_MODES },
  q: { kind: 'string', def: '' },
  minProfit: { kind: 'number', def: 100_000, min: 0 },
  /** percent */
  minMargin: { kind: 'number', def: 5 },
  minCount: { kind: 'number', def: 5, min: AH_FLIP.minCount },
  pets: { kind: 'bool', def: true },
  suspect: { kind: 'bool', def: false },
  sort: { kind: 'sort', def: { key: 'profit', dir: 'desc' }, keys: SORT_KEYS },
} as const satisfies QuerySchema;

export type AhFlipQuery = QueryValues<typeof AHFLIP_SCHEMA>;

export interface AhFlipFilters {
  q: string;
  minProfit: number | null;
  minMargin: number | null;
  /** ignored for George flips (he buys any copy) */
  minCount: number | null;
  pets: boolean;
  hideSuspect: boolean;
}

/** Filter rows: thresholds, pets, search (name, id or listing name), suspect rows when hidden. */
export function filterAhFlips(rows: readonly AhFlipRow[], o: AhFlipFilters, catalog: AppState['catalog']): { rows: AhFlipRow[]; hidden: number } {
  const out: AhFlipRow[] = [];
  let hidden = 0;
  const q = o.q.trim().toLowerCase();
  for (const r of rows) {
    if (o.minProfit != null && r.profit < o.minProfit) continue;
    if (o.minMargin != null && r.margin < o.minMargin / 100) continue;
    if (o.minCount != null && r.venue === 'ah' && r.count < o.minCount) continue;
    if (!o.pets && r.pet) continue;
    if (q && !matchesQuery(catalog, r.id, o.q) && !r.name.toLowerCase().includes(q) && !(r.listingName ?? '').toLowerCase().includes(q)) continue;
    if (o.hideSuspect && r.risk.level === 'suspect') {
      hidden++;
      continue;
    }
    out.push(r);
  }
  return { rows: out, hidden };
}
