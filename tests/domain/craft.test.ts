import { describe, expect, it } from 'vitest';
import { AH_SALES, MAX_ORDER_UNITS } from '../../src/config.ts';
import { computeCrafts, createCraftPricer, getPricer } from '../../src/domain/craft.ts';
import { createMarketCore } from '../../src/domain/market.ts';
import { ahNet, buyQuote } from '../../src/domain/pricing.ts';
import { assessRisk } from '../../src/domain/risk.ts';
import type { AhPrice, AhSalesStat, CatalogFile, CraftRow } from '../../src/types/contracts.ts';
import { baseSettings, buildCatalog, catalog, catalogFile, ctx, makeProduct, P, snap, stats } from './helpers.ts';

const NPC_RATE = baseSettings.npcDailyLimit / 24;

const rowsBy = (rows: CraftRow[]) => new Map(rows.map((r) => [r.recipe.key, r]));

describe('computeCrafts (order/offer)', () => {
  const rows = computeCrafts(ctx());
  const by = rowsBy(rows);

  it('every recipe, off-bazaar outputs flagged', () => {
    expect(rows).toHaveLength(catalog.recipes.length);
    expect(by.get('PAPER#12')).toMatchObject({ outputOffBazaar: true, unpriced: ['PAPER'], profitPerHour: 0 });
    expect(by.get('CYCLE_A#17')!.outputOffBazaar).toBe(true);
    expect(by.get('ENCHANTED_MELON#2')!.outputOffBazaar).toBeUndefined();
  });

  it('ENCHANTED_MELON from MELON by order', () => {
    const r = by.get('ENCHANTED_MELON#2')!;
    expect(r.lines[0]).toMatchObject({ id: 'MELON', name: 'Melon', qty: 160, unit: 1.8, source: 'order', bottleneck: true }); // bid+0.1=0.8 floored at 0.9 x NPC sell 2
    expect(r.cost).toBeCloseTo(288, 9);
    expect(r.value).toBeCloseTo(324.6 * 0.9875, 9);
    expect(r.valueSource).toBe('bazaar');
    expect(r.profit).toBeCloseTo(r.value - r.cost, 9);
    expect(r.margin).toBeCloseTo(r.profit / r.cost, 9);
    // MELON buy orders: 489269278/168 * min(.05, 1/(1+competitors)) / 160
    expect(r.lines[0]!.craftsPerHour).toBeCloseTo((489269278 / 168) * 0.05 / 160, 6);
    expect(r.outCraftsPerHour).toBeCloseTo(6005159 / 168 / 93, 6);
    expect(r.inCraftsPerHour).toBe(r.lines[0]!.craftsPerHour);
    expect(r.tp.unitsPerHour).toBeGreaterThan(0);
    expect(r.profitPerHour).toBeCloseTo(r.tp.unitsPerHour * r.profit, 6);
    expect(r.unpriced).toEqual([]);
  });

  it('sub-crafts PAPER for ENCHANTED_PAPER', () => {
    const r = by.get('ENCHANTED_PAPER#13')!;
    const l = r.lines[0]!;
    expect(l.source).toBe('craft');
    expect(l.viaRecipe).toBe('PAPER#12');
    expect(l.unit).toBeCloseTo(3.6, 9); // 3 sugar cane (order 1.9, floored at 0.9 x NPC sell 4) -> 3 paper
    // sub-craft rate comes from its own input: sugar cane buy-order rate / 3 * 3 paper, per 64 paper
    expect(Number.isFinite(l.craftsPerHour) && l.craftsPerHour > 0).toBe(true);
    expect(l.bottleneck).toBe(true);
    expect(r.cost).toBeCloseTo(64 * 3.6, 9);
    expect(r.inCraftsPerHour).toBe(l.craftsPerHour);
    expect(r.unpriced).toEqual([]);
  });

  it('floors dead 0.1 bids at 0.9 x NPC sell price in sub-crafts (ENCHANTED_GOLD_BLOCK)', () => {
    // capital binds, so the cheapest source stays: 160 gold ingots x max(0.2, 0.9 x NPC 3) = 432 < buy order 456.0
    const l = rowsBy(computeCrafts(ctx({ capital: 100_000 }))).get('ENCHANTED_GOLD_BLOCK#1')!.lines[0]!;
    expect(l.source).toBe('craft');
    expect(l.viaRecipe).toBe('ENCHANTED_GOLD#0');
    expect(l.unit).toBeCloseTo(432, 9);
    expect(l.leaves).toEqual([{ id: 'GOLD_INGOT', qty: 160 * 160, unit: 2.7, source: 'order', res: 'GOLD_INGOT:bid' }]);
  });

  it('source choice: the bottleneck ingredient switches to a faster source when it earns more per hour', () => {
    const r = by.get('ENCHANTED_GOLD_BLOCK#1')!;
    // with 5M capital the gold-ingot sub-craft is volume-bound; buying Enchanted Gold by order makes more per hour
    expect(r.lines[0]).toMatchObject({ source: 'order', unit: 456 });
    const capped = rowsBy(computeCrafts(ctx({ capital: 100_000 }))).get('ENCHANTED_GOLD_BLOCK#1')!;
    expect(r.profitPerHour).toBeGreaterThan(capped.profitPerHour);
    expect(r.lines[0]!.craftsPerHour).toBeGreaterThan(capped.lines[0]!.craftsPerHour);
  });

  it('sub-crafts an ingredient with an empty book (HAY_BLOCK via NPC wheat)', () => {
    const r = by.get('ENCHANTED_HAY_BLOCK#10')!;
    expect(r.lines[0]).toMatchObject({ id: 'HAY_BLOCK', source: 'craft', viaRecipe: 'HAY_BLOCK#9' });
    expect(r.lines[0]!.unit).toBeCloseTo(9 * 2.33, 9);
    // output has no bazaar price nor NPC price
    expect(r.unpriced).toEqual(['ENCHANTED_HAY_BLOCK']);
    expect(r.margin).toBeNull();
    expect(r.cost).toBe(0);
  });

  it('NPC-only ingredient (STICK) and mixed sources', () => {
    const r = by.get('ENCHANTED_BREAD#15')!;
    expect(r.lines.map((l) => [l.id, l.source])).toEqual([
      ['WHEAT', 'npc'], // NPC 2.33 < order 3.5
      ['STICK', 'npc'],
    ]);
    // NPC-bought ingredients are capped by the assumed daily shop limit
    expect(r.lines[0]!.craftsPerHour).toBeCloseTo(NPC_RATE / 59, 9);
    expect(r.lines[1]!.craftsPerHour).toBeCloseTo(NPC_RATE / 1, 9);
    expect(r.lines[0]!.bottleneck).toBe(true);
    expect(r.inCraftsPerHour).toBeCloseTo(NPC_RATE / 59, 9);
    expect(r.cost).toBeCloseTo(59 * 2.33 + 1, 9);
    // in insta mode WHEAT is still NPC (2.33 < 5.7)
    const insta = rowsBy(computeCrafts(ctx({ costMode: 'insta' }))).get('ENCHANTED_BREAD#11')!;
    expect(insta.lines[0]!.source).toBe('npc');
  });

  it('cycle CYCLE_A/CYCLE_B terminates and yields unpriced', () => {
    const r = by.get('ENCHANTED_COAL#19')!;
    expect(r.unpriced).toEqual(['CYCLE_A']);
    expect(r.cost).toBe(0);
    expect(r.value).toBe(0);
    expect(r.profit).toBe(0);
    expect(r.margin).toBeNull();
    expect(r.profitPerHour).toBe(0);
    expect(r.tp.unitsPerHour).toBe(0);
  });

  it('unpriced ENCHANTMENT_ULTIMATE_WISE_1 (MYSTERY_DUST)', () => {
    const r = by.get('ENCHANTMENT_ULTIMATE_WISE_1#16')!;
    expect(r.unpriced).toEqual(['MYSTERY_DUST']);
    expect(r.lines[0]).toMatchObject({ id: 'MYSTERY_DUST', unit: 0, total: 0, craftsPerHour: 0 });
    expect(r.margin).toBeNull();
    for (const k of ['cost', 'value', 'profit', 'profitPerHour'] as const) expect(Number.isNaN(r[k])).toBe(false);
  });

  it('forge cap for REFINED_MITHRIL', () => {
    const r = by.get('REFINED_MITHRIL#14')!;
    expect(r.recipe.kind).toBe('forge');
    expect(r.cost).toBeCloseTo(160 * 1313.1, 6);
    expect(r.tp.limitedBy).toBe('forge');
    const forgeCap = (2 * 3600) / 21600;
    expect(r.tp.unitsPerHour).toBeCloseTo(forgeCap, 9);
    expect(r.profitPerHour).toBeCloseTo(forgeCap * r.profit, 6);
    const r4 = rowsBy(computeCrafts(ctx({ forgeSlots: 4 }))).get('REFINED_MITHRIL#14')!;
    expect(r4.tp.unitsPerHour).toBeCloseTo(2 * forgeCap, 9);
  });

  it('NPC value wins when higher than bazaar (ENCHANTED_GOLD_BLOCK ns 102400 > ~76k)', () => {
    const r = by.get('ENCHANTED_GOLD_BLOCK#1')!;
    expect(r.valueSource).toBe('npc');
    expect(r.value).toBe(102400);
    expect(r.outCraftsPerHour).toBe(Infinity);
  });

  it("NPC-valued crafts do not carry the output's bazaar risk", () => {
    const r = by.get('ENCHANTED_GOLD_BLOCK#1')!;
    const outFlags = assessRisk(P('ENCHANTED_GOLD_BLOCK')).flags;
    expect(outFlags.length).toBeGreaterThan(0);
    for (const f of outFlags) expect(r.risk.flags).not.toContain(f);
    expect(r.risk).toEqual({ level: 'ok', score: 0, flags: [] });
    // the bazaar-valued sibling still carries its output's flags
    const melon = by.get('ENCHANTED_MELON#2')!;
    expect(melon.risk.flags).toEqual(expect.arrayContaining(assessRisk(P('ENCHANTED_MELON')).flags));
  });

  it('slot limit binds: buy orders for 160 melons per craft + one sell offer', () => {
    const r = rowsBy(computeCrafts(ctx({ orderSlots: 2, capital: 0, cycleHours: 168 }))).get('ENCHANTED_MELON#2')!;
    expect(r.tp.limitedBy).toBe('slots');
    expect(r.tp.batchQty).toBeCloseTo(MAX_ORDER_UNITS / 160, 9);
    expect(r.tp.slots).toBe(2);
    const free = rowsBy(computeCrafts(ctx({ capital: 0, cycleHours: 168, orderSlots: 35 }))).get('ENCHANTED_MELON#2')!;
    expect(free.tp.slots).toBeLessThanOrEqual(35);
  });

  it('no NaN anywhere', () => {
    for (const r of rows) {
      for (const v of [r.cost, r.value, r.profit, r.profitPerHour, r.tp.unitsPerHour, r.tp.batchQty]) expect(Number.isNaN(v)).toBe(false);
      if (r.margin != null) expect(Number.isFinite(r.margin)).toBe(true);
    }
  });
});

describe('computeCrafts (insta)', () => {
  const by = rowsBy(computeCrafts(ctx({ costMode: 'insta', sellMode: 'insta' })));

  it('chooses NPC MELON (2.5) over insta ask (4.9)', () => {
    const r = by.get('ENCHANTED_MELON#2')!;
    expect(r.lines[0]).toMatchObject({ source: 'npc', unit: 2.5, bottleneck: true });
    expect(r.lines[0]!.craftsPerHour).toBeCloseTo(NPC_RATE / 160, 9);
    expect(r.cost).toBe(400);
    expect(r.value).toBeCloseTo(302 * 0.9875, 9);
    expect(r.outCraftsPerHour).toBeCloseTo((215043264 / 168) * 0.05, 6);
  });

  it('insta ingredient caps by book depth', () => {
    const r = by.get('ENCHANTED_COAL#4')!;
    expect(r.lines[0]).toMatchObject({ id: 'COAL', source: 'insta', unit: 7.2 });
    expect(r.lines[0]!.craftsPerHour).toBeCloseTo((6905689 / 168) * 0.05 / 160, 6);
    const r2 = rowsBy(computeCrafts(ctx({ costMode: 'insta', sellMode: 'insta', share: 1, capital: 0, cycleHours: 168 }))).get(
      'ENCHANTED_COAL#4',
    )!;
    expect(r2.tp.limitedBy).toBe('depth');
    expect(r2.tp.batchQty).toBeCloseTo((59316 + 9166 + 57472 + 24800 + 8990) / 160, 9);
  });
});

describe('computeCrafts risk', () => {
  it('ingredients contribute only PRICE_SPIKE / QUICK_DIVERGENCE', () => {
    const r = rowsBy(computeCrafts(ctx())).get('ENCHANTED_MELON#2')!;
    // MELON itself is WIDE_SPREAD (0.7 bid vs 4.9 ask); that must not leak into the craft row
    expect(r.risk.flags).not.toContain('WIDE_SPREAD');
    const withStats = rowsBy(
      computeCrafts(ctx({}, { stats: (id) => (id === 'MELON' ? stats({ medianAsk: 1, medianBid: 0.7, madAsk: 0.1 }) : null) })),
    ).get('ENCHANTED_MELON#2')!;
    expect(withStats.risk.flags).toContain('PRICE_SPIKE');
    expect(withStats.risk.level).toBe('suspect');
  });
});

describe('computeCrafts recursion depth', () => {
  const chain = (levels: number, npcAt: string): CatalogFile => {
    const items: CatalogFile['items'] = { TOP: { n: 'Top', bz: 1, ns: 1e9 } };
    const recipes: CatalogFile['recipes'] = [{ o: 'TOP', c: 1, i: [['L1', 1]], k: 'craft' }];
    for (let i = 1; i <= levels; i++) {
      items[`L${i}`] = { n: `Level ${i}`, ...(`L${i}` === npcAt ? { nb: 5 } : {}) };
      if (i < levels) recipes.push({ o: `L${i}`, c: 1, i: [[`L${i + 1}`, 2]], k: 'craft' });
    }
    return { ...catalogFile, items, recipes };
  };

  it('resolves up to 3 sub-craft levels', () => {
    const cat = buildCatalog(chain(4, 'L4'));
    const [r] = computeCrafts({ ...ctx(), catalog: cat });
    expect(r!.unpriced).toEqual([]);
    expect(r!.cost).toBe(5 * 8);
    expect(r!.lines[0]!.source).toBe('craft');
  });

  it('gives up beyond the depth limit', () => {
    const cat = buildCatalog(chain(5, 'L5'));
    const [r] = computeCrafts({ ...ctx(), catalog: cat });
    expect(r!.unpriced).toEqual(['L1']);
  });

  it('forge sub-recipes count their forge time; zero-count recipes are skipped', () => {
    const f: CatalogFile = {
      ...catalogFile,
      items: { TOP: { n: 'Top', bz: 1, ns: 10 }, X: { n: 'X' }, Y: { n: 'Y', nb: 1 } },
      recipes: [
        { o: 'TOP', c: 1, i: [['X', 1]], k: 'craft' },
        { o: 'X', c: 1, i: [['Y', 1]], k: 'forge', d: 60 },
        { o: 'X', c: 0, i: [['Y', 1]], k: 'craft' },
      ],
    };
    const [r] = computeCrafts({ ...ctx(), catalog: buildCatalog(f) });
    expect(r!.unpriced).toEqual([]);
    expect(r!.lines[0]).toMatchObject({ source: 'craft', viaRecipe: 'X#1', unit: 1 });
    // a 60 s forge per X with 2 slots: 120 crafts/h; the NPC limit (26.67/h) binds first
    expect(r!.tp.limitedBy).toBe('npcLimit');
    expect(r!.plan!.uses).toEqual(expect.arrayContaining([{ key: 'forge', perUnit: 60 / 3600 }, { key: 'Y:npc', perUnit: 1 }]));
    const slow = computeCrafts({ ...ctx({ forgeSlots: 0.1 }), catalog: buildCatalog(f) })[0]!;
    expect(slow.tp.limitedBy).toBe('forge');
    expect(slow.tp.unitsPerHour).toBeCloseTo(0.1 * 60, 9);
  });

  it('output missing from snapshot falls back to NPC value; recipe without inputs', () => {
    const f: CatalogFile = {
      ...catalogFile,
      items: { NEWTHING: { n: 'New', bz: 1, ns: 10 }, Y: { n: 'Y', nb: 1 } },
      recipes: [
        { o: 'NEWTHING', c: 2, i: [['Y', 3]], k: 'forge', d: 3600 },
        { o: 'NEWTHING', c: 1, i: [], k: 'craft' },
      ],
    };
    const [r, empty] = computeCrafts({ ...ctx(), catalog: buildCatalog(f) });
    expect(r!.valueSource).toBe('npc');
    expect(r!.value).toBe(20);
    expect(r!.cost).toBe(3);
    expect(r!.tp.limitedBy).toBe('forge'); // NPC in, NPC out: only the forge (2 slots / 1h) limits
    expect(r!.tp.unitsPerHour).toBe(2);
    expect(r!.risk.level).toBe('ok');
    expect(empty!.cost).toBe(0);
    expect(empty!.margin).toBeNull();
  });

  it('bazaar ingredient missing from snapshot with snapshot product lookups', () => {
    const p = makeProduct({ id: 'SYN_IN' });
    const s = { ...snap, products: { ...snap.products, SYN_IN: p } };
    const f: CatalogFile = {
      ...catalogFile,
      items: { ENCHANTED_MELON: { n: 'Enchanted Melon', bz: 1 }, SYN_IN: { n: 'Syn', bz: 1 } },
      recipes: [{ o: 'ENCHANTED_MELON', c: 1, i: [['SYN_IN', 2]], k: 'craft' }],
    };
    const [r] = computeCrafts({ ...ctx(), snap: s, catalog: buildCatalog(f) });
    expect(r!.lines[0]!.unit).toBe(100.1);
    expect(r!.cost).toBeCloseTo(200.2, 9);
  });
});

describe('computeCrafts insta slippage (refine pass)', () => {
  // ING: 50 units at 10, then a wall at 20. OUT: 20 bids at 300, then 200.
  const ing = makeProduct({
    id: 'ING',
    asks: [
      { price: 10, amount: 50, orders: 1 },
      { price: 20, amount: 100_000, orders: 5 },
    ],
    bids: [{ price: 9, amount: 1000, orders: 5 }],
    instaBuysWeek: 168 * 20_000, // 1000/h at share 0.05 -> 100 crafts/h
  });
  const out = makeProduct({
    id: 'OUT',
    bids: [
      { price: 300, amount: 20, orders: 1 },
      { price: 200, amount: 100_000, orders: 5 },
    ],
    asks: [{ price: 310, amount: 1000, orders: 1 }],
    instaSellsWeek: 168 * 4000, // 200/h at share 0.05
  });
  const f: CatalogFile = {
    ...catalogFile,
    items: { OUT: { n: 'Out', bz: 1 }, ING: { n: 'Ing', bz: 1 } },
    recipes: [{ o: 'OUT', c: 1, i: [['ING', 10]], k: 'craft' }],
  };
  const run = (over = {}) =>
    computeCrafts({ ...ctx({ costMode: 'insta', sellMode: 'insta', ...over }), snap: { ...snap, products: { ING: ing, OUT: out } }, catalog: buildCatalog(f) })[0]!;

  it('re-quotes ingredients and output at the batch size', () => {
    const r = run();
    // sequential: Q/100 + Q/200 = 1h -> Q = 66.67 crafts -> re-quoted at 67 crafts = 670 ING / 67 OUT
    expect(r.tp.batchQty).toBeCloseTo(200 / 3, 9);
    const qty1Cost = 10 * buyQuote(ing, 'insta', 10)!.price;
    expect(qty1Cost).toBe(100);
    expect(r.lines[0]!.unit).toBeCloseTo((50 * 10 + 620 * 20) / 670, 9);
    expect(r.cost).toBeCloseTo((10 * (50 * 10 + 620 * 20)) / 670, 9);
    expect(r.cost).toBeGreaterThan(qty1Cost * 1.9);
    expect(r.value).toBeCloseTo(((20 * 300 + 47 * 200) / 67) * 0.9875, 9);
    expect(r.profit).toBeCloseTo(r.value - r.cost, 9);
    expect(r.profitPerHour).toBeCloseTo(r.tp.unitsPerHour * r.profit, 9);
    expect(r.tp.slots).toBe(0); // insta legs use no order slots
  });

  it('order/offer modes are not re-quoted', () => {
    const r = run({ costMode: 'order', sellMode: 'offer' });
    expect(r.lines[0]!.unit).toBe(9.1);
  });
});

describe('computeCrafts off-bazaar outputs', () => {
  const f: CatalogFile = {
    ...catalogFile,
    items: { Y: { n: 'Y', nb: 1 }, GEAR_N: { n: 'Gear N', ns: 50 }, GEAR_A: { n: 'Gear A' }, GEAR_U: { n: 'Gear U' } },
    recipes: [
      { o: 'GEAR_N', c: 1, i: [['Y', 3]], k: 'forge', d: 3600 },
      { o: 'GEAR_A', c: 2, i: [['Y', 3]], k: 'forge', d: 3600 },
      { o: 'GEAR_U', c: 1, i: [['Y', 3]], k: 'forge', d: 3600 },
    ],
  };
  const cat = buildCatalog(f);
  for (const id of ['GEAR_N', 'GEAR_A', 'GEAR_U']) cat.items[id]!.auctionable = true;
  const ah = (count: number) => (id: string): AhPrice | null => (id === 'GEAR_A' ? { price: 1000, count } : null);
  const run = (over = {}, count = 1) => rowsBy(computeCrafts({ ...ctx(over, { ah: ah(count) }), catalog: cat }));

  it('NPC-valued, AH-valued and unpriced forge outputs', () => {
    const by = run();
    const n = by.get('GEAR_N#0')!;
    expect(n).toMatchObject({ outputOffBazaar: true, valueSource: 'npc', value: 50, cost: 3, unpriced: [] });
    expect(n.outCraftsPerHour).toBe(Infinity);
    // NPC in (26.67/h / 3 per craft), NPC out: the forge (2 slots, 1h) binds
    expect(n.tp).toMatchObject({ limitedBy: 'forge', unitsPerHour: 2, slots: 0 });
    expect(n.profitPerHour).toBeCloseTo(2 * 47, 9);

    const a = by.get('GEAR_A#1')!;
    // 2 items, each listed 1 coin under the 1,000 lowest BIN: 1 % listing fee, no claim tax below 1M
    expect(a).toMatchObject({ outputOffBazaar: true, valueSource: 'ah', cost: 3, unpriced: [] });
    expect(a.value).toBeCloseTo(2 * ahNet(999), 9);
    // no measured sales: AH_SALES.defaultPerHour items/hour, 2 per craft
    expect(a.outCraftsPerHour).toBeCloseTo(AH_SALES.defaultPerHour / 2, 12);
    expect(a.risk.flags).toEqual(['AH_THIN']); // fewer than AH.minCount listings
    expect(a.tp).toMatchObject({ limitedBy: 'ahSales' });
    expect(a.tp.unitsPerHour).toBeCloseTo(AH_SALES.defaultPerHour / 2, 12);
    expect(Number.isFinite(a.profitPerHour)).toBe(true);
    expect(a.plan!.uses).toEqual([
      { key: 'Y:npc', perUnit: 3 },
      { key: 'forge', perUnit: 1 },
    ]);

    const u = by.get('GEAR_U#2')!;
    expect(u).toMatchObject({ outputOffBazaar: true, unpriced: ['GEAR_U'], cost: 0, value: 0, profitPerHour: 0, margin: null });
  });

  it('NPC vs AH: the higher value wins unless a faster venue earns more per hour', () => {
    const both = (price: number) => (id: string): AhPrice | null => (id === 'GEAR_N' ? { price, count: 5 } : null);
    // AH nets more per item but sells 0.25/h; the NPC buys all 2 crafts/h the forge makes
    const slow = rowsBy(computeCrafts({ ...ctx({}, { ah: both(80) }), catalog: cat })).get('GEAR_N#0')!;
    expect(slow).toMatchObject({ valueSource: 'npc', value: 50 });
    // measured sales: 100/h x 5 % share = 5/h, the forge (2/h) binds either way and the AH nets more
    const sales = (id: string): AhSalesStat | null => (id === 'GEAR_N' ? { n: 40, items: 40, median: 90, perHour: 100, coverageHours: 24, last: 0 } : null);
    const hi = rowsBy(computeCrafts({ ...ctx({}, { ah: both(80), ahSales: sales }), catalog: cat })).get('GEAR_N#0')!;
    expect(hi.valueSource).toBe('ah');
    expect(hi.value).toBeCloseTo(ahNet(79), 9);
    expect(hi.outCraftsPerHour).toBeCloseTo(100 * 0.05, 9);
    const lo = rowsBy(computeCrafts({ ...ctx({}, { ah: both(20) }), catalog: cat })).get('GEAR_N#0')!;
    expect(lo).toMatchObject({ valueSource: 'npc', value: 50 });
  });

  it('AH value is after the listing fee and claim tax; Derpy quadruples the claim tax', () => {
    const big = (id: string): AhPrice | null => (id === 'GEAR_A' ? { price: 5_000_000, count: 5 } : null);
    const plain = rowsBy(computeCrafts({ ...ctx({}, { ah: big }), catalog: cat })).get('GEAR_A#1')!;
    expect(plain.value).toBeCloseTo(2 * ahNet(4_999_999), 6);
    expect(ahNet(4_999_999)).toBeCloseTo(4_999_999 * 0.98, 6); // 1 % listing fee + 1 % claim tax
    const derpy = rowsBy(computeCrafts({ ...ctx({}, { ah: big, derpy: true }), catalog: cat })).get('GEAR_A#1')!;
    expect(derpy.value).toBeCloseTo(2 * ahNet(4_999_999, true), 6);
  });

  it('enough AH listings -> no AH flag; no ctx.ah or not auctionable -> unpriced', () => {
    expect(run({}, 5).get('GEAR_A#1')!.risk.flags).toEqual([]);
    const plain = rowsBy(computeCrafts({ ...ctx(), catalog: cat }));
    expect(plain.get('GEAR_A#1')!.unpriced).toEqual(['GEAR_A']);
    const noAuction = buildCatalog(f);
    expect(rowsBy(computeCrafts({ ...ctx({}, { ah: ah(5) }), catalog: noAuction })).get('GEAR_A#1')!.unpriced).toEqual(['GEAR_A']);
  });

  it('NPC daily limit binds without the forge, and npcDailyLimit sets the rate', () => {
    const r = run({ forgeSlots: 100 }).get('GEAR_N#0')!;
    expect(r.lines[0]!.craftsPerHour).toBeCloseTo(640 / 24 / 3, 9);
    expect(r.tp.limitedBy).toBe('npcLimit');
    expect(r.tp.unitsPerHour).toBeCloseTo(640 / 24 / 3, 9);
    const r2 = run({ forgeSlots: 100, npcDailyLimit: 72 }).get('GEAR_N#0')!;
    expect(r2.lines[0]!.craftsPerHour).toBeCloseTo(1, 9);
    expect(r2.tp.unitsPerHour).toBeCloseTo(1, 9);
  });

  it('NPC limit propagates through sub-crafts', () => {
    const g: CatalogFile = {
      ...catalogFile,
      items: { TOP: { n: 'Top', ns: 100 }, MID: { n: 'Mid' }, Y: { n: 'Y', nb: 1 } },
      recipes: [
        { o: 'TOP', c: 1, i: [['MID', 2]], k: 'craft' },
        { o: 'MID', c: 1, i: [['Y', 4]], k: 'craft' },
      ],
    };
    const [r] = computeCrafts({ ...ctx(), catalog: buildCatalog(g) });
    expect(r!.lines[0]).toMatchObject({ source: 'craft', viaRecipe: 'MID#1' });
    expect(r!.inCraftsPerHour).toBeCloseTo(640 / 24 / 8, 9);
    expect(r!.tp.limitedBy).toBe('npcLimit');
  });
});

describe('computeCrafts sources, sale venues and planner inputs', () => {
  // RARE: auctionable, off-bazaar. M: NPC 1 or bazaar (order 2.1). B: bazaar only. OUT: bazaar output, slow offers.
  const items: CatalogFile['items'] = {
    RARE: { n: 'Rare' },
    M: { n: 'Em', bz: 1, nb: 1 },
    B: { n: 'Bee', bz: 1 },
    TOP: { n: 'Top', ns: 100_000 },
    TOPB: { n: 'Top B', bz: 1 },
    SHOPOUT: { n: 'Shop out', bz: 1, ns: 1e9 },
    SUBSHOP: { n: 'Sub shop' },
    TOPS: { n: 'Top S', ns: 10_000 },
    OUT: { n: 'Out', bz: 1, ns: 300 },
  };
  const recipes: CatalogFile['recipes'] = [
    { o: 'TOP', c: 1, i: [['RARE', 2]], k: 'craft' },
    { o: 'TOP', c: 1, i: [['M', 100]], k: 'craft' },
    { o: 'SHOPOUT', c: 2, i: [['B', 3]], k: 'shop' },
    { o: 'SUBSHOP', c: 1, i: [['B', 1]], k: 'shop' },
    { o: 'TOPS', c: 1, i: [['SUBSHOP', 4]], k: 'craft' },
    { o: 'OUT', c: 1, i: [['B', 2]], k: 'craft' },
    { o: 'TOPB', c: 1, i: [['B', 1]], k: 'craft' },
  ];
  const cat = buildCatalog({ ...catalogFile, items, recipes });
  cat.items.RARE!.auctionable = true;
  const lv = (price: number, amount = 1_000_000) => [{ price, amount, orders: 2 }];
  const products = {
    M: makeProduct({ id: 'M', bids: lv(2), asks: lv(3), instaSellsWeek: 168 * 2000 }),
    B: makeProduct({ id: 'B', bids: lv(10), asks: lv(11), instaSellsWeek: 168 * 20_000, instaBuysWeek: 168 * 20_000 }),
    SHOPOUT: makeProduct({ id: 'SHOPOUT', bids: lv(90), asks: lv(100) }),
    OUT: makeProduct({ id: 'OUT', bids: lv(280), asks: lv(320), instaBuysWeek: 168 * 2 }),
    TOPB: makeProduct({ id: 'TOPB', bids: lv(40), asks: lv(45) }),
  };
  const s2 = { ...snap, products };
  const rare: AhPrice = { price: 100, count: 3, next: 120, prices: [100, 120, 200] };
  const base = (over = {}, extra = {}) => ({ ...ctx(over, { ah: (id: string) => (id === 'RARE' ? rare : null), ...extra }), snap: s2, catalog: cat });
  const run = (over = {}, extra = {}) => rowsBy(computeCrafts(base(over, extra)));

  it('AH ingredients: lowest BINs, capped by the AH sales rate, re-quoted at the batch size', () => {
    const r = run().get('TOP#0')!;
    // a batch of 1 craft buys the two cheapest listings
    expect(r.lines[0]).toMatchObject({ id: 'RARE', source: 'ah', unit: 110, leaves: [{ id: 'RARE', qty: 2, unit: 110, source: 'ah' }] });
    expect(r.lines[0]!.craftsPerHour).toBeCloseTo(AH_SALES.defaultPerHour / 2, 12);
    expect(r.tp.limitedBy).toBe('ahSales');
    expect(r.risk.flags).toEqual([]);
    // measured sales: 1000/h x 0.05 share = 50/h -> 25 crafts/h, but the 3 listings seen hold 1.5 crafts per batch; 2 crafts walk all 3
    const sales = (id: string): AhSalesStat | null => (id === 'RARE' ? { n: 60, items: 60, median: 110, perHour: 1000, coverageHours: 10, last: 0 } : null);
    const fast = run({}, { ahSales: sales }).get('TOP#0')!;
    expect(fast.tp).toMatchObject({ limitedBy: 'depth', batchQty: 1.5 });
    expect(fast.lines[0]!.unit).toBeCloseTo((100 + 120 + 200) / 3, 9);
    expect(fast.plan!.segments!.length).toBeGreaterThan(0);
    // thin AH market: AH_THIN on the row
    const thin = rowsBy(computeCrafts({ ...base(), ah: (id: string) => (id === 'RARE' ? { ...rare, count: 1 } : null) })).get('TOP#0')!;
    expect(thin.risk.flags).toContain('AH_THIN');
  });

  it('mixes the NPC (up to its limit) with the bazaar when that earns more per hour', () => {
    const r = run().get('TOP#1')!;
    const npc = baseSettings.npcDailyLimit / 24;
    const bz = (2000 * 0.05) / 1; // M buy order rate: 2000/h insta-sells x share (comp: 2 orders -> min(.05, 1/3))
    const l = r.lines[0]!;
    expect(l.source).toBe('mix');
    const share = npc / (npc + bz);
    expect(l.unit).toBeCloseTo(share * 1 + (1 - share) * 2.1, 9);
    expect(l.leaves!.map((x) => [x.source, x.res])).toEqual([
      ['npc', 'M:npc'],
      ['order', 'M:bid'],
    ]);
    expect(l.craftsPerHour).toBeCloseTo((npc + bz) / 100, 9);
    expect(r.plan!.uses).toEqual([
      { key: 'M:npc', perUnit: 100 * share },
      { key: 'M:bid', perUnit: 100 * (1 - share) },
    ]);
    expect(r.plan!.orderUnits).toEqual([100 * (1 - share)]);
    // NPC only would be cheaper per craft but capped at 26.7/h
    expect(r.cost).toBeGreaterThan(100);
    // a capital limit keeps the cheapest source
    expect(run({ capital: 300, cycleHours: 24 }).get('TOP#1')!.lines[0]!.source).toBe('npc');
  });

  it('shop trades: no NPC buy-back, the shop limit caps the output, sub-trades carry their limit', () => {
    const r = run().get('SHOPOUT#2')!;
    expect(r.valueSource).toBe('bazaar'); // npcSell 1e9 is never used for a shop trade
    expect(r.value).toBeCloseTo(2 * (100 - 0.1) * (1 - 0.0125), 9);
    expect(r.plan!.uses).toEqual(expect.arrayContaining([{ key: 'SHOPOUT:npc', perUnit: 2 }, { key: 'B:bid', perUnit: 3 }, { key: 'SHOPOUT:ask', perUnit: 2 }]));
    const s = run().get('TOPS#4')!;
    expect(s.lines[0]).toMatchObject({ source: 'craft', viaRecipe: 'SUBSHOP#3' });
    // SUBSHOP is bought from the NPC 4 per craft: 26.67 / 4 crafts/h
    expect(s.inCraftsPerHour).toBeCloseTo(baseSettings.npcDailyLimit / 24 / 4, 9);
    expect(s.tp.limitedBy).toBe('npcLimit');
    expect(s.plan!.uses).toEqual(expect.arrayContaining([{ key: 'SUBSHOP:npc', perUnit: 4 }]));
    // an off-bazaar, non-auctionable shop output has no venue left
    const off = buildCatalog({ ...catalogFile, items: { ...items, SHOPOUT: { n: 'x', ns: 1e9 } }, recipes });
    expect(rowsBy(computeCrafts({ ...base(), catalog: off })).get('SHOPOUT#2')!.unpriced).toEqual(['SHOPOUT']);
  });

  it('sells to an NPC instead of the bazaar when the bazaar volume binds and the NPC earns more per hour', () => {
    const r = run().get('OUT#5')!;
    // OUT offers fill 2/h x 5 %; the NPC (300) pays a bit less than the offer (319.9 x 0.9875) but without limit
    expect(r.valueSource).toBe('npc');
    expect(r.value).toBe(300);
    expect(r.outCraftsPerHour).toBe(Infinity);
    // capital binds: the source choice is skipped, the best net (bazaar) stays
    expect(run({ capital: 40, cycleHours: 24 }).get('OUT#5')!.valueSource).toBe('bazaar');
  });

  it('planner inputs: orders of sub-crafts counted, insta rows segmented, unprofitable rows have none', () => {
    const r = run().get('TOPB#6')!;
    expect(r.profit).toBeGreaterThan(0);
    expect(r.plan).toMatchObject({ orderUnits: [1, 1], uses: [{ key: 'B:bid', perUnit: 1 }, { key: 'TOPB:ask', perUnit: 1 }] });
    expect(r.plan!.segments).toBeUndefined();
    const insta = run({ costMode: 'insta', sellMode: 'insta' }).get('TOPB#6')!;
    expect(insta.plan!.orderUnits).toEqual([]);
    expect(insta.plan!.uses).toEqual([
      { key: 'B:ask', perUnit: 1 },
      { key: 'TOPB:bid', perUnit: 1 },
    ]);
    expect(insta.plan!.segments).toHaveLength(4);
    // sub-craft order leaves: ENCHANTED_PAPER from paper from sugar cane by order
    const paper = rowsBy(computeCrafts(ctx())).get('ENCHANTED_PAPER#13')!;
    expect(paper.plan!.orderUnits[0]).toBeCloseTo(64, 9);
    const loss = rowsBy(computeCrafts(ctx())).get('ENCHANTED_COAL#19');
    expect(loss!.plan).toBeUndefined();
  });

  it('conservatism: row cons from the legs and the output', () => {
    const st = () => stats({ n: 50, medianAsk: 12, medianBid: 9 });
    const mk = () => ({ id: 'B', n: 50, change1h: 0, change24h: 0, volatility: 0, spreadMedian: 0, consistency: 1, buyVolTrend: 0.5, sellVolTrend: 0.5, bidMovesPerHour: 2, askMovesPerHour: 2 });
    const r = run({ conservative: true }, { stats: st, market: mk }).get('TOPB#6')!;
    expect(r.cons).toBeDefined();
    expect(r.cons!.rateMul).toBe(0.5);
    expect(r.cons!.churn).toBeGreaterThan(0);
    expect(run().get('TOPB#6')!.cons).toBeUndefined();
  });
});

describe('getPricer and the shared resolver', () => {
  it('one pricer per context; a context on the same core reuses the ingredient memo with its own settings', () => {
    const c = ctx();
    expect(getPricer(c)).toBe(getPricer(c));
    const core = createMarketCore(c);
    const a = { ...c, core };
    const b = { ...c, core, settings: { ...c.settings, capital: 1000 } };
    const ra = getPricer(a).price(catalog.recipes.find((r) => r.key === 'ENCHANTED_MELON#2')!);
    const rb = getPricer(b).price(catalog.recipes.find((r) => r.key === 'ENCHANTED_MELON#2')!);
    expect(rb.lines[0]!.unit).toBe(ra.lines[0]!.unit);
    expect(rb.tp.limitedBy).toBe('capital');
    expect(ra.tp.limitedBy).not.toBe('capital');
  });

  it('cycle-cut results are cached per path: repeated pricing gives the same rows', () => {
    const c = ctx();
    const first = computeCrafts(c);
    const again = computeCrafts(c);
    expect(again.map((r) => [r.recipe.key, r.cost, r.unpriced])).toEqual(first.map((r) => [r.recipe.key, r.cost, r.unpriced]));
    expect(computeCrafts(ctx()).map((r) => r.cost)).toEqual(first.map((r) => r.cost));
  });

  it('a cut result is not reused on a path where its checked ids differ', () => {
    // A <-> B cycle: from TOP, B can be crafted from A; from A's own row, B can't (A is on the path)
    const f: CatalogFile = {
      ...catalogFile,
      items: { TOP: { n: 'Top', ns: 1000 }, A: { n: 'A', ns: 1000 }, B: { n: 'B' }, C: { n: 'C', nb: 1 } },
      recipes: [
        { o: 'TOP', c: 1, i: [['B', 1]], k: 'craft' },
        { o: 'A', c: 1, i: [['B', 1]], k: 'craft' },
        { o: 'B', c: 1, i: [['A', 1]], k: 'craft' },
        { o: 'A', c: 1, i: [['C', 2]], k: 'craft' },
      ],
    };
    const p = createCraftPricer({ ...ctx(), catalog: buildCatalog(f) });
    const cat2 = buildCatalog(f);
    const top = p.price(cat2.recipes[0]!);
    expect(top.lines[0]).toMatchObject({ source: 'craft', unit: 2 }); // B <- A <- 2 C
    const a = p.price(cat2.recipes[1]!);
    expect(a.unpriced).toEqual(['B']); // B needs A, which is on the path
    expect(p.price(cat2.recipes[0]!).lines[0]!.unit).toBe(2);
  });
});

describe('coins as an input', () => {
  it('are paid as they are: no NPC limit, no planner resource', () => {
    const f: CatalogFile = {
      ...catalogFile,
      items: { OUT: { n: 'Out', ns: 2000 }, SKYBLOCK_COIN: { n: 'Coins', nb: 1 }, Y: { n: 'Y', nb: 1 } },
      recipes: [{ o: 'OUT', c: 1, i: [['Y', 1], ['SKYBLOCK_COIN', 1000]], k: 'forge', d: 3600 }],
    };
    const [r] = computeCrafts({ ...ctx(), catalog: buildCatalog(f) });
    expect(r!.cost).toBe(1001);
    expect(r!.lines[1]).toMatchObject({ source: 'npc', unit: 1, craftsPerHour: Infinity });
    expect(r!.tp.limitedBy).toBe('forge');
    expect(r!.plan!.uses.map((u) => u.key)).toEqual(['Y:npc', 'forge']);
  });
});

describe('shared leaves', () => {
  it('a leaf reached through several lines and sub-recipes draws on one market', () => {
    const f: CatalogFile = {
      ...catalogFile,
      items: { TOP: { n: 'Top', ns: 1e6 }, TOP2: { n: 'Top 2', ns: 1e6 }, P: { n: 'P' }, Q1: { n: 'Q1' }, Q2: { n: 'Q2' }, Y: { n: 'Y', nb: 1 }, SA: { n: 'SA' }, PS: { n: 'PS' } },
      recipes: [
        { o: 'TOP', c: 1, i: [['P', 1], ['Q1', 1]], k: 'craft' },
        { o: 'P', c: 1, i: [['Q1', 1], ['Q2', 1]], k: 'craft' },
        { o: 'Q1', c: 1, i: [['Y', 1]], k: 'craft' },
        { o: 'Q2', c: 1, i: [['Y', 2]], k: 'craft' },
        { o: 'SA', c: 1, i: [['Y', 1]], k: 'shop' },
        { o: 'PS', c: 1, i: [['SA', 2]], k: 'craft' },
        { o: 'TOP2', c: 1, i: [['PS', 1], ['SA', 1]], k: 'craft' },
      ],
    };
    const by = rowsBy(computeCrafts({ ...ctx(), catalog: buildCatalog(f) }));
    const r = by.get('TOP#0')!;
    expect(r.lines[0]!.leaves).toEqual([{ id: 'Y', qty: 3, unit: 1, source: 'npc', res: 'Y:npc' }]);
    // 3 Y through P + 1 through Q1 share the NPC limit
    expect(r.inCraftsPerHour).toBeCloseTo(640 / 24 / 4, 9);
    expect(r.plan!.uses).toEqual([{ key: 'Y:npc', perUnit: 4 }]);
    const s = by.get('TOP2#6')!;
    // 3 SA bought from the shop per craft (2 inside PS + 1), 3 Y paid for them
    expect(s.plan!.uses).toEqual([
      { key: 'Y:npc', perUnit: 3 },
      { key: 'SA:npc', perUnit: 3 },
    ]);
    expect(s.inCraftsPerHour).toBeCloseTo(640 / 24 / 3, 9);
  });
});
