// Pure helpers for the craft view: URL/query schema, legacy prefs migration, row filtering, market-line math.
import { LS_VIEWPREFS, RISK } from '../../../config.ts';
import { walkBook } from '../../../domain/book.ts';
import { afterTax, buyQuote, sellQuote } from '../../../domain/pricing.ts';
import { matchesQuery } from '../../../domain/search.ts';
import { lsGet, lsSet } from '../../../storage/local.ts';
import type { Catalog, CraftRow, Product } from '../../../types/contracts.ts';
import { locale } from '../../format.ts';
import type { QuerySchema, QueryValues } from '../../kit/index.ts';

export type KindFilter = 'all' | 'craft' | 'forge';
export type MarketFilter = 'all' | 'bazaar' | 'off';

/** Sortable table column keys (also the valid `sort` keys in the URL). */
export const SORT_KEYS = ['name', 'count', 'cost', 'value', 'profit', 'margin', 'outRate', 'inRate', 'limited', 'slots', 'pph', 'risk'] as const;

/** Filters + sort, mirrored in the URL (#/craft?q=…&kind=forge) and in localStorage. */
export const SCHEMA = {
  q: { kind: 'string', def: '' },
  kind: { kind: 'enum', def: 'all', values: ['all', 'craft', 'forge'] },
  market: { kind: 'enum', def: 'all', values: ['all', 'bazaar', 'off'] },
  /** min output volume, crafts/week (outCraftsPerHour * 168) */
  minVol: { kind: 'number', def: 1000, min: 0 },
  /** min margin, percent */
  minMargin: { kind: 'number', def: 1 },
  /** min profit/hour, coins */
  minPph: { kind: 'number', def: null },
  unpriced: { kind: 'bool', def: false },
  suspect: { kind: 'bool', def: false },
  sort: { kind: 'sort', def: { key: 'pph', dir: 'desc' }, keys: SORT_KEYS },
} as const satisfies QuerySchema;

export type CraftQuery = QueryValues<typeof SCHEMA>;

export const PREFS_KEY = LS_VIEWPREFS + 'craft';

/**
 * Round 1 stored typed prefs ({minVol: 1000, minMargin: null, showUnpriced: true, sort: {key, dir}}) under the same key;
 * bindQueryState expects URL-encoded strings. Rewrite the old shape in place (no-op when already strings).
 */
export function migrateLegacyPrefs(): void {
  const raw = lsGet<unknown>(PREFS_KEY, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const r = raw as Record<string, unknown>;
  if (Object.values(r).every((v) => typeof v === 'string')) return;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    const key = k === 'showUnpriced' ? 'unpriced' : k;
    if (!(key in SCHEMA)) continue;
    if (typeof v === 'string') out[key] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = String(v);
    else if (v === null) out[key] = 'none';
    else if (typeof v === 'boolean') out[key] = v ? '1' : '0';
    else if (key === 'sort' && v && typeof v === 'object') {
      const s = v as Record<string, unknown>;
      if (typeof s.key === 'string' && (s.dir === 'asc' || s.dir === 'desc')) out.sort = `${s.key}.${s.dir}`;
    }
  }
  lsSet(PREFS_KEY, out);
}

export interface FilterOpts {
  q: string;
  /** crafts/week; null = no minimum */
  minVol: number | null;
  /** percent; null = no minimum */
  minMargin: number | null;
  /** coins/hour; null = no minimum */
  minPph: number | null;
  kind: KindFilter;
  market: MarketFilter;
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
  /** unpriced rows that matched kind/market/search but were hidden */
  unpricedHidden: number;
}

/** Search hits the output or any ingredient (display name or id). */
export function rowMatchesQuery(catalog: Catalog | null, r: CraftRow, q: string): boolean {
  if (!q.trim()) return true;
  if (matchesQuery(catalog, r.id, q)) return true;
  return r.recipe.inputs.some((i) => matchesQuery(catalog, i.id, q));
}

const fin = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

/** Filter computed rows (cheap filters first, the text search last). */
export function filterCrafts(all: readonly CraftRow[], o: FilterOpts, catalog: Catalog | null): FilterResult {
  const rows: CraftRow[] = [];
  let hidden = 0;
  let suspect = 0;
  let unpricedHidden = 0;
  const minWeek = fin(o.minVol) ? o.minVol : -Infinity;
  const minM = fin(o.minMargin) ? o.minMargin / 100 : -Infinity;
  const minP = fin(o.minPph) ? o.minPph : -Infinity;
  for (const r of all) {
    if (o.kind !== 'all' && r.recipe.kind !== o.kind) continue;
    if (o.market !== 'all' && !!r.outputOffBazaar !== (o.market === 'off')) continue;
    if (r.unpriced.length > 0) {
      if (!o.showUnpriced) {
        if (rowMatchesQuery(catalog, r, o.q)) unpricedHidden++;
        continue;
      }
    } else {
      if (!(r.outCraftsPerHour * 168 >= minWeek)) continue;
      if (r.margin == null || r.margin < minM) continue;
      if (!(r.profitPerHour >= minP)) continue;
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
  return { rows, hidden, suspect, unpricedHidden };
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

/** An item's own order→offer flip margin after tax (legacy "tek başına flip marjı"); null when a side is missing. */
export function ownFlipMargin(p: Product | undefined, taxRate: number, npcSell?: number): number | null {
  if (!p) return null;
  const b = buyQuote(p, 'order', undefined, npcSell);
  const s = sellQuote(p, 'offer');
  if (!b || !s || !(b.price > 0)) return null;
  return (afterTax(s.price, taxRate) - b.price) / b.price;
}

/** Fewer than RISK.fewOrders orders on either side (the FEW_ORDERS risk rule). */
export function fewOrders(p: Product | undefined): boolean {
  if (!p) return false;
  return Math.min(p.quick.buyOrders || 0, p.quick.sellOrders || 0) < RISK.fewOrders;
}

export interface Slip {
  /** units in the batch */
  qty: number;
  /** price of the first unit (top of book) */
  one: number;
  /** average price over the batch */
  batch: number;
  /** units the book could fill (< qty when depth runs out) */
  filled: number;
  /** (batch - one) / one */
  pct: number;
}

/** Walk one side of the book for 1 unit and for `qty` units; null when the side is empty. */
export function slippage(levels: Product['asks'], qty: number): Slip | null {
  const one = walkBook(levels, 1);
  const all = walkBook(levels, Math.max(1, qty));
  if (!one || !all || !(one.avgPrice > 0)) return null;
  return { qty: Math.max(1, qty), one: one.avgPrice, batch: all.avgPrice, filled: all.filled, pct: (all.avgPrice - one.avgPrice) / one.avgPrice };
}

/** Crafts per batch the domain re-quoted insta legs at (craft.ts refine pass). */
export function batchCrafts(r: CraftRow): number {
  return r.tp.batchQty > 0 ? Math.max(1, Math.ceil(r.tp.batchQty)) : 1;
}
