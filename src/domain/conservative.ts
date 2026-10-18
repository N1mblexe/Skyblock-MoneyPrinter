// History-based conservatism (settings.conservative): adjust one bazaar side's price and rate from the recent
// history. Owner: s1/core.
import { CONSERVATIVE, PRICE_TICK } from '../config.ts';
import type { MarketStat, PriceStats, Product, Settings } from '../types/contracts.ts';
import { competitors, round1 } from './pricing.ts';

export interface SideAdjustment {
  /** adjusted per-unit price (sell: never above the snapshot quote; buy: never below it) */
  price: number;
  /** fill-rate multiplier (<= 1) */
  rateMul: number;
  /** expected coins lost per unit to re-listing after being outbid / undercut */
  churn: number;
  /** orders and offers: competitors weighted by amount, when that is more than the order count */
  comp?: number;
}

const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);
const pos = (x: number | null | undefined): x is number => fin(x) && x > 0;

/** The volume trend clamped to CONSERVATIVE.trendClamp; 1 when unknown. */
function trendMul(trend: number | null | undefined): number {
  if (!fin(trend)) return 1;
  const [lo, hi] = CONSERVATIVE.trendClamp;
  return Math.min(hi, Math.max(lo, trend));
}

/**
 * The adjustment for trading `p` on one side at `price` (the snapshot quote), or null when conservatism is off,
 * there is too little history, or nothing changes. `legHours` = hours the leg rests on the book (default
 * s.cycleHours). The side's mode is s.costMode (buy) or s.sellMode (sell):
 *  price  sell offer min(price, medianAsk - tick), insta-sell min(price, medianBid);
 *         buy order max(price, medianBid + tick) but never above the ask, insta-buy max(price, medianAsk)
 *  rate   x the volume trend of the flow that fills the side (buy order / insta-sell: insta-sells; sell offer /
 *         insta-buy: insta-buys), clamped to CONSERVATIVE.trendClamp
 *  churn  orders and offers only: relists x max(tick, relistStep x price), relists = min(maxRelists, top moves per
 *         hour on the side you queue on x legHours)
 *  comp   orders and offers only: competitors on the side you queue on weighted by amount (competitors(…, true)),
 *         set when that is more than the plain order count
 */
export function sideAdjust(
  side: 'buy' | 'sell',
  p: Product,
  price: number,
  stats: PriceStats | null,
  market: MarketStat | null,
  s: Pick<Settings, 'conservative' | 'cycleHours' | 'costMode' | 'sellMode'>,
  legHours?: number,
): SideAdjustment | null {
  if (!s.conservative || !stats || !(stats.n >= CONSERVATIVE.minPoints)) return null;
  const queued = side === 'buy' ? s.costMode === 'order' : s.sellMode === 'offer';
  let adj = price;
  if (side === 'sell') {
    const ref = queued ? stats.medianAsk - PRICE_TICK : stats.medianBid;
    if (pos(ref)) adj = Math.min(price, round1(ref));
  } else {
    const ref = queued ? stats.medianBid + PRICE_TICK : stats.medianAsk;
    if (pos(ref)) {
      adj = Math.max(price, round1(ref));
      // an order above the ask would be an insta-buy
      if (queued && pos(p.ask)) adj = Math.max(price, Math.min(adj, p.ask));
    }
  }
  // bids fill from insta-sells, asks from insta-buys
  const bidSide = (side === 'buy') === queued;
  const rateMul = trendMul(bidSide ? market?.sellVolTrend : market?.buyVolTrend);
  let churn = 0;
  if (queued) {
    const moves = side === 'buy' ? market?.bidMovesPerHour : market?.askMovesPerHour;
    const hours = legHours ?? s.cycleHours;
    const relists = pos(moves) && pos(hours) ? Math.min(CONSERVATIVE.maxRelists, moves * hours) : 0;
    churn = relists * Math.max(PRICE_TICK, CONSERVATIVE.relistStep * adj);
  }
  let comp: number | undefined;
  if (queued) {
    const levels = side === 'buy' ? p.bids : p.asks;
    const weighted = competitors(levels, undefined, true);
    if (weighted > competitors(levels)) comp = weighted;
  }
  if (adj === price && rateMul === 1 && churn === 0 && comp == null) return null;
  const out: SideAdjustment = { price: adj, rateMul, churn };
  if (comp != null) out.comp = comp;
  return out;
}
