import { describe, expect, it } from 'vitest';
import { CONSERVATIVE, PRICE_TICK } from '../../src/config.ts';
import { sideAdjust } from '../../src/domain/conservative.ts';
import { competitors } from '../../src/domain/pricing.ts';
import type { MarketStat, Settings } from '../../src/types/contracts.ts';
import { makeProduct, stats } from './helpers.ts';

type S = Pick<Settings, 'conservative' | 'cycleHours' | 'costMode' | 'sellMode'>;
const on: S = { conservative: true, cycleHours: 1, costMode: 'order', sellMode: 'offer' };
const insta: S = { ...on, costMode: 'insta', sellMode: 'insta' };
const market = (o: Partial<MarketStat> = {}): MarketStat => ({
  id: 'SYNTH',
  n: 20,
  change1h: null,
  change24h: null,
  volatility: null,
  spreadMedian: null,
  consistency: null,
  buyVolTrend: null,
  sellVolTrend: null,
  ...o,
});
// bid 100 / ask 105, two levels of 5,000 x 10 orders on each side
const p = makeProduct();

describe('sideAdjust: a no-op without the setting or enough history', () => {
  it('off, no stats, or fewer than CONSERVATIVE.minPoints points -> null', () => {
    const st = stats({ medianAsk: 90, medianBid: 120 });
    const m = market({ buyVolTrend: 0.5, sellVolTrend: 0.5, bidMovesPerHour: 3, askMovesPerHour: 3 });
    expect(sideAdjust('sell', p, 104.9, st, m, { ...on, conservative: false })).toBeNull();
    expect(sideAdjust('sell', p, 104.9, null, m, on)).toBeNull();
    expect(sideAdjust('buy', p, 100.1, stats({ n: CONSERVATIVE.minPoints - 1 }), m, on)).toBeNull();
    expect(sideAdjust('buy', p, 100.1, stats({ n: CONSERVATIVE.minPoints - 1 }), m, insta)).toBeNull();
  });

  it('history that agrees with the snapshot and no market stats -> null', () => {
    expect(sideAdjust('sell', p, 104.9, stats(), null, on)).toBeNull();
    expect(sideAdjust('buy', p, 100.1, stats(), null, on)).toBeNull();
    expect(sideAdjust('sell', p, 100, stats(), null, insta)).toBeNull();
    expect(sideAdjust('buy', p, 105, stats(), null, insta)).toBeNull();
  });
});

describe('sideAdjust: prices', () => {
  it('sell offer: min(quote, medianAsk - tick)', () => {
    expect(sideAdjust('sell', p, 104.9, stats({ medianAsk: 104 }), null, on)).toEqual({ price: 103.9, rateMul: 1, churn: 0 });
    // a higher median never raises the sale
    expect(sideAdjust('sell', p, 104.9, stats({ medianAsk: 120 }), null, on)).toBeNull();
  });

  it('insta-sell: min(quote, medianBid)', () => {
    expect(sideAdjust('sell', p, 100, stats({ medianBid: 98 }), null, insta)!.price).toBe(98);
  });

  it('buy order: max(quote, medianBid + tick), never above the ask', () => {
    expect(sideAdjust('buy', p, 100.1, stats({ medianBid: 101 }), null, on)!.price).toBe(101.1);
    expect(sideAdjust('buy', p, 100.1, stats({ medianBid: 110 }), null, on)!.price).toBe(105);
    // no ask: nothing to cap at
    const noAsk = makeProduct({ asks: [], ask: null });
    expect(sideAdjust('buy', noAsk, 100.1, stats({ medianBid: 110 }), null, on)!.price).toBe(110.1);
    // a lower median never lowers the cost
    expect(sideAdjust('buy', p, 100.1, stats({ medianBid: 90 }), null, on)).toBeNull();
  });

  it('insta-buy: max(quote, medianAsk)', () => {
    expect(sideAdjust('buy', p, 105, stats({ medianAsk: 107 }), null, insta)!.price).toBe(107);
  });

  it('an unusable median (0 or NaN) leaves the price', () => {
    expect(sideAdjust('sell', p, 104.9, stats({ medianAsk: 0 }), null, on)).toBeNull();
    expect(sideAdjust('buy', p, 105, stats({ medianAsk: NaN }), null, insta)).toBeNull();
  });
});

describe('sideAdjust: rates', () => {
  const m = market({ buyVolTrend: 0.8, sellVolTrend: 0.3 });
  it('x the trend of the flow that fills the side, clamped to CONSERVATIVE.trendClamp', () => {
    const [lo] = CONSERVATIVE.trendClamp;
    // buy orders and insta-sells fill from insta-sells; sell offers and insta-buys from insta-buys
    expect(sideAdjust('buy', p, 100.1, stats(), m, on)!.rateMul).toBe(lo);
    expect(sideAdjust('sell', p, 100, stats(), m, insta)!.rateMul).toBe(lo);
    expect(sideAdjust('sell', p, 104.9, stats(), m, on)!.rateMul).toBe(0.8);
    expect(sideAdjust('buy', p, 105, stats(), m, insta)!.rateMul).toBe(0.8);
  });

  it('a rising or unknown trend never speeds a side up', () => {
    expect(sideAdjust('sell', p, 104.9, stats(), market({ buyVolTrend: 1.7 }), on)).toBeNull();
    expect(sideAdjust('sell', p, 104.9, stats(), market({ buyVolTrend: NaN }), on)).toBeNull();
  });
});

describe('sideAdjust: churn', () => {
  it('orders: relists x max(tick, relistStep x price), relists = moves/h x leg hours, at most maxRelists', () => {
    const m = market({ bidMovesPerHour: 2, askMovesPerHour: 0.5 });
    const step = CONSERVATIVE.relistStep * 100.1;
    expect(sideAdjust('buy', p, 100.1, stats(), m, on)!.churn).toBeCloseTo(2 * step, 12);
    expect(sideAdjust('buy', p, 100.1, stats(), m, { ...on, cycleHours: 2 })!.churn).toBeCloseTo(4 * step, 12);
    // legHours overrides the cycle; maxRelists caps it
    expect(sideAdjust('buy', p, 100.1, stats(), m, on, 100)!.churn).toBeCloseTo(CONSERVATIVE.maxRelists * step, 12);
    // offers use the ask moves
    expect(sideAdjust('sell', p, 104.9, stats(), m, on)!.churn).toBeCloseTo(0.5 * CONSERVATIVE.relistStep * 104.9, 12);
  });

  it('a cheap item loses at least a tick per relist; insta legs and missing moves have no churn', () => {
    const cheap = makeProduct({ bids: [{ price: 1, amount: 10, orders: 1 }], asks: [{ price: 1.5, amount: 10, orders: 1 }] });
    const m = market({ bidMovesPerHour: 3, askMovesPerHour: 3 });
    expect(sideAdjust('buy', cheap, 1.1, stats({ medianBid: 1, medianAsk: 1.5 }), m, on)!.churn).toBeCloseTo(3 * PRICE_TICK, 12);
    expect(sideAdjust('buy', p, 105, stats(), m, insta)).toBeNull();
    expect(sideAdjust('buy', p, 100.1, stats(), market({ bidMovesPerHour: null }), on)).toBeNull();
    expect(sideAdjust('buy', p, 100.1, stats(), m, { ...on, cycleHours: 0 })).toBeNull();
  });
});

describe('sideAdjust: competitors weighted by amount', () => {
  // the best bid holds 50,000 in 2 orders; the typical order on the side is 51,000 / 12 = 4,250
  const whale = makeProduct({
    bids: [
      { price: 100, amount: 50_000, orders: 2 },
      { price: 90, amount: 1000, orders: 10 },
    ],
  });

  it('orders: set when the weighted count is above the order count', () => {
    expect(competitors(whale.bids)).toBe(2);
    expect(competitors(whale.bids, undefined, true)).toBeCloseTo(50_000 / (51_000 / 12), 9);
    const a = sideAdjust('buy', whale, 100.1, stats(), null, on)!;
    expect(a).toEqual({ price: 100.1, rateMul: 1, churn: 0, comp: competitors(whale.bids, undefined, true) });
  });

  it('even-sized orders, insta legs and the sell side of a normal book: no comp', () => {
    expect(sideAdjust('buy', p, 100.1, stats(), null, on)).toBeNull();
    expect(sideAdjust('buy', whale, 105, stats(), null, insta)).toBeNull();
    expect(sideAdjust('sell', whale, 104.9, stats(), null, on)).toBeNull();
  });
});
