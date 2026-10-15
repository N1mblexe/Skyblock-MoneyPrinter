import { describe, expect, it } from 'vitest';
import { rawOptions, sellOptions } from '../../src/domain/sell.ts';
import { afterTax } from '../../src/domain/pricing.ts';
import type { CatalogFile, Product } from '../../src/types/contracts.ts';
import { buildCatalog, catalogFile, ctx, makeProduct, snap } from './helpers.ts';

// A -> B (160 A) -> C (2 B + 1 S) -> D (4 C); S is NPC-bought. A has an NPC sell price too.
const file: CatalogFile = {
  ...catalogFile,
  items: {
    A: { n: 'Alpha', bz: 1, ns: 0.5 },
    B: { n: 'Beta', bz: 1 },
    C: { n: 'Gamma', bz: 1 },
    D: { n: 'Delta', bz: 1 },
    S: { n: 'Side', nb: 10 },
  },
  recipes: [
    { o: 'B', c: 1, i: [['A', 160]], k: 'craft' },
    { o: 'C', c: 1, i: [['B', 2], ['S', 1]], k: 'craft' },
    { o: 'D', c: 1, i: [['C', 4]], k: 'craft' },
  ],
};
const cat = buildCatalog(file);
const lvl = (price: number, amount = 1_000_000) => [
  { price, amount, orders: 5 },
  { price: price * 0.99, amount, orders: 5 },
];
const prod = (id: string, bid: number, ask: number, bidAmount?: number): Product =>
  makeProduct({ id, bids: lvl(bid, bidAmount), asks: lvl(ask).map((l, i) => ({ ...l, price: ask + i * 0.1 })), instaBuysWeek: 5_000_000, instaSellsWeek: 5_000_000 });
const products = [prod('A', 1, 1.2), prod('B', 400, 500), prod('C', 1200, 1300), prod('D', 9000, 10_000)];
const s = { ...snap, products: Object.fromEntries(products.map((p) => [p.id, p])) };
const c = () => ({ ...ctx(), snap: s, catalog: cat });
const TAX = 0.0125;

describe('raw sale options', () => {
  it('insta-sell walks the buy orders, sell offer takes time, NPC is immediate', () => {
    const by = new Map(rawOptions(c(), 'A', 1000).map((o) => [o.method, o]));
    expect(by.get('insta')!.net).toBeCloseTo(afterTax(1, TAX) * 1000, 6);
    expect(by.get('insta')!.hours).toBe(0);
    expect(by.get('offer')!.net).toBeCloseTo(afterTax(1.1, TAX) * 1000, 6);
    expect(by.get('offer')!.hours).toBeGreaterThan(0);
    expect(by.get('npc')).toMatchObject({ net: 500, perItem: 0.5, hours: 0 });
    expect(by.has('ah')).toBe(false); // not auctionable / no AH price
  });

  it('insta-sell beyond the book counts only what fills', () => {
    const thin = { ...s, products: { ...s.products, A: prod('A', 1, 1.2, 100) } };
    const insta = rawOptions({ ...c(), snap: thin }, 'A', 1000).find((o) => o.method === 'insta')!;
    expect(insta.filled).toBe(200);
  });
});

describe('sellOptions', () => {
  it('crafting up: whole crafts from your items, side ingredients bought, leftovers sold raw', () => {
    const qty = 3000; // 1 D needs 1280 A: 2 crafts, 440 left over
    const r = sellOptions(c(), 'A', qty);
    const craftD = r.options.find((o) => o.craft?.toId === 'D')!;
    expect(craftD.craft).toMatchObject({ path: ['A', 'B', 'C', 'D'], need: 1280, made: 2, used: 2560, leftover: 440 });
    expect(craftD.craft!.sideCost).toBeCloseTo(4 * 10, 9); // 4 S at the NPC per D
    const rawBest = Math.max(...rawOptions(c(), 'A', qty).map((o) => o.perItem));
    expect(craftD.net).toBeCloseTo(2 * (craftD.craft!.row.value - 40) + 440 * rawBest, 6);
    // every tier above the item is an option (B, C, D), sorted best first
    expect(new Set(r.options.filter((o) => o.method === 'craft').map((o) => o.craft!.toId))).toEqual(new Set(['B', 'C', 'D']));
    for (let i = 1; i < r.options.length; i++) expect(r.options[i - 1]!.net).toBeGreaterThanOrEqual(r.options[i]!.net);
    expect(r.options[0]!.method).toBe('craft'); // D at 10k from 1,280 A at ~1 coin each
  });

  it('not enough items for one craft: no craft option to that tier', () => {
    const r = sellOptions(c(), 'A', 500);
    expect(r.options.some((o) => o.craft?.toId === 'D')).toBe(false);
    expect(r.options.some((o) => o.craft?.toId === 'B')).toBe(true);
  });
});
