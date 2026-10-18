import { RISK } from '../config.ts';
import type { CostMode, PriceStats, Product, RiskFlag, RiskLevel, RiskReport, SellMode } from '../types/contracts.ts';
import type { RiskUse } from './market.ts';
import { robustZ } from './stats.ts';

/** Canonical flag order (reports list flags in this order). */
export const RISK_FLAGS: readonly RiskFlag[] = [
  'DEAD_BID',
  'PRICE_SPIKE',
  'WIDE_SPREAD',
  'EXTREME_SPREAD',
  'LOW_VOLUME',
  'FEW_ORDERS',
  'THIN_TOP',
  'QUICK_DIVERGENCE',
  'VOLUME_IMBALANCE',
  'AH_THIN',
  'AH_GAP',
  'AH_VARIANT',
  'NO_HISTORY',
];

/** Flags that make a market 'suspect' on their own. */
export const HARD_FLAGS: ReadonlySet<RiskFlag> = new Set<RiskFlag>(['DEAD_BID', 'EXTREME_SPREAD', 'PRICE_SPIKE']);

const LEVEL_RANK: Record<RiskLevel, number> = { ok: 0, caution: 1, suspect: 2 };

/** Score weight of a flag; hard flags weigh suspectScore. */
export function flagWeight(f: RiskFlag): number {
  if (HARD_FLAGS.has(f)) return RISK.suspectScore;
  return (RISK.weights as Record<string, number>)[f] ?? 0;
}

/** Build a report (score + level) from a set of flags. */
export function reportFromFlags(flags: Iterable<RiskFlag>): RiskReport {
  const set = new Set(flags);
  const ordered = RISK_FLAGS.filter((f) => set.has(f));
  const score = ordered.reduce((s, f) => s + flagWeight(f), 0);
  let level: RiskLevel = 'ok';
  if (
    ordered.some((f) => HARD_FLAGS.has(f)) ||
    (set.has('WIDE_SPREAD') && set.has('LOW_VOLUME')) ||
    score >= RISK.suspectScore
  ) {
    level = 'suspect';
  } else if (score >= RISK.cautionScore) {
    level = 'caution';
  }
  return { level, score, flags: ordered };
}

/** Ingredient flags that matter even when buying by order (dead bids etc. are normal on raw materials). */
export const INGREDIENT_FLAGS: ReadonlySet<RiskFlag> = new Set<RiskFlag>(['PRICE_SPIKE', 'QUICK_DIVERGENCE']);

const outside = (x: number, [lo, hi]: readonly [number, number]) => x < lo || x > hi;

/** A side of the book: bids (buy orders, filled by insta-sells) or asks (sell offers, filled by insta-buys). */
export type BookSide = 'bid' | 'ask';

/**
 * The book side a leg queues on or trades against, which is also the flow that fills it and the price it is quoted
 * from: a buy order and an insta-sell use the bids, an insta-buy and a sell offer use the asks.
 */
export function bookOf(side: 'buy' | 'sell', mode: CostMode | SellMode): BookSide {
  return (side === 'buy') === (mode !== 'insta') ? 'bid' : 'ask';
}

/**
 * Risk assessment of a single product's market (thresholds in config.RISK; see docs/estimates.md).
 * `use` names the sides a strategy trades; without it every flag is checked on both sides (side-blind). With it:
 * the spread and dead-bid flags (DEAD_BID, WIDE_SPREAD, EXTREME_SPREAD) only when a sell side is used, since a buyer
 * pays the quote it gets; LOW_VOLUME, QUICK_DIVERGENCE, FEW_ORDERS and THIN_TOP only on the book sides used (bookOf);
 * VOLUME_IMBALANCE only when the smaller flow is used. PRICE_SPIKE and NO_HISTORY are checked either way.
 */
export function assessRisk(p: Product, stats?: PriceStats | null, use?: RiskUse): RiskReport {
  const flags: RiskFlag[] = [];
  const { bid, ask } = p;
  const books = new Set<BookSide>(use ? [] : ['bid', 'ask']);
  if (use?.buy) books.add(bookOf('buy', use.buy));
  if (use?.sell) books.add(bookOf('sell', use.sell));
  const selling = !use || use.sell != null;

  // DEAD_BID: no buy orders, or bids are a token fraction of the ask.
  const deadBid = bid == null || (ask != null && (bid < ask * RISK.deadBidRatio || (bid <= 1 && ask > 100)));
  if (deadBid && selling) flags.push('DEAD_BID');

  const spread = bid != null && ask != null && bid > 0 ? (ask - bid) / bid : 0;
  if (spread > RISK.wideSpreadMargin && selling) flags.push('WIDE_SPREAD');
  if (spread > RISK.extremeSpreadMargin && !deadBid && selling) flags.push('EXTREME_SPREAD');

  // the flow that fills each used side: bids fill from insta-sells, asks from insta-buys
  const ib = p.instaBuysWeek || 0;
  const is = p.instaSellsWeek || 0;
  const flow: Record<BookSide, number> = { bid: is, ask: ib };
  if (books.size > 0) {
    const weekVol = Math.min(...[...books].map((b) => flow[b]));
    const refPrice = ask ?? bid ?? 0;
    if (weekVol < RISK.lowVolumeUnits || weekVol * refPrice < RISK.lowVolumeCoins) flags.push('LOW_VOLUME');
  }

  // quick_status names the sides the API way: buyOrders = sell offers (asks), sellOrders = buy orders (bids)
  const orders: Record<BookSide, number> = { bid: p.quick.sellOrders || 0, ask: p.quick.buyOrders || 0 };
  if ([...books].some((b) => orders[b] < RISK.fewOrders)) flags.push('FEW_ORDERS');

  const [a0, a1] = p.asks;
  const [b0, b1] = p.bids;
  const thinAsk = books.has('ask') && a0 && a1 && a1.price > a0.price * RISK.thinTopGap && a0.amount < p.instaBuysWeek / 168;
  const thinBid = books.has('bid') && b0 && b1 && b1.price < b0.price / RISK.thinTopGap && b0.amount < p.instaSellsWeek / 168;
  if (thinAsk || thinBid) flags.push('THIN_TOP');

  const divAsk = books.has('ask') && ask != null && ask > 0 && p.quick.buyPrice > 0 && outside(p.quick.buyPrice / ask, RISK.quickDivergence);
  const divBid = books.has('bid') && bid != null && bid > 0 && p.quick.sellPrice > 0 && outside(p.quick.sellPrice / bid, RISK.quickDivergence);
  if (divAsk || divBid) flags.push('QUICK_DIVERGENCE');

  const imbalanced = (ib > 0 || is > 0) && (ib === 0 || is === 0 || outside(ib / is, RISK.volumeImbalance));
  if (imbalanced && books.has(ib < is ? 'ask' : 'bid')) flags.push('VOLUME_IMBALANCE');

  if (!stats || stats.n < RISK.spikeMinPoints) {
    flags.push('NO_HISTORY');
  } else {
    const z = ask != null ? robustZ(ask, stats.medianAsk, stats.madAsk) : NaN;
    const up = ask != null && stats.medianAsk > 0 && ask / stats.medianAsk > RISK.spikeUp;
    const down = bid != null && stats.medianBid > 0 && bid / stats.medianBid < RISK.spikeDown;
    if (z > RISK.spikeZ || up || down) flags.push('PRICE_SPIKE');
  }

  return reportFromFlags(flags);
}

/** Combine several reports (e.g. craft output + ingredients): union of flags, max score, worst level. */
export function combineRisk(reports: readonly RiskReport[]): RiskReport {
  const set = new Set<RiskFlag>();
  let score = 0;
  let level: RiskLevel = 'ok';
  for (const r of reports) {
    for (const f of r.flags) set.add(f);
    score = Math.max(score, r.score);
    if (LEVEL_RANK[r.level] > LEVEL_RANK[level]) level = r.level;
  }
  return { level, score, flags: RISK_FLAGS.filter((f) => set.has(f)) };
}
