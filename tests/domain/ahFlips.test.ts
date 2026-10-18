import { describe, expect, it } from 'vitest';
import { AH_SALES } from '../../src/config.ts';
import { computeAhFlips, computeGeorgeFlips, isPetLevelKey, isPetMaxKey, petName } from '../../src/domain/ahFlips.ts';
import { ahListingFee, ahNet } from '../../src/domain/pricing.ts';
import type { AhPrice, AhSalesStat, AhSnapshot, CatalogFile } from '../../src/types/contracts.ts';
import { catalogFromFile } from '../../src/data/catalog.ts';

const cat = catalogFromFile({
  v: 2,
  generatedAt: '',
  items: { GOOD: { n: 'Good Thing' }, SWORDY: { n: 'Swordy', c: 'SWORD' }, FEW: { n: 'Few' } },
  recipes: [],
} as CatalogFile);
const snap = (bins: Record<string, AhPrice>): AhSnapshot => ({ v: 2, fetchedAt: 0, lastUpdated: 0, lowestBin: bins });
const by = (rows: ReturnType<typeof computeAhFlips>) => new Map(rows.map((r) => [r.id, r]));

describe('computeAhFlips', () => {
  const rows = by(
    computeAhFlips(
      snap({
        GOOD: { price: 1_000_000, next: 1_500_000, count: 5, uuid: 'u1', name: 'Good Thing' },
        SWORDY: { price: 10_000_000, next: 12_000_000, count: 4 },
        FEW: { price: 100, next: 1_000, count: 2 }, // under AH_FLIP.minCount
        TIGHT: { price: 1_000, next: 1_005, count: 9 }, // fee eats the gap
        OLD: { price: 5, count: 9 }, // scan v1 entry: no next price
        'ENDER_DRAGON;4': { price: 500_000_000, next: 2_000_000_000, count: 6, name: '[Lvl 1] Ender Dragon' },
      }),
      cat,
    ),
  );

  it('profit = ahNet(next − 1) − lowest; unprofitable, thin and old entries are left out', () => {
    expect([...rows.keys()].sort()).toEqual(['ENDER_DRAGON;4', 'GOOD', 'SWORDY']);
    const g = rows.get('GOOD')!;
    expect(g).toMatchObject({ name: 'Good Thing', buy: 1_000_000, next: 1_500_000, sellAt: 1_499_999, count: 5, uuid: 'u1', pet: false });
    expect(g.profit).toBeCloseTo(ahNet(1_499_999) - 1_000_000, 6);
    expect(g.listingFee + g.claimTax).toBeCloseTo(1_499_999 - ahNet(1_499_999), 6);
    expect(g.margin).toBeCloseTo(g.profit / 1_000_000, 9);
    expect(g.risk.level).toBe('ok');
  });

  it('variants and big gaps are flagged; pets are named from the listing with their rarity', () => {
    expect(rows.get('SWORDY')!.risk.flags).toEqual(['AH_VARIANT']);
    const pet = rows.get('ENDER_DRAGON;4')!;
    expect(pet).toMatchObject({ name: 'Ender Dragon (Legendary)', pet: true });
    expect(pet.risk.flags).toEqual(['AH_GAP', 'AH_VARIANT']);
  });

  it('Derpy quadruples the claim tax', () => {
    const plain = computeAhFlips(snap({ GOOD: { price: 1_000_000, next: 1_500_000, count: 5 } }), cat)[0]!;
    const derpy = computeAhFlips(snap({ GOOD: { price: 1_000_000, next: 1_500_000, count: 5 } }), cat, { derpy: true })[0]!;
    expect(derpy.claimTax).toBeCloseTo(4 * plain.claimTax, 6);
    expect(derpy.profit).toBeLessThan(plain.profit);
  });
});

describe('computeAhFlips: scan v4', () => {
  const stat = (o: Partial<AhSalesStat> = {}): AhSalesStat => ({ n: 6, items: 6, median: 1_200_000, perHour: 2, coverageHours: 5, last: 0, ...o });

  it('max-level pet keys are flipped without AH_VARIANT; level bands are skipped', () => {
    const rows = by(
      computeAhFlips(
        snap({
          'BLACK_CAT;4@MAX': { price: 10_000_000, next: 12_000_000, count: 4, name: '[Lvl 100] Black Cat' },
          'BLACK_CAT;4@L49': { price: 1_000_000, next: 5_000_000, count: 4 },
          'BLACK_CAT;4': { price: 1_000_000, next: 1_200_000, count: 8 },
        }),
        cat,
      ),
    );
    expect([...rows.keys()].sort()).toEqual(['BLACK_CAT;4', 'BLACK_CAT;4@MAX']);
    const max = rows.get('BLACK_CAT;4@MAX')!;
    expect(max).toMatchObject({ key: 'ah:BLACK_CAT;4@MAX', venue: 'ah', maxLevel: true, pet: true, name: 'Black Cat (Legendary)' });
    expect(max.risk.flags).toEqual([]);
    expect(rows.get('BLACK_CAT;4')!.risk.flags).toEqual(['AH_VARIANT']);
    expect(rows.get('BLACK_CAT;4')!.maxLevel).toBe(false);
  });

  it('a stack is bought whole: per-item prices, fees taken on the relisted stack', () => {
    const r = computeAhFlips(snap({ GOOD: { price: 100_000, next: 200_001, count: 5, stack: 64, prices: [100_000, 200_001] } }), cat)[0]!;
    expect(r.stack).toBe(64);
    expect(r.sellAt).toBe(200_000);
    // 64 x 200k = 12.8M: the 2 % listing tier and the claim tax apply to the stack
    expect(r.listingFee).toBeCloseTo(ahListingFee(12_800_000) / 64, 6);
    expect(r.profit).toBeCloseTo(ahNet(12_800_000) / 64 - 100_000, 6);
    expect(r.listingFee + r.claimTax).toBeCloseTo(200_000 - ahNet(12_800_000) / 64, 6);
    expect(r.sellHours).toBeCloseTo(64 / AH_SALES.defaultPerHour, 9);
    expect(r.plan).toEqual({ unitCost: 100_000, buyCost: 100_000, profitPerUnit: r.profit, unitsPerHour: AH_SALES.defaultPerHour, maxUnits: 64, orderUnits: [], uses: [] });
  });

  it('sell hours from measured AH sales; conservatism relists at no more than the median sold', () => {
    const ah = snap({ GOOD: { price: 1_000_000, next: 1_500_000, count: 5 } });
    const sales = (s: AhSalesStat | null) => () => s;
    const plain = computeAhFlips(ah, cat)[0]!;
    expect(plain).toMatchObject({ sellHours: 1 / AH_SALES.defaultPerHour, salesPerHour: null, units: 1 });
    expect(plain.profitPerHour).toBeCloseTo(plain.profit * AH_SALES.defaultPerHour, 6);
    const fed = computeAhFlips(ah, cat, { sales: sales(stat()) })[0]!;
    expect(fed).toMatchObject({ sellHours: 0.5, salesPerHour: 2, sellAt: 1_499_999 });
    expect(fed.plan.unitsPerHour).toBe(2);
    const cons = computeAhFlips(ah, cat, { sales: sales(stat()), conservative: true })[0]!;
    expect(cons).toMatchObject({ sellAt: 1_200_000, sellRef: 1_499_999 });
    expect(cons.profit).toBeCloseTo(ahNet(1_200_000) - 1_000_000, 6);
    // the median at or under the buy price: no flip
    expect(computeAhFlips(ah, cat, { sales: sales(stat({ median: 990_000 })), conservative: true })).toEqual([]);
    // too few sales, too little coverage, no rate yet
    expect(computeAhFlips(ah, cat, { sales: sales(stat({ n: 2 })), conservative: true })[0]!.sellAt).toBe(1_499_999);
    expect(computeAhFlips(ah, cat, { sales: sales(stat({ coverageHours: 1 })), conservative: true })[0]).toMatchObject({ sellAt: 1_499_999, salesPerHour: null });
    expect(computeAhFlips(ah, cat, { sales: sales(stat({ perHour: null })) })[0]!.sellHours).toBe(1 / AH_SALES.defaultPerHour);
  });

  it('level keys', () => {
    expect(isPetMaxKey('A;1@MAX')).toBe(true);
    expect(isPetLevelKey('A;1@MAX')).toBe(true);
    expect(isPetLevelKey('A;1@L89')).toBe(true);
    expect(isPetLevelKey('A;1')).toBe(false);
    expect(isPetMaxKey('A;1@L89')).toBe(false);
  });
});

describe('computeGeorgeFlips', () => {
  const gcat = { ...cat, george: { 'BEE;0': 100, 'BEE;1': 500, 'TIGER;4': 2_000_000, 'NONE;1': 9 } };

  it('pets listed under George: profit George − buy, no fees, sold at once; every kept listing below him', () => {
    const rows = computeGeorgeFlips(
      snap({
        'BEE;0': { price: 150, count: 9 },
        'BEE;1': { price: 200, next: 300, count: 9, prices: [200, 300, 450, 600], uuid: 'b1', name: '[Lvl 3] Bee' },
        'TIGER;4': { price: 1_500_000, next: 1_900_000, count: 3 },
      }),
      gcat,
      { cycleHours: 2 },
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['BEE;1', 'TIGER;4']);
    const bee = rows.find((r) => r.id === 'BEE;1')!;
    expect(bee).toMatchObject({
      key: 'george:BEE;1',
      venue: 'george',
      name: 'Bee (Uncommon)',
      buy: 200,
      next: 500,
      sellAt: 500,
      listingFee: 0,
      claimTax: 0,
      profit: 300,
      margin: 1.5,
      units: 3,
      sellHours: 0,
      uuid: 'b1',
      listingName: '[Lvl 3] Bee',
      pet: true,
    });
    expect(bee.risk.level).toBe('ok');
    expect(bee.plan.segments).toEqual([
      { upTo: 1, profitPerUnit: 300 },
      { upTo: 2, profitPerUnit: 200 },
      { upTo: 3, profitPerUnit: 50 },
    ]);
    expect(bee.plan).toMatchObject({ maxUnits: 3, unitsPerHour: 1.5, buyCost: 950 / 3, unitCost: 950 / 3, profitPerUnit: 500 - 950 / 3 });
    expect(bee.profitPerHour).toBeCloseTo((3 * 500 - 950) / 2, 9);
    // older scans: lowest and second-lowest
    const tiger = rows.find((r) => r.id === 'TIGER;4')!;
    expect(tiger.units).toBe(2);
    expect(computeGeorgeFlips(snap({ 'BEE;1': { price: 200, count: 1 } }), gcat)[0]).toMatchObject({ units: 1, profitPerHour: 300 });
    expect(computeGeorgeFlips(snap({ 'BEE;1': { price: 200, count: 1 } }), gcat)[0]!.plan.segments).toBeUndefined();
  });

  it('no George price, no listing, or no profit: no row', () => {
    expect(computeGeorgeFlips(snap({ 'BEE;0': { price: 100, count: 3 }, 'X;1': { price: 1, count: 3 } }), gcat)).toEqual([]);
    expect(computeGeorgeFlips(snap({ 'BEE;0': { price: 0, count: 3 } }), gcat)).toEqual([]);
  });
});

describe('petName', () => {
  it('from the listing, else from the id', () => {
    expect(petName('BLACK_CAT;5', '[Lvl 100] Black Cat')).toBe('Black Cat (Mythic)');
    expect(petName('BLACK_CAT;5')).toBe('Black Cat (Mythic)');
    expect(petName('BLACK_CAT;5@MAX')).toBe('Black Cat (Mythic)');
    expect(petName('PET')).toBe('Pet');
  });
});
