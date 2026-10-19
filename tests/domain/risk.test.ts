import { describe, expect, it } from 'vitest';
import { assessRisk, bookOf, combineRisk, INGREDIENT_FLAGS, reportFromFlags } from '../../src/domain/risk.ts';
import type { RiskFlag } from '../../src/types/contracts.ts';
import { makeProduct, P, stats } from './helpers.ts';

const flagsOf = (...a: Parameters<typeof assessRisk>) => assessRisk(...a).flags;

describe('assessRisk on fixture products', () => {
  it('JALAPENO_BOOK is suspect (low volume, imbalance, quick divergence)', () => {
    const r = assessRisk(P('JALAPENO_BOOK'));
    expect(r.level).toBe('suspect');
    expect(r.flags).toEqual(expect.arrayContaining(['LOW_VOLUME', 'VOLUME_IMBALANCE', 'NO_HISTORY']));
  });

  it('END_STONE_SHULKER (dead bid) is suspect', () => {
    const r = assessRisk(P('END_STONE_SHULKER'));
    expect(r.level).toBe('suspect');
    expect(r.flags).toContain('DEAD_BID');
  });

  it('GOLD_INGOT 0.1 bid vs 6 ask is a dead bid', () => {
    expect(flagsOf(P('GOLD_INGOT'))).toContain('DEAD_BID');
  });

  it('empty book is suspect', () => {
    expect(assessRisk(P('ENCHANTMENT_LIFE_STEAL_2')).level).toBe('suspect');
  });

  it('ENCHANTED_MELON is not suspect', () => {
    const r = assessRisk(P('ENCHANTED_MELON'), stats({ medianAsk: 325, medianBid: 302, madAsk: 2, madBid: 2 }));
    expect(r.level).not.toBe('suspect');
    expect(r.flags).not.toContain('NO_HISTORY');
  });
});

describe('assessRisk flags (synthetic)', () => {
  const healthy = makeProduct();

  it('healthy product with history is ok', () => {
    expect(assessRisk(healthy, stats())).toEqual({ level: 'ok', score: 0, flags: [] });
  });

  it('NO_HISTORY (info only)', () => {
    const r = assessRisk(healthy);
    expect(r).toEqual({ level: 'ok', score: 0, flags: ['NO_HISTORY'] });
    expect(assessRisk(healthy, stats({ n: 11 })).flags).toEqual(['NO_HISTORY']);
    expect(assessRisk(healthy, null).flags).toEqual(['NO_HISTORY']);
  });

  it.each<[string, Parameters<typeof makeProduct>[0]]>([
    ['bid null', { bids: [], bid: null }],
    ['bid < 2% of ask', { bids: [{ price: 1.5, amount: 10, orders: 10 }], quick: { sellPrice: 1.5 } }],
    ['bid <= 1 and ask > 100', { bids: [{ price: 1, amount: 10, orders: 10 }], quick: { sellPrice: 1 } }],
  ])('DEAD_BID: %s', (_n, over) => {
    const r = assessRisk(makeProduct(over), stats());
    expect(r.flags).toContain('DEAD_BID');
    expect(r.level).toBe('suspect');
  });

  it('WIDE_SPREAD alone -> caution; with LOW_VOLUME -> suspect', () => {
    const wide = makeProduct({ asks: [{ price: 170, amount: 5000, orders: 10 }], quick: { buyPrice: 170 } });
    const r = assessRisk(wide, stats({ medianAsk: 170 }));
    expect(r).toEqual({ level: 'caution', score: 2, flags: ['WIDE_SPREAD'] });
    const wideLow = makeProduct({
      asks: [{ price: 170, amount: 5000, orders: 10 }],
      quick: { buyPrice: 170 },
      instaBuysWeek: 900,
      instaSellsWeek: 900,
    });
    const r2 = assessRisk(wideLow, stats({ medianAsk: 170 }));
    expect(r2.flags).toEqual(['WIDE_SPREAD', 'LOW_VOLUME']);
    expect(r2.level).toBe('suspect');
  });

  it('LOW_VOLUME by units or by coins', () => {
    expect(flagsOf(makeProduct({ instaBuysWeek: 999, instaSellsWeek: 999 }), stats())).toEqual(['LOW_VOLUME']);
    // 5000 units * 105 coins = 525k < 1M
    expect(flagsOf(makeProduct({ instaBuysWeek: 5000, instaSellsWeek: 5000 }), stats())).toEqual(['LOW_VOLUME']);
  });

  it('FEW_ORDERS', () => {
    expect(flagsOf(makeProduct({ quick: { buyOrders: 4 } }), stats())).toEqual(['FEW_ORDERS']);
    expect(flagsOf(makeProduct({ quick: { sellOrders: 2 } }), stats())).toEqual(['FEW_ORDERS']);
  });

  it('THIN_TOP on asks and on bids', () => {
    const thinAsk = makeProduct({
      asks: [
        { price: 105, amount: 10, orders: 1 },
        { price: 140, amount: 5000, orders: 10 },
      ],
    });
    expect(flagsOf(thinAsk, stats())).toEqual(['THIN_TOP']);
    const thinBid = makeProduct({
      bids: [
        { price: 100, amount: 10, orders: 1 },
        { price: 70, amount: 5000, orders: 10 },
      ],
    });
    expect(flagsOf(thinBid, stats())).toEqual(['THIN_TOP']);
    // big top level is not thin
    const deep = makeProduct({
      asks: [
        { price: 105, amount: 100_000, orders: 1 },
        { price: 140, amount: 5000, orders: 10 },
      ],
    });
    expect(flagsOf(deep, stats())).toEqual([]);
  });

  it('QUICK_DIVERGENCE', () => {
    expect(flagsOf(makeProduct({ quick: { buyPrice: 300 } }), stats())).toEqual(['QUICK_DIVERGENCE']);
    expect(flagsOf(makeProduct({ quick: { sellPrice: 40 } }), stats())).toEqual(['QUICK_DIVERGENCE']);
    expect(assessRisk(makeProduct({ quick: { buyPrice: 300 } }), stats()).level).toBe('caution');
  });

  it('VOLUME_IMBALANCE', () => {
    expect(flagsOf(makeProduct({ instaBuysWeek: 1_000_000, instaSellsWeek: 90_000 }), stats())).toEqual(['VOLUME_IMBALANCE']);
    expect(flagsOf(makeProduct({ instaBuysWeek: 20_000, instaSellsWeek: 300_000 }), stats())).toEqual(['VOLUME_IMBALANCE']);
    expect(flagsOf(makeProduct({ instaBuysWeek: 100_000, instaSellsWeek: 0 }), stats())).toContain('VOLUME_IMBALANCE');
    expect(flagsOf(makeProduct({ instaBuysWeek: 0, instaSellsWeek: 0 }), stats())).not.toContain('VOLUME_IMBALANCE');
  });

  it('PRICE_SPIKE via robust z, ask jump, bid crash', () => {
    const z = assessRisk(healthy, stats({ medianAsk: 100, madAsk: 0.5 })); // z = .6745*5/.5 = 6.7
    expect(z.flags).toEqual(['PRICE_SPIKE']);
    expect(z.level).toBe('suspect');
    expect(flagsOf(healthy, stats({ medianAsk: 60, madAsk: 0 }))).toEqual(['PRICE_SPIKE']); // 105/60 = 1.75
    expect(flagsOf(healthy, stats({ medianBid: 200 }))).toEqual(['PRICE_SPIKE']); // 100/200 = 0.5
    expect(flagsOf(healthy, stats({ medianAsk: 104, madAsk: 1 }))).toEqual([]); // z = 0.67
    // needs >= 12 points
    expect(flagsOf(healthy, stats({ n: 5, medianBid: 200 }))).toEqual(['NO_HISTORY']);
  });

  it('score threshold alone can make suspect', () => {
    const p = makeProduct({ quick: { buyPrice: 300, buyOrders: 1 }, instaBuysWeek: 1_000_000, instaSellsWeek: 50_000 });
    const r = assessRisk(p, stats());
    expect(r.flags).toEqual(['FEW_ORDERS', 'QUICK_DIVERGENCE', 'VOLUME_IMBALANCE']);
    expect(r.score).toBe(3);
    expect(r.level).toBe('suspect');
  });
});

describe('assessRisk: side-aware (use)', () => {
  it('bookOf: buy orders and insta-sells use the bids, insta-buys and sell offers the asks', () => {
    expect(bookOf('buy', 'order')).toBe('bid');
    expect(bookOf('sell', 'insta')).toBe('bid');
    expect(bookOf('buy', 'insta')).toBe('ask');
    expect(bookOf('sell', 'offer')).toBe('ask');
  });

  it('spread and dead-bid flags only when selling on the bazaar', () => {
    const dead = makeProduct({ bids: [{ price: 1, amount: 10, orders: 10 }], quick: { sellPrice: 1 } });
    expect(flagsOf(dead, stats(), { buy: 'order' })).not.toContain('DEAD_BID');
    expect(flagsOf(dead, stats(), { sell: 'offer' })).toContain('DEAD_BID');
    const wide = makeProduct({ asks: [{ price: 170, amount: 5000, orders: 10 }], quick: { buyPrice: 170 } });
    expect(flagsOf(wide, stats({ medianAsk: 170 }), { buy: 'insta' })).toEqual([]);
    expect(flagsOf(wide, stats({ medianAsk: 170 }), { sell: 'insta' })).toEqual(['WIDE_SPREAD']);
    const extreme = makeProduct({ asks: [{ price: 400, amount: 5000, orders: 10 }], quick: { buyPrice: 400 } });
    expect(flagsOf(extreme, stats({ medianAsk: 400 }), { buy: 'order' })).toEqual([]);
    expect(flagsOf(extreme, stats({ medianAsk: 400 }), { sell: 'offer' })).toEqual(['WIDE_SPREAD', 'EXTREME_SPREAD']);
  });

  it('LOW_VOLUME on the flow that fills the used sides', () => {
    // few insta-buys: sell offers and insta-buys are thin, buy orders and insta-sells are not
    const p = makeProduct({ instaBuysWeek: 900, instaSellsWeek: 90_000 });
    expect(flagsOf(p, stats(), { buy: 'order' })).not.toContain('LOW_VOLUME');
    expect(flagsOf(p, stats(), { sell: 'insta' })).not.toContain('LOW_VOLUME');
    expect(flagsOf(p, stats(), { sell: 'offer' })).toContain('LOW_VOLUME');
    expect(flagsOf(p, stats(), { buy: 'insta' })).toContain('LOW_VOLUME');
    expect(flagsOf(p, stats(), { buy: 'order', sell: 'offer' })).toContain('LOW_VOLUME');
  });

  it('FEW_ORDERS, THIN_TOP and QUICK_DIVERGENCE on the used book only', () => {
    const fewAsks = makeProduct({ quick: { buyOrders: 2 } });
    expect(flagsOf(fewAsks, stats(), { buy: 'order' })).toEqual([]);
    expect(flagsOf(fewAsks, stats(), { sell: 'offer' })).toEqual(['FEW_ORDERS']);
    const thinBid = makeProduct({
      bids: [
        { price: 100, amount: 10, orders: 1 },
        { price: 70, amount: 5000, orders: 10 },
      ],
    });
    expect(flagsOf(thinBid, stats(), { buy: 'order' })).toEqual(['THIN_TOP']);
    expect(flagsOf(thinBid, stats(), { buy: 'insta' })).toEqual([]);
    const divAsk = makeProduct({ quick: { buyPrice: 300 } });
    expect(flagsOf(divAsk, stats(), { buy: 'insta' })).toEqual(['QUICK_DIVERGENCE']);
    expect(flagsOf(divAsk, stats(), { sell: 'insta' })).toEqual([]);
  });

  it('VOLUME_IMBALANCE only when the smaller flow is used', () => {
    const p = makeProduct({ instaBuysWeek: 1_000_000, instaSellsWeek: 90_000 });
    expect(flagsOf(p, stats(), { buy: 'order' })).toEqual(['VOLUME_IMBALANCE']); // bids fill from the small flow
    expect(flagsOf(p, stats(), { sell: 'offer' })).toEqual([]);
  });

  it('PRICE_SPIKE and NO_HISTORY either way; an empty use checks no book', () => {
    expect(flagsOf(makeProduct(), stats({ medianBid: 200 }), { buy: 'order' })).toEqual(['PRICE_SPIKE']);
    expect(flagsOf(makeProduct(), null, { sell: 'offer' })).toEqual(['NO_HISTORY']);
    expect(flagsOf(makeProduct({ instaBuysWeek: 1, instaSellsWeek: 1, quick: { buyOrders: 0 } }), stats(), {})).toEqual([]);
  });

  it('INGREDIENT_FLAGS: the flags that matter on an input bought by order', () => {
    expect([...INGREDIENT_FLAGS].sort()).toEqual(['PRICE_SPIKE', 'QUICK_DIVERGENCE']);
  });
});

describe('combineRisk / reportFromFlags', () => {
  it('union of flags, max score, worst level', () => {
    const a = reportFromFlags(['QUICK_DIVERGENCE']);
    const b = reportFromFlags(['WIDE_SPREAD', 'NO_HISTORY']);
    const c = reportFromFlags(['DEAD_BID']);
    expect(combineRisk([a, b])).toEqual({ level: 'caution', score: 2, flags: ['WIDE_SPREAD', 'QUICK_DIVERGENCE', 'NO_HISTORY'] });
    expect(combineRisk([a, c]).level).toBe('suspect');
    expect(combineRisk([])).toEqual({ level: 'ok', score: 0, flags: [] });
  });

  it('reportFromFlags levels', () => {
    expect(reportFromFlags([]).level).toBe('ok');
    expect(reportFromFlags(['NO_HISTORY']).level).toBe('ok');
    expect(reportFromFlags(['THIN_TOP']).level).toBe('caution');
    expect(reportFromFlags(['PRICE_SPIKE'] as RiskFlag[]).level).toBe('suspect');
  });
});
