// Per-item market statistics from history points. Owner: history package.
import type { HistoryPoint, MarketStat } from '../types/contracts.ts';

/** Stats for one item from its (ts-sorted) history points. Wave 0 stub. */
export function marketStatFromPoints(id: string, pts: readonly HistoryPoint[], _now: number, _taxRate: number): MarketStat {
  return {
    id,
    n: pts.length,
    change1h: null,
    change24h: null,
    volatility: null,
    spreadMedian: null,
    consistency: null,
    buyVolTrend: null,
    sellVolTrend: null,
  };
}
