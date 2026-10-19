// Bits shop page model: URL schema, row filtering and the multiplier helpers (no DOM or CSS, so scripts/smoke.ts can
// import it).
import { BITS } from '../../../config.ts';
import { bitsMultiplier, type BitsRow } from '../../../domain/bits.ts';
import { matchesQuery } from '../../../domain/search.ts';
import type { AppState } from '../../../types/contracts.ts';
import type { QuerySchema, QueryValues } from '../../kit/index.ts';

const SORT_KEYS = ['name', 'bits', 'value', 'source', 'cpb', 'vs', 'liq', 'risk'] as const;

export const BITS_SCHEMA = {
  q: { kind: 'string', def: '' },
  minCpb: { kind: 'number', def: null, min: 0 },
  src: { kind: 'enum', def: 'all', values: ['all', 'bazaar', 'ah'] },
  /** untradeable and unpriced offers */
  unsold: { kind: 'bool', def: false },
  suspect: { kind: 'bool', def: false },
  sort: { kind: 'sort', def: { key: 'cpb', dir: 'desc' }, keys: SORT_KEYS },
} as const satisfies QuerySchema;

export type BitsQuery = QueryValues<typeof BITS_SCHEMA>;

export interface BitsFilters {
  q: string;
  minCpb: number | null;
  src: string;
  /** show untradeable and unpriced rows */
  unsold: boolean;
  hideSuspect: boolean;
}

/** Filter rows: search, min coins per bit, value source, unsold rows unless shown, suspect rows when hidden. */
export function filterBitsRows(rows: readonly BitsRow[], o: BitsFilters, catalog: AppState['catalog']): { rows: BitsRow[]; hidden: number } {
  const out: BitsRow[] = [];
  let hidden = 0;
  const q = o.q.trim().toLowerCase();
  for (const r of rows) {
    if (!o.unsold && (r.untradeable || r.value == null)) continue;
    if (o.minCpb != null && (r.coinsPerBit == null || r.coinsPerBit < o.minCpb)) continue;
    if (o.src !== 'all' && r.valueSource !== o.src) continue;
    if (q && !matchesQuery(catalog, r.id, o.q) && !r.name.toLowerCase().includes(q)) continue;
    if (o.hideSuspect && r.risk?.level === 'suspect') {
      hidden++;
      continue;
    }
    out.push(r);
  }
  return { rows: out, hidden };
}

/** The old page's prefs under LS_BITS (before settings.bitsMultiplier): the fame rank, and a custom multiplier. */
export interface BitsPrefs {
  rank: string;
  custom: number | null;
}

export const DEFAULT_BITS_PREFS: BitsPrefs = { rank: BITS.fameRanks[0]![0], custom: null };

/** Stored prefs, cleaned: unknown ranks fall back to New Player, non-positive custom values to none. */
export function parseBitsPrefs(raw: unknown): BitsPrefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BITS_PREFS };
  const x = raw as Record<string, unknown>;
  const rank = BITS.fameRanks.some(([n]) => n === x.rank) ? (x.rank as string) : DEFAULT_BITS_PREFS.rank;
  const custom = typeof x.custom === 'number' && Number.isFinite(x.custom) && x.custom > 0 ? x.custom : null;
  return { rank, custom };
}

/** Valid settings.bitsMultiplier values (sanitizeSettings keeps 1..5). */
export const MULT_MIN = 1;
export const MULT_MAX = 5;
export const validMultiplier = (n: number): boolean => Number.isFinite(n) && n >= MULT_MIN && n <= MULT_MAX;

/** The multiplier the old prefs meant, clamped to the settings range; null when nothing was stored. */
export function legacyMultiplier(raw: unknown): number | null {
  if (raw == null) return null;
  const p = parseBitsPrefs(raw);
  return Math.min(MULT_MAX, Math.max(MULT_MIN, bitsMultiplier(p.rank, p.custom)));
}

/** The fame rank whose multiplier is `m`, null for a custom value. */
export function rankOf(m: number): string | null {
  return BITS.fameRanks.find(([, , x]) => x === m)?.[0] ?? null;
}
