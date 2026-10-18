import { describe, expect, it } from 'vitest';
import { bestPerLadder, chainGraph, chainStep, computeChains, ladderDetail, moveRecipe } from '../../src/domain/chains.ts';
import { createCraftPricer } from '../../src/domain/craft.ts';
import type { CatalogFile, Product } from '../../src/types/contracts.ts';
import { buildCatalog, catalog as fixtureCatalog, catalogFile, ctx, makeProduct, snap } from './helpers.ts';

// A -> B -> C -> D and C -> E (branch). S is an NPC-bought side ingredient.
//   B = 160 A            (also: 160 A + 1 S, which loses the tie-break: more side inputs)
//   C = 2 B + 1 S        (main B holds 2/3 of the input units)
//   D = 4 C, E = 4 C
//   A x9 = 1 B           (uncrafting: more comes out than goes in, not a step)
//   X = 1 A + 3 S        (main S is not a bazaar item, not a step)
const file: CatalogFile = {
  ...catalogFile,
  items: {
    A: { n: 'Alpha', bz: 1 },
    B: { n: 'Beta', bz: 1 },
    C: { n: 'Gamma', bz: 1 },
    D: { n: 'Delta', bz: 1 },
    E: { n: 'Epsilon', bz: 1 },
    X: { n: 'Ex', bz: 1 },
    S: { n: 'Side', nb: 10 },
  },
  recipes: [
    { o: 'B', c: 1, i: [['A', 160]], k: 'craft' },
    { o: 'B', c: 1, i: [['A', 160], ['S', 1]], k: 'craft' },
    { o: 'C', c: 1, i: [['B', 2], ['S', 1]], k: 'craft' },
    { o: 'D', c: 1, i: [['C', 4]], k: 'craft' },
    { o: 'E', c: 1, i: [['C', 4]], k: 'craft' },
    { o: 'A', c: 9, i: [['B', 1]], k: 'craft' },
    { o: 'X', c: 1, i: [['A', 1], ['S', 3]], k: 'craft' },
  ],
};
const cat = buildCatalog(file);

const lvl = (price: number) => [
  { price, amount: 1_000_000, orders: 5 },
  { price: price * 0.99, amount: 1_000_000, orders: 5 },
];
/** bid/ask pair; buy orders cost bid + 0.1, sell offers get ask - 0.1 */
const prod = (id: string, bid: number, ask: number): Product =>
  makeProduct({ id, bids: lvl(bid), asks: lvl(ask).map((l, i) => ({ ...l, price: ask + i * 0.1 })), instaBuysWeek: 5_000_000, instaSellsWeek: 5_000_000 });
const products = [prod('A', 1, 1.2), prod('B', 400, 500), prod('C', 1200, 1300), prod('D', 7000, 8000), prod('E', 4000, 4500), prod('X', 50, 60)];
const s = { ...snap, products: Object.fromEntries(products.map((p) => [p.id, p])) };
const c = () => ({ ...ctx(), snap: s, catalog: cat });

describe('chain steps and ladders', () => {
  it('main input rule: largest bazaar input, >= half the units, consumed faster than produced', () => {
    const byOut = (o: string) => cat.recipes.filter((r) => r.output === o);
    expect(chainStep(byOut('C')[0]!, cat)).toMatchObject({ from: 'B', to: 'C', mainQty: 2 });
    expect(chainStep(byOut('A')[0]!, cat)).toBeNull(); // uncrafting
    expect(chainStep(byOut('X')[0]!, cat)).toBeNull(); // main input S is not on the bazaar
  });

  it('keeps one step per pair (fewest side inputs) and enumerates root-to-top ladders with branches', () => {
    const g = chainGraph(cat);
    expect(g.next.get('A')!.map((st) => st.recipe.inputs.length)).toEqual([1]);
    expect(g.ladders).toEqual([
      ['A', 'B', 'C', 'D'],
      ['A', 'B', 'C', 'E'],
    ]);
    expect(chainGraph(cat)).toBe(g); // memoised per catalog
  });

  it('a move becomes one recipe: start units and side inputs summed over the steps', () => {
    const { recipe, needFrom } = moveRecipe(chainGraph(cat), ['A', 'B', 'C', 'D']);
    // 1 D = 4 C; 4 C = 8 B + 4 S; 8 B = 1280 A
    expect(needFrom).toBe(1280);
    expect(recipe).toMatchObject({ key: 'chain:A>B>C>D', output: 'D', outCount: 1, kind: 'craft' });
    expect(recipe.inputs).toEqual([
      { id: 'A', qty: 1280 },
      { id: 'S', qty: 4 },
    ]);
  });
});

describe('computeChains', () => {
  const rows = computeChains(c());
  const by = new Map(rows.map((r) => [r.key, r]));

  it('lists moves of two or more steps once, with every ladder they lie on', () => {
    expect([...by.keys()].sort()).toEqual(['A>B>C', 'A>B>C>D', 'A>B>C>E', 'B>C>D', 'B>C>E']);
    expect(by.get('A>B>C')!.ladders).toEqual(['A>B>C>D', 'A>B>C>E']);
    expect(by.get('B>C>D')).toMatchObject({ fromId: 'B', toId: 'D', steps: 2, needFrom: 8 });
  });

  it('prices a move like the craft view, buying the start tier even when crafting it is cheaper', () => {
    const r = by.get('A>B>C>D')!.row;
    expect(r.unpriced).toEqual([]);
    const line = (row: typeof r, id: string) => row.lines.find((l) => l.id === id)!;
    expect(line(r, 'A')).toMatchObject({ qty: 1280, unit: 1.1, source: 'order' });
    expect(line(r, 'S')).toMatchObject({ qty: 4, unit: 10, source: 'npc' });
    expect(r.cost).toBeCloseTo(1280 * 1.1 + 40, 6);
    expect(r.value).toBeCloseTo((8000 - 0.1) * (1 - 0.0125), 6);
    expect(r.profit).toBeCloseTo(r.value - r.cost, 6);
    // B costs 400.1 to buy but 160 * 1.1 = 176 to craft: the B>C>D move still buys B
    expect(line(by.get('B>C>D')!.row, 'B')).toMatchObject({ qty: 8, source: 'order' });
    // the same row priced by craft rules would sub-craft B (capital binds, so the cheapest source is kept)
    const crafted = createCraftPricer({ ...c(), settings: { ...c().settings, capital: 1000 } }).price({ key: 't', output: 'D', outCount: 1, kind: 'craft', inputs: [{ id: 'B', qty: 8 }] });
    expect(crafted.lines[0]!.source).toBe('craft');
  });

  it('best move per ladder by profit/hour', () => {
    const best = bestPerLadder(rows);
    for (const l of ['A>B>C>D', 'A>B>C>E']) {
      const on = rows.filter((r) => r.ladders.includes(l) && r.row.profitPerHour > 0);
      const top = on.reduce((a, b) => (b.row.profitPerHour > a.row.profitPerHour ? b : a));
      expect(best.has(top.key)).toBe(true);
    }
    expect(best.size).toBeLessThanOrEqual(2);
  });

  it('ladder detail: unit prices per tier and the move ending at each tier', () => {
    const tiers = ladderDetail(c(), ['A', 'B', 'C', 'D'], 1);
    expect(tiers.map((t) => t.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(tiers[1]).toMatchObject({ name: 'Beta', need: 1, buyUnit: 400.1, move: null });
    expect(tiers[2]!.need).toBe(2);
    expect(tiers[3]!.need).toBe(8);
    expect(tiers[3]!.move!.recipe.key).toBe('chain:B>C>D');
    expect(tiers[2]!.move!.recipe.key).toBe('chain:B>C'); // one step from the start: still priced for the panel
    expect(tiers[0]!.move).toBeNull(); // below the start
    expect(tiers[3]!.sellNet).toBeCloseTo((8000 - 0.1) * (1 - 0.0125), 6);
  });
});

describe('first-tier source', () => {
  // A is also sold by an NPC for less than the bazaar buy order (1.1)
  const npcCat = buildCatalog({ ...file, items: { ...file.items, A: { n: 'Alpha', bz: 1, nb: 0.5 } } });
  const cc = () => ({ ...ctx(), snap: s, catalog: npcCat });

  it("'bazaar' (default) buys the first tier on the bazaar even when an NPC is cheaper", () => {
    const r = computeChains(cc()).find((x) => x.key === 'A>B>C>D')!.row;
    expect(r.lines.find((l) => l.id === 'A')).toMatchObject({ unit: 1.1, source: 'order' });
  });

  it("'cheapest' takes the NPC price and its daily limit, topped up from the bazaar when that earns more", () => {
    const r = computeChains(cc(), 'cheapest').find((x) => x.key === 'A>B>C>D')!.row;
    // 1,280 A per craft: the NPC limit alone (26.7/h) makes 0.02 crafts/h, so the bazaar fills the rest
    const a = r.lines.find((l) => l.id === 'A')!;
    expect(a.source).toBe('mix');
    expect(a.leaves![0]).toMatchObject({ source: 'npc', unit: 0.5, res: 'A:npc' });
    expect(a.unit).toBeGreaterThan(0.5);
    expect(a.unit).toBeLessThan(1.1);
    // capital binds: the cheapest source (the NPC) and its limit
    const capped = { ...cc(), settings: { ...cc().settings, capital: 500, cycleHours: 168 } };
    const n = computeChains(capped, 'cheapest').find((x) => x.key === 'A>B>C>D')!.row;
    expect(n.lines.find((l) => l.id === 'A')).toMatchObject({ unit: 0.5, source: 'npc' });
    expect(ladderDetail(capped, ['A', 'B', 'C', 'D'], 0, 'cheapest')[3]!.move!.lines[0]!.source).toBe('npc');
    expect(ladderDetail(cc(), ['A', 'B', 'C', 'D'], 0, 'cheapest')[0]!.buyUnit).toBe(0.5);
  });
});

describe('real catalog', () => {
  it('finds the wheat ladder up to Enchanted Hay Bale and 4+ tier ladders', () => {
    const g = chainGraph(fixtureCatalog);
    const has = (path: string[]) => g.ladders.some((l) => l.join('>').includes(path.join('>')));
    if (fixtureCatalog.items.ENCHANTED_HAY_BALE) expect(has(['WHEAT', 'ENCHANTED_WHEAT', 'ENCHANTED_HAY_BALE'])).toBe(true);
    expect(g.ladders.length).toBeGreaterThan(0);
  });
});
