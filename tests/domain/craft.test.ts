import { NPC_BUY_RATE_PER_HOUR } from '../../src/config.ts';
import { describe, expect, it } from 'vitest';
import { computeCrafts } from '../../src/domain/craft.ts';
import type { CatalogFile, CraftRow } from '../../src/types/contracts.ts';
import { buildCatalog, catalogFile, ctx, makeProduct, snap, stats } from './helpers.ts';

const rowsBy = (rows: CraftRow[]) => new Map(rows.map((r) => [r.recipe.key, r]));

describe('computeCrafts (order/offer)', () => {
  const rows = computeCrafts(ctx());
  const by = rowsBy(rows);

  it('only recipes with bazaar outputs', () => {
    expect(rows.every((r) => r.recipe.output !== 'PAPER' && !r.id.startsWith('CYCLE_'))).toBe(true);
    expect(by.has('PAPER#12')).toBe(false);
    expect(by.has('CYCLE_A#17')).toBe(false);
    expect(rows).toHaveLength(17);
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
    expect(r.lines[0]!.craftsPerHour).toBeCloseTo(NPC_BUY_RATE_PER_HOUR / 59, 9);
    expect(r.lines[1]!.craftsPerHour).toBeCloseTo(NPC_BUY_RATE_PER_HOUR / 1, 9);
    expect(r.lines[0]!.bottleneck).toBe(true);
    expect(r.inCraftsPerHour).toBeCloseTo(NPC_BUY_RATE_PER_HOUR / 59, 9);
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
    expect(r.lines[0]!.craftsPerHour).toBeCloseTo(NPC_BUY_RATE_PER_HOUR / 160, 9);
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
