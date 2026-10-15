import { describe, expect, it } from 'vitest';
import { MAX_ORDER_UNITS } from '../../src/config.ts';
import { computeCrafts } from '../../src/domain/craft.ts';
import { buyQuote } from '../../src/domain/pricing.ts';
import { assessRisk } from '../../src/domain/risk.ts';
import type { AhPrice, CatalogFile, CraftRow } from '../../src/types/contracts.ts';
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
    const l = by.get('ENCHANTED_GOLD_BLOCK#1')!.lines[0]!;
    // sub-craft would be 160 gold ingots x max(0.2, 0.9 x NPC 3) = 432 < enchanted gold buy order 456.0
    expect(l.source).toBe('craft');
    expect(l.viaRecipe).toBe('ENCHANTED_GOLD#0');
    expect(l.unit).toBeCloseTo(432, 9);
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

  it('forge sub-recipes are not used for sub-crafting; zero-count recipes are skipped', () => {
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
    expect(r!.unpriced).toEqual(['X']);
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
    // 2 items, each listed at the 1,000 lowest BIN: 1 % listing fee, no claim tax below 1M
    expect(a).toMatchObject({ outputOffBazaar: true, valueSource: 'ah', value: 2 * 990, cost: 3, unpriced: [] });
    expect(a.outCraftsPerHour).toBe(Infinity);
    expect(a.risk.flags).toEqual(['AH_THIN']); // fewer than AH.minCount listings
    expect(a.tp.unitsPerHour).toBe(2);

    const u = by.get('GEAR_U#2')!;
    expect(u).toMatchObject({ outputOffBazaar: true, unpriced: ['GEAR_U'], cost: 0, value: 0, profitPerHour: 0, margin: null });
  });

  it('NPC vs AH: the higher value wins', () => {
    const both = (price: number) => (id: string): AhPrice | null => (id === 'GEAR_N' ? { price, count: 5 } : null);
    const hi = rowsBy(computeCrafts({ ...ctx({}, { ah: both(80) }), catalog: cat })).get('GEAR_N#0')!;
    expect(hi.valueSource).toBe('ah');
    expect(hi.value).toBeCloseTo(80 * 0.99, 9);
    const lo = rowsBy(computeCrafts({ ...ctx({}, { ah: both(20) }), catalog: cat })).get('GEAR_N#0')!;
    expect(lo).toMatchObject({ valueSource: 'npc', value: 50 });
  });

  it('AH value is after the listing fee and claim tax; Derpy quadruples the claim tax', () => {
    const big = (id: string): AhPrice | null => (id === 'GEAR_A' ? { price: 5_000_000, count: 5 } : null);
    const plain = rowsBy(computeCrafts({ ...ctx({}, { ah: big }), catalog: cat })).get('GEAR_A#1')!;
    expect(plain.value).toBeCloseTo(2 * (5_000_000 - 50_000 - 50_000), 6);
    const derpy = rowsBy(computeCrafts({ ...ctx({}, { ah: big, derpy: true }), catalog: cat })).get('GEAR_A#1')!;
    expect(derpy.value).toBeCloseTo(2 * (5_000_000 - 50_000 - 200_000), 6);
  });

  it('enough AH listings -> no AH flag; no ctx.ah -> unpriced', () => {
    expect(run({}, 5).get('GEAR_A#1')!.risk.flags).toEqual([]);
    const plain = rowsBy(computeCrafts({ ...ctx(), catalog: cat }));
    expect(plain.get('GEAR_A#1')!.unpriced).toEqual(['GEAR_A']);
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
