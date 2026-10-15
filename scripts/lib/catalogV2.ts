// Pure extraction helpers for catalog v2 fields (shops, books, shard metadata, items API flags).
import type { CatalogBookRule, CatalogItemEntry, CatalogShopOffer } from '../../src/types/contracts.ts';
import { stripFormatting } from '../../src/domain/ids.ts';
import type { ShopOfferRaw } from './neu.ts';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const posNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

// ------------------------------------------------------------------ items API flags
/** Items API fields read for v2 (RawItem only declares a subset). */
export interface ItemsApiFlags {
  category?: string;
  can_auction?: boolean;
  soulbound?: string;
}

/**
 * v2 item flags from an items API entry: `c` = category (except "NONE"), `ah` = 1 unless the item says
 * `can_auction: false` or is soulbound. The API only lists `can_auction` when it is non-default (almost always false),
 * so a missing field means "can be auctioned". Ids absent from the items API get no `ah`.
 */
export function itemApiFlags(a: ItemsApiFlags | undefined): Pick<CatalogItemEntry, 'c' | 'ah'> {
  if (!a) return {};
  const out: Pick<CatalogItemEntry, 'c' | 'ah'> = {};
  if (typeof a.category === 'string' && a.category && a.category !== 'NONE') out.c = a.category;
  if (a.can_auction !== false && !a.soulbound) out.ah = 1;
  return out;
}

// ------------------------------------------------------------------ attribute shards
export type ShardMeta = NonNullable<CatalogItemEntry['sh']>;

/**
 * NEU constants/attribute_shards.json -> bazaar SHARD_* id -> {r: rarity, f?: families, a?: alignment}.
 * Entries whose `bazaarName` is not a bazaar product are skipped.
 */
export function extractShardMeta(json: unknown, bazaarIds: ReadonlySet<string>): Map<string, ShardMeta> {
  const out = new Map<string, ShardMeta>();
  const list = isObj(json) && Array.isArray(json.attributes) ? json.attributes : [];
  for (const x of list as unknown[]) {
    if (!isObj(x) || typeof x.bazaarName !== 'string' || !bazaarIds.has(x.bazaarName)) continue;
    if (typeof x.rarity !== 'string' || !x.rarity) continue;
    const m: ShardMeta = { r: x.rarity };
    const fam = Array.isArray(x.family) ? x.family.filter((f): f is string => typeof f === 'string' && !!f) : [];
    if (fam.length) m.f = fam;
    if (typeof x.alignment === 'string' && x.alignment) m.a = x.alignment;
    out.set(x.bazaarName, m);
  }
  return out;
}

// ------------------------------------------------------------------ shops
/** SkyMart (constants/skymart.json) currency names -> currency ids, matching NEU npc_shop cost ids. */
export const SKYMART_CURRENCY: Readonly<Record<string, string>> = {
  coins: 'SKYBLOCK_COIN',
  copper: 'SKYBLOCK_COPPER',
  gems: 'SKYBLOCK_GEM',
  bits: 'SKYBLOCK_BIT',
  motes: 'SKYBLOCK_MOTE',
  north_stars: 'SKYBLOCK_NORTH_STAR',
};

/** NEU constants/skymart.json ({ NEU_ID: {price, currency} }) -> raw offers of 1 item from `shop`. Unknown currencies are skipped. */
export function skymartOffers(json: unknown, shop = 'SKYMART_NPC'): ShopOfferRaw[] {
  const out: ShopOfferRaw[] = [];
  if (!isObj(json)) return out;
  for (const [id, v] of Object.entries(json)) {
    if (!isObj(v) || !posNum(v.price) || typeof v.currency !== 'string') continue;
    const currency = SKYMART_CURRENCY[v.currency.toLowerCase()];
    if (!currency || !id) continue;
    out.push({ shop, currency, costQty: v.price, result: id, qty: 1 });
  }
  return out;
}

/** "§9SkyMart (NPC)" -> "SkyMart"; falls back to the NEU id. */
export function shopDisplayName(neuId: string, displayName?: string): string {
  const n = displayName ? stripFormatting(displayName).replace(/\s*\(NPC\)\s*$/i, '').trim() : '';
  return n || neuId;
}

export interface BuildShopsOptions {
  /** NEU id -> bazaar-normalized id (outputs and item currencies) */
  norm(neuId: string): string;
  /** keep an offer whose (normalized) output is this id (bazaar product or NPC-sellable) */
  keep(id: string): boolean;
  /** shop NEU id -> label stored in `s` */
  shopName?(neuId: string): string;
  /** currency ids to drop (default: SKYBLOCK_COIN, already covered by `nb`) */
  excludeCurrencies?: ReadonlySet<string>;
}

/**
 * Normalize, filter and dedupe raw shop offers. The first offer per (shop, currency, output, outQty) wins, so pass
 * npc_shop offers before the SkyMart constants. Sorted by shop, output, currency.
 */
export function buildShops(raw: readonly ShopOfferRaw[], opts: BuildShopsOptions): CatalogShopOffer[] {
  const exclude = opts.excludeCurrencies ?? new Set(['SKYBLOCK_COIN']);
  const seen = new Set<string>();
  const out: CatalogShopOffer[] = [];
  for (const r of raw) {
    if (!posNum(r.costQty) || !posNum(r.qty)) continue;
    const cur = opts.norm(r.currency);
    const o = opts.norm(r.result);
    if (exclude.has(cur) || cur === o || !opts.keep(o)) continue;
    const s = opts.shopName ? opts.shopName(r.shop) : r.shop;
    const key = `${s}|${cur}|${o}|${r.qty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ s, cur, cq: r.costQty, o, oq: r.qty });
  }
  return out.sort((a, b) => a.s.localeCompare(b.s) || a.o.localeCompare(b.o) || a.cur.localeCompare(b.cur) || a.oq - b.oq);
}

// ------------------------------------------------------------------ books
/** "ENCHANTMENT_ULTIMATE_WISE_3" -> {base: "ENCHANTMENT_ULTIMATE_WISE", level: 3}; null for anything else. */
export function enchantBase(id: string): { base: string; level: number } | null {
  const m = /^(ENCHANTMENT_.+)_(\d+)$/.exec(id);
  return m ? { base: m[1]!, level: Number(m[2]) } : null;
}

/** NEU constants/enchants.json `max_xp_table_levels` -> UPPER-case enchant name -> table max. */
export function tableMaxLevels(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const t = isObj(json) && isObj(json.max_xp_table_levels) ? json.max_xp_table_levels : {};
  for (const [k, v] of Object.entries(t)) if (posNum(v) && Number.isInteger(v)) out.set(k.toUpperCase(), v);
  return out;
}

/**
 * scripts/data/book-rules.json -> base -> curated anvil max. Shape: `{ groups: [{ $source, max: { BASE: n } }] }`;
 * keys starting with "$" are comments. Throws on malformed entries (the file is hand-written).
 */
export function parseBookRules(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!isObj(json) || !Array.isArray(json.groups)) throw new Error('book-rules: expected { groups: [...] }');
  for (const g of json.groups as unknown[]) {
    if (!isObj(g) || !isObj(g.max)) throw new Error('book-rules: every group needs a "max" object');
    for (const [base, v] of Object.entries(g.max)) {
      if (base.startsWith('$')) continue;
      if (!/^ENCHANTMENT_[A-Z0-9_]+$/.test(base)) throw new Error(`book-rules: bad base id ${base}`);
      if (!posNum(v) || !Number.isInteger(v)) throw new Error(`book-rules: ${base} max must be a positive integer`);
      if (out.has(base)) throw new Error(`book-rules: duplicate ${base}`);
      out.set(base, v);
    }
  }
  return out;
}

export interface ExtraRecipe {
  output: string;
  outCount: number;
  inputs: [string, number][];
}

/**
 * scripts/data/extra-recipes.json -> hand-kept craft recipes NEU lacks. Shape:
 * `{ recipes: [{ output, outCount, inputs: [{ id, qty }], source }] }`; keys starting with "$" are comments.
 * Every entry must name the `source` it was checked against. Throws on malformed entries (the file is hand-written).
 */
export function parseExtraRecipes(json: unknown): ExtraRecipe[] {
  if (!isObj(json) || !Array.isArray(json.recipes)) throw new Error('extra-recipes: expected { recipes: [...] }');
  const id = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || !/^[A-Z0-9_:]+$/.test(v)) throw new Error(`extra-recipes: bad ${what} id ${String(v)}`);
    return v;
  };
  const seen = new Set<string>();
  return (json.recipes as unknown[]).map((r) => {
    if (!isObj(r) || !Array.isArray(r.inputs) || !r.inputs.length) throw new Error('extra-recipes: every recipe needs inputs');
    const output = id(r.output, 'output');
    if (typeof r.source !== 'string' || !r.source.trim()) throw new Error(`extra-recipes: ${output} needs a source`);
    if (!posNum(r.outCount) || !Number.isInteger(r.outCount)) throw new Error(`extra-recipes: ${output} outCount must be a positive integer`);
    if (seen.has(output)) throw new Error(`extra-recipes: duplicate ${output}`);
    seen.add(output);
    const inputs = (r.inputs as unknown[]).map((i): [string, number] => {
      if (!isObj(i) || !posNum(i.qty)) throw new Error(`extra-recipes: ${output} input qty must be positive`);
      return [id(i.id, 'input'), i.qty];
    });
    return { output, outCount: r.outCount, inputs: inputs.sort((a, b) => a[0].localeCompare(b[0])) };
  });
}

/** Extra recipes for outputs NEU has no recipe for (`hasRecipe`); the rest are skipped and reported. */
export function mergeExtraRecipes(extra: readonly ExtraRecipe[], hasRecipe: (id: string) => boolean): { added: ExtraRecipe[]; skipped: string[] } {
  const added: ExtraRecipe[] = [];
  const skipped: string[] = [];
  for (const r of extra) (hasRecipe(r.output) ? skipped.push(r.output) : added.push(r));
  return { added, skipped };
}

/**
 * Book rules for every ENCHANTMENT_<BASE>_<N> bazaar id: `t` = enchanting-table max (NEU), `m` = curated anvil max.
 * Bases with neither are omitted.
 */
export function buildBookRules(
  bazaarIds: Iterable<string>,
  tableMax: ReadonlyMap<string, number>,
  curated: ReadonlyMap<string, number>,
): Record<string, CatalogBookRule> {
  const bases = new Set<string>();
  for (const id of bazaarIds) {
    const e = enchantBase(id);
    if (e) bases.add(e.base);
  }
  const out: Record<string, CatalogBookRule> = {};
  for (const base of [...bases].sort()) {
    const r: CatalogBookRule = {};
    const t = tableMax.get(base.slice('ENCHANTMENT_'.length));
    if (t !== undefined) r.t = t;
    const m = curated.get(base);
    if (m !== undefined) r.m = m;
    if (r.t !== undefined || r.m !== undefined) out[base] = r;
  }
  return out;
}
