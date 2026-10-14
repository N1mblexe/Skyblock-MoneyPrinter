import { describe, expect, it } from 'vitest';
import { STATS } from '../../src/config.ts';
import { marketStatFromColumns, marketStatFromPoints, medianInPlace, medMadInPlace } from '../../src/domain/marketStats.ts';
import { mad, median } from '../../src/domain/stats.ts';
import type { HistoryPoint } from '../../src/types/contracts.ts';

const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 9, 1); // bucket aligned
const TAX = 0.0125;

const pt = (ts: number, bid: number, ask: number, bw = 1000, sw = 1000): HistoryPoint => ({
  ts,
  bid,
  ask,
  instaBuysWeek: bw,
  instaSellsWeek: sw,
  buyOrders: 1,
  sellOrders: 1,
});

/** 97 points, one per 15 min over 24h (k = 0..96), from f(k). now = last point. */
function series(f: (k: number) => Partial<HistoryPoint>): { pts: HistoryPoint[]; now: number } {
  const pts = Array.from({ length: 97 }, (_, k) => ({ ...pt(T0 + k * 15 * MIN, 0, 0), ...f(k) }));
  return { pts, now: T0 + 24 * H };
}

describe('medianInPlace / medMadInPlace', () => {
  it('match stats.median / stats.mad on random data (odd and even n)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 100;
    for (const n of [1, 2, 3, 4, 10, 11, 97, 280]) {
      const xs = Array.from({ length: n }, () => Math.round(rnd() * 10) / 10); // with ties
      const a = Float64Array.from(xs);
      expect(medianInPlace(a, n)).toBeCloseTo(median(xs), 12);
      const [m, d] = medMadInPlace(Float64Array.from(xs), n);
      expect(m).toBeCloseTo(median(xs), 12);
      expect(d).toBeCloseTo(mad(xs), 12);
    }
    expect(medianInPlace(new Float64Array(0), 0)).toBeNaN();
    expect(medMadInPlace(new Float64Array(0), 0)).toEqual([NaN, NaN]);
  });
});

describe('marketStatFromPoints', () => {
  it('exact stats on a linear 24h series', () => {
    // bid 100+k, ask bid+10 -> mid 105+k; buy counter 15600 -> 18000, sell counter 20000 -> 0
    const { pts, now } = series((k) => ({
      bid: 100 + k,
      ask: 110 + k,
      instaBuysWeek: 15600 + 25 * k,
      instaSellsWeek: 20000 - (20000 / 96) * k,
    }));
    const s = marketStatFromPoints('A', pts, now, TAX);
    expect(s.id).toBe('A');
    expect(s.n).toBe(97);
    expect(s.change1h).toBeCloseTo((201 - 197) / 197, 12);
    expect(s.change24h).toBeCloseTo((201 - 105) / 105, 12);
    // mids 105..201: median 153, |k - 48| -> MAD 24
    expect(s.volatility).toBeCloseTo(24 / 153, 12);
    expect(s.spreadMedian).toBeCloseTo(10 / 148, 12);
    expect(s.consistency).toBe(1);
    // W̄ = 16800 = 168*100, Δt = 24h, ΔW = 2400: 1 + 168*2400 / (24*16800) = 2
    expect(s.buyVolTrend).toBeCloseTo(2, 9);
    // W̄ = 10000, ΔW = -20000 -> 1 - 14 -> clamped
    expect(s.sellVolTrend).toBe(0);
  });

  it('consistency counts profitable bid+tick -> ask-tick points after tax', () => {
    // even k: ask 110 (profitable); odd k: ask 100.5 ((100.4)(0.9875) < 100.1)
    const { pts, now } = series((k) => ({ bid: 100, ask: k % 2 ? 100.5 : 110 }));
    const s = marketStatFromPoints('A', pts, now, TAX);
    expect(s.consistency).toBeCloseTo(49 / 97, 12);
    expect(s.change1h).toBe(0); // k=96 and k=92 both even
    // tax matters: with no tax, 100.4 - 100.1 > 0
    expect(marketStatFromPoints('A', pts, now, 0).consistency).toBe(1);
    // constant counters -> trend exactly 1
    expect(s.buyVolTrend).toBe(1);
    expect(s.sellVolTrend).toBe(1);
  });

  it('needs STATS.consistencyMinPoints for volatility and consistency', () => {
    const few = Array.from({ length: STATS.consistencyMinPoints - 1 }, (_, k) => pt(T0 + k * 15 * MIN, 100, 110));
    const now = few.at(-1)!.ts;
    const s = marketStatFromPoints('A', few, now, TAX);
    expect(s.n).toBe(STATS.consistencyMinPoints - 1);
    expect(s.consistency).toBeNull();
    expect(s.volatility).toBeNull();
    expect(s.spreadMedian).toBeCloseTo(0.1, 12);
    const enough = [...few, pt(now + 15 * MIN, 100, 110)];
    const s2 = marketStatFromPoints('A', enough, now + 15 * MIN, TAX);
    expect(s2.consistency).toBe(1);
    expect(s2.volatility).toBe(0);
  });

  it('thins to the last point per 15-min bucket for the distribution stats', () => {
    // 12 buckets with one point each, plus 50 extra points inside the last bucket at a very different price
    const pts: HistoryPoint[] = [];
    for (let k = 0; k < 12; k++) pts.push(pt(T0 + k * 15 * MIN, 100, 110));
    const last = T0 + 11 * 15 * MIN;
    pts.pop();
    for (let i = 0; i < 50; i++) pts.push(pt(last + i * 10_000, 500, 1000));
    pts.push(pt(last + 14 * MIN, 100, 110)); // bucket's last point
    const s = marketStatFromPoints('A', pts, last + 14 * MIN, TAX);
    expect(s.n).toBe(12);
    expect(s.spreadMedian).toBeCloseTo(0.1, 12);
    expect(s.volatility).toBe(0);
  });

  it('skips one-sided points in n, mids and changes; spread needs bid > 0', () => {
    const { pts, now } = series((k) => (k % 2 ? { bid: NaN, ask: 50 } : { bid: 100, ask: 120 }));
    pts[96] = pt(now, NaN, 120); // newest is one-sided -> latest two-sided is k=94, 30 min old
    const s = marketStatFromPoints('A', pts, now, TAX);
    expect(s.n).toBe(48);
    expect(s.spreadMedian).toBeCloseTo(0.2, 12);
    expect(s.change1h).toBeNull(); // 30 min > the 15 min freshness tolerance of 1h
    expect(s.change24h).toBe(0); // within the 2h tolerance of 24h
    expect(s.volatility).toBe(0);
    const zero = series(() => ({ bid: 0, ask: 10 }));
    const z = marketStatFromPoints('Z', zero.pts, zero.now, TAX);
    expect(z.spreadMedian).toBeNull();
    expect(z.volatility).toBe(0); // mid 5, MAD 0
    expect(z.change24h).toBe(0);
    const empty = marketStatFromPoints('E', [], T0, TAX);
    expect(empty).toEqual({
      id: 'E',
      n: 0,
      change1h: null,
      change24h: null,
      volatility: null,
      spreadMedian: null,
      consistency: null,
      buyVolTrend: null,
      sellVolTrend: null,
    });
  });

  it('volatility is null when the median mid is not positive', () => {
    const { pts, now } = series(() => ({ bid: -10, ask: 5 }));
    expect(marketStatFromPoints('A', pts, now, TAX).volatility).toBeNull();
  });

  describe('changes need coverage', () => {
    it('history shorter than the span -> null', () => {
      const pts = [pt(T0 - 30 * MIN, 100, 110), pt(T0, 120, 130)];
      const s = marketStatFromPoints('A', pts, T0, TAX);
      expect(s.change1h).toBeNull(); // first point 30 min after now-1h (> 15 min tolerance)
      expect(s.change24h).toBeNull();
    });

    it('a first point within the tolerance after now - span counts', () => {
      const pts = [pt(T0 - 50 * MIN, 100, 110), pt(T0, 120, 130)];
      expect(marketStatFromPoints('A', pts, T0, TAX).change1h).toBeCloseTo(20 / 105, 12);
      const d = [pt(T0 - 22.5 * H, 100, 110), pt(T0, 120, 130)];
      expect(marketStatFromPoints('A', d, T0, TAX).change24h).toBeCloseTo(20 / 105, 12);
      const d2 = [pt(T0 - 21.5 * H, 100, 110), pt(T0, 120, 130)];
      expect(marketStatFromPoints('A', d2, T0, TAX).change24h).toBeNull();
    });

    it('uses the nearest point at or before now - span', () => {
      const pts = [pt(T0 - 2 * H, 50, 50), pt(T0 - 61 * MIN, 100, 100), pt(T0 - 59 * MIN, 400, 400), pt(T0, 110, 110)];
      expect(marketStatFromPoints('A', pts, T0, TAX).change1h).toBeCloseTo(0.1, 12);
    });

    it('a stale newest point -> null; points after now are ignored', () => {
      const pts = [pt(T0 - 3 * H, 100, 100), pt(T0 - 20 * MIN, 110, 110)];
      expect(marketStatFromPoints('A', pts, T0, TAX).change1h).toBeNull();
      const future = [pt(T0 - 2 * H, 100, 100), pt(T0, 110, 110), pt(T0 + H, 999, 999)];
      expect(marketStatFromPoints('A', future, T0, TAX).change1h).toBeCloseTo(0.1, 12);
    });
  });

  describe('volume trend', () => {
    it('ratio = 1 + 168·ΔW / (Δt_h·W̄)', () => {
      // 2h window, W 1000 -> 1100 (W̄ 1050): 1 + 168*100/(2*1050) = 9
      const pts = [pt(T0, 1, 2, 1000, 1000), pt(T0 + H, 1, 2, 1040, 1000), pt(T0 + 2 * H, 1, 2, 1100, 990)];
      const s = marketStatFromPoints('A', pts, T0 + 2 * H, TAX);
      expect(s.buyVolTrend).toBeCloseTo(9, 9);
      expect(s.sellVolTrend).toBeCloseTo(1 + (168 * -10) / (2 * 995), 9);
    });

    it('null when Δt < 30 min, no valid counters, or W̄ = 0; skips invalid readings', () => {
      const short = [pt(T0, 1, 2, 1000, 1000), pt(T0 + 29 * MIN, 1, 2, 2000, 2000)];
      expect(marketStatFromPoints('A', short, T0 + 29 * MIN, TAX).buyVolTrend).toBeNull();
      const none = [pt(T0, 1, 2, NaN, -1), pt(T0 + H, 1, 2, NaN, -1)];
      const s = marketStatFromPoints('A', none, T0 + H, TAX);
      expect(s.buyVolTrend).toBeNull();
      expect(s.sellVolTrend).toBeNull();
      const zero = [pt(T0, 1, 2, 0, 0), pt(T0 + H, 1, 2, 0, 0)];
      expect(marketStatFromPoints('A', zero, T0 + H, TAX).buyVolTrend).toBeNull();
      const gaps = [pt(T0, 1, 2, NaN, 1), pt(T0 + H, 1, 2, 1000, 1), pt(T0 + 2 * H, 1, 2, 1000, 1), pt(T0 + 3 * H, 1, 2, NaN, 1)];
      expect(marketStatFromPoints('A', gaps, T0 + 3 * H, TAX).buyVolTrend).toBe(1);
    });
  });

  it('columns API with typed arrays and a shared scratch equals the points API', () => {
    const { pts, now } = series((k) => ({ bid: 100 + (k % 7), ask: 112 - (k % 5), instaBuysWeek: 5000 + k, instaSellsWeek: 9000 - k }));
    const cols = {
      ts: Float64Array.from(pts, (p) => p.ts),
      bid: Float32Array.from(pts, (p) => p.bid),
      ask: Float32Array.from(pts, (p) => p.ask),
      buyWeek: Float32Array.from(pts, (p) => p.instaBuysWeek),
      sellWeek: Float32Array.from(pts, (p) => p.instaSellsWeek),
    };
    const a = marketStatFromColumns('A', cols, pts.length, now, TAX, new Float64Array(200));
    const b = marketStatFromPoints('A', pts, now, TAX);
    expect(a).toEqual(b);
  });
});
