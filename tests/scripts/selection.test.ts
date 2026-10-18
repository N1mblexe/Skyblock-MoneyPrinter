import { describe, expect, it } from 'vitest';
import { makePriceable, selectRecipes, type SelectOptions } from '../../scripts/lib/selection.ts';
import { LIMITS, acceptanceFailures, type AcceptanceStats } from '../../scripts/lib/acceptance.ts';
import type { CatalogRecipeEntry } from '../../src/types/contracts.ts';

type Rec = Pick<CatalogRecipeEntry, 'o' | 'i' | 'k'> & { name?: string };
const rec = (o: string, i: [string, number][], k: Rec['k'] = 'craft'): Rec => ({ o, i, k });

describe('makePriceable', () => {
  const recipes: Rec[] = [
    rec('A', [['BZ', 1]]),
    rec('B', [['A', 2], ['NB', 1]]),
    rec('C', [['B', 1]]),
    rec('D', [['C', 1]]),
    rec('LOOP_X', [['LOOP_Y', 1]]),
    rec('LOOP_Y', [['LOOP_X', 1]]),
    rec('MIXED', [['BZ', 1], ['NOWHERE', 1]]),
    rec('ALT', [['NOWHERE', 1]]),
    rec('ALT', [['BZ', 3]], 'forge'),
  ];
  const by = (id: string) => recipes.filter((r) => r.o === id);
  const direct = (id: string) => id === 'BZ' || id === 'NB';

  it('prices direct ids and sub-crafts within the depth', () => {
    const p = makePriceable(direct, by, 3);
    expect(p('BZ')).toBe(true);
    expect(p('A')).toBe(true);
    expect(p('B')).toBe(true);
    expect(p('C')).toBe(true);
    // D -> C -> B -> A -> BZ needs 4 levels
    expect(p('D')).toBe(false);
    expect(makePriceable(direct, by, 4)('D')).toBe(true);
    expect(makePriceable(direct, by, 0)('A')).toBe(false);
  });

  it('fails unknown ids, cycles, recipes with one unpriceable input; any recipe kind counts', () => {
    const p = makePriceable(direct, by, 3);
    expect(p('NOWHERE')).toBe(false);
    expect(p('LOOP_X')).toBe(false);
    expect(p('MIXED')).toBe(false);
    expect(p('ALT')).toBe(true);
  });

  it('treats blocked ids like the cycle guard, without poisoning the memo', () => {
    const p = makePriceable(direct, by, 3);
    // a blocked input fails even when it is direct (the runtime checks `visited` first)
    expect(p('A', new Set(['BZ']))).toBe(false);
    expect(p('A')).toBe(true);
    expect(p('B', new Set(['A']))).toBe(false);
    expect(p('B')).toBe(true);
  });
});

describe('selectRecipes', () => {
  const opts: SelectOptions = {
    bazaar: (id) => id.startsWith('BZ'),
    npcSellable: (id) => id === 'NPC_SELL',
    auctionable: (id) => id.startsWith('AH') || id === 'NOT_RARE',
    npcBuyable: (id) => id === 'NB',
    hasRarity: (id) => id !== 'NOT_RARE',
    depth: 3,
  };
  const bzOut = rec('BZ_OUT', [['SUB', 1]]);
  const sub = rec('SUB', [['BZ_IN', 2]]);
  const nbSub = rec('NB', [['BZ_IN', 1]]);
  const forge = rec('FORGED', [['BZ_IN', 1]], 'forge');
  const shopSell = rec('NPC_SELL', [['SKYBLOCK_COIN', 10], ['BZ_IN', 1]], 'shop');
  const shopAh = rec('AH_SHOP', [['BZ_IN', 1]], 'shop');
  const shopDead = rec('JUNK', [['BZ_IN', 1]], 'shop');
  const ahOk = rec('AH_OK', [['NB', 1], ['BZ_IN', 1]]);
  const ahDeep = rec('AH_DEEP', [['MID', 1]]);
  const mid = rec('MID', [['SUB', 1]]);
  const ahBad = rec('AH_BAD', [['NOWHERE', 1]]);
  const notRare = rec('NOT_RARE', [['BZ_IN', 1]]);
  const plain = rec('PLAIN', [['BZ_IN', 1]]);
  const all = [bzOut, sub, nbSub, forge, shopSell, shopAh, shopDead, ahOk, ahDeep, mid, ahBad, notRare, plain];

  it('applies the rules in order and pulls in sub-crafts', () => {
    const got = selectRecipes(all, opts);
    expect(Object.fromEntries([...got].map(([r, why]) => [`${r.k}:${r.o}`, why]))).toEqual({
      'craft:BZ_OUT': 'bazaar',
      'forge:FORGED': 'forge',
      'shop:NPC_SELL': 'shop',
      'shop:AH_SHOP': 'shop',
      'craft:AH_OK': 'ah',
      'craft:AH_DEEP': 'ah',
      'craft:SUB': 'subcraft',
      // NPC-buyable inputs get their recipes too (crafting can be cheaper)
      'craft:NB': 'subcraft',
      'craft:MID': 'subcraft',
    });
  });

  it('drops AH crafts whose inputs are out of the sub-craft depth', () => {
    const got = selectRecipes(all, { ...opts, depth: 1 });
    expect(got.get(ahDeep)).toBeUndefined();
    expect(got.get(ahOk)).toBe('ah');
    // depth 1: one level of sub-crafts below the selected recipes
    expect(got.get(sub)).toBe('subcraft');
    expect(got.get(mid)).toBeUndefined();
  });

  it('keeps every bazaar-output recipe, whatever its inputs', () => {
    const odd = rec('BZ_ODD', [['NOWHERE', 1]], 'shop');
    expect(selectRecipes([odd], opts).get(odd)).toBe('bazaar');
  });
});

describe('acceptanceFailures', () => {
  const pass: AcceptanceStats = {
    bazaarOutput: LIMITS.bazaarRecipes,
    forge: LIMITS.forge,
    bazaarNamed: 10,
    bazaarProducts: 10,
    withNb: LIMITS.nb,
    withNs: LIMITS.ns,
    bytes: LIMITS.bytes,
    copperToBazaar: LIMITS.copperToBazaar,
    shards: LIMITS.shards,
    booksWithT: LIMITS.booksT,
    katSteps: LIMITS.kat,
    bitsOffers: LIMITS.bits,
    shopRecipes: LIMITS.shopRecipes,
    george: LIMITS.george,
    ahOutput: LIMITS.ahOutput,
    hasPetLeveling: true,
    sharpnessMax: 5,
  };

  it('passes at the limits', () => {
    expect(acceptanceFailures(pass)).toEqual([]);
    expect(LIMITS).toMatchObject({ shopRecipes: 60, george: 100, ahOutput: 400, bytes: 600 * 1024 });
  });

  it('reports every failed check', () => {
    expect(
      acceptanceFailures({
        ...pass,
        shopRecipes: 59,
        george: 0,
        ahOutput: 399,
        bytes: LIMITS.bytes + 1,
        bazaarNamed: 9,
        hasPetLeveling: false,
        sharpnessMax: undefined,
      }),
    ).toEqual([
      'named bazaar ids 9 / 10',
      `size ${LIMITS.bytes + 1} > ${LIMITS.bytes}`,
      'shop recipes 59 < 60',
      'george prices 0 < 100',
      'AH-output recipes 399 < 400',
      'no pet leveling table (constants/pets.json)',
      'books.ENCHANTMENT_SHARPNESS.m = undefined (expected 5)',
    ]);
  });

  it('takes other limits', () => {
    expect(acceptanceFailures(pass, { ...LIMITS, george: 101 })).toEqual(['george prices 100 < 101']);
  });
});
