// History-based conservatism (settings.conservative): adjust one bazaar side's price and rate from the recent
// history. Owner: s1/core. Wave 0 stub: changes nothing.
import type { MarketStat, PriceStats, Product, Settings } from '../types/contracts.ts';

export interface SideAdjustment {
  /** adjusted per-unit price (sell: never above the snapshot quote; buy: never below it) */
  price: number;
  /** fill-rate multiplier (<= 1) */
  rateMul: number;
  /** expected coins lost per unit to re-listing after being outbid / undercut */
  churn: number;
}

/**
 * The adjustment for trading `p` on one side at `price` (the snapshot quote), or null when conservatism is off,
 * there is too little history, or nothing changes. `legHours` = hours the leg rests on the book.
 */
export function sideAdjust(
  _side: 'buy' | 'sell',
  _p: Product,
  _price: number,
  _stats: PriceStats | null,
  _market: MarketStat | null,
  _s: Pick<Settings, 'conservative' | 'cycleHours' | 'costMode' | 'sellMode'>,
  _legHours?: number,
): SideAdjustment | null {
  return null;
}
