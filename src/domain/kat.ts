// Kat upgrades: buy a pet on the AH, take it up one or more rarities at Kat (coins + items + a wait), sell it on the AH.
// Kat's coin price drops KAT.levelDiscount per pet level. The pet keeps its XP through an upgrade, but higher rarities
// need more XP per level, so its level is recomputed at each rarity (a level 100 Epic is a lower-level Legendary).
// Kat flowers / bouquets can skip the wait (one item per upgrade, so skipping is priced per step). The upgraded pet
// sells on the AH or to George, whichever pays more.
import { AH, AH_FLIP, AH_SALES, KAT } from '../config.ts';
import type { AhPrice, AhSnapshot, CalcCtx, KatStep, PetLeveling, PlanInputs, QuoteSource, RiskFlag, RiskReport, Throughput } from '../types/contracts.ts';
import { isPetMaxKey, petName } from './ahFlips.ts';
import { bitsItemCosts } from './bits.ts';
import { getPricer } from './craft.ts';
import { petLevelFromName } from './ids.ts';
import { coreOf, salesOf } from './market.ts';
import { ahNet } from './pricing.ts';
import { reportFromFlags } from './risk.ts';

/** Rarity names by index (PetLeveling.offsets keys); game data, so not translated. */
export const KAT_RARITIES = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'] as const;

/** Hours assumed to sell the upgraded pet without measured AH sales (alias of KAT.defaultSellHours). */
export const KAT_TRADE_HOURS = KAT.defaultSellHours;

/** AH scan version Kat rows need (pet `exp` and the `@MAX` keys): the page and derived.kat() both gate on it. */
export const KAT_MIN_SCAN = 3;
export const katScanReady = (ah: Pick<AhSnapshot, 'v'> | null): boolean => ah?.v != null && ah.v >= KAT_MIN_SCAN;

/** Pet levels end at 100 unless PetLeveling.custom says otherwise. */
const DEFAULT_MAX_LEVEL = 100;

/** 'any': the cheapest listing of any level (`PET;i`); 'max': the cheapest max-level listing (`PET;i@MAX`). */
export type KatBand = 'any' | 'max';
export const KAT_BANDS: readonly KatBand[] = ['any', 'max'];

/**
 * 'flowers': skip each step's wait with Kat Flowers / Bouquets; 'best': skip the steps whose skip raises the profit
 * per hour (the planner's choice).
 */
export type KatSkip = 'none' | 'flowers' | 'best';
export const KAT_SKIPS: readonly KatSkip[] = ['best', 'none', 'flowers'];
/** The skip option derived.kat() (the planner's Kat rows) uses; the Kat page shows those rows for it. */
export const KAT_DERIVED_SKIP: KatSkip = 'best';

/** Where the upgraded pet is sold. */
export type KatSellVenue = 'ah' | 'george';

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
  /** null when no market has it; 'bits': bought with bits from Booster Cookies */
  source: QuoteSource | 'bits' | null;
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
  /**
   * AH key the sale is priced from: `PET;j@MAX` for a max-level pet when listed, else the level band (`PET;j@L89`,
   * scan v4) when the level is known and listed, else `PET;j`
   */
  sellKey: string;
  sellVenue: KatSellVenue;
  /** your list price (lowest BIN of sellKey − undercut, capped at the median sold when conservative) or George's */
  sell: number;
  /** what the sale leaves after the AH listing fee and claim tax (George: his price) */
  sellNet: number;
  sellCount: number;
  /** hours to sell: 1 / measured sales per hour of sellKey, else KAT.defaultSellHours; 0 for George */
  sellHours: number;
  salesPerHour: number | null;
  /** George's price for the upgraded pet, null when he has none */
  george: number | null;
  /** the list price before the median-sold cap, when the cap lowered it */
  sellRef?: number;
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
  /** katHours + sellHours */
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
  /** planner inputs: one pet per run, no order slots */
  plan: PlanInputs;
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

/** A step before the skip choice: its line without skip items, and what skipping it would cost and leave. */
interface StepDraft {
  line: KatStepLine;
  skip: { lines: KatItemLine[]; cost: number; hours: number } | null;
}

const withSkip = (d: StepDraft): KatStepLine => (d.skip ? { ...d.line, hours: d.skip.hours, skip: d.skip.lines, skipCost: d.skip.cost } : d.line);

/** `${key}@L<upTo>`: the scan v4 level-band key holding `level` (api/auctions.ts petBandKey), null above the bands. */
export function bandKey(key: string, level: number): string | null {
  const upTo = AH.petBands.find((b) => level <= b);
  return upTo === undefined ? null : `${key}@L${upTo}`;
}

/**
 * Every Kat upgrade run in the catalog with an AH price for the pet you start from: each chain of consecutive steps
 * i -> j of one pet, bought at the cheapest listing of any level ('any') or at max level ('max'). Items are priced
 * like craft inputs (the shared craft pricer, then the AH), bits-shop items at no more than their bits through
 * Booster Cookies. Rows with an unpriced item or no sale are kept with `unpriced` set.
 */
export function computeKatFlips(ctx: CalcCtx, opts: KatOptions = {}): KatRow[] {
  const { catalog } = ctx;
  const ah = ctx.ah;
  if (!ah) return [];
  const pricer = getPricer(ctx);
  const core = coreOf(ctx);
  const bitsCost = bitsItemCosts(ctx);
  const priceMemo = new Map<string, { unit: number; source: KatItemLine['source'] }>();
  const skipMode = opts.skip ?? 'none';

  /** Unit price of an item: as crafts price inputs (bazaar, NPC, sub-craft), else the AH; capped by its bits cost. */
  const priceOf = (id: string): { unit: number; source: KatItemLine['source'] } => {
    let p = priceMemo.get(id);
    if (p) return p;
    const line = pricer.price({ key: `kat:${id}`, output: `kat:${id}`, outCount: 1, inputs: [{ id, qty: 1 }], kind: 'craft' }).lines[0]!;
    // a pricer without AH sources leaves AH-only items unpriced
    const a = line.unit > 0 ? null : core.ahBuy(id);
    if (line.unit > 0) p = { unit: line.unit, source: line.source };
    else if (a) p = { unit: a.price, source: 'ah' };
    else p = { unit: 0, source: null };
    const b = bitsCost.get(id);
    if (b != null && (p.source == null || b < p.unit)) p = { unit: b, source: 'bits' };
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
        const steps: StepDraft[] = [];
        let curves = !!startCurve;
        let level = startCurve ? levelFromExp(startCurve, exp) : band === 'max' ? maxLevelOf(catalog.petLeveling, pet) : 1;
        for (let to = from + 1; byFrom.has(to - 1); to++) {
          const step = byFrom.get(to - 1)!;
          const curve = petCurve(catalog.petLeveling, pet, to);
          if (!curve) curves = false;
          const levelAfter = curves && curve ? levelFromExp(curve, exp) : level;
          const items = step.items.map((it) => lineOf(it.id, it.qty));
          const plan = skipMode !== 'none' ? planSkip(step.hours, unitOrNull(KAT.flowerId), unitOrNull(KAT.bouquetId)) : null;
          steps.push({
            line: {
              from: step.from,
              to: step.to,
              levelBefore: level,
              levelAfter,
              baseCoins: step.coins,
              coins: katCoins(step.coins, level),
              items,
              itemsCost: items.reduce((s, l) => s + l.total, 0),
              baseHours: step.hours,
              hours: step.hours,
              skip: [],
              skipCost: 0,
            },
            skip: plan && plan.items.length > 0 ? { lines: plan.items.map((it) => lineOf(it.id, it.qty)), cost: plan.cost, hours: plan.hours } : null,
          });
          level = levelAfter;
          const req = KAT.tamingReq[to] ?? 0;
          if (opts.taming != null && req > opts.taming) break;
          rows.push(buildRow(ctx, { pet, from, to, band, buyKey, buy, steps: steps.slice(), level, levelKnown: curves && expKnown }, skipMode));
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
  buy: AhPrice;
  steps: StepDraft[];
  /** level at `to` */
  level: number;
  levelKnown: boolean;
}

/** How the upgraded pet sells: on the AH (lowest BIN of sellKey − undercut) or to George, whichever nets more. */
interface Sale {
  sellKey: string;
  venue: KatSellVenue;
  /** list price (AH) or George's price; 0 without either */
  price: number;
  net: number;
  hours: number;
  count: number;
  salesPerHour: number | null;
  /** the list price before the median-sold cap */
  ref?: number;
  /** AH listing used (null for George or no listing) */
  listing: AhPrice | null;
  george: number | null;
}

/**
 * The sale of a pet at `level` and rarity `to`: the most specific AH key listed (`@MAX` at max level, else the scan v4
 * level band when the level is known, else the plain key), listed AH_FLIP.undercut under its lowest BIN and, with
 * conservatism on, at no more than the median sold; it takes 1 / (measured sales per hour) hours, else
 * KAT.defaultSellHours. George's price floors it: when he pays more than the AH nets, the pet goes to him at once.
 */
function saleOf(ctx: CalcCtx, x: RowInput, maxLevel: number): Sale {
  const ah = ctx.ah!;
  const plainKey = `${x.pet};${x.to}`;
  let sellKey = plainKey;
  let listing = ah(plainKey);
  const atMax = x.level >= maxLevel ? ah(maxKey(plainKey)) : null;
  if (atMax && atMax.price > 0 && maxOk(atMax, maxLevel)) {
    sellKey = maxKey(plainKey);
    listing = atMax;
  } else if (x.levelKnown && x.level < maxLevel) {
    const bk = bandKey(plainKey, x.level);
    const b = bk ? ah(bk) : null;
    if (b && b.price > 0) {
      sellKey = bk!;
      listing = b;
    }
  }
  const sales = salesOf(ctx, sellKey);
  const perHour = sales?.perHour != null && sales.perHour > 0 ? sales.perHour : null;
  let price = listing && listing.price > 0 ? Math.max(0, listing.price - AH_FLIP.undercut) : 0;
  let ref: number | undefined;
  if (price > 0 && ctx.settings.conservative && sales && sales.n >= AH_SALES.minSales && sales.median > 0 && sales.median < price) {
    ref = price;
    price = sales.median;
  }
  const g = ctx.catalog.george[plainKey];
  const george = g != null && g > 0 ? g : null;
  const net = price > 0 ? ahNet(price, ctx.derpy) : 0;
  const base = { sellKey, count: listing?.count ?? 0, salesPerHour: perHour, george };
  if (george != null && george > net) return { ...base, venue: 'george', price: george, net: george, hours: 0, listing: null };
  const sale: Sale = { ...base, venue: 'ah', price, net, hours: perHour != null ? 1 / perHour : KAT.defaultSellHours, listing: price > 0 ? listing : null };
  if (ref != null) sale.ref = ref;
  return sale;
}

/**
 * Which steps to skip with flowers: 'flowers' every step that can be, 'best' the set with the most profit per hour
 * (the cheapest skips per saved hour first, any prefix of them), 'none' none.
 */
function chooseSkips(steps: readonly StepDraft[], mode: KatSkip, profit: number, hours: number, priced: boolean): KatStepLine[] {
  if (mode === 'none' || (mode === 'best' && !priced)) return steps.map((d) => d.line);
  if (mode === 'flowers') return steps.map(withSkip);
  const cands = steps
    .map((d, i) => ({ i, cost: d.skip?.cost ?? 0, saved: d.skip ? d.line.baseHours - d.skip.hours : 0 }))
    .filter((c) => c.saved > 0)
    .sort((a, b) => a.cost / a.saved - b.cost / b.saved);
  let best = 0;
  let bestPph = profit / hours;
  let p = profit;
  let h = hours;
  cands.forEach((c, k) => {
    p -= c.cost;
    h -= c.saved;
    const pph = h > 0 ? p / h : p > 0 ? Infinity : -Infinity;
    if (pph > bestPph) {
      bestPph = pph;
      best = k + 1;
    }
  });
  const on = new Set(cands.slice(0, best).map((c) => c.i));
  return steps.map((d, i) => (on.has(i) ? withSkip(d) : d.line));
}

function buildRow(ctx: CalcCtx, x: RowInput, mode: KatSkip): KatRow {
  const { catalog } = ctx;
  const flags: RiskFlag[] = [];
  const maxLevel = petCurve(catalog.petLeveling, x.pet, x.to)?.max ?? maxLevelOf(catalog.petLeveling, x.pet);
  const sale = saleOf(ctx, x, maxLevel);
  // a plain or band key's lowest BIN is whatever level is cheapest in it: maybe not the level you sell (George pays
  // the same for any level)
  if (sale.venue === 'ah' && (!isPetMaxKey(sale.sellKey) || !x.levelKnown)) flags.push('AH_VARIANT');
  if (x.buy.count < KAT.minCount || (sale.venue === 'ah' && sale.listing && sale.count < KAT.minCount)) flags.push('AH_THIN');
  if (x.buy.next != null && x.buy.next / x.buy.price > AH_FLIP.gapRatio) flags.push('AH_GAP');

  const itemUnpriced = [...new Set(x.steps.flatMap((s) => s.line.items.filter((l) => l.source == null).map((l) => l.id)))];
  const sold = sale.net > 0;
  const priced = itemUnpriced.length === 0 && sold;
  const sumOf = (steps: readonly KatStepLine[], f: (s: KatStepLine) => number) => steps.reduce((a, s) => a + f(s), 0);
  const plain = x.steps.map((d) => d.line);
  const noSkipCapital = x.buy.price + sumOf(plain, (s) => s.coins + s.itemsCost);
  const steps = chooseSkips(x.steps, mode, sale.net - noSkipCapital, sumOf(plain, (s) => s.hours) + sale.hours, priced);

  const unpriced = [...itemUnpriced];
  if (!sold) unpriced.push(sale.sellKey);
  const coins = sumOf(steps, (s) => s.coins);
  const itemsCost = sumOf(steps, (s) => s.itemsCost);
  const skipCost = sumOf(steps, (s) => s.skipCost);
  const upgradeCost = coins + itemsCost + skipCost;
  const capital = x.buy.price + upgradeCost;
  const katHours = sumOf(steps, (s) => s.hours);
  const hours = katHours + sale.hours;
  const profit = priced ? sale.net - capital : 0;
  // fully skipped and sold to George: instant; one pet per minute keeps the rate finite
  const rateHours = Math.max(hours, 1 / 60);
  const tp: Throughput = {
    unitsPerHour: 1 / rateHours,
    batchQty: 1,
    capitalUsed: capital,
    fillHours: hours,
    limitedBy: 'kat',
    buyHours: 0,
    sellHours: sale.hours,
    slots: 0,
  };
  const row: KatRow = {
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
    levelStart: x.steps[0]!.line.levelBefore,
    levelEnd: x.level,
    maxLevel,
    levelKnown: x.levelKnown,
    sellKey: sale.sellKey,
    sellVenue: sale.venue,
    sell: sale.price,
    sellNet: sale.net,
    sellCount: sale.count,
    sellHours: sale.hours,
    salesPerHour: sale.salesPerHour,
    george: sale.george,
    coins,
    itemsCost,
    skipCost,
    upgradeCost,
    capital,
    baseHours: sumOf(steps, (s) => s.baseHours),
    katHours,
    hours,
    profit,
    margin: priced ? profit / capital : 0,
    profitPerHour: profit / rateHours,
    tp,
    steps,
    risk: reportFromFlags(flags),
    unpriced,
    plan: { unitCost: capital, buyCost: capital, profitPerUnit: profit, unitsPerHour: 1 / rateHours, maxUnits: 1, orderUnits: [], uses: [] },
  };
  if (sale.ref != null) row.sellRef = sale.ref;
  return row;
}
