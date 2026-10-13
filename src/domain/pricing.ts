import { COMP_TOL, MAX_ORDER_UNITS, NPC_FLOOR_RATIO, PRICE_TICK } from '../config.ts';
import type { CostMode, OrderLevel, Product, Quote, SellMode, Throughput } from '../types/contracts.ts';
import { bookUnits, walkBook } from './book.ts';

const HOURS_PER_WEEK = 168;

/** Round to one decimal (bazaar price granularity), avoiding float noise. */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * Per-unit cost of acquiring the product.
 *  order: bid + PRICE_TICK (rounded to 0.1), filled=Infinity, slippage 0, source 'order'
 *  insta: walkBook(asks, qty ?? 1).avgPrice, filled from walk, slippage vs ask, source 'insta'
 * null when the needed side is empty.
 */
export function buyQuote(p: Product, mode: CostMode, qty?: number, npcSell?: number): Quote | null {
  if (mode === 'order') {
    if (p.bid == null || !Number.isFinite(p.bid)) return null;
    // Sellers rarely dump far below the NPC price, so a 0.1 bid on a raw material is a stale floor:
    // assume a buy order must pay at least NPC_FLOOR_RATIO x the NPC sell price.
    const price = Math.max(round1(p.bid + PRICE_TICK), round1((npcSell ?? 0) * NPC_FLOOR_RATIO));
    return { price, filled: Infinity, slippage: 0, source: 'order' };
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

/** Buy side: order -> queue on bids (competition), insta -> take asks (share only, depth-capped). */
export function buySide(p: Product, mode: CostMode, share: number, qty?: number, npcSell?: number): SideInfo | null {
  const quote = buyQuote(p, mode, qty, npcSell);
  if (!quote) return null;
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
}

const ZERO_TP: Throughput = { unitsPerHour: 0, batchQty: 0, capitalUsed: 0, fillHours: 0, limitedBy: 'volume' };

/**
 * r = min(rBuy, rSell, forgeCap?)
 * batchQty = min(floor(capital/unitCost), r*cycleHours, depthCap?, MAX_ORDER_UNITS)
 * unitsPerHour = batchQty / max(cycleHours, batchQty / r)
 * capitalUsed = batchQty*unitCost; fillHours = batchQty / r; limitedBy = whichever bound won.
 * capital <= 0 (or non-finite) means unlimited. MAX_ORDER_UNITS reports as 'depth'.
 * Zero/invalid inputs -> all zeros.
 */
export function throughput(o: ThroughputInput): Throughput {
  const forge = o.forgeCap != null && o.forgeCap >= 0 ? o.forgeCap : Infinity;
  const rMarket = Math.min(nn(o.rBuy), nn(o.rSell));
  const r = Math.min(rMarket, forge);
  if (!(r > 0) || !(o.unitCost > 0) || !Number.isFinite(o.unitCost) || !(o.cycleHours > 0) || !Number.isFinite(o.cycleHours)) {
    return { ...ZERO_TP, limitedBy: forge < rMarket ? 'forge' : 'volume' };
  }
  const capital = o.capital > 0 ? o.capital : Infinity;
  const bounds: [number, Throughput['limitedBy']][] = [
    [r * o.cycleHours, forge < rMarket ? 'forge' : 'volume'],
    [Math.floor(capital / o.unitCost), 'capital'],
    [o.depthCap != null && o.depthCap >= 0 ? o.depthCap : Infinity, 'depth'],
    [MAX_ORDER_UNITS, 'depth'],
  ];
  let [batchQty, limitedBy] = bounds[0]!;
  for (const [q, why] of bounds) {
    if (q < batchQty) {
      batchQty = q;
      limitedBy = why;
    }
  }
  if (!(batchQty > 0)) return { ...ZERO_TP, limitedBy };
  const fillHours = Number.isFinite(r) ? batchQty / r : 0;
  return {
    unitsPerHour: batchQty / Math.max(o.cycleHours, fillHours),
    batchQty,
    capitalUsed: batchQty * o.unitCost,
    fillHours,
    limitedBy,
  };
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
  s: { capital: number; cycleHours: number },
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
