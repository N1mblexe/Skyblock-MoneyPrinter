import { describe, expect, it } from 'vitest';
import { MAX_ORDER_UNITS } from '../../src/config.ts';
import { walkBook } from '../../src/domain/book.ts';
import {
  ahClaimTax,
  ahListingFee,
  ahNet,
  afterTax,
  buyQuote,
  buySide,
  competitors,
  effShare,
  planTrade,
  round1,
  sellQuote,
  sellSide,
  npcBuyRate,
  sideRates,
  slotsFor,
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

  it('volume-limited (sequential: buy the batch, then sell it)', () => {
    // Q/1000 + Q/2000 = 1h -> Q = 2000/3
    const t = throughput(base);
    expect(t.limitedBy).toBe('volume');
    expect(t.batchQty).toBeCloseTo(2000 / 3, 9);
    expect(t.unitsPerHour).toBeCloseTo(2000 / 3, 9);
    expect(t.capitalUsed).toBeCloseTo(200_000 / 3, 6);
    expect(t.buyHours).toBeCloseTo(2 / 3, 12);
    expect(t.sellHours).toBeCloseTo(1 / 3, 12);
    expect(t.fillHours).toBeCloseTo(1, 12);
    expect(t.slots).toBe(0); // no orderUnits given
  });

  it('volume-limited (pipelined: one batch buys while the previous one sells, 2x capital)', () => {
    const t = throughput({ ...base, fillModel: 'pipelined' });
    expect(t).toEqual({
      unitsPerHour: 1000,
      batchQty: 1000,
      capitalUsed: 200_000,
      fillHours: 1,
      limitedBy: 'volume',
      buyHours: 1,
      sellHours: 0.5,
      slots: 0,
    });
    // an instant side (NPC sell) needs no overlap: 1x capital, same as sequential
    const npcOut = { ...base, rSell: Infinity };
    expect(throughput({ ...npcOut, fillModel: 'pipelined' })).toEqual(throughput(npcOut));
    expect(throughput(npcOut).capitalUsed).toBe(100_000);
  });

  it('capital-limited', () => {
    const t = throughput({ ...base, capital: 10_050 });
    expect(t.limitedBy).toBe('capital');
    expect(t.batchQty).toBe(100);
    expect(t.capitalUsed).toBe(10_000);
    expect(t.fillHours).toBeCloseTo(0.15, 12); // 100/1000 + 100/2000
    expect(t.unitsPerHour).toBe(100); // one batch per cycle, not capital/price per hour
    const p = throughput({ ...base, capital: 10_050, fillModel: 'pipelined' });
    expect(p).toMatchObject({ limitedBy: 'capital', batchQty: 50, capitalUsed: 10_000, unitsPerHour: 50 });
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

  it('MAX_ORDER_UNITS cap when nothing else bounds the batch; unlimited capital (<= 0)', () => {
    const t = throughput({ ...base, rBuy: Infinity, rSell: Infinity, capital: 0 });
    expect(t.batchQty).toBe(MAX_ORDER_UNITS);
    expect(t.limitedBy).toBe('depth');
    expect(t.fillHours).toBe(0);
    expect(t.unitsPerHour).toBe(MAX_ORDER_UNITS);
    // orders but no slot limit: still capped
    expect(throughput({ ...base, rBuy: Infinity, rSell: Infinity, capital: 0, orderUnits: [1, 1] }).batchQty).toBe(MAX_ORDER_UNITS);
  });

  it('longer cycles spread a batch over the cycle', () => {
    const t = throughput({ ...base, cycleHours: 4, capital: 20_000 });
    expect(t.batchQty).toBe(200);
    expect(t.unitsPerHour).toBe(50);
  });

  it('sequential vs pipelined on a synthetic product (exact)', () => {
    // order/offer flip: buy rate 300/h, sell rate 100/h, cycle 2h, ample capital
    const o = { rBuy: 300, rSell: 100, unitCost: 50, capital: 1e9, cycleHours: 2, orderUnits: [1, 1], orderSlots: 14 };
    const seq = throughput({ ...o, fillModel: 'sequential' });
    // Q/300 + Q/100 = 2 -> Q = 150; period 2h
    expect(seq.batchQty).toBeCloseTo(150, 9);
    expect(seq.unitsPerHour).toBeCloseTo(75, 9);
    expect(seq.buyHours).toBeCloseTo(0.5, 12);
    expect(seq.sellHours).toBeCloseTo(1.5, 12);
    expect(seq.capitalUsed).toBeCloseTo(7500, 6);
    expect(seq.slots).toBe(2);
    const pipe = throughput({ ...o, fillModel: 'pipelined' });
    // Q = 2h x min(300, 100) = 200; capital 2 x 200 x 50
    expect(pipe).toMatchObject({ unitsPerHour: 100, batchQty: 200, capitalUsed: 20_000, fillHours: 2, limitedBy: 'volume', sellHours: 2, slots: 2 });
    expect(pipe.buyHours).toBeCloseTo(2 / 3, 12);
    expect(seq.unitsPerHour).toBeLessThanOrEqual(pipe.unitsPerHour);
    // the default model is sequential
    expect(throughput(o)).toEqual(seq);
  });

  it('sequential uph <= pipelined uph whenever capital does not bind', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 300; i++) {
      const o = {
        rBuy: rnd() * 1e4,
        rSell: rnd() < 0.2 ? Infinity : rnd() * 1e4,
        unitCost: 1 + rnd() * 1e3,
        capital: 0,
        cycleHours: 0.1 + rnd() * 12,
        depthCap: rnd() < 0.3 ? rnd() * 1e4 : undefined,
        forgeCap: rnd() < 0.2 ? rnd() * 10 : undefined,
        orderUnits: rnd() < 0.5 ? [1, 1] : [],
        orderSlots: 1 + Math.floor(rnd() * 20),
      };
      const s = throughput({ ...o, fillModel: 'sequential' });
      const p = throughput({ ...o, fillModel: 'pipelined' });
      expect(s.unitsPerHour).toBeLessThanOrEqual(p.unitsPerHour + 1e-9);
    }
  });

  it('order slots: ceil(Q / MAX_ORDER_UNITS) per order, Q shrinks to fit (limitedBy slots)', () => {
    const o = { rBuy: 1e7, rSell: 1e7, unitCost: 1, capital: 0, cycleHours: 1, fillModel: 'pipelined' as const };
    // two orders (buy + sell) of 1 unit each per batch unit, 5 slots -> floor(5/2) = 2 orders each
    const t = throughput({ ...o, orderUnits: [1, 1], orderSlots: 5 });
    expect(t.limitedBy).toBe('slots');
    expect(t.batchQty).toBe(2 * MAX_ORDER_UNITS);
    expect(t.slots).toBe(4);
    // uneven legs: 1 unit + 3 units per batch unit within 4 slots -> 3 slots on the big leg, 1 on the small one
    const u = throughput({ ...o, orderUnits: [1, 3], orderSlots: 4 });
    expect(u.limitedBy).toBe('slots');
    expect(u.batchQty).toBe(MAX_ORDER_UNITS);
    expect(u.slots).toBe(4);
    // one slot cannot hold two orders
    expect(throughput({ ...o, orderUnits: [1, 1], orderSlots: 1 })).toMatchObject({ batchQty: 0, unitsPerHour: 0, limitedBy: 'slots' });
    // within the limit nothing changes; insta/NPC legs (no orderUnits) use no slots
    const small = throughput({ ...o, rBuy: 100, rSell: 100, orderUnits: [1, 1], orderSlots: 2 });
    expect(small).toMatchObject({ limitedBy: 'volume', batchQty: 100, slots: 2 });
    expect(slotsFor(MAX_ORDER_UNITS, [1, 1])).toBe(2);
    expect(slotsFor(MAX_ORDER_UNITS + 1, [1, 1])).toBe(4);
    expect(slotsFor(0.0001, [1, 0, NaN])).toBe(1);
  });

  it('NPC-limited side reports npcLimit', () => {
    const t = throughput({ ...base, rBuy: 640 / 24, rSell: Infinity, buyBound: 'npcLimit' });
    expect(t.limitedBy).toBe('npcLimit');
    expect(t.unitsPerHour).toBeCloseTo(640 / 24, 9);
    expect(throughput({ ...base, rSell: 10, sellBound: 'npcLimit' }).limitedBy).toBe('npcLimit');
    expect(throughput({ ...base, rBuy: 0, buyBound: 'npcLimit' }).limitedBy).toBe('npcLimit');
    expect(npcBuyRate(640)).toBeCloseTo(640 / 24, 12);
    expect(npcBuyRate(NaN)).toBe(0);
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
    // sequential: Q/100 + Q/50 = 1h -> Q = 100/3, re-quoted at ceil(Q) = 34
    expect(qs).toEqual([1, 34]);
    expect(plan.profit).toBe(9);
    expect(plan.tp.batchQty).toBeCloseTo(100 / 3, 9);
  });

  it('passes fill model, slots and leg bounds to throughput', () => {
    const leg = (rate: number, extra = {}) => () => ({ price: 10, net: 10, rate, order: true, ...extra });
    const s = { capital: 0, cycleHours: 1, fillModel: 'pipelined' as const, orderSlots: 1 };
    // two order legs cannot share one slot
    expect(planTrade(leg(100), leg(100), s, false)!.tp.limitedBy).toBe('slots');
    const npc = planTrade(leg(5, { order: false, bound: 'npcLimit' }), leg(100), { ...s, orderSlots: 14 }, false)!;
    expect(npc.tp).toMatchObject({ limitedBy: 'npcLimit', batchQty: 5, slots: 1 });
  });

  it('keeps the first quote if the re-quote fails', () => {
    const buy = (q: number) => (q > 1 ? null : { price: 10, net: 10, rate: 100 });
    const plan = planTrade(buy, () => ({ price: 20, net: 20, rate: 50 }), { capital: 1e9, cycleHours: 1 }, true)!;
    expect(plan.profit).toBe(10);
  });
});

describe('NPC floor on buy orders', () => {
  const p = makeProduct({
    bids: [{ price: 0.1, amount: 1, orders: 1 }],
    asks: [{ price: 6, amount: 1, orders: 1 }],
    instaBuysWeek: 168_000,
    instaSellsWeek: 16_800,
  });

  it('raises dead bids to 0.9 x NPC sell price, leaves normal bids alone', () => {
    expect(buyQuote(p, 'order', undefined, 3)).toEqual({ price: 2.7, filled: Infinity, slippage: 0, source: 'order', clamped: 'npcFloor' });
    const normal = buyQuote({ ...p, bid: 5 }, 'order', undefined, 3)!;
    expect(normal.price).toBeCloseTo(5.1, 9);
    expect(normal.clamped).toBeUndefined();
    expect(buyQuote(p, 'insta', 1, 3)!.price).toBe(6);
  });

  it('never above the ask (ENDER_PEARL shape: bid 1.5, ask 3.9, NPC sell 7 -> floor 6.3 capped at 3.9)', () => {
    const pearl = makeProduct({
      bids: [{ price: 1.5, amount: 20_000, orders: 3 }],
      asks: [
        { price: 3.9, amount: 500, orders: 2 },
        { price: 4.2, amount: 9000, orders: 6 },
      ],
      instaBuysWeek: 168_000,
      instaSellsWeek: 16_800,
    });
    const q = buyQuote(pearl, 'order', undefined, 7)!;
    expect(q.price).toBeLessThanOrEqual(pearl.ask!);
    expect(q).toEqual({ price: 3.9, filled: Infinity, slippage: 0, source: 'order', clamped: 'ask' });
    // capped at the ask -> fills right away: insta-buy rate (instaBuysWeek/168 x share), no queue
    const s = buySide(pearl, 'order', 0.05, undefined, 7)!;
    expect(s.rate).toBeCloseTo((168_000 / 168) * 0.05, 9);
    expect(s.comp).toBe(0);
    // without the NPC floor it queues on the bids at the bid-side rate
    const plain = buySide(pearl, 'order', 0.05)!;
    expect(plain.quote.clamped).toBeUndefined();
    expect(plain.rate).toBeCloseTo((16_800 / 168) * 0.05, 9);
    // a floor that lands exactly on the ask is not clamped
    expect(buyQuote(pearl, 'order', undefined, 3.9 / 0.9)).toMatchObject({ price: 3.9, clamped: 'npcFloor' });
    // no ask: the floor stands
    expect(buyQuote({ ...pearl, ask: null, asks: [] }, 'order', undefined, 7)).toMatchObject({ price: 6.3, clamped: 'npcFloor' });
  });
});

describe('AH fees', () => {
  it('listing fee by price tier', () => {
    expect(ahListingFee(0)).toBe(0);
    expect(ahListingFee(1_000_000)).toBeCloseTo(10_000, 6); // 1 %
    expect(ahListingFee(10_000_000)).toBeCloseTo(100_000, 6); // still 1 % at exactly 10M
    expect(ahListingFee(50_000_000)).toBeCloseTo(1_000_000, 6); // 2 %
    expect(ahListingFee(200_000_000)).toBeCloseTo(5_000_000, 6); // 2.5 %
  });

  it('claim tax: none up to 1M, 1 % above, never below the 1M floor; Derpy x4', () => {
    expect(ahClaimTax(1_000_000)).toBe(0);
    expect(ahClaimTax(1_000_050)).toBeCloseTo(50, 6); // 1 % would be 10,000.5: capped at the floor
    expect(ahClaimTax(5_000_000)).toBeCloseTo(50_000, 6);
    expect(ahClaimTax(5_000_000, true)).toBeCloseTo(200_000, 6);
    expect(ahClaimTax(1_100_000, true)).toBeCloseTo(44_000, 6);
    expect(ahClaimTax(1_030_000, true)).toBeCloseTo(30_000, 6); // 4 % = 41,200, capped at the floor
  });

  it('net = price - listing fee - claim tax', () => {
    expect(ahNet(500_000)).toBeCloseTo(495_000, 6);
    expect(ahNet(20_000_000)).toBeCloseTo(20_000_000 - 400_000 - 200_000, 6);
    expect(ahNet(20_000_000, true)).toBeCloseTo(20_000_000 - 400_000 - 800_000, 6);
  });
});
