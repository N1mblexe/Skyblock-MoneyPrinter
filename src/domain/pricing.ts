import { COMP_TOL, FILL_MODEL_DEFAULT, MAX_ORDER_UNITS, NPC_FLOOR_RATIO, PRICE_TICK } from '../config.ts';
import type { CostMode, FillModel, OrderLevel, Product, Quote, SellMode, Throughput } from '../types/contracts.ts';
import { bookUnits, walkBook } from './book.ts';

const HOURS_PER_WEEK = 168;

/** Round to one decimal (bazaar price granularity), avoiding float noise. */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * Per-unit cost of acquiring the product.
 *  order: min(max(bid + PRICE_TICK, NPC_FLOOR_RATIO x npcSell), ask) (rounded to 0.1), filled=Infinity, slippage 0,
 *         source 'order'; `clamped` says whether the NPC floor raised it or the ask capped it
 *  insta: walkBook(asks, qty ?? 1).avgPrice, filled from walk, slippage vs ask, source 'insta'
 * null when the needed side is empty.
 */
export function buyQuote(p: Product, mode: CostMode, qty?: number, npcSell?: number): Quote | null {
  if (mode === 'order') {
    if (p.bid == null || !Number.isFinite(p.bid)) return null;
    // Sellers rarely dump far below the NPC price, so a 0.1 bid on a raw material is a stale floor:
    // assume a buy order must pay at least NPC_FLOOR_RATIO x the NPC sell price, but never more than the ask.
    const base = round1(p.bid + PRICE_TICK);
    const floor = round1((npcSell ?? 0) * NPC_FLOOR_RATIO);
    let price = Math.max(base, floor);
    let clamped: Quote['clamped'] = floor > base ? 'npcFloor' : undefined;
    if (p.ask != null && Number.isFinite(p.ask) && price > p.ask) {
      price = p.ask;
      clamped = 'ask';
    }
    const q: Quote = { price, filled: Infinity, slippage: 0, source: 'order' };
    if (clamped) q.clamped = clamped;
    return q;
  }
  const w = walkBook(p.asks, qty ?? 1);
  if (!w) return null;
  const top = p.asks[0]!.price;
  return { price: w.avgPrice, filled: w.filled, slippage: top > 0 ? (w.avgPrice - top) / top : 0, source: 'insta' };
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

/** Sum of `orders` over levels within tol (relative) of the best level's price. */
export function competitors(levels: readonly OrderLevel[], tol: number = COMP_TOL): number {
  const best = levels[0];
  if (!best) return 0;
  const band = Math.abs(best.price) * tol;
  let n = 0;
  for (const l of levels) if (Math.abs(l.price - best.price) <= band + 1e-9) n += Math.max(0, l.orders);
  return n;
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
 * An order capped at the ask fills against the sell offers right away, so it gets the insta-buy rate (no queue).
 */
export function buySide(p: Product, mode: CostMode, share: number, qty?: number, npcSell?: number): SideInfo | null {
  const quote = buyQuote(p, mode, qty, npcSell);
  if (!quote) return null;
  if (quote.clamped === 'ask') return { quote, rate: sideRates(p, 'insta', 'offer').buy * Math.max(0, share), comp: 0 };
  const raw = sideRates(p, mode, 'offer').buy;
  if (mode === 'order') {
    const comp = competitors(p.bids);
    return { quote, rate: raw * effShare(share, comp), comp };
  }
  return { quote, rate: raw * Math.max(0, share), comp: 0, depth: bookUnits(p.asks) };
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

/** What limits a side's rate when that side binds: market volume, or an NPC shop's daily limit. */
export type SideBound = 'volume' | 'npcLimit';

export interface ThroughputInput {
  /** your buy-side rate, units/hour (after share) */
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

/**
 * One batch of Q units per period, period = max(cycleHours, fill time, Q / forgeCap).
 *  sequential: buy the batch, then sell it -> fill time = Q/rBuy + Q/rSell, capital = Q * unitCost
 *  pipelined:  one batch buys while the previous one sells -> fill time = Q / min(rBuy, rSell),
 *              capital = 2 * Q * unitCost (1x when one side is instant, e.g. NPC sell)
 * Q = min(volume that fills within a cycle, forgeCap * cycleHours, capital bound, depthCap); then, if its orders need
 * more than orderSlots slots, Q shrinks to fit ('slots'). A batch nothing bounds is MAX_ORDER_UNITS ('depth').
 * capital <= 0 (or non-finite) means unlimited. Zero/invalid inputs -> all zeros.
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
  const overlap = pipelined && hB > 0 && hS > 0 ? 2 : 1;
  const capital = o.capital > 0 ? o.capital : Infinity;
  const units = (o.orderUnits ?? []).filter((u) => u > 0 && Number.isFinite(u));
  const bounds: [number, Throughput['limitedBy']][] = [
    [hFill > 0 ? o.cycleHours / hFill : Infinity, sideWhy],
    [forge * o.cycleHours, 'forge'],
    [Math.floor(capital / (overlap * o.unitCost)), 'capital'],
    [o.depthCap != null && o.depthCap >= 0 ? o.depthCap : Infinity, 'depth'],
  ];
  let [batchQty, limitedBy] = bounds[0]!;
  for (const [q, why] of bounds) {
    if (q < batchQty) {
      batchQty = q;
      limitedBy = why;
    }
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

/** One side of a trade for planTrade: per-unit price (net = after tax for sales), your rate, optional book depth. */
export interface Leg {
  price: number;
  /** what you actually pay / receive per unit (sell legs: after tax) */
  net: number;
  rate: number;
  depth?: number;
  comp?: number;
  /** this leg rests on the bazaar as an order (uses an order slot) */
  order?: boolean;
  /** reported as limitedBy when this leg's rate binds (default 'volume') */
  bound?: SideBound;
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

/**
 * Evaluate buy-then-sell of one unit type. Legs are quoted for a quantity; when `refine` is set (an insta side),
 * the legs are re-quoted once at the planned batch size so VWAP slippage is reflected in profit.
 */
export function planTrade(
  buy: (qty: number) => Leg | null,
  sell: (qty: number) => Leg | null,
  s: PlanSettings,
  refine: boolean,
): TradePlan | null {
  let b = buy(1);
  let sl = sell(1);
  if (!b || !sl) return null;
  const tpFor = (bl: Leg, sll: Leg) =>
    throughput({
      rBuy: bl.rate,
      rSell: sll.rate,
      unitCost: bl.net,
      capital: s.capital,
      cycleHours: s.cycleHours,
      depthCap: minDefined(bl.depth, sll.depth),
      fillModel: s.fillModel,
      orderSlots: s.orderSlots,
      orderUnits: [bl, sll].filter((l) => l.order).map(() => 1),
      buyBound: bl.bound,
      sellBound: sll.bound,
    });
  let tp = tpFor(b, sl);
  if (refine && tp.batchQty > 1 && sl.net - b.net > 0) {
    const q = Math.ceil(tp.batchQty);
    const b2 = buy(q);
    const s2 = sell(q);
    if (b2 && s2) {
      b = b2;
      sl = s2;
      tp = tpFor(b, sl);
    }
  }
  return { buy: b, sell: sl, profit: sl.net - b.net, tp };
}
