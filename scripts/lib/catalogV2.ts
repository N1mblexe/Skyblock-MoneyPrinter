// Pure extraction helpers for catalog v2 fields (shops, books, shard metadata, items API flags).
import type { CatalogBookRule, CatalogItemEntry, CatalogShopOffer } from '../../src/types/contracts.ts';
import { stripFormatting } from '../../src/domain/ids.ts';
import type { KatStepRaw, NeuItem, ShopOfferRaw } from './neu.ts';

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
  /** keep an offer whose (normalized) output is `id`, paid in (normalized) `currency`; see shopKeep */
  keep(id: string, currency: string): boolean;
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
    if (exclude.has(cur) || cur === o || !opts.keep(o, cur)) continue;
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

// ------------------------------------------------------------------ bits shop
export const BITS_CURRENCY = 'SKYBLOCK_BIT';

export interface BitsRules {
  /** bits-shop offers NEU lacks: 1 x `output` for `bits` */
  extraOffers: { output: string; bits: number }[];
  /** ids sold on the AH although the items API does not list them */
  auctionable: string[];
  /** bits-shop outputs that cannot be traded (kept in the shop list, marked in catalog.untradeable) */
  untradeable: string[];
}

/**
 * scripts/data/bits-rules.json -> BitsRules. Shape: `{ extraOffers: [{ output, bits, source }], auctionable: [{ id, source }],
 * untradeable: [{ id, source }] }` (all three lists optional); keys starting with "$" are comments. Every entry must name
 * the `source` it was checked against. Throws on malformed entries (the file is hand-written).
 */
export function parseBitsRules(json: unknown): BitsRules {
  if (!isObj(json)) throw new Error('bits-rules: expected an object');
  const list = (k: string): Record<string, unknown>[] => {
    const v = json[k] ?? [];
    if (!Array.isArray(v)) throw new Error(`bits-rules: ${k} must be an array`);
    return v.map((e) => {
      if (!isObj(e)) throw new Error(`bits-rules: every ${k} entry must be an object`);
      return e;
    });
  };
  const id = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || !/^[A-Z0-9_:]+$/.test(v)) throw new Error(`bits-rules: bad ${what} id ${String(v)}`);
    return v;
  };
  const source = (e: Record<string, unknown>, what: string) => {
    if (typeof e.source !== 'string' || !e.source.trim()) throw new Error(`bits-rules: ${what} needs a source`);
  };
  const uniq = (k: string, ids: string[]) => {
    const dup = ids.find((x, i) => ids.indexOf(x) !== i);
    if (dup) throw new Error(`bits-rules: duplicate ${k} ${dup}`);
    return ids;
  };
  const extraOffers = list('extraOffers').map((e) => {
    const output = id(e.output, 'output');
    source(e, output);
    if (!posNum(e.bits) || !Number.isInteger(e.bits)) throw new Error(`bits-rules: ${output} bits must be a positive integer`);
    return { output, bits: e.bits };
  });
  uniq('extraOffers', extraOffers.map((o) => o.output));
  const ids = (k: string) =>
    uniq(k, list(k).map((e) => {
      const x = id(e.id, k);
      source(e, x);
      return x;
    }));
  return { extraOffers, auctionable: ids('auctionable'), untradeable: ids('untradeable') };
}

/**
 * Shop keep rule: any offer whose output can be sold (bazaar product or NPC-sellable, `sellable`); bits offers also
 * when the output is auctionable (`auctionable`, from the items API) or named in bits-rules (auctionable / untradeable).
 */
export function shopKeep(
  sellable: (id: string) => boolean,
  auctionable: (id: string) => boolean,
  rules: Pick<BitsRules, 'auctionable' | 'untradeable'>,
): (id: string, currency: string) => boolean {
  const listed = new Set([...rules.auctionable, ...rules.untradeable]);
  return (id, currency) => sellable(id) || (currency === BITS_CURRENCY && (auctionable(id) || listed.has(id)));
}

/** bits-rules extra offers as raw Elizabeth offers, except outputs NEU already sells for bits (`hasOffer`, reported). */
export function mergeBitsOffers(
  extra: BitsRules['extraOffers'],
  hasOffer: (id: string) => boolean,
  shop = 'ELIZABETH_NPC',
): { added: ShopOfferRaw[]; skipped: string[] } {
  const added: ShopOfferRaw[] = [];
  const skipped: string[] = [];
  for (const x of extra) {
    if (hasOffer(x.output)) skipped.push(x.output);
    else added.push({ shop, currency: BITS_CURRENCY, costQty: x.bits, result: x.output, qty: 1 });
  }
  return { added, skipped };
}

// ------------------------------------------------------------------ Kat upgrades
/** catalog.kat entry: pet `p` from rarity `f` to `t` for `c` coins + items `i` ([id, qty], omitted when none), `s` seconds. */
export interface CatalogKatEntry {
  p: string;
  f: number;
  t: number;
  c: number;
  s: number;
  i?: [string, number][];
}

/** Highest rarity index kept: COMMON..MYTHIC = 0..5 (the AH pet tiers). NEU's SPECIAL/VERY_SPECIAL steps (7/8, e.g. Phoenix) are dropped. */
export const MAX_KAT_TIER = 5;

/**
 * Raw katgrade steps -> catalog.kat: ingredient ids normalized (`norm`, so LOG-3 matches the bazaar LOG:3) and merged,
 * steps above MAX_KAT_TIER dropped, the first step per (pet, from, to) kept. Sorted by pet, then from.
 */
export function buildKatSteps(raw: readonly KatStepRaw[], norm: (neuId: string) => string): { steps: CatalogKatEntry[]; dropped: string[]; duplicates: number } {
  const seen = new Set<string>();
  const steps: CatalogKatEntry[] = [];
  const dropped: string[] = [];
  let duplicates = 0;
  for (const r of raw) {
    const key = `${r.pet};${r.from}>${r.to}`;
    if (r.from > MAX_KAT_TIER || r.to > MAX_KAT_TIER) {
      dropped.push(key);
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const merged = new Map<string, number>();
    for (const s of r.items) {
      const id = norm(s.id);
      merged.set(id, (merged.get(id) ?? 0) + s.qty);
    }
    const e: CatalogKatEntry = { p: r.pet, f: r.from, t: r.to, c: r.coins, s: r.seconds };
    if (merged.size) e.i = [...merged].sort((a, b) => a[0].localeCompare(b[0]));
    steps.push(e);
  }
  steps.sort((a, b) => a.p.localeCompare(b.p) || a.f - b.f || a.t - b.t);
  return { steps, dropped, duplicates };
}

// ------------------------------------------------------------------ pets
/**
 * catalog.petLeveling: `o` = rarity -> start index into `l`, `l` = XP to the next level, `c` = per-pet overrides
 * (`l` = extra levels, `a` = 1 when `l` is appended to the base table instead of replacing it, `m` = max level).
 */
export interface CatalogPetLeveling {
  o: Record<string, number>;
  l: number[];
  c: Record<string, { l?: number[]; a?: 1; m?: number }>;
}

const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * NEU constants/pets.json -> catalog.petLeveling (null without `pet_levels`). In `custom_pet_leveling`, NEU's
 * `type: 1` appends `pet_levels` to the base table (Golden Dragon: base 20..118 = levels 1..100 at LEGENDARY, plus 100
 * more for 101..200), any other type replaces it. Overrides that PetLeveling cannot carry (per-pet `rarity_offset`,
 * `xp_multiplier`) are reported in `ignored` as "PET.field".
 */
export function extractPetLeveling(json: unknown): { leveling: CatalogPetLeveling | null; ignored: string[] } {
  const ignored: string[] = [];
  if (!isObj(json) || !Array.isArray(json.pet_levels)) return { leveling: null, ignored };
  const l = json.pet_levels.filter(posNum);
  if (!l.length || l.length !== json.pet_levels.length) return { leveling: null, ignored };
  const o: Record<string, number> = {};
  if (isObj(json.pet_rarity_offset)) for (const [k, v] of Object.entries(json.pet_rarity_offset)) if (nonNegInt(v)) o[k] = v;
  const c: CatalogPetLeveling['c'] = {};
  if (isObj(json.custom_pet_leveling)) {
    for (const [pet, v] of Object.entries(json.custom_pet_leveling)) {
      if (!isObj(v)) continue;
      const e: CatalogPetLeveling['c'][string] = {};
      if (Array.isArray(v.pet_levels) && v.pet_levels.length && v.pet_levels.every(posNum)) {
        e.l = v.pet_levels as number[];
        if (v.type === 1) e.a = 1;
      }
      if (posNum(v.max_level) && Number.isInteger(v.max_level)) e.m = v.max_level;
      for (const k of Object.keys(v)) if (!['pet_levels', 'type', 'max_level'].includes(k)) ignored.push(`${pet}.${k}`);
      if (e.l || e.m) c[pet] = e;
    }
  }
  return { leveling: { o, l, c }, ignored };
}

const PET_FILE = /^([A-Z0-9_]+);\d+$/;

/**
 * Pet type -> display name, from NEU pet item files ("[Lvl {LVL}] Ocelot" in OCELOT;2.json -> "Ocelot"), then
 * constants/pets.json `id_to_display_name` on top (it only lists overrides, e.g. TYRANNOSAURUS -> T-Rex). Sorted by type.
 */
export function petDisplayNames(items: readonly NeuItem[], petsJson: unknown): Record<string, string> {
  const m = new Map<string, string>();
  for (const it of items) {
    const pet = PET_FILE.exec(it.internalname);
    if (!pet || !it.displayname?.includes('{LVL}') || m.has(pet[1]!)) continue;
    const n = stripFormatting(it.displayname).replace(/\[Lvl \{LVL\}\]\s*/g, '').replace(/\s+/g, ' ').trim();
    if (n) m.set(pet[1]!, n);
  }
  const over = isObj(petsJson) && isObj(petsJson.id_to_display_name) ? petsJson.id_to_display_name : {};
  for (const [k, v] of Object.entries(over)) if (typeof v === 'string' && v.trim()) m.set(k, stripFormatting(v));
  return Object.fromEntries([...m].sort((a, b) => a[0].localeCompare(b[0])));
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
