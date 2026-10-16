// Kat upgrades: buy a pet on the AH, take it up one or more rarities at Kat (coins + items + a wait), sell it on the AH.
// Kat's coin price drops KAT.levelDiscount per pet level. The pet keeps its XP through an upgrade, but higher rarities
// need more XP per level, so its level is recomputed at each rarity (a level 100 Epic is a lower-level Legendary).
// Kat flowers / bouquets can skip the wait (one item per upgrade, so skipping is priced per step).
import { AH, AH_FLIP, KAT } from '../config.ts';
import type { AhPrice, AhSnapshot, CalcCtx, KatStep, PetLeveling, QuoteSource, RiskFlag, RiskReport, Throughput } from '../types/contracts.ts';
import { petName } from './ahFlips.ts';
import { createCraftPricer } from './craft.ts';
import { petLevelFromName } from './ids.ts';
import { ahNet } from './pricing.ts';
import { reportFromFlags } from './risk.ts';

/** Rarity names by index (PetLeveling.offsets keys); game data, so not translated. */
export const KAT_RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'] as const;

/**
 * Hours on top of Kat's wait for the two AH legs: the BIN buy is instant, but the finished pet has to sell. One hour
 * is an optimistic guess for a pet listed at the lowest BIN; it mostly keeps instant (fully skipped) upgrades finite.
 */
export const KAT_TRADE_HOURS = 1;

/** AH scan version Kat rows need (pet `exp` and the `@MAX` keys): the page and derived.kat() both gate on it. */
export const KAT_MIN_SCAN = 3;
export const katScanReady = (ah: Pick<AhSnapshot, 'v'> | null): boolean => ah?.v != null && ah.v >= KAT_MIN_SCAN;

/** Pet levels end at 100 unless PetLeveling.custom says otherwise. */
const DEFAULT_MAX_LEVEL = 100;

/** 'any': the cheapest listing of any level (`PET;i`); 'max': the cheapest max-level listing (`PET;i@MAX`). */
export type KatBand = 'any' | 'max';
export const KAT_BANDS: readonly KatBand[] = ['any', 'max'];

/** 'flowers': skip each step's wait with Kat Flowers / Bouquets. */
export type KatSkip = 'none' | 'flowers';

export interface KatOptions {
  /** default 'none' */
  skip?: KatSkip;
  /** your Taming level: rows whose target rarity needs more (KAT.tamingReq) are dropped; omitted = no filter */
  taming?: number;
}

/** One priced item (a step ingredient or a skip item). */
export interface KatItemLine {
  id: string;
  name: string;
  qty: number;
  /** per-unit cost (0 when unpriced) */
  unit: number;
  total: number;
  /** null when no market has it */
  source: QuoteSource | 'ah' | null;
}

export interface KatStepLine {
  from: number;
  to: number;
  /** pet level when it goes in (at `from`) and when it comes out (at `to`) */
  levelBefore: number;
  levelAfter: number;
  /** Kat's list price, and after the level discount */
  baseCoins: number;
  coins: number;
  items: KatItemLine[];
  itemsCost: number;
  /** Kat's wait, and what is left of it after the skip items */
  baseHours: number;
  hours: number;
  /** flowers / bouquets used on this step (empty without the skip option) */
  skip: KatItemLine[];
  skipCost: number;
}

export interface KatRow {
  /** unique: `${pet};${from}>${to}:${band}` */
  key: string;
  /** the buy key (`PET;i` or `PET;i@MAX`) */
  id: string;
  pet: string;
  /** "Ocelot" (catalog pet name, else from the listing) */
  name: string;
  from: number;
  to: number;
  band: KatBand;
  /** lowest BIN you pay */
  buy: number;
  buyCount: number;
  /** cheapest listing, for /viewauction */
  uuid?: string;
  listingName?: string;
  /** pet level as bought and as sold */
  levelStart: number;
  levelEnd: number;
  /** max level of the pet */
  maxLevel: number;
  /** false when the XP table or the listing's XP is missing and the level is a guess by band */
  levelKnown: boolean;
  /** AH key the sale is priced from (`PET;j@MAX` for a max-level pet when listed, else `PET;j`) */
  sellKey: string;
  /** lowest BIN of sellKey (your listing price), and what it leaves after the listing fee and claim tax */
  sell: number;
  sellNet: number;
  sellCount: number;
  coins: number;
  itemsCost: number;
  skipCost: number;
  /** coins + items + skip */
  upgradeCost: number;
  /** buy + upgradeCost: coins tied up per pet */
  capital: number;
  /** Kat's wait summed over steps, and after skipping */
  baseHours: number;
  katHours: number;
  /** katHours + KAT_TRADE_HOURS */
  hours: number;
  /** sellNet − capital (0 when unpriced) */
  profit: number;
  margin: number;
  profitPerHour: number;
  /** one pet at Kat at a time */
  tp: Throughput;
  steps: KatStepLine[];
  risk: RiskReport;
  /** ids without a price (items, or the sell key); such rows have profit 0 */
  unpriced: string[];
}

const maxKey = (key: string) => key + AH.petMaxSuffix;

/**
 * The scanner (no catalog in its worker) files `@MAX` by a hand-kept list of 200-level pets; trust such an entry only
 * when its listing's level matches the catalog's max level for the pet.
 */
const maxOk = (p: AhPrice, maxLevel: number): boolean => {
  const lvl = petLevelFromName(p.name);
  return lvl == null || lvl === maxLevel;
};

interface Curve {
  /** XP to the next level, from level 1 */
  table: number[];
  max: number;
}

/** XP curve of `pet` at rarity index `r`; null without a leveling table or an offset for that rarity. */
export function petCurve(pl: PetLeveling | null, pet: string, r: number): Curve | null {
  const off = pl?.offsets[KAT_RARITIES[r] ?? ''];
  if (!pl || off == null) return null;
  const c = pl.custom[pet];
  const max = c?.maxLevel ?? DEFAULT_MAX_LEVEL;
  // append: the pet's own levels go after the base table's 100-level slice (Golden Dragon 101..200); else they replace it
  const table = c?.levels && c.append ? pl.levels.slice(off, off + DEFAULT_MAX_LEVEL - 1).concat(c.levels) : (c?.levels ?? pl.levels).slice(off);
  return { table: table.slice(0, max - 1), max };
}

/** Level reached with `exp` total XP (1 .. curve.max). */
export function levelFromExp(curve: Curve, exp: number): number {
  let level = 1;
  let acc = 0;
  for (const need of curve.table) {
    if (acc + need > exp) break;
    acc += need;
    level++;
  }
  return Math.min(level, curve.max);
}

/** Total XP of a pet at `level`. */
export function expForLevel(curve: Curve, level: number): number {
  let sum = 0;
  for (let i = 0; i < level - 1 && i < curve.table.length; i++) sum += curve.table[i]!;
  return sum;
}

/** Kat's coin price for a pet at `level`: KAT.levelDiscount off per level, never below 0. */
export function katCoins(baseCoins: number, level: number): number {
  return Math.max(0, baseCoins * (1 - KAT.levelDiscount * level));
}

interface SkipPlan {
  items: { id: string; qty: number }[];
  cost: number;
  /** wait left */
  hours: number;
}

/**
 * Cheapest Kat Flower / Bouquet mix that skips every full flower-length of a `hours` wait (the part under one flower
 * stays), with unit prices `flower` / `bouquet` (null = not for sale). A bouquet past the end finishes the wait.
 */
export function planSkip(hours: number, flower: number | null, bouquet: number | null): SkipPlan {
  const days = Math.floor(hours / KAT.flowerHours + 1e-9);
  const none: SkipPlan = { items: [], cost: 0, hours };
  if (days < 1 || (flower == null && bouquet == null)) return none;
  const per = KAT.bouquetHours / KAT.flowerHours;
  let best: SkipPlan | null = null;
  const maxB = bouquet == null ? 0 : Math.ceil(days / per);
  for (let b = 0; b <= maxB; b++) {
    const f = Math.max(0, days - b * per);
    if (f > 0 && flower == null) continue;
    const cost = b * (bouquet ?? 0) + f * (flower ?? 0);
    const left = Math.max(0, hours - b * KAT.bouquetHours - f * KAT.flowerHours);
    if (!best || cost < best.cost || (cost === best.cost && left < best.hours)) {
      const items = [...(b > 0 ? [{ id: KAT.bouquetId, qty: b }] : []), ...(f > 0 ? [{ id: KAT.flowerId, qty: f }] : [])];
      best = { items, cost, hours: left };
    }
  }
  // b = 0 (flowers only) or b = maxB (bouquets only) always qualifies
  return best!;
}

/** Steps grouped by pet and from-tier. */
function stepIndex(steps: readonly KatStep[]): Map<string, Map<number, KatStep>> {
  const m = new Map<string, Map<number, KatStep>>();
  for (const s of steps) {
    if (s.to !== s.from + 1) continue;
    let byFrom = m.get(s.pet);
    if (!byFrom) m.set(s.pet, (byFrom = new Map()));
    if (!byFrom.has(s.from)) byFrom.set(s.from, s);
  }
  return m;
}

/**
 * Every Kat upgrade run in the catalog with an AH price for the pet you start from: each chain of consecutive steps
 * i -> j of one pet, bought at the cheapest listing of any level ('any') or at max level ('max'). Rows with an
 * unpriced item or no sell price are kept with `unpriced` set.
 */
export function computeKatFlips(ctx: CalcCtx, opts: KatOptions = {}): KatRow[] {
  const { catalog } = ctx;
  const ah = ctx.ah;
  if (!ah) return [];
  const pricer = createCraftPricer(ctx);
  const priceMemo = new Map<string, { unit: number; source: KatItemLine['source'] }>();

  /** Unit price of an item: bazaar in your cost mode / NPC / sub-craft (as crafts price inputs), else AH lowest BIN. */
  const priceOf = (id: string): { unit: number; source: KatItemLine['source'] } => {
    let p = priceMemo.get(id);
    if (p) return p;
    const line = pricer.price({ key: `kat:${id}`, output: `kat:${id}`, outCount: 1, inputs: [{ id, qty: 1 }], kind: 'craft' }).lines[0]!;
    const a = ah(id);
    if (line.unit > 0) p = { unit: line.unit, source: line.source };
    else if (a && a.price > 0 && Number.isFinite(a.price)) p = { unit: a.price, source: 'ah' };
    else p = { unit: 0, source: null };
    priceMemo.set(id, p);
    return p;
  };
  const lineOf = (id: string, qty: number): KatItemLine => {
    const p = priceOf(id);
    return { id, name: catalog.name(id), qty, unit: p.unit, total: p.unit * qty, source: p.source };
  };
  const unitOrNull = (id: string) => {
    const p = priceOf(id);
    return p.source ? p.unit : null;
  };

  const rows: KatRow[] = [];
  for (const [pet, byFrom] of stepIndex(catalog.kat)) {
    for (const from of [...byFrom.keys()].sort((a, b) => a - b)) {
      for (const band of KAT_BANDS) {
        const baseKey = `${pet};${from}`;
        const buyKey = band === 'max' ? maxKey(baseKey) : baseKey;
        const buy = ah(buyKey);
        if (!buy || !(buy.price > 0)) continue;
        const startCurve = petCurve(catalog.petLeveling, pet, from);
        if (band === 'max' && !maxOk(buy, startCurve?.max ?? maxLevelOf(catalog.petLeveling, pet))) continue;
        // no listing XP (0 on a max-level listing means petInfo had none): a level 1 pet for 'any' (no discount: the
        // safe guess), a max-level one for 'max'; either way the level is a guess
        const expKnown = buy.exp != null && (band === 'any' || buy.exp > 0);
        const exp = expKnown ? buy.exp! : band === 'max' && startCurve ? expForLevel(startCurve, startCurve.max) : 0;
        const steps: KatStepLine[] = [];
        let curves = !!startCurve;
        let level = startCurve ? levelFromExp(startCurve, exp) : band === 'max' ? maxLevelOf(catalog.petLeveling, pet) : 1;
        for (let to = from + 1; byFrom.has(to - 1); to++) {
          const step = byFrom.get(to - 1)!;
          const curve = petCurve(catalog.petLeveling, pet, to);
          if (!curve) curves = false;
          const levelAfter = curves && curve ? levelFromExp(curve, exp) : level;
          const items = step.items.map((it) => lineOf(it.id, it.qty));
          const skip = opts.skip === 'flowers' ? planSkip(step.hours, unitOrNull(KAT.flowerId), unitOrNull(KAT.bouquetId)) : null;
          steps.push({
            from: step.from,
            to: step.to,
            levelBefore: level,
            levelAfter,
            baseCoins: step.coins,
            coins: katCoins(step.coins, level),
            items,
            itemsCost: items.reduce((s, l) => s + l.total, 0),
            baseHours: step.hours,
            hours: skip ? skip.hours : step.hours,
            skip: skip ? skip.items.map((it) => lineOf(it.id, it.qty)) : [],
            skipCost: skip?.cost ?? 0,
          });
          level = levelAfter;
          const req = KAT.tamingReq[to] ?? 0;
          if (opts.taming != null && req > opts.taming) break;
          rows.push(buildRow(ctx, { pet, from, to, band, buyKey, buy, steps: steps.slice(), level, levelKnown: curves && expKnown }));
        }
      }
    }
  }
  return rows;
}

function maxLevelOf(pl: PetLeveling | null, pet: string): number {
  return pl?.custom[pet]?.maxLevel ?? DEFAULT_MAX_LEVEL;
}

interface RowInput {
  pet: string;
  from: number;
  to: number;
  band: KatBand;
  buyKey: string;
  buy: NonNullable<ReturnType<NonNullable<CalcCtx['ah']>>>;
  steps: KatStepLine[];
  /** level at `to` */
  level: number;
  levelKnown: boolean;
}

function buildRow(ctx: CalcCtx, x: RowInput): KatRow {
  const { catalog } = ctx;
  const ah = ctx.ah!;
  const flags: RiskFlag[] = [];
  const maxLevel = petCurve(catalog.petLeveling, x.pet, x.to)?.max ?? maxLevelOf(catalog.petLeveling, x.pet);
  const plainKey = `${x.pet};${x.to}`;
  const atMax = x.level >= maxLevel ? ah(maxKey(plainKey)) : null;
  const sellKey = atMax && atMax.price > 0 && maxOk(atMax, maxLevel) ? maxKey(plainKey) : plainKey;
  const sellAh = sellKey === plainKey ? ah(plainKey) : atMax;
  // the plain key's lowest BIN is whatever level is cheapest: maybe not the level you sell
  if (sellKey === plainKey || !x.levelKnown) flags.push('AH_VARIANT');
  if (x.buy.count < KAT.minCount || (sellAh && sellAh.count < KAT.minCount)) flags.push('AH_THIN');
  if (x.buy.next != null && x.buy.next / x.buy.price > AH_FLIP.gapRatio) flags.push('AH_GAP');

  const unpriced = [...new Set(x.steps.flatMap((s) => [...s.items, ...s.skip].filter((l) => l.source == null).map((l) => l.id)))];
  const sell = sellAh && sellAh.price > 0 ? sellAh.price : 0;
  if (!sell) unpriced.push(sellKey);
  const sum = (f: (s: KatStepLine) => number) => x.steps.reduce((a, s) => a + f(s), 0);
  const coins = sum((s) => s.coins);
  const itemsCost = sum((s) => s.itemsCost);
  const skipCost = sum((s) => s.skipCost);
  const upgradeCost = coins + itemsCost + skipCost;
  const capital = x.buy.price + upgradeCost;
  const sellNet = sell ? ahNet(sell, ctx.derpy) : 0;
  const katHours = sum((s) => s.hours);
  const hours = katHours + KAT_TRADE_HOURS;
  const priced = unpriced.length === 0;
  const profit = priced ? sellNet - capital : 0;
  const tp: Throughput = {
    unitsPerHour: 1 / hours,
    batchQty: 1,
    capitalUsed: capital,
    fillHours: hours,
    limitedBy: 'kat',
    buyHours: 0,
    sellHours: KAT_TRADE_HOURS,
    slots: 0,
  };
  return {
    key: `${x.pet};${x.from}>${x.to}:${x.band}`,
    id: x.buyKey,
    pet: x.pet,
    name: catalog.petNames[x.pet] ?? petName(x.pet, x.buy.name),
    from: x.from,
    to: x.to,
    band: x.band,
    buy: x.buy.price,
    buyCount: x.buy.count,
    ...(x.buy.uuid ? { uuid: x.buy.uuid } : {}),
    ...(x.buy.name ? { listingName: x.buy.name } : {}),
    levelStart: x.steps[0]!.levelBefore,
    levelEnd: x.level,
    maxLevel,
    levelKnown: x.levelKnown,
    sellKey,
    sell,
    sellNet,
    sellCount: sellAh?.count ?? 0,
    coins,
    itemsCost,
    skipCost,
    upgradeCost,
    capital,
    baseHours: sum((s) => s.baseHours),
    katHours,
    hours,
    profit,
    margin: priced ? profit / capital : 0,
    profitPerHour: profit / hours,
    tp,
    steps: x.steps,
    risk: reportFromFlags(flags),
    unpriced,
  };
}
