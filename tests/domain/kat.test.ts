import { describe, expect, it } from 'vitest';
import { KAT } from '../../src/config.ts';
import {
  computeKatFlips,
  expForLevel,
  katCoins,
  KAT_TRADE_HOURS,
  levelFromExp,
  petCurve,
  planSkip,
  type KatOptions,
  type KatRow,
} from '../../src/domain/kat.ts';
import { ahNet } from '../../src/domain/pricing.ts';
import type { AhPrice, CalcCtx, Catalog, KatStep, PetLeveling, Product } from '../../src/types/contracts.ts';
import { baseSettings, buildCatalog, catalogFile, makeProduct, snap } from './helpers.ts';

// XP to the next level grows by 100 per level, so higher rarities (later offsets) need more XP per level.
const LEVELING: PetLeveling = {
  offsets: { COMMON: 0, UNCOMMON: 6, RARE: 11, EPIC: 16, LEGENDARY: 20, MYTHIC: 20 },
  levels: Array.from({ length: 119 }, (_, i) => (i + 1) * 100),
  custom: {
    GOLDEN_DRAGON: { levels: Array.from({ length: 100 }, () => 5_000), maxLevel: 200, append: true },
    TINY: { levels: [10, 10, 10, 10], maxLevel: 5 },
  },
};

const step = (pet: string, from: number, coins: number, hours: number, items: [string, number][] = []): KatStep => ({
  pet,
  from,
  to: from + 1,
  coins,
  hours,
  items: items.map(([id, qty]) => ({ id, qty })),
});

/** bazaar product you insta-buy at `price` */
const bz = (id: string, price: number): Product =>
  makeProduct({
    id,
    asks: [{ price, amount: 1_000_000, orders: 5 }],
    bids: [{ price: price * 0.9, amount: 1_000_000, orders: 5 }],
  });

interface Setup {
  kat: KatStep[];
  ah: Record<string, AhPrice>;
  products?: Product[];
  leveling?: PetLeveling | null;
  petNames?: Record<string, string>;
  derpy?: boolean;
}

function setup(s: Setup): CalcCtx {
  const catalog: Catalog = {
    ...buildCatalog({ ...catalogFile, items: { FISH: { n: 'Raw Fish', bz: 1 } }, recipes: [] }),
    kat: s.kat,
    petLeveling: s.leveling === undefined ? LEVELING : s.leveling,
    petNames: s.petNames ?? {},
  };
  const products: Record<string, Product> = {};
  for (const p of s.products ?? []) products[p.id] = p;
  return {
    snap: { ...snap, products },
    catalog,
    settings: { ...baseSettings, costMode: 'insta' },
    ah: (id) => s.ah[id] ?? null,
    ...(s.derpy ? { derpy: true } : {}),
  };
}

const run = (s: Setup, o?: KatOptions) => computeKatFlips(setup(s), o);
const byKey = (rows: KatRow[], key: string) => {
  const r = rows.find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key}: ${rows.map((x) => x.key).join(', ')}`);
  return r;
};

const curve = (pet: string, r: number) => petCurve(LEVELING, pet, r)!;
const EPIC_MAX_XP = expForLevel(curve('OCELOT', 3), 100);

describe('pet levels', () => {
  it('curves start at the rarity offset and stop at the max level', () => {
    expect(petCurve(null, 'OCELOT', 0)).toBeNull();
    expect(petCurve(LEVELING, 'OCELOT', 9)).toBeNull();
    expect(petCurve({ ...LEVELING, offsets: {} }, 'OCELOT', 0)).toBeNull();
    const c = curve('OCELOT', 4);
    expect(c.max).toBe(100);
    expect(c.table).toHaveLength(99);
    expect(c.table[0]).toBe(2_100);
  });

  it('level from XP and XP for a level round-trip', () => {
    const c = curve('OCELOT', 0);
    expect(levelFromExp(c, 0)).toBe(1);
    expect(levelFromExp(c, 99)).toBe(1);
    expect(levelFromExp(c, 100)).toBe(2);
    expect(levelFromExp(c, 299)).toBe(2);
    expect(levelFromExp(c, 1e12)).toBe(100);
    expect(levelFromExp(c, expForLevel(c, 37))).toBe(37);
    expect(expForLevel(c, 1)).toBe(0);
    expect(expForLevel(c, 500)).toBe(expForLevel(c, 100));
  });

  it('an appended custom table goes past 100; a replacing one stops at its max level', () => {
    const g = curve('GOLDEN_DRAGON', 4);
    expect(g.max).toBe(200);
    expect(g.table).toHaveLength(199);
    expect(g.table[99]).toBe(5_000);
    expect(levelFromExp(g, 1e12)).toBe(200);
    expect(levelFromExp(g, expForLevel(g, 100) + 5_000)).toBe(101);
    const t = curve('TINY', 0);
    expect(t.table).toEqual([10, 10, 10, 10]);
    expect(levelFromExp(t, 1e9)).toBe(5);
    expect(levelFromExp(t, 25)).toBe(3);
  });

  it('Kat coins drop by the level discount and never go negative', () => {
    expect(katCoins(1_000_000, 0)).toBe(1_000_000);
    expect(katCoins(1_000_000, 100)).toBeCloseTo(700_000, 6);
    expect(katCoins(1_000, 1_000)).toBe(0);
  });
});

describe('skipping the wait', () => {
  const F = KAT.flowerHours;
  const B = KAT.bouquetHours;
  it('under one flower-length there is nothing to skip', () => {
    expect(planSkip(F - 1, 10, 30)).toEqual({ items: [], cost: 0, hours: F - 1 });
    expect(planSkip(5 * F, null, null)).toEqual({ items: [], cost: 0, hours: 5 * F });
  });

  it('flowers skip every full day and leave the rest', () => {
    expect(planSkip(2 * F + 3, 10, null)).toEqual({ items: [{ id: KAT.flowerId, qty: 2 }], cost: 20, hours: 3 });
  });

  it('bouquets when cheaper per hour, flowers for the remainder', () => {
    expect(planSkip(B + 2 * F + 1, 10, 30)).toEqual({
      items: [
        { id: KAT.bouquetId, qty: 1 },
        { id: KAT.flowerId, qty: 2 },
      ],
      cost: 50,
      hours: 1,
    });
    // dear bouquets: flowers only
    expect(planSkip(B, 10, 100).items).toEqual([{ id: KAT.flowerId, qty: 5 }]);
  });

  it('a bouquet past the end finishes the wait when that is cheapest', () => {
    expect(planSkip(3 * F + 5, 10, 25)).toEqual({ items: [{ id: KAT.bouquetId, qty: 1 }], cost: 25, hours: 0 });
    // bouquet only on sale
    expect(planSkip(2 * B, null, 40)).toEqual({ items: [{ id: KAT.bouquetId, qty: 2 }], cost: 80, hours: 0 });
    // equal cost: fewer hours left wins
    expect(planSkip(4 * F + 2, 10, 40)).toEqual({ items: [{ id: KAT.bouquetId, qty: 1 }], cost: 40, hours: 0 });
  });
});

describe('computeKatFlips', () => {
  // OCELOT: common -> uncommon -> rare, then a gap, epic -> legendary -> mythic
  const KAT_STEPS = [
    step('OCELOT', 0, 10_000, 1, [['FISH', 2]]),
    step('OCELOT', 1, 50_000, 24),
    step('OCELOT', 3, 1_000_000, 130),
    step('OCELOT', 4, 2_000_000, 10, [['PET_ITEM_X', 1]]),
  ];
  const AH_ROWS: Record<string, AhPrice> = {
    'OCELOT;0': { price: 1_000, count: 10, exp: 0, uuid: 'u0', name: '[Lvl 1] Ocelot' },
    'OCELOT;1': { price: 100_000, count: 10, exp: 0 },
    'OCELOT;2': { price: 500_000, count: 10 },
    'OCELOT;3@MAX': { price: 3_000_000, count: 5, exp: EPIC_MAX_XP, name: '[Lvl 100] Ocelot' },
    'OCELOT;4': { price: 6_000_000, count: 10 },
    'OCELOT;4@MAX': { price: 9_000_000, count: 10 },
    'OCELOT;5': { price: 12_000_000, count: 10 },
    'OCELOT;5@MAX': { price: 20_000_000, count: 10 },
    PET_ITEM_X: { price: 100_000, count: 4 },
  };
  const base: Setup = { kat: KAT_STEPS, ah: AH_ROWS, products: [bz('FISH', 50)] };

  it('needs an AH scan', () => {
    expect(computeKatFlips({ ...setup(base), ah: undefined })).toEqual([]);
  });

  it('chains consecutive steps of a pet, per band with a buy price', () => {
    const keys = run(base).map((r) => r.key);
    expect(keys.sort()).toEqual(
      ['OCELOT;0>1:any', 'OCELOT;0>2:any', 'OCELOT;1>2:any', 'OCELOT;3>4:max', 'OCELOT;3>5:max', 'OCELOT;4>5:any', 'OCELOT;4>5:max'].sort(),
    );
    const r = byKey(run(base), 'OCELOT;0>2:any');
    expect(r.steps.map((s) => [s.from, s.to])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(r.coins).toBeCloseTo(10_000 * (1 - KAT.levelDiscount) + 50_000 * (1 - KAT.levelDiscount), 6);
    expect(r.itemsCost).toBe(100);
    expect(r.baseHours).toBe(25);
    expect(r.katHours).toBe(25);
    expect(r.hours).toBe(25 + KAT_TRADE_HOURS);
    expect(r.id).toBe('OCELOT;0');
    expect(r.uuid).toBe('u0');
    expect(r.listingName).toBe('[Lvl 1] Ocelot');
  });

  it('ignores steps that skip a rarity and repeated steps', () => {
    const rows = run({ ...base, kat: [...KAT_STEPS, { ...step('OCELOT', 0, 1, 1), to: 2 }, step('OCELOT', 0, 999_999, 1)] });
    expect(byKey(rows, 'OCELOT;0>1:any').steps[0]!.baseCoins).toBe(10_000);
    expect(rows.filter((r) => r.key === 'OCELOT;0>2:any')).toHaveLength(1);
  });

  it('a level 100 Epic comes out a lower-level Legendary and is sold at the any-level price', () => {
    const r = byKey(run(base), 'OCELOT;3>4:max');
    expect(r.levelStart).toBe(100);
    expect(r.levelEnd).toBe(96);
    expect(r.levelKnown).toBe(true);
    expect(r.steps[0]).toMatchObject({ levelBefore: 100, levelAfter: 96, baseCoins: 1_000_000 });
    expect(r.coins).toBeCloseTo(700_000, 6);
    expect(r.sellKey).toBe('OCELOT;4');
    expect(r.sell).toBe(6_000_000);
    expect(r.sellNet).toBe(ahNet(6_000_000));
    expect(r.risk.flags).toContain('AH_VARIANT');
    expect(r.profit).toBeCloseTo(ahNet(6_000_000) - 3_000_000 - 700_000, 6);
    expect(r.margin).toBeCloseTo(r.profit / r.capital, 9);
    expect(r.capital).toBeCloseTo(3_700_000, 6);
  });

  it('legendary -> mythic keeps the level: a max pet sells at the max-level price', () => {
    const r = byKey(run(base), 'OCELOT;4>5:max');
    expect(r.levelStart).toBe(100);
    expect(r.levelEnd).toBe(100);
    expect(r.coins).toBeCloseTo(1_400_000, 6);
    expect(r.sellKey).toBe('OCELOT;5@MAX');
    expect(r.sell).toBe(20_000_000);
    expect(r.risk.flags).not.toContain('AH_VARIANT');
    // the 96 Legendary from the Epic chain goes on at that level
    const chain = byKey(run(base), 'OCELOT;3>5:max');
    expect(chain.steps[1]).toMatchObject({ levelBefore: 96, levelAfter: 96 });
    expect(chain.sellKey).toBe('OCELOT;5');
  });

  it('a max-band listing without XP is taken as max level', () => {
    const ah = { ...AH_ROWS, 'OCELOT;3@MAX': { price: 3_000_000, count: 5 } };
    expect(byKey(run({ ...base, ah }), 'OCELOT;3>4:max').levelStart).toBe(100);
    const any = byKey(run({ ...base, ah: { ...AH_ROWS, 'OCELOT;4': { price: 6_000_000, count: 10 } } }), 'OCELOT;4>5:any');
    expect(any.levelStart).toBe(1);
  });

  it('prices step items on the bazaar, else at the AH lowest BIN; unpriced items keep the row', () => {
    const r = byKey(run(base), 'OCELOT;4>5:any');
    expect(r.steps[0]!.items).toEqual([{ id: 'PET_ITEM_X', name: 'Pet Item X', qty: 1, unit: 100_000, total: 100_000, source: 'ah' }]);
    expect(byKey(run(base), 'OCELOT;0>1:any').steps[0]!.items[0]).toMatchObject({ id: 'FISH', name: 'Raw Fish', unit: 50, source: 'insta' });
    const ah = { ...AH_ROWS };
    delete ah.PET_ITEM_X;
    const u = byKey(run({ ...base, ah }), 'OCELOT;4>5:any');
    expect(u.unpriced).toEqual(['PET_ITEM_X']);
    expect(u.profit).toBe(0);
    expect(u.margin).toBe(0);
    expect(u.steps[0]!.items[0]!.source).toBeNull();
  });

  it('no sell price: unpriced', () => {
    const ah = { ...AH_ROWS };
    delete ah['OCELOT;2'];
    const r = byKey(run({ ...base, ah }), 'OCELOT;1>2:any');
    expect(r.unpriced).toEqual(['OCELOT;2']);
    expect(r.sell).toBe(0);
    expect(r.sellCount).toBe(0);
    expect(r.profit).toBe(0);
  });

  it('taming drops rows whose target rarity needs a higher level', () => {
    const keys = (taming: number) => run(base, { taming }).map((r) => r.key);
    expect(keys(60)).toHaveLength(7);
    expect(keys(KAT.tamingReq[5]! - 1)).not.toContain('OCELOT;4>5:any');
    expect(keys(KAT.tamingReq[5]! - 1)).toContain('OCELOT;3>4:max');
    expect(keys(KAT.tamingReq[2]! - 1).sort()).toEqual(['OCELOT;0>1:any']);
    expect(keys(0)).toEqual([]);
  });

  it('the skip option buys flowers per step and shortens the wait', () => {
    const products = [bz('FISH', 50), bz(KAT.flowerId, 1_000), bz(KAT.bouquetId, 4_000)];
    const r = byKey(run({ ...base, products }, { skip: 'flowers' }), 'OCELOT;3>4:max');
    // 130h = 5 days + 10h: one bouquet (cheaper than 5 flowers), the 10h stay
    expect(r.steps[0]!.skip.map((l) => [l.id, l.qty, l.unit])).toEqual([[KAT.bouquetId, 1, 4_000]]);
    expect(r.skipCost).toBe(4_000);
    expect(r.katHours).toBe(10);
    expect(r.baseHours).toBe(130);
    expect(r.upgradeCost).toBeCloseTo(r.coins + r.itemsCost + 4_000, 6);
    // per step: the 24h step takes one flower, the 1h step nothing
    const c = byKey(run({ ...base, products }, { skip: 'flowers' }), 'OCELOT;0>2:any');
    expect(c.steps.map((s) => s.skip.length)).toEqual([0, 1]);
    expect(c.katHours).toBe(1);
    // nothing to buy them with: the wait stays
    const none = byKey(run(base, { skip: 'flowers' }), 'OCELOT;3>4:max');
    expect(none.katHours).toBe(130);
    expect(none.skipCost).toBe(0);
    // flowers only on the AH
    const ahFlower = byKey(run({ ...base, ah: { ...AH_ROWS, [KAT.flowerId]: { price: 2_000, count: 9 } } }, { skip: 'flowers' }), 'OCELOT;1>2:any');
    expect(ahFlower.steps[0]!.skip[0]).toMatchObject({ id: KAT.flowerId, source: 'ah', unit: 2_000 });
  });

  it('throughput: one pet at Kat at a time', () => {
    const r = byKey(run(base), 'OCELOT;3>4:max');
    expect(r.tp).toEqual({
      unitsPerHour: 1 / (130 + KAT_TRADE_HOURS),
      batchQty: 1,
      capitalUsed: r.capital,
      fillHours: 130 + KAT_TRADE_HOURS,
      limitedBy: 'kat',
      buyHours: 0,
      sellHours: KAT_TRADE_HOURS,
      slots: 0,
    });
    expect(r.profitPerHour).toBeCloseTo(r.profit / r.hours, 9);
  });

  it('flags thin markets and a big gap to the next BIN', () => {
    const ah = { ...AH_ROWS, 'OCELOT;1': { price: 100_000, next: 400_000, count: 10 }, 'OCELOT;2': { price: 500_000, count: 2 } };
    const r = byKey(run({ ...base, ah }), 'OCELOT;1>2:any');
    expect(r.risk.flags).toEqual(['AH_THIN', 'AH_GAP', 'AH_VARIANT']);
    expect(r.risk.level).toBe('suspect');
    const thinBuy = byKey(run({ ...base, ah: { ...AH_ROWS, 'OCELOT;1': { price: 100_000, next: 110_000, count: 1 } } }), 'OCELOT;1>2:any');
    expect(thinBuy.risk.flags).toEqual(['AH_THIN', 'AH_VARIANT']);
    expect(byKey(run(base), 'OCELOT;4>5:max').risk.flags).toEqual([]);
  });

  it('without an XP table the level is a guess by band and the row is flagged', () => {
    const rows = run({ ...base, leveling: null });
    const max = byKey(rows, 'OCELOT;4>5:max');
    expect(max).toMatchObject({ levelStart: 100, levelEnd: 100, levelKnown: false, sellKey: 'OCELOT;5@MAX' });
    expect(max.risk.flags).toContain('AH_VARIANT');
    expect(byKey(rows, 'OCELOT;0>1:any')).toMatchObject({ levelStart: 1, levelKnown: false });
    // a rarity missing from the offsets mid-chain: level carried over, flagged
    const noMythic = run({ ...base, leveling: { ...LEVELING, offsets: { ...LEVELING.offsets, MYTHIC: undefined as unknown as number } } });
    const m = byKey(noMythic, 'OCELOT;4>5:max');
    expect(m).toMatchObject({ levelEnd: 100, levelKnown: false });
  });

  it('Derpy quadruples the claim tax on the sale', () => {
    const r = byKey(run({ ...base, derpy: true }), 'OCELOT;4>5:max');
    expect(r.sellNet).toBe(ahNet(20_000_000, true));
    expect(r.sellNet).toBeLessThan(ahNet(20_000_000));
  });

  it('names come from the catalog, else from the listing', () => {
    expect(byKey(run({ ...base, petNames: { OCELOT: 'Ocelot Cat' } }), 'OCELOT;0>1:any').name).toBe('Ocelot Cat');
    expect(byKey(run(base), 'OCELOT;0>1:any').name).toBe('Ocelot');
    expect(byKey(run(base), 'OCELOT;1>2:any').name).toBe('Ocelot');
  });

  it('Golden Dragon sells at the max-level price only at level 200', () => {
    const kat = [step('GOLDEN_DRAGON', 3, 1_000, 1)];
    const g = (r: number) => curve('GOLDEN_DRAGON', r);
    const ah = {
      'GOLDEN_DRAGON;3': { price: 1_000, count: 5, exp: expForLevel(g(3), 200) },
      'GOLDEN_DRAGON;4': { price: 2_000_000, count: 5 },
      'GOLDEN_DRAGON;4@MAX': { price: 9_000_000, count: 5 },
    };
    const r = byKey(run({ kat, ah }), 'GOLDEN_DRAGON;3>4:any');
    expect(r.maxLevel).toBe(200);
    expect(r.levelEnd).toBeLessThan(200);
    expect(r.sellKey).toBe('GOLDEN_DRAGON;4');
    const top = byKey(run({ kat, ah: { ...ah, 'GOLDEN_DRAGON;3': { price: 1_000, count: 5, exp: 1e12 } } }), 'GOLDEN_DRAGON;3>4:any');
    expect(top.levelEnd).toBe(200);
    expect(top.sellKey).toBe('GOLDEN_DRAGON;4@MAX');
  });

  it('is deterministic', () => {
    expect(run(base)).toEqual(run(base));
  });
});
