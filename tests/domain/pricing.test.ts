import { describe, expect, it } from 'vitest';
import { MAX_ORDER_UNITS } from '../../src/config.ts';
import { walkBook } from '../../src/domain/book.ts';
import {
  afterTax,
  buyQuote,
  buySide,
  competitors,
  effShare,
  planTrade,
  round1,
  sellQuote,
  sellSide,
  sideRates,
  throughput,
} from '../../src/domain/pricing.ts';
import { makeProduct, P } from './helpers.ts';

describe('quotes from top of book (never quick_status)', () => {
  const melon = P('ENCHANTED_MELON');

  it('ENCHANTED_MELON order/offer', () => {
    // bid = sell_summary[0] = 302, ask = buy_summary[0] = 324.7; quick buyPrice is ~831 and must NOT be used.
    expect(melon.bid).toBe(302);
    expect(melon.ask).toBe(324.7);
    const b = buyQuote(melon, 'order')!;
    const s = sellQuote(melon, 'offer')!;
    expect(b).toEqual({ price: 302.1, filled: Infinity, slippage: 0, source: 'order' });
    expect(s.price).toBe(324.6);
    expect(s.price).toBe(round1(melon.ask! - 0.1));
    expect(s.price).toBeLessThan(melon.quick.buyPrice / 2);
  });

  it('insta quotes walk the book', () => {
    const b = buyQuote(melon, 'insta', 500)!;
    expect(b.source).toBe('insta');
    expect(b.price).toBeCloseTo(walkBook(melon.asks, 500)!.avgPrice, 9);
    expect(b.slippage).toBeGreaterThan(0);
    expect(b.filled).toBe(500);
    expect(buyQuote(melon, 'insta')!.price).toBe(324.7);

    const s = sellQuote(melon, 'insta', 20_000)!;
    expect(s.price).toBeCloseTo((14087 * 302 + 5913 * 301.9) / 20_000, 9);
    expect(s.slippage).toBeLessThan(0);
    expect(sellQuote(melon, 'insta')!.price).toBe(302);
  });

  it('null on empty sides; offer never below 0.1', () => {
    const empty = P('ENCHANTMENT_LIFE_STEAL_2');
    expect(buyQuote(empty, 'order')).toBeNull();
    expect(buyQuote(empty, 'insta')).toBeNull();
    expect(sellQuote(empty, 'offer')).toBeNull();
    expect(sellQuote(empty, 'insta')).toBeNull();
    const cheap = makeProduct({ asks: [{ price: 0.1, amount: 10, orders: 1 }] });
    expect(sellQuote(cheap, 'offer')!.price).toBe(0.1);
  });

  it('profit formula with tax', () => {
    const buyAt = buyQuote(melon, 'order')!.price;
    const sellAt = sellQuote(melon, 'offer')!.price;
    const net = afterTax(sellAt, 0.0125);
    expect(net).toBeCloseTo(324.6 * 0.9875, 9);
    expect(net - buyAt).toBeCloseTo(18.4425, 6);
  });
});

describe('rates & competition', () => {
  const melon = P('ENCHANTED_MELON');
  it('sideRates', () => {
    expect(sideRates(melon, 'order', 'offer')).toEqual({ buy: 215043264 / 168, sell: 6005159 / 168 });
    expect(sideRates(melon, 'insta', 'insta')).toEqual({ buy: 6005159 / 168, sell: 215043264 / 168 });
    expect(sideRates(makeProduct({ instaBuysWeek: NaN, instaSellsWeek: -1 }), 'order', 'offer')).toEqual({ buy: 0, sell: 0 });
  });

  it('competitors within 1% of best', () => {
    expect(competitors(melon.bids)).toBe(13); // 302..300.8 all within 3.02
    expect(competitors(melon.asks)).toBe(92); // 324.7, 324.8, 325
    expect(competitors([])).toBe(0);
    expect(competitors(melon.asks, 0)).toBe(1);
  });

  it('effShare', () => {
    expect(effShare(0.05, 0)).toBe(0.05);
    expect(effShare(0.5, 3)).toBe(0.25);
    expect(effShare(0, 3)).toBe(0);
    expect(effShare(1, -2)).toBe(1);
  });

  it('buySide/sellSide apply competition only to queued sides', () => {
    const b = buySide(melon, 'order', 0.05)!;
    expect(b.comp).toBe(13);
    expect(b.rate).toBeCloseTo((215043264 / 168) * 0.05, 6);
    expect(b.depth).toBeUndefined();
    const s = sellSide(melon, 'offer', 0.05)!;
    expect(s.comp).toBe(92);
    expect(s.rate).toBeCloseTo((6005159 / 168) / 93, 6);
    const bi = buySide(melon, 'insta', 0.05)!;
    expect(bi.comp).toBe(0);
    expect(bi.depth).toBe(294 + 238 + 45917 + 86 + 26969);
    const si = sellSide(melon, 'insta', 0.05)!;
    expect(si.rate).toBeCloseTo((215043264 / 168) * 0.05, 6);
    expect(si.depth).toBe(14087 + 92051 + 71680 + 350543 + 1044);
    expect(buySide(P('ENCHANTMENT_LIFE_STEAL_2'), 'order', 0.05)).toBeNull();
    expect(sellSide(P('ENCHANTMENT_LIFE_STEAL_2'), 'offer', 0.05)).toBeNull();
  });
});

describe('throughput', () => {
  const base = { rBuy: 1000, rSell: 2000, unitCost: 100, capital: 1e12, cycleHours: 1 };

  it('volume-limited', () => {
    const t = throughput(base);
    expect(t).toEqual({ unitsPerHour: 1000, batchQty: 1000, capitalUsed: 100_000, fillHours: 1, limitedBy: 'volume' });
  });

  it('capital-limited', () => {
    const t = throughput({ ...base, capital: 10_050 });
    expect(t.limitedBy).toBe('capital');
    expect(t.batchQty).toBe(100);
    expect(t.capitalUsed).toBe(10_000);
    expect(t.fillHours).toBeCloseTo(0.1);
    expect(t.unitsPerHour).toBe(100); // one batch per cycle, not capital/price per hour
  });

  it('depth-limited', () => {
    const t = throughput({ ...base, depthCap: 40 });
    expect(t.limitedBy).toBe('depth');
    expect(t.batchQty).toBe(40);
    expect(t.unitsPerHour).toBe(40);
  });

  it('forge-limited', () => {
    const t = throughput({ ...base, forgeCap: 0.5, cycleHours: 2 });
    expect(t.limitedBy).toBe('forge');
    expect(t.batchQty).toBe(1);
    expect(t.unitsPerHour).toBe(0.5);
  });

  it('MAX_ORDER_UNITS cap and unlimited capital (<= 0)', () => {
    const t = throughput({ ...base, rBuy: Infinity, rSell: Infinity, capital: 0 });
    expect(t.batchQty).toBe(MAX_ORDER_UNITS);
    expect(t.limitedBy).toBe('depth');
    expect(t.fillHours).toBe(0);
    expect(t.unitsPerHour).toBe(MAX_ORDER_UNITS);
  });

  it('longer cycles spread a batch over the cycle', () => {
    const t = throughput({ ...base, cycleHours: 4, capital: 20_000 });
    expect(t.batchQty).toBe(200);
    expect(t.unitsPerHour).toBe(50);
  });

  it('zero / invalid inputs -> zeros', () => {
    for (const o of [
      { ...base, unitCost: 0 },
      { ...base, rBuy: 0 },
      { ...base, rSell: NaN },
      { ...base, cycleHours: 0 },
      { ...base, unitCost: Infinity },
    ]) {
      const t = throughput(o);
      expect(t.unitsPerHour).toBe(0);
      expect(t.batchQty).toBe(0);
      expect(t.capitalUsed).toBe(0);
    }
    expect(throughput({ ...base, forgeCap: 0 }).limitedBy).toBe('forge');
    const poor = throughput({ ...base, capital: 50 });
    expect(poor).toMatchObject({ unitsPerHour: 0, batchQty: 0, limitedBy: 'capital' });
  });

  it('profit/hour never exceeds capital * margin / cycleHours', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 500; i++) {
      const unitCost = 0.1 + rnd() * 1e5;
      const margin = rnd() * 0.5;
      const o = {
        rBuy: rnd() * 1e5,
        rSell: rnd() < 0.2 ? Infinity : rnd() * 1e5,
        unitCost,
        capital: rnd() * 1e8,
        cycleHours: 0.05 + rnd() * 24,
        depthCap: rnd() < 0.3 ? rnd() * 1e4 : undefined,
        forgeCap: rnd() < 0.2 ? rnd() : undefined,
      };
      const t = throughput(o);
      const pph = t.unitsPerHour * unitCost * margin;
      expect(pph).toBeLessThanOrEqual((o.capital * margin) / o.cycleHours + 1e-6);
      expect(t.capitalUsed).toBeLessThanOrEqual(o.capital + 1e-6);
    }
  });
});

describe('planTrade', () => {
  it('returns null when a leg is missing', () => {
    const leg = () => ({ price: 1, net: 1, rate: 1 });
    expect(planTrade(() => null, leg, { capital: 1, cycleHours: 1 }, false)).toBeNull();
    expect(planTrade(leg, () => null, { capital: 1, cycleHours: 1 }, false)).toBeNull();
  });

  it('re-quotes insta legs at the batch size', () => {
    const qs: number[] = [];
    const buy = (q: number) => (qs.push(q), { price: q > 1 ? 11 : 10, net: q > 1 ? 11 : 10, rate: 100, depth: 500 });
    const plan = planTrade(buy, () => ({ price: 20, net: 20, rate: 50 }), { capital: 1e9, cycleHours: 1 }, true)!;
    expect(qs).toEqual([1, 50]);
    expect(plan.profit).toBe(9);
    expect(plan.tp.batchQty).toBe(50);
  });

  it('keeps the first quote if the re-quote fails', () => {
    const buy = (q: number) => (q > 1 ? null : { price: 10, net: 10, rate: 100 });
    const plan = planTrade(buy, () => ({ price: 20, net: 20, rate: 50 }), { capital: 1e9, cycleHours: 1 }, true)!;
    expect(plan.profit).toBe(10);
  });
});

describe('NPC floor on buy orders', () => {
  it('raises dead bids to 0.9 x NPC sell price, leaves normal bids alone', async () => {
    const { buyQuote } = await import('../../src/domain/pricing.ts');
    const p = { id: 'X', bid: 0.1, ask: 6, bids: [{ price: 0.1, amount: 1, orders: 1 }], asks: [{ price: 6, amount: 1, orders: 1 }], quick: {} as never, instaBuysWeek: 1, instaSellsWeek: 1 };
    expect(buyQuote(p, 'order', undefined, 3)!.price).toBeCloseTo(2.7, 9);
    expect(buyQuote({ ...p, bid: 5 }, 'order', undefined, 3)!.price).toBeCloseTo(5.1, 9);
    expect(buyQuote(p, 'insta', 1, 3)!.price).toBe(6);
  });
});
