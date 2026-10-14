import { RISK } from '../config.ts';
import type { PriceStats, Product, RiskFlag, RiskLevel, RiskReport } from '../types/contracts.ts';
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

const outside = (x: number, [lo, hi]: readonly [number, number]) => x < lo || x > hi;

/** Risk assessment of a single product's market (thresholds in config.RISK; see plan). */
export function assessRisk(p: Product, stats?: PriceStats | null): RiskReport {
  const flags: RiskFlag[] = [];
  const { bid, ask } = p;

  // DEAD_BID: no buy orders, or bids are a token fraction of the ask.
  if (bid == null || (ask != null && (bid < ask * RISK.deadBidRatio || (bid <= 1 && ask > 100)))) flags.push('DEAD_BID');

  const spread = bid != null && ask != null && bid > 0 ? (ask - bid) / bid : 0;
  if (spread > RISK.wideSpreadMargin) flags.push('WIDE_SPREAD');
  if (spread > RISK.extremeSpreadMargin && !flags.includes('DEAD_BID')) flags.push('EXTREME_SPREAD');

  const weekVol = Math.min(p.instaBuysWeek || 0, p.instaSellsWeek || 0);
  const refPrice = ask ?? bid ?? 0;
  if (weekVol < RISK.lowVolumeUnits || weekVol * refPrice < RISK.lowVolumeCoins) flags.push('LOW_VOLUME');

  if ((p.quick.buyOrders || 0) < RISK.fewOrders || (p.quick.sellOrders || 0) < RISK.fewOrders) flags.push('FEW_ORDERS');

  const [a0, a1] = p.asks;
  const [b0, b1] = p.bids;
  const thinAsk = a0 && a1 && a1.price > a0.price * RISK.thinTopGap && a0.amount < p.instaBuysWeek / 168;
  const thinBid = b0 && b1 && b1.price < b0.price / RISK.thinTopGap && b0.amount < p.instaSellsWeek / 168;
  if (thinAsk || thinBid) flags.push('THIN_TOP');

  const divAsk = ask != null && ask > 0 && p.quick.buyPrice > 0 && outside(p.quick.buyPrice / ask, RISK.quickDivergence);
  const divBid = bid != null && bid > 0 && p.quick.sellPrice > 0 && outside(p.quick.sellPrice / bid, RISK.quickDivergence);
  if (divAsk || divBid) flags.push('QUICK_DIVERGENCE');

  const ib = p.instaBuysWeek || 0;
  const is = p.instaSellsWeek || 0;
  if ((ib > 0 || is > 0) && (ib === 0 || is === 0 || outside(ib / is, RISK.volumeImbalance))) flags.push('VOLUME_IMBALANCE');

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
