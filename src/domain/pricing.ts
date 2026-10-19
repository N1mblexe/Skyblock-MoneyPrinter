import { AH, COMP_TOL, FILL_MODEL_DEFAULT, MAX_ORDER_UNITS, NPC_FLOOR_RATIO, OPTIMIZER, PRICE_TICK } from '../config.ts';
import type {
  ConsInfo,
  CostMode,
  FillModel,
  OrderLevel,
  PlanInputs,
  Product,
  ProfitSegment,
  Quote,
  QuoteSource,
  ResourceKey,
  ResourceUse,
  SellMode,
  Throughput,
} from '../types/contracts.ts';
import { bookUnits, walkBook } from './book.ts';

const HOURS_PER_WEEK = 168;

/** Round to one decimal (bazaar price granularity), avoiding float noise. */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Walk the asks for qty ?? 1 units: VWAP, units filled, slippage vs the best ask. null when the asks are empty. */
function instaBuy(p: Product, qty?: number): Quote | null {
  const w = walkBook(p.asks, qty ?? 1);
  if (!w) return null;
  const top = p.asks[0]!.price;
  return { price: w.avgPrice, filled: w.filled, slippage: top > 0 ? (w.avgPrice - top) / top : 0, source: 'insta' };
}

/**
 * Per-unit cost of acquiring the product.
 *  order: max(bid + PRICE_TICK, NPC_FLOOR_RATIO x npcSell) (rounded to 0.1), filled=Infinity, slippage 0, source
 *         'order'; clamped 'npcFloor' when the NPC floor raised it. An order at or above the ask would fill against
 *         the sell offers at once, so it comes back as the insta-buy of qty (walk-book VWAP), source 'insta',
 *         clamped 'ask'.
 *  insta: walkBook(asks, qty ?? 1).avgPrice, filled from walk, slippage vs ask, source 'insta'
 * null when the needed side is empty.
 */
export function buyQuote(p: Product, mode: CostMode, qty?: number, npcSell?: number): Quote | null {
  if (mode === 'order') {
    if (p.bid == null || !Number.isFinite(p.bid)) return null;
    // Sellers rarely dump far below the NPC price, so a 0.1 bid on a raw material is a stale floor:
    // assume a buy order must pay at least NPC_FLOOR_RATIO x the NPC sell price.
    const base = round1(p.bid + PRICE_TICK);
    const floor = round1((npcSell ?? 0) * NPC_FLOOR_RATIO);
    const price = Math.max(base, floor);
    if (p.ask != null && Number.isFinite(p.ask) && price >= p.ask) {
      // an ask without levels (inconsistent product) keeps the ask as its price
      const q = instaBuy(p, qty) ?? { price: p.ask, filled: Infinity, slippage: 0, source: 'insta' as const };
      return { ...q, clamped: 'ask' };
    }
    const q: Quote = { price, filled: Infinity, slippage: 0, source: 'order' };
    if (floor > base) q.clamped = 'npcFloor';
    return q;
  }
  return instaBuy(p, qty);
}

/**
 * Per-unit PRE-TAX sale price.
 *  offer: ask - PRICE_TICK (rounded to 0.1, never below 0.1)
 *  insta: walkBook(bids, qty ?? 1).avgPrice
 * null when the needed side is empty.
 */
export function sellQuote(p: Product, mode: SellMode, qty?: number): Quote | null {
  if (mode === 'offer') {
    if (p.ask == null || !Number.isFinite(p.ask)) return null;
    return { price: Math.max(PRICE_TICK, round1(p.ask - PRICE_TICK)), filled: Infinity, slippage: 0, source: 'order' };
  }
  const w = walkBook(p.bids, qty ?? 1);
  if (!w) return null;
  const top = p.bids[0]!.price;
  return { price: w.avgPrice, filled: w.filled, slippage: top > 0 ? (w.avgPrice - top) / top : 0, source: 'insta' };
}

/** price * (1 - tax) */
export function afterTax(price: number, tax: number): number {
  return price * (1 - tax);
}

/** BIN listing fee for one item listed at `price` (AH.fees.listing tiers). */
export function ahListingFee(price: number): number {
  if (!(price > 0)) return 0;
  const tier = AH.fees.listing.find(([upTo]) => price <= upTo) ?? AH.fees.listing[AH.fees.listing.length - 1]!;
  return price * tier[1];
}

/** Claim tax when collecting a sale of `price`: up to 1 % (×4 under Derpy), never below AH.fees.claimFloor. */
export function ahClaimTax(price: number, derpy = false): number {
  const { claimTax, claimFloor, derpyClaimMul } = AH.fees;
  if (!(price > claimFloor)) return 0;
  const tax = price * claimTax * (derpy ? derpyClaimMul : 1);
  return Math.min(tax, price - claimFloor);
}

/** What one BIN sale at `price` leaves you after the listing fee and the claim tax. */
export function ahNet(price: number, derpy = false): number {
  return price - ahListingFee(price) - ahClaimTax(price, derpy);
}

const perHour = (week: number) => (Number.isFinite(week) && week > 0 ? week / HOURS_PER_WEEK : 0);

/**
 * Raw MARKET fill rates (units/hour) for your buy side and sell side.
 *  buy order fills from insta-sells (instaSellsWeek/168); insta-buy draws from instaBuysWeek/168
 *  sell offer fills from insta-buys (instaBuysWeek/168); insta-sell from instaSellsWeek/168
 */
export function sideRates(p: Product, costMode: CostMode, sellMode: SellMode): { buy: number; sell: number } {
  return {
    buy: perHour(costMode === 'order' ? p.instaSellsWeek : p.instaBuysWeek),
    sell: perHour(sellMode === 'offer' ? p.instaBuysWeek : p.instaSellsWeek),
  };
}

/**
 * Sum of `orders` over levels within max(PRICE_TICK, tol x |best price|) of the best level's price.
 * `byAmount` (conservatism): a competitor counts by its size, so the band's amount over the side's typical order
 * (total amount / total orders) when that is more than the order count.
 */
export function competitors(levels: readonly OrderLevel[], tol: number = COMP_TOL, byAmount = false): number {
  const best = levels[0];
  if (!best) return 0;
  // the tick floor: on a cheap item the next price up is one tick away, well outside 1 % of a few coins
  const band = Math.max(PRICE_TICK, Math.abs(best.price) * tol);
  let n = 0;
  let amount = 0;
  for (const l of levels) {
    if (Math.abs(l.price - best.price) > band + 1e-9) continue;
    n += Math.max(0, l.orders);
    amount += Math.max(0, l.amount);
  }
  if (!byAmount) return n;
  let totalAmount = 0;
  let totalOrders = 0;
  for (const l of levels) {
    totalAmount += Math.max(0, l.amount);
    totalOrders += Math.max(0, l.orders);
  }
  const typical = totalOrders > 0 ? totalAmount / totalOrders : 0;
  return typical > 0 ? Math.max(n, amount / typical) : n;
}

/** min(share, 1 / (1 + n)) */
export function effShare(share: number, n: number): number {
  if (!(share > 0)) return 0;
  return Math.min(share, 1 / (1 + Math.max(0, n)));
}

/** One side of a trade as seen by you: quote, your fill rate (after share/competition), competition, book depth. */
export interface SideInfo {
  quote: Quote;
  /** your units/hour on this side */
  rate: number;
  /** competing orders near the top of the side you queue on (0 for insta) */
  comp: number;
  /** units on the book (insta only) */
  depth?: number;
}

/**
 * Buy side: order -> queue on bids (competition), insta -> take asks (share only, depth-capped).
 * An order at or above the ask comes back from buyQuote as an insta-buy, so it gets the insta rate and depth too.
 */
export function buySide(p: Product, mode: CostMode, share: number, qty?: number, npcSell?: number): SideInfo | null {
  const quote = buyQuote(p, mode, qty, npcSell);
  if (!quote) return null;
  if (quote.source === 'insta') return { quote, rate: perHour(p.instaBuysWeek) * Math.max(0, share), comp: 0, depth: bookUnits(p.asks) };
  const comp = competitors(p.bids);
  return { quote, rate: perHour(p.instaSellsWeek) * effShare(share, comp), comp };
}

/** Sell side: offer -> queue on asks (competition), insta -> hit bids (share only, depth-capped). */
export function sellSide(p: Product, mode: SellMode, share: number, qty?: number): SideInfo | null {
  const quote = sellQuote(p, mode, qty);
  if (!quote) return null;
  const raw = sideRates(p, 'order', mode).sell;
  if (mode === 'offer') {
    const comp = competitors(p.asks);
    return { quote, rate: raw * effShare(share, comp), comp };
  }
  return { quote, rate: raw * Math.max(0, share), comp: 0, depth: bookUnits(p.bids) };
}

/**
 * The shared market a bazaar or NPC leg draws on (planner resource): a buy order on X and an insta-sell of X both
 * use X's insta-sells (`X:bid`); an insta-buy and a sell offer use X's insta-buys (`X:ask`); an NPC purchase uses
 * X's daily limit (`X:npc`). Selling to an NPC uses nothing (undefined).
 */
export function sideRes(id: string, side: 'buy' | 'sell', source: QuoteSource): ResourceKey | undefined {
  if (source === 'npc') return side === 'buy' ? `${id}:npc` : undefined;
  if (source !== 'order' && source !== 'insta') return undefined;
  return (side === 'buy') === (source === 'order') ? `${id}:bid` : `${id}:ask`;
}

/** What limits a side's rate when that side binds: market volume, an NPC shop's daily limit, or AH sales. */
export type SideBound = 'volume' | 'npcLimit' | 'ahSales';

/** A per-hour cap of an instant leg (no fill time): bounds the batch at perHour x cycleHours. */
export interface RateCap {
  perHour: number;
  /** reported as limitedBy when this cap binds */
  bound: Throughput['limitedBy'];
}

export interface ThroughputInput {
  /** your buy-side rate, units/hour (after share); Infinity for an instant leg */
  rBuy: number;
  /** your sell-side rate, units/hour (Infinity if unconstrained, e.g. NPC sell) */
  rSell: number;
  /** cost per unit (or per craft) */
  unitCost: number;
  capital: number;
  cycleHours: number;
  /** units available on the book for insta modes */
  depthCap?: number;
  /** units/hour cap from forge slots */
  forgeCap?: number;
  /** default FILL_MODEL_DEFAULT */
  fillModel?: FillModel;
  /** bazaar order slots available; undefined = unlimited */
  orderSlots?: number;
  /**
   * Units each bazaar order needs per batch unit, one entry per order (buy orders and sell offers; insta and NPC legs
   * are left out). A flip by order/offer is [1, 1]; a craft lists qty per craft of every ordered ingredient and outCount.
   */
  orderUnits?: readonly number[];
  /** reported as limitedBy when the buy / sell rate binds (default 'volume') */
  buyBound?: SideBound;
  sellBound?: SideBound;
  /**
   * Per-hour cap of an instant buy leg, e.g. an NPC shop (npcDailyLimit / 24) with rBuy = Infinity. It takes no
   * fill time and no pipelined overlap; it bounds the batch at cap x cycleHours ('npcLimit').
   */
  buyCapPerHour?: number;
  /** more per-hour caps of instant legs, each with its own limitedBy */
  caps?: readonly RateCap[];
}

const ZERO_TP: Throughput = {
  unitsPerHour: 0,
  batchQty: 0,
  capitalUsed: 0,
  fillHours: 0,
  limitedBy: 'volume',
  buyHours: 0,
  sellHours: 0,
  slots: 0,
};

/** Order slots a batch of q units occupies: sum over orders of ceil(q * units / MAX_ORDER_UNITS). */
export function slotsFor(q: number, orderUnits: readonly number[]): number {
  let n = 0;
  for (const u of orderUnits) {
    const x = (q * u) / MAX_ORDER_UNITS;
    if (x > 0) n += Math.max(1, Math.ceil(x - 1e-9));
  }
  return n;
}

/** Largest batch whose orders fit in `slots` (0 when even one unit per order does not fit). */
function maxQForSlots(orderUnits: readonly number[], slots: number): number {
  let best = 0;
  for (const u of orderUnits) {
    for (let k = 1; k <= slots; k++) {
      const q = (k * MAX_ORDER_UNITS) / u;
      if (q > best && slotsFor(q, orderUnits) <= slots) best = q;
    }
  }
  return best;
}

/** Positive, finite order units (loops, not closures: throughput is called for every row and re-quote). */
function validUnits(units: readonly number[] | undefined): number[] {
  const out: number[] = [];
  if (units) for (const u of units) if (u > 0 && Number.isFinite(u)) out.push(u);
  return out;
}

/** A leg that takes time: a positive, finite rate (instant legs have Infinity). */
const timed = (r: number) => r > 0 && Number.isFinite(r);

/**
 * Batches held at once: 2 under the pipelined model when both sides take time (one batch buys while the previous
 * one sells), else 1. Instant legs (NPC buys and sells: Infinity rates) take no time.
 */
export function fillOverlap(o: Pick<ThroughputInput, 'rBuy' | 'rSell' | 'fillModel'>): 1 | 2 {
  return (o.fillModel ?? FILL_MODEL_DEFAULT) === 'pipelined' && timed(o.rBuy) && timed(o.rSell) ? 2 : 1;
}

/**
 * One batch of Q units per period, period = max(cycleHours, fill time, Q / forgeCap).
 *  sequential: buy the batch, then sell it -> fill time = Q/rBuy + Q/rSell, capital = Q * unitCost
 *  pipelined:  one batch buys while the previous one sells -> fill time = Q / min(rBuy, rSell),
 *              capital = 2 * Q * unitCost (1x when one side is instant, e.g. NPC buy or sell)
 * Q = min(volume that fills within a cycle, forgeCap * cycleHours, capital bound, depthCap, instant caps x
 * cycleHours); then, if its orders need more than orderSlots slots, Q shrinks to fit ('slots'). A batch nothing
 * bounds is MAX_ORDER_UNITS ('depth'). capital <= 0 (or non-finite) means unlimited. Zero/invalid inputs -> all zeros.
 * unitsPerHour = Q / period, so sequential <= pipelined unless capital binds (pipelined holds twice the coins).
 */
export function throughput(o: ThroughputInput): Throughput {
  const forge = o.forgeCap != null && o.forgeCap >= 0 ? o.forgeCap : Infinity;
  const rB = nn(o.rBuy);
  const rS = nn(o.rSell);
  const rMarket = Math.min(rB, rS);
  const sideWhy: Throughput['limitedBy'] = rB <= rS ? (o.buyBound ?? 'volume') : (o.sellBound ?? 'volume');
  if (
    !(rMarket > 0) ||
    !(forge > 0) ||
    !(o.unitCost > 0) ||
    !Number.isFinite(o.unitCost) ||
    !(o.cycleHours > 0) ||
    !Number.isFinite(o.cycleHours)
  ) {
    return { ...ZERO_TP, limitedBy: forge < rMarket ? 'forge' : sideWhy };
  }
  const pipelined = (o.fillModel ?? FILL_MODEL_DEFAULT) === 'pipelined';
  const hB = Number.isFinite(rB) ? 1 / rB : 0;
  const hS = Number.isFinite(rS) ? 1 / rS : 0;
  const hFill = pipelined ? Math.max(hB, hS) : hB + hS;
  const overlap = fillOverlap(o);
  const capital = o.capital > 0 ? o.capital : Infinity;
  const units = validUnits(o.orderUnits);
  // the smallest bound wins; ties keep the first: market volume, forge, capital, depth, then the instant caps
  // (no closures here: throughput runs for every row and re-quote)
  let batchQty = hFill > 0 ? o.cycleHours / hFill : Infinity;
  let limitedBy: Throughput['limitedBy'] = sideWhy;
  const qForge = forge * o.cycleHours;
  if (qForge < batchQty) {
    batchQty = qForge;
    limitedBy = 'forge';
  }
  const qCapital = Math.floor(capital / (overlap * o.unitCost));
  if (qCapital < batchQty) {
    batchQty = qCapital;
    limitedBy = 'capital';
  }
  const qDepth = o.depthCap != null && o.depthCap >= 0 ? o.depthCap : Infinity;
  if (qDepth < batchQty) {
    batchQty = qDepth;
    limitedBy = 'depth';
  }
  // instant legs (NaN/negative caps -> 0)
  for (const c of o.caps ?? []) {
    const q = nn(c.perHour) * o.cycleHours;
    if (q < batchQty) {
      batchQty = q;
      limitedBy = c.bound;
    }
  }
  const qBuyCap = o.buyCapPerHour != null ? nn(o.buyCapPerHour) * o.cycleHours : Infinity;
  if (qBuyCap < batchQty) {
    batchQty = qBuyCap;
    limitedBy = 'npcLimit';
  }
  const slotCap = o.orderSlots != null && o.orderSlots >= 0 ? Math.floor(o.orderSlots) : Infinity;
  if (units.length > 0 && slotsFor(batchQty, units) > slotCap) {
    batchQty = maxQForSlots(units, slotCap);
    limitedBy = 'slots';
  }
  if (!Number.isFinite(batchQty)) {
    // nothing bounds the batch (instant legs, unlimited capital, no orders or slot limit): one order's worth
    batchQty = MAX_ORDER_UNITS;
    limitedBy = 'depth';
  }
  if (!(batchQty > 0)) return { ...ZERO_TP, limitedBy };
  const buyHours = batchQty * hB;
  const sellHours = batchQty * hS;
  const fillHours = Math.max(pipelined ? Math.max(buyHours, sellHours) : buyHours + sellHours, batchQty / forge);
  return {
    unitsPerHour: batchQty / Math.max(o.cycleHours, fillHours),
    batchQty,
    capitalUsed: overlap * batchQty * o.unitCost,
    fillHours,
    limitedBy,
    buyHours,
    sellHours,
    slots: slotsFor(batchQty, units),
  };
}

/** Units/hour you can buy from an NPC shop with the given per-item daily limit (NaN/negative -> 0). */
export function npcBuyRate(dailyLimit: number): number {
  return nn(dailyLimit) / 24;
}

/** NaN/negative -> 0; keeps Infinity. */
function nn(x: number): number {
  return x > 0 ? x : 0;
}

/**
 * One side of a trade for planTrade, per batch unit: price (net = after tax for sales), your rate, optional book
 * depth. A book combine's unit is one output book, so its input leg costs `count` books and divides rate and depth.
 */
export interface Leg {
  price: number;
  /** what you actually pay / receive per unit (sell legs: after tax) */
  net: number;
  /** units/hour; Infinity for an instant leg (NPC sale, or an NPC purchase with `cap`) */
  rate: number;
  /** units on the book, insta legs only: a leg with depth is re-quoted at the batch size */
  depth?: number;
  comp?: number;
  /** this leg rests on the bazaar as an order (uses an order slot) */
  order?: boolean;
  /** units resting on this leg's order per batch unit (default 1), e.g. 2^(L-k) input books per output book */
  units?: number;
  /** per-hour cap of an instant leg (an NPC shop's daily limit / 24), reported as `bound` (default 'npcLimit') */
  cap?: number;
  /** quote clamp passed through from buyQuote */
  clamped?: Quote['clamped'];
  /** reported as limitedBy when this leg's rate (or cap) binds (default 'volume') */
  bound?: SideBound;
  /** the shared market this leg draws on, for the planner (sideRes) */
  res?: ResourceKey;
  /** what conservatism changed on this leg's quote */
  cons?: ConsInfo;
}

/** Settings planTrade needs (a full Settings object fits). */
export interface PlanSettings {
  capital: number;
  cycleHours: number;
  fillModel?: FillModel;
  orderSlots?: number;
}

export interface TradePlan {
  buy: Leg;
  sell: Leg;
  profit: number;
  tp: Throughput;
}

const minDefined = (a?: number, b?: number) => (a == null ? b : b == null ? a : Math.min(a, b));
const isInsta = (l: Leg) => l.depth != null;

/** Throughput input of a buy leg and a sell leg (orders from `order` legs, instant caps from `cap` legs). */
export function legsInput(b: Leg, sl: Leg, s: PlanSettings): ThroughputInput {
  const orderUnits: number[] = [];
  const caps: RateCap[] = [];
  for (const l of [b, sl]) {
    if (l.order) orderUnits.push(l.units ?? 1);
    if (l.cap != null) caps.push({ perHour: l.cap, bound: l.bound ?? 'npcLimit' });
  }
  return {
    rBuy: b.rate,
    rSell: sl.rate,
    unitCost: b.net,
    capital: s.capital,
    cycleHours: s.cycleHours,
    depthCap: minDefined(b.depth, sl.depth),
    fillModel: s.fillModel,
    orderSlots: s.orderSlots,
    orderUnits,
    buyBound: b.bound,
    sellBound: sl.bound,
    caps,
  };
}

/** Planner uses of some legs: one entry per resource key, units per batch unit summed. */
export function legUses(legs: readonly Leg[]): ResourceUse[] {
  const out: ResourceUse[] = [];
  for (const l of legs) {
    if (!l.res) continue;
    const u = out.find((x) => x.key === l.res);
    if (u) u.perUnit += l.units ?? 1;
    else out.push({ key: l.res, perUnit: l.units ?? 1 });
  }
  return out;
}

/**
 * Evaluate buy-then-sell of one unit type. Legs are quoted for a quantity; when a leg is insta (it has a depth) or
 * `refine` is set, the legs are re-quoted once at the planned batch size so VWAP slippage is reflected in profit.
 */
export function planTrade(
  buy: (qty: number) => Leg | null,
  sell: (qty: number) => Leg | null,
  s: PlanSettings,
  refine = false,
): TradePlan | null {
  let b = buy(1);
  let sl = sell(1);
  if (!b || !sl) return null;
  let tp = throughput(legsInput(b, sl, s));
  if ((refine || isInsta(b) || isInsta(sl)) && tp.batchQty > 1 && sl.net - b.net > 0) {
    const q = Math.ceil(tp.batchQty);
    const b2 = buy(q);
    const s2 = sell(q);
    if (b2 && s2) {
      b = b2;
      sl = s2;
      tp = throughput(legsInput(b, sl, s));
    }
  }
  return { buy: b, sell: sl, profit: sl.net - b.net, tp };
}

/** What planInputs needs from a row. */
export interface PlanSpec {
  /** the row's throughput input at its base quotes; capital and order slots are replaced by "unlimited" */
  tp: ThroughputInput;
  /** profit per unit at the base quotes */
  profitPerUnit: number;
  uses: readonly ResourceUse[];
  /**
   * Re-quote with `qty` units traded at once (insta legs walk the book): profit and buy cost per unit. Give it when a
   * leg is insta; null keeps the base quotes.
   */
  requote?: (qty: number) => { profitPerUnit: number; buyCost: number } | null;
}

/**
 * Planner inputs of a row, with capital and order slots unbounded (the planner applies both): maxUnits and
 * unitsPerHour from throughput, buyCost per unit and unitCost with the pipelined overlap. With `requote`, the
 * profit is taken at maxUnits, and `segments` split 0..maxUnits into OPTIMIZER.segments equal slices, each with the
 * marginal profit per unit of that slice (clamped non-increasing, so the curve is concave).
 */
export function planInputs(o: PlanSpec): PlanInputs {
  const input: ThroughputInput = { ...o.tp, capital: 0, orderSlots: undefined };
  const tp = throughput(input);
  const maxUnits = tp.batchQty;
  let buyCost = o.tp.unitCost;
  let profitPerUnit = o.profitPerUnit;
  let segments: ProfitSegment[] | undefined;
  if (o.requote && maxUnits > 0) {
    const n = Math.max(1, OPTIMIZER.segments);
    const segs: ProfitSegment[] = [];
    let prevQ = 0;
    let prevTotal = 0;
    for (let k = 1; k <= n; k++) {
      const q = (maxUnits * k) / n;
      const r = o.requote(q);
      if (!r) break;
      const total = q * r.profitPerUnit;
      const marginal = (total - prevTotal) / (q - prevQ);
      segs.push({ upTo: q, profitPerUnit: Math.min(marginal, segs.at(-1)?.profitPerUnit ?? Infinity) });
      prevQ = q;
      prevTotal = total;
      if (k === n) {
        buyCost = r.buyCost;
        profitPerUnit = r.profitPerUnit;
        segments = segs;
      }
    }
  }
  const plan: PlanInputs = {
    unitCost: fillOverlap(input) * buyCost,
    buyCost,
    profitPerUnit,
    unitsPerHour: tp.unitsPerHour,
    maxUnits,
    orderUnits: validUnits(o.tp.orderUnits),
    uses: [...o.uses],
  };
  if (segments) plan.segments = segments;
  return plan;
}

/** planInputs of a buy-then-sell trade (flips, books, NPC flips): legs at one unit, re-quoted when one is insta. */
export function tradePlanInputs(
  buy: (qty: number) => Leg | null,
  sell: (qty: number) => Leg | null,
  s: Pick<PlanSettings, 'cycleHours' | 'fillModel'>,
): PlanInputs | null {
  const b = buy(1);
  const sl = sell(1);
  if (!b || !sl) return null;
  const spec: PlanSpec = {
    tp: legsInput(b, sl, { cycleHours: s.cycleHours, fillModel: s.fillModel, capital: 0 }),
    profitPerUnit: sl.net - b.net,
    uses: legUses([b, sl]),
  };
  if (isInsta(b) || isInsta(sl)) {
    spec.requote = (q: number) => {
      const b2 = buy(q);
      const s2 = sell(q);
      return b2 && s2 ? { profitPerUnit: s2.net - b2.net, buyCost: b2.net } : null;
    };
  }
  return planInputs(spec);
}
