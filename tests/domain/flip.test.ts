import { describe, expect, it } from 'vitest';
import { computeFlips } from '../../src/domain/flip.ts';
import { computeNpcFlips } from '../../src/domain/npc.ts';
import { ctx, P, stats } from './helpers.ts';

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
    expect(r.tp.batchQty).toBeCloseTo(r.rSell, 6);
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

  it('uses stats for risk when provided', () => {
    const r = computeFlips(ctx({}, { stats: () => stats({ medianAsk: 325, medianBid: 302, madAsk: 2 }) })).find(
      (x) => x.id === 'ENCHANTED_MELON',
    )!;
    expect(r.risk.flags).not.toContain('NO_HISTORY');
  });
});

describe('computeNpcFlips', () => {
  it('GOLD_INGOT 0.1 bid: buy order floored at 0.9 x NPC sell, still suspect', () => {
    const rows = computeNpcFlips(ctx());
    const g = rows.find((r) => r.id === 'GOLD_INGOT' && r.direction === 'bz2npc')!;
    expect(g.buyAt).toBeCloseTo(2.7, 9);
    expect(g.sellAt).toBe(3);
    expect(g.profit).toBeCloseTo(0.3, 9);
    expect(g.risk.level).toBe('suspect'); // dead bid
    for (const r of rows) expect(r.profit).toBeGreaterThan(0);
  });

  it('npc2bz: MELON bought at NPC, sold by offer after tax', () => {
    const rows = computeNpcFlips(ctx());
    const m = rows.find((r) => r.id === 'MELON' && r.direction === 'npc2bz')!;
    expect(m.buyAt).toBe(2.5);
    expect(m.sellAt).toBeCloseTo(4.8 * 0.9875, 9);
    expect(m.profit).toBeCloseTo(4.8 * 0.9875 - 2.5, 9);
    expect(m.tp.limitedBy).toBe('volume');
  });

  it('insta modes: GOLD_INGOT insta ask 6 > NPC 4 -> not listed; MELON insta-sell 0.7 < 2.5 -> not listed', () => {
    const rows = computeNpcFlips(ctx({ costMode: 'insta', sellMode: 'insta' }));
    expect(rows.find((r) => r.id === 'GOLD_INGOT')).toBeUndefined();
    expect(rows.find((r) => r.id === 'MELON' && r.direction === 'npc2bz')).toBeUndefined();
    for (const r of rows) expect(r.profit).toBeGreaterThan(0);
  });
});
