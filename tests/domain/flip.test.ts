import { describe, expect, it } from 'vitest';
import { computeFlips, planFlip } from '../../src/domain/flip.ts';
import { coreOf } from '../../src/domain/market.ts';
import type { CalcCtx } from '../../src/types/contracts.ts';
import { ctx, makeProduct, P, stats } from './helpers.ts';

describe('computeFlips', () => {
  const rows = computeFlips(ctx());
  const byId = new Map(rows.map((r) => [r.id, r]));

  it('ENCHANTED_MELON uses top of book with tax', () => {
    const r = byId.get('ENCHANTED_MELON')!;
    expect(r.name).toBe('Enchanted Melon');
    expect(r.buyAt).toBe(302.1);
    expect(r.sellAt).toBe(324.6);
    expect(r.netSell).toBeCloseTo(324.6 * 0.9875, 9);
    expect(r.profit).toBeCloseTo(324.6 * 0.9875 - 302.1, 9);
    expect(r.margin).toBeCloseTo(r.profit / 302.1, 12);
    expect(r.compBuy).toBe(13);
    expect(r.compSell).toBe(92);
    expect(r.rBuy).toBeCloseTo((215043264 / 168) * 0.05, 6);
    expect(r.rSell).toBeCloseTo(6005159 / 168 / 93, 6);
    expect(r.weekVol).toBe(6005159);
    expect(r.tp.limitedBy).toBe('volume');
    // sequential fill: buy the batch, then sell it within one 1h cycle
    expect(r.tp.batchQty).toBeCloseTo(1 / (1 / r.rBuy + 1 / r.rSell), 6);
    expect(r.tp.buyHours! + r.tp.sellHours!).toBeCloseTo(1, 9);
    expect(r.tp.slots).toBe(2); // one buy order + one sell offer
    const pipe = computeFlips(ctx({ fillModel: 'pipelined' })).find((x) => x.id === 'ENCHANTED_MELON')!;
    expect(pipe.tp.batchQty).toBeCloseTo(r.rSell, 6);
    expect(pipe.tp.capitalUsed).toBeCloseTo(2 * pipe.tp.batchQty * 302.1, 6);
    expect(r.profitPerHour).toBeCloseTo(r.tp.unitsPerHour * r.profit, 6);
    expect(r.risk.flags).toContain('NO_HISTORY');
  });

  it('drops unprofitable / unpriceable rows, never yields NaN', () => {
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      expect(r.profit).toBeGreaterThan(0);
      expect(Number.isFinite(r.margin)).toBe(true);
      expect(Number.isFinite(r.profitPerHour)).toBe(true);
      const p = P(r.id);
      expect(r.buyAt).toBeGreaterThanOrEqual(p.bid!);
      expect(r.sellAt).toBeLessThanOrEqual(p.ask!);
    }
    expect(byId.has('ENCHANTMENT_LIFE_STEAL_2')).toBe(false);
    expect(byId.has('HAY_BLOCK')).toBe(false);
  });

  it('suspect rows stay in the result (views filter)', () => {
    expect(byId.get('JALAPENO_BOOK')!.risk.level).toBe('suspect');
    expect(byId.get('END_STONE_SHULKER')!.risk.level).toBe('suspect');
  });

  it('capital limits profit/hour', () => {
    const poor = computeFlips(ctx({ capital: 3021 })).find((r) => r.id === 'ENCHANTED_MELON')!;
    expect(poor.tp.limitedBy).toBe('capital');
    expect(poor.tp.batchQty).toBe(10);
    expect(poor.profitPerHour).toBeLessThanOrEqual((3021 * poor.margin) / 1 + 1e-9);
  });

  it('insta modes use VWAP and depth', () => {
    const insta = computeFlips(ctx({ costMode: 'insta', sellMode: 'offer', capital: 0 }));
    for (const r of insta) {
      const p = P(r.id);
      expect(r.buyAt).toBeGreaterThanOrEqual(p.ask!);
      expect(r.buyAt).toBeLessThanOrEqual(p.asks.at(-1)!.price);
      expect(r.compBuy).toBe(0);
      expect(r.profit).toBeGreaterThan(0);
    }
    // insta-buy then insta-sell can never profit (ask > bid everywhere in fixture)
    expect(computeFlips(ctx({ costMode: 'insta', sellMode: 'insta' }))).toEqual([]);
  });

  it('order quotes never exceed the ask (NPC floor capped)', () => {
    for (const r of rows) expect(r.buyAt).toBeLessThanOrEqual(P(r.id).ask!);
  });

  it('slot limit binds on huge markets', () => {
    const r = computeFlips(ctx({ orderSlots: 1, capital: 0 })).find((x) => x.id === 'ENCHANTED_MELON')!;
    expect(r.tp.limitedBy).toBe('slots');
    expect(r.profitPerHour).toBe(0);
  });

  it('every row carries planner inputs on its two markets', () => {
    const r = byId.get('ENCHANTED_MELON')!;
    expect(r.plan!.uses).toEqual([
      { key: 'ENCHANTED_MELON:bid', perUnit: 1 },
      { key: 'ENCHANTED_MELON:ask', perUnit: 1 },
    ]);
    expect(r.plan!.orderUnits).toEqual([1, 1]);
    expect(r.plan!.profitPerUnit).toBeCloseTo(r.profit, 9);
    for (const x of rows) expect(x.plan).toBeDefined();
  });

  it('a buy order capped at the ask is an insta-buy: depth-bound, VWAP, no slot (and never a profitable flip)', () => {
    // a one-tick spread: bid + tick is the ask
    const tight = makeProduct({
      id: 'TIGHT',
      bids: [{ price: 104.9, amount: 5000, orders: 10 }],
      asks: [
        { price: 105, amount: 100, orders: 1 },
        { price: 106, amount: 100_000, orders: 10 },
      ],
      quick: { buyPrice: 105, sellPrice: 104.9 },
    });
    const c: CalcCtx = { ...ctx({ capital: 0 }), snap: { ...ctx().snap, products: { TIGHT: tight } } };
    const plan = planFlip('TIGHT', tight, c)!;
    expect(plan.buy.clamped).toBe('ask');
    expect(plan.buy.order).toBe(false);
    expect(plan.buy.depth).toBe(100_100);
    expect(plan.tp.slots).toBe(1); // only the sell offer
    expect(plan.buy.price).toBe(105); // the insta VWAP of one unit (a losing trade is not re-quoted)
    expect(plan.profit).toBeLessThan(0);
    expect(computeFlips(c)).toEqual([]);
  });

  it('conservatism: the legs\' adjustments merged into cons', () => {
    const on = computeFlips(ctx({ conservative: true }, { stats: () => stats({ n: 50, medianAsk: 320, medianBid: 303, madAsk: 2 }) }));
    const r = on.find((x) => x.id === 'ENCHANTED_MELON')!;
    expect(r.cons!.buyRef).toBe(302.1);
    expect(r.buyAt).toBe(303.1);
    expect(byId.get('ENCHANTED_MELON')!.cons).toBeUndefined();
  });

  it('risk is checked on the sides a flip uses (a profitable flip always buys by order)', () => {
    expect(byId.get('ENCHANTED_MELON')!.risk).toEqual(coreOf(ctx()).risk('ENCHANTED_MELON', { buy: 'order', sell: 'offer' }));
  });

  it('uses stats for risk when provided', () => {
    const r = computeFlips(ctx({}, { stats: () => stats({ medianAsk: 325, medianBid: 302, madAsk: 2 }) })).find(
      (x) => x.id === 'ENCHANTED_MELON',
    )!;
    expect(r.risk.flags).not.toContain('NO_HISTORY');
  });
});
