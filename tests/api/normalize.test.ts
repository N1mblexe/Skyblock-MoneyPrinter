import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/bazaar.json';
import { toSnapshot, validateRaw } from '../../src/api/normalize.ts';
import { BOOK_DEPTH } from '../../src/config.ts';

const raw = validateRaw(fixture);

describe('validateRaw', () => {
  it('accepts the fixture', () => {
    expect(raw.success).toBe(true);
  });
  it.each([
    [null, /not a JSON object/],
    [[], /not a JSON object/],
    [{ success: false, cause: 'Key throttle' }, /Key throttle/],
    [{ success: false }, /success/],
    [{ success: true }, /products/],
    [{ success: true, products: [] }, /products/],
    [{ success: true, products: {} }, /lastUpdated/],
  ])('rejects %j', (x, msg) => {
    expect(() => validateRaw(x)).toThrow(msg);
  });
});

describe('toSnapshot', () => {
  const snap = toSnapshot(raw, 123, 'fixture');
  const rp = (fixture as any).products;

  it('copies metadata', () => {
    expect(snap.lastUpdated).toBe(fixture.lastUpdated);
    expect(snap.fetchedAt).toBe(123);
    expect(snap.source).toBe('fixture');
    expect(Object.keys(snap.products).length).toBe(Object.keys(rp).length);
  });

  it('maps the inverted Hypixel books (sell_summary = bids, buy_summary = asks)', () => {
    const m = snap.products.ENCHANTED_MELON!;
    expect(m.bid).toBe(rp.ENCHANTED_MELON.sell_summary[0].pricePerUnit);
    expect(m.ask).toBe(rp.ENCHANTED_MELON.buy_summary[0].pricePerUnit);
    expect(m.bid).toBe(302);
    expect(m.ask).toBe(324.7);
    expect(m.bid!).toBeLessThan(m.ask!);
    expect(m.bids[0]).toEqual({ price: 302, amount: 14087, orders: 1 });
    expect(m.instaBuysWeek).toBe(rp.ENCHANTED_MELON.quick_status.buyMovingWeek);
    expect(m.instaSellsWeek).toBe(rp.ENCHANTED_MELON.quick_status.sellMovingWeek);
    expect(m.quick).not.toHaveProperty('productId');
    expect(m.quick.buyPrice).toBe(rp.ENCHANTED_MELON.quick_status.buyPrice);
  });

  it('sorts bids desc and asks asc for every product', () => {
    for (const p of Object.values(snap.products)) {
      for (let i = 1; i < p.bids.length; i++) expect(p.bids[i]!.price).toBeLessThanOrEqual(p.bids[i - 1]!.price);
      for (let i = 1; i < p.asks.length; i++) expect(p.asks[i]!.price).toBeGreaterThanOrEqual(p.asks[i - 1]!.price);
    }
  });

  it('empty book -> null bid/ask', () => {
    const c = snap.products.ENCHANTMENT_CAYENNE_3!;
    expect(c.bid).toBeNull();
    expect(c.ask).toBeNull();
    expect(c.bids).toEqual([]);
    expect(c.asks).toEqual([]);
  });

  it('caps depth, re-sorts unsorted input, tolerates missing arrays, drops products without quick_status', () => {
    const q = rp.ENCHANTED_MELON.quick_status;
    const many = Array.from({ length: 40 }, (_, i) => ({ amount: 1, pricePerUnit: 100 + i, orders: 1 }));
    const s = toSnapshot(
      {
        success: true,
        lastUpdated: 1,
        products: {
          A: { product_id: 'A', sell_summary: [...many].reverse().reverse(), buy_summary: many, quick_status: q },
          B: { product_id: 'B', quick_status: q } as any,
          C: { product_id: 'C', sell_summary: [], buy_summary: [] } as any,
        },
      },
      0,
      'manual',
    );
    expect(Object.keys(s.products)).toEqual(['A', 'B']);
    const a = s.products.A!;
    expect(a.bids.length).toBe(BOOK_DEPTH);
    expect(a.asks.length).toBe(BOOK_DEPTH);
    expect(a.bid).toBe(139);
    expect(a.ask).toBe(100);
    expect(s.products.B!.bids).toEqual([]);
    expect(s.products.B!.bid).toBeNull();
  });
});
