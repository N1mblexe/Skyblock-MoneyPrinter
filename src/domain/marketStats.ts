// Per-item market statistics (MarketStat) and risk baselines (PriceStats) from history columns or points. Owner: s1/state.
import { HISTORY_Q15_BUCKET_MS, HISTORY_RAW_KEEP_MS, PRICE_TICK, STATS } from '../config.ts';
import type { HistoryPoint, MarketStat, PriceStats } from '../types/contracts.ts';
import { medianInPlace, medMadInPlace, pctChange } from './stats.ts';

const H = 3600_000;
const HOURS_PER_WEEK = 168;
/** volume trends need at least this much time between the first and last counter reading */
const TREND_MIN_SPAN_MS = 30 * 60_000;
/** PriceStats.change24h needs at least this much time between the first and last two-sided point */
const CHANGE_MIN_SPAN_MS = 20 * H;

/**
 * Column view of one item's history, sorted by ts; row k is (ts[k], bid[k], ask[k], buyWeek[k], sellWeek[k]).
 * NaN = side missing. Typed-array subarrays work, so the history repo can feed its Float32 rows without building
 * point objects.
 */
export interface StatColumns {
  ts: ArrayLike<number>;
  bid: ArrayLike<number>;
  ask: ArrayLike<number>;
  /** instaBuysWeek (moving week) */
  buyWeek: ArrayLike<number>;
  /** instaSellsWeek (moving week) */
  sellWeek: ArrayLike<number>;
}

const fin = (x: number) => Number.isFinite(x);
const bucketOf = (ts: number) => Math.floor(ts / HISTORY_Q15_BUCKET_MS);

/**
 * Relative change of the mid price over `span`: newest mid vs the mid at the nearest point at or before now - span.
 * Coverage: the newest point must be within tol of now, and the history must reach back to now - span (a first
 * point up to tol after it is accepted, because the in-memory window is cut at exactly now - 24h).
 * tol = max(one 15-min bucket, span / 12): 15 min for 1h, 2h for 24h.
 */
function changeOver(c: StatColumns, n: number, now: number, span: number): number | null {
  const tol = Math.max(HISTORY_Q15_BUCKET_MS, span / 12);
  const mid = (k: number) => (c.bid[k]! + c.ask[k]!) / 2;
  // newest valid point at or before now
  let cur = lastAtOrBefore(c.ts, n, now);
  while (cur >= 0 && !fin(mid(cur))) cur--;
  if (cur < 0 || c.ts[cur]! < now - tol) return null;
  const target = now - span;
  // nearest valid point at or before the target...
  let ref = lastAtOrBefore(c.ts, cur, target);
  while (ref >= 0 && !fin(mid(ref))) ref--;
  if (ref < 0) {
    // ...or the first valid point, if it starts within tol after the target
    let first = 0;
    while (first < cur && !fin(mid(first))) first++;
    if (first < cur && c.ts[first]! <= target + tol) ref = first;
  }
  return ref < 0 ? null : pctChange(mid(ref), mid(cur));
}

/** Largest index k < n with ts[k] <= t (ts sorted), -1 if none. */
function lastAtOrBefore(ts: ArrayLike<number>, n: number, t: number): number {
  let lo = 0;
  let hi = n; // invariant: ts[0..lo) <= t < ts[hi..n)
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (ts[m]! <= t) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

/**
 * Volume trend from a moving-week counter W (units traded in the trailing 168h), read at the first and last valid
 * points of the window, Δt apart. THIS IS AN ESTIMATE:
 *   W(t1) - W(t0) = (volume in the last Δt) - (volume in the same Δt one week earlier).
 * The week-earlier volume is unknown, so we approximate it by the weekly average pace W̄·Δt/168h, with
 * W̄ = (W(t0) + W(t1)) / 2. Then recent ≈ ΔW + W̄·Δt/168h and the reported ratio is
 *   (recent / Δt_h) / (W̄ / 168) = 1 + 168·ΔW / (Δt_h·W̄),   clamped at >= 0.
 * 1 = normal pace, 2 = twice the weekly average. It is skewed when last week's same window was unusual, and the
 * Float32 history rows keep ~7 significant digits of W. null when Δt < 30 min or W̄ <= 0.
 */
function volTrend(ts: ArrayLike<number>, w: ArrayLike<number>, n: number): number | null {
  const ok = (k: number) => fin(w[k]!) && w[k]! >= 0;
  let i0 = 0;
  while (i0 < n && !ok(i0)) i0++;
  if (i0 >= n) return null;
  let i1 = n - 1;
  while (!ok(i1)) i1--;
  const dt = ts[i1]! - ts[i0]!;
  if (dt < TREND_MIN_SPAN_MS) return null;
  const wBar = (w[i0]! + w[i1]!) / 2;
  if (!(wBar > 0)) return null;
  return Math.max(0, 1 + (HOURS_PER_WEEK * (w[i1]! - w[i0]!)) / ((dt / H) * wBar));
}

/**
 * Stats for one item from n column rows (sorted by ts). See MarketStat.
 *  - change1h / change24h: mid price over all points (coverage rules in changeOver).
 *  - volatility, spreadMedian and consistency use the window thinned to the last point per 15-min bucket (like the
 *    q15 store), so the dense last-3h raw records don't outweigh the other 21 hours. n counts the thinned points
 *    with both sides; volatility and consistency need n >= STATS.consistencyMinPoints.
 *  - volatility = MAD / median of mid; spreadMedian = median((ask - bid) / bid) over bid > 0;
 *    consistency = share of points where (ask - tick)(1 - tax) - (bid + tick) > 0.
 *  - buyVolTrend / sellVolTrend: estimate from the moving-week counters, see volTrend.
 *  - bidMovesPerHour / askMovesPerHour: see movesPerHour.
 * scratch (length >= 2n) avoids allocations when called for many items.
 */
export function marketStatFromColumns(
  id: string,
  c: StatColumns,
  n: number,
  now: number,
  taxRate: number,
  scratch: Float64Array = new Float64Array(2 * n),
): MarketStat {
  const mids = scratch;
  const spreads = scratch.subarray(n);
  let nm = 0;
  let ns = 0;
  let good = 0;
  const keep = 1 - taxRate;
  let nextBucket = n > 0 ? bucketOf(c.ts[0]!) : 0;
  for (let k = 0; k < n; k++) {
    const bucket = nextBucket;
    if (k + 1 < n) {
      nextBucket = bucketOf(c.ts[k + 1]!);
      if (nextBucket === bucket) continue; // not the bucket's last point
    }
    const b = c.bid[k]!;
    const a = c.ask[k]!;
    if (!fin(a)) continue;
    if (b > 0) spreads[ns++] = (a - b) / b;
    if (!fin(b)) continue;
    mids[nm++] = (a + b) / 2;
    if ((a - PRICE_TICK) * keep - (b + PRICE_TICK) > 0) good++;
  }
  const enough = nm >= STATS.consistencyMinPoints;
  let volatility: number | null = null;
  if (enough) {
    const [med, madv] = medMadInPlace(mids, nm);
    volatility = med > 0 ? madv / med : null;
  }
  const spread = medianInPlace(spreads, ns);
  return {
    id,
    n: nm,
    change1h: changeOver(c, n, now, H),
    change24h: changeOver(c, n, now, 24 * H),
    volatility,
    spreadMedian: fin(spread) ? spread : null,
    consistency: enough ? good / nm : null,
    buyVolTrend: volTrend(c.ts, c.buyWeek, n),
    sellVolTrend: volTrend(c.ts, c.sellWeek, n),
    bidMovesPerHour: movesPerHour(c.ts, c.bid, n, now),
    askMovesPerHour: movesPerHour(c.ts, c.ask, n, now),
  };
}

/**
 * How often the best price on one side changed: over the points of the last HISTORY_RAW_KEEP_MS up to now (the raw
 * store's every-snapshot records), the number of consecutive pairs whose prices are both finite and differ, divided
 * by the hours from the first to the last of those points. null with fewer than 2 points or a zero span.
 */
function movesPerHour(ts: ArrayLike<number>, px: ArrayLike<number>, n: number, now: number): number | null {
  const k1 = lastAtOrBefore(ts, n, now);
  let k0 = k1;
  const from = now - HISTORY_RAW_KEEP_MS;
  while (k0 > 0 && ts[k0 - 1]! >= from) k0--;
  if (k0 < 0 || k1 - k0 < 1) return null;
  const span = ts[k1]! - ts[k0]!;
  if (!(span > 0)) return null;
  let moves = 0;
  for (let k = k0 + 1; k <= k1; k++) {
    const a = px[k - 1]!;
    const b = px[k]!;
    if (fin(a) && fin(b) && a !== b) moves++;
  }
  return moves / (span / H);
}

/**
 * Risk baseline of one item from n column rows (sorted by ts), as HistoryRepo.stats returns it:
 *  - medians / MADs of ask and bid use the points thinned to the last point per 15-min bucket (like the q15 store),
 *    minus points newer than now - 15 min, so a fresh multi-hour spike in the dense raw data can't become the median
 *    it is compared against. n counts those baseline points.
 *  - change24h: mid change from the first to the last two-sided point (full resolution), when they are at least
 *    20 h apart.
 * null when n = 0 (no points at all). scratch (length >= 2n) avoids allocations when called for many items.
 */
export function priceStatsFromColumns(
  c: Pick<StatColumns, 'ts' | 'bid' | 'ask'>,
  n: number,
  now: number,
  scratch: Float64Array = new Float64Array(2 * n),
): PriceStats | null {
  if (n === 0) return null;
  const cut = now - HISTORY_Q15_BUCKET_MS;
  const asks = scratch;
  const bids = scratch.subarray(n);
  let nb = 0;
  let na = 0;
  let used = 0;
  let first = -1;
  let last = -1;
  let nextBucket = bucketOf(c.ts[0]!);
  for (let k = 0; k < n; k++) {
    const a = c.ask[k]!;
    const b = c.bid[k]!;
    if (fin(a) && fin(b)) {
      if (first < 0) first = k;
      last = k;
    }
    const bucket = nextBucket;
    if (k + 1 < n) {
      nextBucket = bucketOf(c.ts[k + 1]!);
      if (nextBucket === bucket) continue; // not the bucket's last point
    }
    if (c.ts[k]! > cut) continue;
    used++;
    if (fin(a)) asks[na++] = a;
    if (fin(b)) bids[nb++] = b;
  }
  const [medianAsk, madAsk] = medMadInPlace(asks, na);
  const [medianBid, madBid] = medMadInPlace(bids, nb);
  const mid = (k: number) => (c.bid[k]! + c.ask[k]!) / 2;
  const change24h = first >= 0 && c.ts[last]! - c.ts[first]! >= CHANGE_MIN_SPAN_MS ? pctChange(mid(first), mid(last)) : null;
  return { n: used, medianAsk, medianBid, madAsk, madBid, change24h };
}

/** PriceStats from (ts-sorted) history points. See priceStatsFromColumns. */
export function priceStatsFromPoints(pts: readonly HistoryPoint[], now: number): PriceStats | null {
  return priceStatsFromColumns({ ts: pts.map((p) => p.ts), bid: pts.map((p) => p.bid), ask: pts.map((p) => p.ask) }, pts.length, now);
}

/** Stats for one item from its (ts-sorted) history points. See marketStatFromColumns. */
export function marketStatFromPoints(id: string, pts: readonly HistoryPoint[], now: number, taxRate: number): MarketStat {
  const cols: StatColumns = {
    ts: pts.map((p) => p.ts),
    bid: pts.map((p) => p.bid),
    ask: pts.map((p) => p.ask),
    buyWeek: pts.map((p) => p.instaBuysWeek),
    sellWeek: pts.map((p) => p.instaSellsWeek),
  };
  return marketStatFromColumns(id, cols, pts.length, now, taxRate);
}
