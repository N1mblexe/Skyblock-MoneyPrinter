import { describe, expect, it } from 'vitest';
import { rawOptions, sellOptions } from '../../src/domain/sell.ts';
import { AH_SALES } from '../../src/config.ts';
import { afterTax, ahNet } from '../../src/domain/pricing.ts';
import { bestSale } from '../../src/domain/sale.ts';
import type { CatalogFile, Product } from '../../src/types/contracts.ts';
import { buildCatalog, catalogFile, ctx, makeProduct, snap, stats } from './helpers.ts';

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
  it('conservatism prices the raw bazaar sales like every other sale (no-op without enough history)', () => {
    const hist = { stats: () => stats({ n: 50, medianAsk: 450, medianBid: 380, madAsk: 2 }) };
    const raw = new Map(rawOptions({ ...c(), ...hist }, 'B', 10).map((o) => [o.method, o]));
    const on = new Map(rawOptions({ ...c(), ...hist, settings: { ...c().settings, conservative: true } }, 'B', 10).map((o) => [o.method, o]));
    // insta-sell at no more than the median bid; sell offer at no more than the median ask - tick
    expect(on.get('insta')!.net).toBeCloseTo(afterTax(380, TAX) * 10, 6);
    expect(on.get('offer')!.net).toBeLessThanOrEqual(afterTax(449.9, TAX) * 10 + 1e-6);
    expect(on.get('offer')!.net).toBeLessThan(raw.get('offer')!.net);
    const thin = new Map(rawOptions({ ...c(), settings: { ...c().settings, conservative: true } }, 'B', 10).map((o) => [o.method, o]));
    expect(thin.get('insta')!.net).toBe(raw.get('insta')!.net);
  });

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

describe('sale venues and hours', () => {
  it('AH: listed under the lowest BIN after fees, hours from the AH sales rate', () => {
    const ahCat = buildCatalog(file);
    ahCat.items.C!.auctionable = true;
    const cx = { ...c(), catalog: ahCat, ah: (id: string) => (id === 'C' ? { price: 5000, count: 4 } : null) };
    const ah = rawOptions(cx, 'C', 10).find((o) => o.method === 'ah')!;
    expect(ah.net).toBeCloseTo(10 * ahNet(4999), 9);
    expect(ah.hours).toBeCloseTo(10 / AH_SALES.defaultPerHour, 9);
    // not auctionable: no AH option
    expect(rawOptions({ ...cx, catalog: cat }, 'C', 10).some((o) => o.method === 'ah')).toBe(false);
  });

  it('crafted items are valued for the crafted quantity at their best venue, with hours to sell them', () => {
    const r = sellOptions(c(), 'A', 3000);
    const d = r.options.find((o) => o.craft?.toId === 'D')!;
    const sale = bestSale(c(), 'D', { qty: 2 })!;
    expect(d.craft).toMatchObject({ venue: 'bazaar', saleNet: sale.net });
    expect(d.net).toBeCloseTo(2 * (sale.net - d.craft!.sideCost) + 440 * Math.max(...rawOptions(c(), 'A', 3000).filter((o) => o.filled == null).map((o) => o.perItem)), 6);
    // a sell offer takes 2 / rate hours; the leftover sells by the best raw method meanwhile
    expect(d.hours).toBeGreaterThanOrEqual(2 / sale.rate - 1e-9);
    // insta-selling the crafted items is immediate
    const insta = sellOptions({ ...c(), settings: { ...c().settings, sellMode: 'insta' } }, 'A', 2560).options.find((o) => o.craft?.toId === 'D')!;
    expect(insta.hours).toBe(0);
    expect(insta.craft!.leftover).toBe(0);
  });

  it('crafted items sold to an NPC are immediate; a leftover with unknown hours makes the option unknown', () => {
    const npcCat = buildCatalog({ ...file, items: { ...file.items, D: { n: 'Delta', bz: 1, ns: 50_000 } } });
    const d = sellOptions({ ...c(), catalog: npcCat }, 'A', 2560).options.find((o) => o.craft?.toId === 'D')!;
    expect(d.craft).toMatchObject({ venue: 'npc', saleNet: 50_000, leftover: 0 });
    expect(d.hours).toBe(0);
    // A's best raw sale is a sell offer that never fills (no insta-buys): its hours are unknown
    const dead = { ...s, products: { ...s.products, A: makeProduct({ id: 'A', bids: lvl(1), asks: lvl(1.2), instaBuysWeek: 0, instaSellsWeek: 5_000_000 }) } };
    const cat2 = buildCatalog({ ...file, items: { ...file.items, A: { n: 'Alpha', bz: 1 } } });
    const left = sellOptions({ ...c(), snap: dead, catalog: cat2 }, 'A', 3000).options.find((o) => o.craft?.toId === 'D')!;
    expect(left.hours).toBeNull();
  });
});

describe('edge cases', () => {
  it('raw options: off-bazaar items, empty books, an AH with no sales', () => {
    const ahCat = buildCatalog({ ...file, items: { ...file.items, S: { n: 'Side', nb: 10, ns: 4 } } });
    ahCat.items.S!.auctionable = true;
    const sales = () => ({ n: 0, items: 0, median: 0, perHour: 0, coverageHours: 10, last: 0 });
    const cx = { ...c(), catalog: ahCat, ah: (id: string) => (id === 'S' ? { price: 50, count: 3 } : null), ahSales: sales };
    const by = new Map(rawOptions(cx, 'S', 5).map((o) => [o.method, o]));
    expect([...by.keys()].sort()).toEqual(['ah', 'npc']);
    expect(by.get('ah')!.hours).toBeNull(); // measured: nothing sells
    const empty = { ...s, products: { ...s.products, A: makeProduct({ id: 'A', bids: [], asks: [], bid: null, ask: null }) } };
    expect(rawOptions({ ...c(), snap: empty }, 'A', 10).map((o) => o.method)).toEqual(['npc']);
  });

  it('crafting up: shared moves once, unpriced and losing moves skipped, a partial insta-sell not used for leftovers', () => {
    const branched: CatalogFile = {
      ...file,
      items: { ...file.items, E: { n: 'Eps', bz: 1 }, F: { n: 'Fee', bz: 1 }, T: { n: 'T' }, G: { n: 'Gee', nb: 1e9 } },
      recipes: [...file.recipes, { o: 'E', c: 1, i: [['C', 4], ['G', 1]], k: 'craft' }, { o: 'F', c: 1, i: [['C', 4], ['T', 1]], k: 'craft' }],
    };
    const thinA = prod('A', 1, 1.2, 100);
    const sn = { ...s, products: { ...s.products, A: thinA, E: prod('E', 10, 20), F: prod('F', 9000, 10_000) } };
    const r = sellOptions({ ...c(), snap: sn, catalog: buildCatalog(branched) }, 'A', 3000);
    const crafts = r.options.filter((o) => o.method === 'craft').map((o) => o.craft!.toId);
    expect(crafts.filter((x) => x === 'C')).toHaveLength(1); // A>B>C lies on three ladders
    expect(crafts).not.toContain('F'); // T has no price
    expect(crafts).not.toContain('E'); // its side ingredient costs more than everything is worth
    const d = r.options.find((o) => o.craft?.toId === 'D')!;
    const offer = r.options.find((o) => o.method === 'offer')!;
    expect(d.net).toBeCloseTo(2 * (d.craft!.saleNet - d.craft!.sideCost) + 440 * offer.perItem, 6);
  });
});
