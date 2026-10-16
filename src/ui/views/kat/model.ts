// Kat upgrades page model: URL schema and row filtering (no DOM or CSS, so scripts/smoke.ts can import it).
import { KAT } from '../../../config.ts';
import type { KatBand, KatRow } from '../../../domain/kat.ts';
import { matchesQuery } from '../../../domain/search.ts';
import type { AppState } from '../../../types/contracts.ts';
import type { QuerySchema, QueryValues } from '../../kit/index.ts';

/** Highest Taming level in the game: the default (no rows dropped). */
export const KAT_MAX_TAMING = 60;

const SORT_KEYS = ['name', 'tiers', 'band', 'buy', 'upgrade', 'sell', 'profit', 'margin', 'hours', 'pph', 'risk'] as const;

export const KAT_SCHEMA = {
  q: { kind: 'string', def: '' },
  minProfit: { kind: 'number', def: 100_000, min: 0 },
  maxCapital: { kind: 'number', def: null, min: 0 },
  maxHours: { kind: 'number', def: null, min: 0 },
  taming: { kind: 'number', def: KAT_MAX_TAMING, min: 0, max: KAT_MAX_TAMING },
  band: { kind: 'enum', def: 'both', values: ['both', 'any', 'max'] },
  skip: { kind: 'bool', def: false },
  unpriced: { kind: 'bool', def: false },
  suspect: { kind: 'bool', def: false },
  sort: { kind: 'sort', def: { key: 'pph', dir: 'desc' }, keys: SORT_KEYS },
} as const satisfies QuerySchema;

export type KatQuery = QueryValues<typeof KAT_SCHEMA>;

export interface KatFilters {
  q: string;
  minProfit: number | null;
  maxCapital: number | null;
  maxHours: number | null;
  /** your Taming level; null = no limit */
  taming: number | null;
  band: KatBand | 'both';
  showUnpriced: boolean;
  hideSuspect: boolean;
}

/**
 * Filter rows: Taming level (KAT.tamingReq of the target rarity), band, thresholds, search (pet name, id or listing),
 * unpriced rows unless shown (they skip the profit threshold: they have no profit), suspect rows when hidden.
 */
export function filterKat(rows: readonly KatRow[], o: KatFilters, catalog: AppState['catalog']): { rows: KatRow[]; hidden: number } {
  const out: KatRow[] = [];
  let hidden = 0;
  const q = o.q.trim().toLowerCase();
  for (const r of rows) {
    const unpriced = r.unpriced.length > 0;
    if (unpriced && !o.showUnpriced) continue;
    if (o.taming != null && (KAT.tamingReq[r.to] ?? 0) > o.taming) continue;
    if (o.band !== 'both' && r.band !== o.band) continue;
    if (!unpriced && o.minProfit != null && r.profit < o.minProfit) continue;
    if (o.maxCapital != null && r.capital > o.maxCapital) continue;
    if (o.maxHours != null && r.hours > o.maxHours) continue;
    if (q && !r.name.toLowerCase().includes(q) && !(r.listingName ?? '').toLowerCase().includes(q) && !matchesQuery(catalog, r.pet, o.q))
      continue;
    if (o.hideSuspect && r.risk.level === 'suspect') {
      hidden++;
      continue;
    }
    out.push(r);
  }
  return { rows: out, hidden };
}
