import { describe, expect, it } from 'vitest';
import { MAX_ORDER_UNITS } from '../../src/config.ts';
import { computeNpcFlips } from '../../src/domain/npc.ts';
import { sellSide } from '../../src/domain/pricing.ts';
import { ctx, P } from './helpers.ts';

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
    // NPC shop: 640/day -> 26.67/h, below the offer fill rate, so the NPC limit binds
    const rSell = sellSide(P('MELON'), 'offer', 0.05)!.rate;
    expect(rSell).toBeGreaterThan(640 / 24);
    expect(m.tp.limitedBy).toBe('npcLimit');
    expect(m.tp.batchQty).toBeCloseTo(1 / (24 / 640 + 1 / rSell), 9);
    expect(m.tp.slots).toBe(1); // only the sell offer uses a slot
  });

  it('npcDailyLimit sets the NPC buy rate', () => {
    const m = (limit: number) =>
      computeNpcFlips(ctx({ npcDailyLimit: limit, fillModel: 'pipelined' })).find((r) => r.id === 'MELON' && r.direction === 'npc2bz')!;
    expect(m(240).tp.unitsPerHour).toBeCloseTo(10, 9);
    expect(m(480).tp.unitsPerHour).toBeCloseTo(20, 9);
    expect(m(240).profitPerHour).toBeCloseTo(10 * m(240).profit, 9);
  });

  it('bz2npc sells to the NPC without a slot or a sell-side limit', () => {
    const g = computeNpcFlips(ctx()).find((r) => r.id === 'GOLD_INGOT' && r.direction === 'bz2npc')!;
    // ~89k units/h of buy orders: two orders of up to MAX_ORDER_UNITS, nothing on the sell side
    expect(g.tp.batchQty).toBeGreaterThan(MAX_ORDER_UNITS);
    expect(g.tp.slots).toBe(2);
    expect(g.tp.sellHours).toBe(0);
    expect(g.tp.limitedBy).toBe('volume');
  });

  it('insta modes: GOLD_INGOT insta ask 6 > NPC 4 -> not listed; MELON insta-sell 0.7 < 2.5 -> not listed', () => {
    const rows = computeNpcFlips(ctx({ costMode: 'insta', sellMode: 'insta' }));
    expect(rows.find((r) => r.id === 'GOLD_INGOT')).toBeUndefined();
    expect(rows.find((r) => r.id === 'MELON' && r.direction === 'npc2bz')).toBeUndefined();
    for (const r of rows) expect(r.profit).toBeGreaterThan(0);
  });
});
