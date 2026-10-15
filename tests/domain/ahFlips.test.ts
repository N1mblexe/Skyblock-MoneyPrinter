import { describe, expect, it } from 'vitest';
import { computeAhFlips, petName } from '../../src/domain/ahFlips.ts';
import { ahNet } from '../../src/domain/pricing.ts';
import type { AhPrice, AhSnapshot, CatalogFile } from '../../src/types/contracts.ts';
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

describe('petName', () => {
  it('from the listing, else from the id', () => {
    expect(petName('BLACK_CAT;5', '[Lvl 100] Black Cat')).toBe('Black Cat (Mythic)');
    expect(petName('BLACK_CAT;5')).toBe('Black Cat (Mythic)');
    expect(petName('PET')).toBe('Pet');
  });
});
