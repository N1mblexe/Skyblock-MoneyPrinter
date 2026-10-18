import { describe, expect, it } from 'vitest';
import { AH_SALES, CONSERVATIVE } from '../../src/config.ts';
import { coreOf, createMarketCore, mergeCons, salesOf, sideLeg } from '../../src/domain/market.ts';
import { buySide, competitors, effShare, sellSide } from '../../src/domain/pricing.ts';
import { assessRisk } from '../../src/domain/risk.ts';
import type { AhPrice, AhSalesStat, CalcCtx, Catalog, MarketStat, Product } from '../../src/types/contracts.ts';
import { baseSettings, catalog, makeProduct, stats } from './helpers.ts';

const X = makeProduct({ id: 'X' });
// a buy order at bid + tick would reach the ask: an insta-buy clamped at the ask
const TIGHT = makeProduct({
  id: 'TIGHT',
  bids: [{ price: 104.9, amount: 5000, orders: 10 }],
  asks: [{ price: 105, amount: 5000, orders: 10 }],
});
// the best bid holds 50,000 in 2 orders; the typical order on the side is 51,000 / 12 = 4,250
const WHALE = makeProduct({
  id: 'WHALE',
  bids: [
    { price: 100, amount: 50_000, orders: 2 },
    { price: 90, amount: 1000, orders: 10 },
  ],
});
const products: Record<string, Product> = { X, TIGHT, WHALE };
const cat: Catalog = {
  ...catalog,
  items: {
    ...catalog.items,
    X: { id: 'X', name: 'X', bazaar: true, npcSell: 10 },
    SHOP: { id: 'SHOP', name: 'Shop item', bazaar: false, npcBuy: 3 },
    FREE: { id: 'FREE', name: 'Free item', bazaar: false, npcBuy: 0 },
  },
};
const mctx = (over: Partial<CalcCtx['settings']> = {}, extra: Partial<CalcCtx> = {}): CalcCtx => ({
  snap: { lastUpdated: 0, fetchedAt: 0, source: 'fixture', products },
  catalog: cat,
  settings: { ...baseSettings, ...over },
  ...extra,
});
const market = (o: Partial<MarketStat> = {}): MarketStat => ({
  id: 'X',
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
const sales = (o: Partial<AhSalesStat> = {}): AhSalesStat => ({ n: 10, items: 10, median: 50, perHour: 2, coverageHours: 3, last: 0, ...o });

describe('coreOf', () => {
  it('uses ctx.core when set, else one core per context object', () => {
    const c = mctx();
    expect(coreOf(c)).toBe(coreOf(c));
    expect(coreOf(c).ctx).toBe(c);
    expect(coreOf(mctx())).not.toBe(coreOf(c));
    const core = createMarketCore(c);
    expect(coreOf({ ...c, core })).toBe(core);
  });
});

describe('MarketCore bazaar sides', () => {
  it('conservatism off: the snapshot sides, memoized per id and qty', () => {
    const core = createMarketCore(mctx());
    expect(core.buy('X')).toEqual(buySide(X, 'order', baseSettings.share, undefined, 10));
    expect(core.sell('X')).toEqual(sellSide(X, 'offer', baseSettings.share));
    expect(core.buy('X')).toBe(core.buy('X'));
    expect(core.sell('X', 5)).toBe(core.sell('X', 5));
    expect(core.buy('X', 5)).not.toBe(core.buy('X'));
    expect(core.buy('NOPE')).toBeNull();
    expect(core.sell('NOPE')).toBeNull();
    expect(core.buy('X')!.cons).toBeUndefined();
  });

  it('conservatism off ignores history', () => {
    const core = createMarketCore(mctx({}, { stats: () => stats({ medianBid: 103 }), market: () => market({ sellVolTrend: 0.1 }) }));
    expect(core.buy('X')).toEqual(buySide(X, 'order', baseSettings.share, undefined, 10));
  });

  it('conservatism on: price moved and churn added against you, rate scaled, cons recorded', () => {
    const m = market({ sellVolTrend: 0.5, bidMovesPerHour: 1 });
    const core = createMarketCore(mctx({ conservative: true }, { stats: () => stats({ medianBid: 101 }), market: () => m }));
    const raw = buySide(X, 'order', baseSettings.share, undefined, 10)!;
    const b = core.buy('X')!;
    const churn = CONSERVATIVE.relistStep * 101.1;
    expect(b.quote.price).toBeCloseTo(101.1 + churn, 9);
    expect(b.rate).toBeCloseTo(raw.rate * 0.5, 9);
    expect(b.cons).toEqual({ buyRef: 100.1, rateMul: 0.5, churn: expect.closeTo(churn, 9) });
    // the sell side: history agrees with the snapshot and the ask flow has no trend -> unchanged
    expect(core.sell('X')).toEqual(sellSide(X, 'offer', baseSettings.share));
  });

  it('conservatism on, sell side: the sale lowered and the churn taken off', () => {
    const m = market({ askMovesPerHour: 2 });
    const core = createMarketCore(mctx({ conservative: true }, { stats: () => stats({ medianAsk: 104 }), market: () => m }));
    const s = core.sell('X')!;
    const churn = 2 * CONSERVATIVE.relistStep * 103.9;
    expect(s.quote.price).toBeCloseTo(103.9 - churn, 9);
    expect(s.cons).toEqual({ sellRef: 104.9, churn: expect.closeTo(churn, 9) });
  });

  it('a buy order clamped at the ask is adjusted as an insta-buy (no churn)', () => {
    const core = createMarketCore(
      mctx({ conservative: true }, { stats: () => stats({ medianAsk: 106 }), market: () => market({ bidMovesPerHour: 5 }) }),
    );
    const b = core.buy('TIGHT')!;
    expect(b.quote.source).toBe('insta');
    expect(b.quote.clamped).toBe('ask');
    expect(b.quote.price).toBe(106);
    expect(b.cons).toEqual({ buyRef: 105 });
  });

  it('competitors weighted by amount lower your share of the flow', () => {
    const on = mctx({ conservative: true, share: 0.5 }, { stats: () => stats() });
    const raw = buySide(WHALE, 'order', 0.5)!;
    const weighted = competitors(WHALE.bids, undefined, true);
    const b = createMarketCore(on).buy('WHALE')!;
    expect(raw.comp).toBe(2);
    expect(b.comp).toBeCloseTo(weighted, 9);
    expect(b.rate).toBeCloseTo((raw.rate * effShare(0.5, weighted)) / effShare(0.5, 2), 9);
    expect(b.cons).toBeUndefined(); // the competition shows in comp, not in cons
    // a zero share has no rate to scale
    const zero = createMarketCore(mctx({ conservative: true, share: 0 }, { stats: () => stats() })).buy('WHALE')!;
    expect(zero.rate).toBe(0);
    expect(zero.comp).toBe(2);
  });

  it('too little history: no-op even with the setting on', () => {
    const core = createMarketCore(
      mctx({ conservative: true }, { stats: () => stats({ n: CONSERVATIVE.minPoints - 1, medianBid: 103 }), market: () => market({ sellVolTrend: 0.1 }) }),
    );
    expect(core.buy('X')).toEqual(buySide(X, 'order', baseSettings.share, undefined, 10));
    expect(createMarketCore(mctx({ conservative: true })).sell('X')).toEqual(sellSide(X, 'offer', baseSettings.share));
  });
});

describe('MarketCore risk', () => {
  it('one memo per id and use; null off the bazaar; stats feed in', () => {
    const core = createMarketCore(mctx({}, { stats: () => stats() }));
    expect(core.risk('X')).toBe(core.risk('X'));
    expect(core.risk('X')).toEqual(assessRisk(X, stats()));
    expect(core.risk('X', { buy: 'order' })).toEqual(assessRisk(X, stats(), { buy: 'order' }));
    expect(core.risk('X', { sell: 'insta' })).toBe(core.risk('X', { sell: 'insta' }));
    expect(core.risk('NOPE')).toBeNull();
    expect(createMarketCore(mctx()).risk('X')!.flags).toContain('NO_HISTORY');
  });
});

describe('MarketCore NPC and AH purchases', () => {
  it('npcBuy: the shop price, npcDailyLimit / 24 per hour; null without a coin price', () => {
    const core = createMarketCore(mctx({ npcDailyLimit: 240 }));
    expect(core.npcBuy('SHOP')).toEqual({ price: 3, rate: 10 });
    expect(core.npcBuy('FREE')).toBeNull();
    expect(core.npcBuy('X')).toBeNull();
    expect(core.npcBuy('NOPE')).toBeNull();
  });

  it('ahBuy: VWAP over the kept per-item prices, else the lowest BIN', () => {
    const ah: Record<string, AhPrice> = {
      V4: { price: 10, count: 3, prices: [10, 12, 20] },
      V3: { price: 40, count: 1 },
      ZERO: { price: 0, count: 1 },
    };
    const core = createMarketCore(mctx({}, { ah: (id) => ah[id] ?? null }));
    expect(core.ahBuy('V4')).toEqual({ price: 10, rate: AH_SALES.defaultPerHour, count: 3 });
    expect(core.ahBuy('V4', 2)!.price).toBeCloseTo(11, 9);
    expect(core.ahBuy('V4', 3)!.price).toBeCloseTo(14, 9);
    expect(core.ahBuy('V4', 2)).toBe(core.ahBuy('V4', 2));
    expect(core.ahBuy('V3', 5)!.price).toBe(40);
    expect(core.ahBuy('ZERO')).toBeNull();
    expect(core.ahBuy('NOPE')).toBeNull();
    expect(createMarketCore(mctx()).ahBuy('V4')).toBeNull();
  });

  it('ahBuy rate: measured sales per hour once coverage reaches AH_SALES.minCoverageHours', () => {
    const ah = (): AhPrice => ({ price: 10, count: 3 });
    const at = (s: AhSalesStat | null) => createMarketCore(mctx({}, { ah, ahSales: () => s })).ahBuy('A')!.rate;
    expect(at(sales({ perHour: 2 }))).toBe(2);
    expect(at(sales({ perHour: 2, coverageHours: AH_SALES.minCoverageHours - 0.5 }))).toBe(AH_SALES.defaultPerHour);
    expect(at(sales({ perHour: null }))).toBe(AH_SALES.defaultPerHour);
    expect(at(null)).toBe(AH_SALES.defaultPerHour);
  });
});

describe('salesOf', () => {
  it('null without a feed or below the coverage threshold', () => {
    expect(salesOf(mctx(), 'A')).toBeNull();
    expect(salesOf(mctx({}, { ahSales: () => null }), 'A')).toBeNull();
    expect(salesOf(mctx({}, { ahSales: () => sales({ coverageHours: 1 }) }), 'A')).toBeNull();
    const s = sales({ coverageHours: AH_SALES.minCoverageHours });
    expect(salesOf(mctx({}, { ahSales: () => s }), 'A')).toBe(s);
  });
});

describe('sideLeg', () => {
  it('sell offer: net after tax, an order on the asks', () => {
    const s = sellSide(X, 'offer', 0.05)!;
    const leg = sideLeg('X', 'sell', s, 0.0125);
    expect(leg).toEqual({ price: 104.9, net: 104.9 * 0.9875, rate: s.rate, comp: s.comp, order: true, res: 'X:ask' });
  });

  it('insta-buy: depth, no order, the ask flow; clamp and cons passed through', () => {
    const s = buySide(TIGHT, 'order', 0.05)!;
    const leg = sideLeg('TIGHT', 'buy', { ...s, cons: { buyRef: 1 } }, 0.0125);
    expect(leg.net).toBe(leg.price);
    expect(leg.order).toBe(false);
    expect(leg.depth).toBe(5000);
    expect(leg.res).toBe('TIGHT:ask');
    expect(leg.clamped).toBe('ask');
    expect(leg.cons).toEqual({ buyRef: 1 });
    // a buy order draws on the bid flow
    expect(sideLeg('X', 'buy', buySide(X, 'order', 0.05)!, 0).res).toBe('X:bid');
  });
});

describe('mergeCons', () => {
  it('first price refs, lowest rate multiplier, churn summed; undefined when nothing changed', () => {
    expect(mergeCons()).toBeUndefined();
    expect(mergeCons(undefined, {})).toBeUndefined();
    expect(mergeCons({ buyRef: 1, rateMul: 0.8, churn: 0.2 }, { buyRef: 9, sellRef: 2, rateMul: 0.6, churn: 0.3 })).toEqual({
      buyRef: 1,
      sellRef: 2,
      rateMul: 0.6,
      churn: 0.5,
    });
  });
});
