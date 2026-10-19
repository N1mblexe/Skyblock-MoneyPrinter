// Pure helpers for the craft view: URL/query schema, legacy prefs migration, row filtering, market-line math.
import { LS_VIEWPREFS, RISK } from '../../../config.ts';
import { walkBook } from '../../../domain/book.ts';
import { afterTax, buyQuote, sellQuote } from '../../../domain/pricing.ts';
import { matchesQuery } from '../../../domain/search.ts';
import { lsGet, lsSet } from '../../../storage/local.ts';
import { t } from '../../../i18n/index.ts';
import type { Catalog, ChainRow, CraftRow, Product, Recipe } from '../../../types/contracts.ts';
import { fmtInt, locale } from '../../format.ts';
import type { QuerySchema, QueryValues } from '../../kit/index.ts';

export type KindFilter = 'all' | 'craft' | 'forge';
/** Recipes shown by a recipes pane: the Craft page or the Forge page. */
export type RecipeKind = 'craft' | 'forge';
export type MarketFilter = 'all' | 'bazaar' | 'off';
/** Craft page: crafting recipes, shop trades (items bought from an NPC with other items), or both. */
export type SourceFilter = 'craft' | 'shop' | 'all';

/** Recipe kinds a recipes pane lists: the Forge page its forges, the Craft page crafts and / or shop trades. */
export function kindsOf(kind: RecipeKind, src: SourceFilter): ReadonlySet<Recipe['kind']> {
  if (kind === 'forge') return new Set(['forge']);
  return new Set(src === 'all' ? ['craft', 'shop'] : [src]);
}

/** Sortable table column keys (also the valid `sort` keys in the URL). */
export const SORT_KEYS = ['name', 'duration', 'count', 'cost', 'value', 'profit', 'margin', 'outRate', 'inRate', 'limited', 'slots', 'pph', 'risk'] as const;

/** Filters + sort, mirrored in the URL (#/craft?q=…, #/forge?q=…) and in localStorage (one key per page). */
export const SCHEMA = {
  q: { kind: 'string', def: '' },
  /** Craft page only: crafting recipes, shop trades or both */
  src: { kind: 'enum', def: 'craft', values: ['craft', 'shop', 'all'] },
  market: { kind: 'enum', def: 'all', values: ['all', 'bazaar', 'off'] },
  /** min output volume of bazaar-sold rows, crafts/week (outCraftsPerHour * 168) */
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
export const FORGE_PREFS_KEY = LS_VIEWPREFS + 'forge';
export const prefsKeyFor = (kind: RecipeKind) => (kind === 'forge' ? FORGE_PREFS_KEY : PREFS_KEY);

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
  /** crafts/week of bazaar-sold rows; null = no minimum */
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
      // a bazaar market's volume; AH and NPC sales are bounded in profit/hour instead (AH sales rate, no limit)
      if (r.valueSource === 'bazaar' && !(r.outCraftsPerHour * 168 >= minWeek)) continue;
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

// ---------------------------------------------------------------- tabs (Recipes | Chains)

export type CraftTab = 'recipes' | 'chains';

/** The tab a route shows: `#/craft?view=chains` is the Chains tab, anything else Recipes. */
export const tabOf = (query: Record<string, string> | undefined): CraftTab => (query?.view === 'chains' ? 'chains' : 'recipes');

/** Tab switch shown in both panes' headers; clicks are handled by the craft view (data-craft-tab). Labels: relabelTabs. */
export function tabsHtml(active: CraftTab): string {
  const tab = (id: CraftTab, key: string) =>
    `<button type="button" class="craft-tab" data-craft-tab="${id}" data-testid="craft-tab-${id}" aria-pressed="${id === active}" data-i18n="${key}"></button>`;
  return `<div class="seg craft-tabs" role="group" data-i18n-aria="craft.tabsLabel">${tab('recipes', 'craft.tabRecipes')}${tab('chains', 'craft.tabChains')}</div>`;
}

/** (Re)translate [data-i18n] text and [data-i18n-aria] labels under `root`. */
export function relabel(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n!)));
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria!)));
}

// ---------------------------------------------------------------- chains tab

export const CHAIN_SORT_KEYS = ['name', 'steps', 'need', 'sides', 'cost', 'value', 'profit', 'margin', 'limited', 'slots', 'pph', 'risk'] as const;

/** Chains tab filters + sort (#/craft?view=chains&…); stored apart from the Recipes tab. */
export const CHAIN_SCHEMA = {
  q: { kind: 'string', def: '' },
  /** only the most profitable move (profit/hour) of each ladder */
  best: { kind: 'bool', def: true },
  minSteps: { kind: 'number', def: 2, min: 2 },
  /** where the first tier is bought */
  start: { kind: 'enum', def: 'bazaar', values: ['bazaar', 'cheapest'] },
  /** percent */
  minMargin: { kind: 'number', def: 1 },
  minPph: { kind: 'number', def: null },
  unpriced: { kind: 'bool', def: false },
  suspect: { kind: 'bool', def: false },
  sort: { kind: 'sort', def: { key: 'pph', dir: 'desc' }, keys: CHAIN_SORT_KEYS },
} as const satisfies QuerySchema;

export type ChainQuery = QueryValues<typeof CHAIN_SCHEMA>;

export const CHAIN_PREFS_KEY = LS_VIEWPREFS + 'craft.chains';

export interface ChainFilterOpts {
  q: string;
  /** keys allowed by the "best per ladder" filter; null = every move */
  only: ReadonlySet<string> | null;
  minSteps: number | null;
  minMargin: number | null;
  minPph: number | null;
  showUnpriced: boolean;
  hideSuspect: boolean;
}

export interface ChainFilterResult {
  rows: ChainRow[];
  hidden: number;
  suspect: number;
  unpricedHidden: number;
}

/** Search hits any tier of the move or a side ingredient. */
export function chainMatchesQuery(catalog: Catalog | null, r: ChainRow, q: string): boolean {
  if (!q.trim()) return true;
  return r.path.some((id) => matchesQuery(catalog, id, q)) || r.row.recipe.inputs.some((i) => matchesQuery(catalog, i.id, q));
}

export function filterChains(all: readonly ChainRow[], o: ChainFilterOpts, catalog: Catalog | null): ChainFilterResult {
  const rows: ChainRow[] = [];
  let hidden = 0;
  let suspect = 0;
  let unpricedHidden = 0;
  const minM = fin(o.minMargin) ? o.minMargin / 100 : -Infinity;
  const minP = fin(o.minPph) ? o.minPph : -Infinity;
  const minS = fin(o.minSteps) ? o.minSteps : 0;
  for (const r of all) {
    if (r.steps < minS) continue;
    const unpriced = r.row.unpriced.length > 0;
    if (unpriced) {
      if (!o.showUnpriced) {
        if (chainMatchesQuery(catalog, r, o.q)) unpricedHidden++;
        continue;
      }
    } else {
      if (o.only && !o.only.has(r.key)) continue;
      if (r.row.margin == null || r.row.margin < minM) continue;
      if (!(r.row.profitPerHour >= minP)) continue;
    }
    if (!chainMatchesQuery(catalog, r, o.q)) continue;
    if (r.row.risk.level === 'suspect' && !unpriced) {
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

/** Quantities: grouped integers, or 2 significant digits for fractions (chain side inputs can be 0.25 per output). */
export const fmtQty = (n: number): string => (Number.isInteger(n) ? fmtInt(n) : fmtRate(n));

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
