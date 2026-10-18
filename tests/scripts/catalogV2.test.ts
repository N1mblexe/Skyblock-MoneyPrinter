import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildBookRules,
  buildKatSteps,
  buildShops,
  enchantBase,
  extractGeorge,
  extractPetLeveling,
  extractShardMeta,
  itemApiFlags,
  mergeBitsOffers,
  mergeExtraRecipes,
  parseBitsRules,
  parseBookRules,
  parseExtraRecipes,
  petDisplayNames,
  shopDisplayName,
  shopKeep,
  skymartOffers,
  tableMaxLevels,
} from '../../scripts/lib/catalogV2.ts';
import { extractKatSteps, extractShopOffers, type ShopOfferRaw } from '../../scripts/lib/neu.ts';
import { cacheDir, cachePath } from '../../scripts/lib/cache.ts';
import { neuToBazaarId } from '../../src/domain/ids.ts';

describe('itemApiFlags', () => {
  it('category except NONE; auctionable unless can_auction:false or soulbound', () => {
    expect(itemApiFlags(undefined)).toEqual({});
    expect(itemApiFlags({ category: 'SWORD' })).toEqual({ c: 'SWORD', ah: 1 });
    expect(itemApiFlags({ category: 'NONE' })).toEqual({ ah: 1 });
    expect(itemApiFlags({ category: 'FARMING_TOOL', can_auction: false })).toEqual({ c: 'FARMING_TOOL' });
    expect(itemApiFlags({ can_auction: true })).toEqual({ ah: 1 });
    expect(itemApiFlags({ soulbound: 'COOP' })).toEqual({});
  });
});

describe('extractShardMeta', () => {
  const json = {
    attribute_levelling: {},
    attributes: [
      { bazaarName: 'SHARD_GROVE', rarity: 'COMMON', alignment: 'Forest', family: ['Elemental'], internalName: 'ATTRIBUTE_SHARD_NATURE_ELEMENTAL;1' },
      { bazaarName: 'SHARD_LONE', rarity: 'RARE', family: [] },
      { bazaarName: 'SHARD_NOT_ON_BAZAAR', rarity: 'EPIC' },
      { bazaarName: 'SHARD_NO_RARITY', family: ['X'] },
      'junk',
    ],
  };
  const bz = new Set(['SHARD_GROVE', 'SHARD_LONE', 'SHARD_NO_RARITY']);

  it('maps bazaar shard ids to rarity / family / alignment', () => {
    const m = extractShardMeta(json, bz);
    expect([...m.keys()]).toEqual(['SHARD_GROVE', 'SHARD_LONE']);
    expect(m.get('SHARD_GROVE')).toEqual({ r: 'COMMON', f: ['Elemental'], a: 'Forest' });
    expect(m.get('SHARD_LONE')).toEqual({ r: 'RARE' });
  });

  it('tolerates missing / malformed constants', () => {
    expect(extractShardMeta(undefined, bz).size).toBe(0);
    expect(extractShardMeta({ attributes: 'x' }, bz).size).toBe(0);
  });
});

describe('shops', () => {
  it('extractShopOffers keeps single-cost npc_shop offers of any currency', () => {
    const offers = extractShopOffers({
      internalname: 'ELIZABETH_NPC',
      recipes: [
        { type: 'npc_shop', cost: ['SKYBLOCK_BIT:1350'], result: 'KISMET_FEATHER:1' },
        { type: 'npc_shop', cost: ['SKYBLOCK_COIN:8.0'], result: 'ROTTEN_FLESH' },
        { type: 'npc_shop', cost: ['ENCHANTED_IRON:4'], result: 'SOME_ITEM:2' },
        { type: 'npc_shop', cost: ['SKYBLOCK_COPPER:20', 'SAM_SCYTHE:1'], result: 'GARDEN_SCYTHE:1' },
        { type: 'npc_shop', cost: [], result: 'X' },
        { type: 'npc_shop', cost: ['SKYBLOCK_BIT:5'] },
        { type: 'crafting', A1: 'GOLD_INGOT:1' },
      ],
    });
    expect(offers).toEqual([
      { shop: 'ELIZABETH_NPC', currency: 'SKYBLOCK_BIT', costQty: 1350, result: 'KISMET_FEATHER', qty: 1 },
      { shop: 'ELIZABETH_NPC', currency: 'SKYBLOCK_COIN', costQty: 8, result: 'ROTTEN_FLESH', qty: 1 },
      { shop: 'ELIZABETH_NPC', currency: 'ENCHANTED_IRON', costQty: 4, result: 'SOME_ITEM', qty: 2 },
    ]);
    expect(extractShopOffers({ internalname: 'X' })).toEqual([]);
  });

  it('skymartOffers maps currency names and skips unknown ones', () => {
    const offers = skymartOffers({
      'SUNDER;1': { display: '§9Sunder I', price: 10, currency: 'copper' },
      CUBE_BARN_SKIN: { price: 250, currency: 'gems' },
      BIOFUEL: { price: 20000, currency: 'coins' },
      WEIRD: { price: 1, currency: 'tokens' },
      FREE: { price: 0, currency: 'copper' },
      BAD: 'x',
    });
    expect(offers).toEqual([
      { shop: 'SKYMART_NPC', currency: 'SKYBLOCK_COPPER', costQty: 10, result: 'SUNDER;1', qty: 1 },
      { shop: 'SKYMART_NPC', currency: 'SKYBLOCK_GEM', costQty: 250, result: 'CUBE_BARN_SKIN', qty: 1 },
      { shop: 'SKYMART_NPC', currency: 'SKYBLOCK_COIN', costQty: 20000, result: 'BIOFUEL', qty: 1 },
    ]);
    expect(skymartOffers(null)).toEqual([]);
  });

  it('shopDisplayName strips formatting and the (NPC) suffix', () => {
    expect(shopDisplayName('SKYMART_NPC', '§9SkyMart (NPC)')).toBe('SkyMart');
    expect(shopDisplayName('ELIZABETH_NPC', '§9Elizabeth')).toBe('Elizabeth');
    expect(shopDisplayName('X_NPC')).toBe('X_NPC');
    expect(shopDisplayName('X_NPC', '§9')).toBe('X_NPC');
  });

  it('buildShops normalizes ids, drops coins / unsellable outputs, dedupes and sorts', () => {
    const bz = new Set(['ENCHANTMENT_SUNDER_1', 'LARGE_WALNUT', 'KISMET_FEATHER', 'MIRIA_COUPON']);
    const ns = new Set(['LOTUS_BELT']);
    const raw: ShopOfferRaw[] = [
      { shop: 'SKYMART_NPC', currency: 'SKYBLOCK_COPPER', costQty: 150, result: 'LARGE_WALNUT', qty: 1 },
      { shop: 'SKYMART_NPC', currency: 'SKYBLOCK_COPPER', costQty: 10, result: 'SUNDER;1', qty: 1 },
      { shop: 'SKYMART_NPC', currency: 'SKYBLOCK_COPPER', costQty: 100, result: 'LOTUS_BELT', qty: 1 },
      { shop: 'SKYMART_NPC', currency: 'SKYBLOCK_COPPER', costQty: 20, result: 'BUILDERS_RULER', qty: 1 },
      { shop: 'SKYMART_NPC', currency: 'SKYBLOCK_COIN', costQty: 5000, result: 'LARGE_WALNUT', qty: 1 },
      { shop: 'ELIZABETH_NPC', currency: 'SKYBLOCK_BIT', costQty: 1350, result: 'KISMET_FEATHER', qty: 1 },
      { shop: 'MIRIA_NPC', currency: 'MIRIA_COUPON', costQty: 1, result: 'MIRIA_COUPON', qty: 1 },
      { shop: 'MIRIA_NPC', currency: 'MIRIA_COUPON', costQty: 0, result: 'KISMET_FEATHER', qty: 1 },
      // SkyMart constants duplicate (later, different price): first one wins
      { shop: 'SKYMART_NPC', currency: 'SKYBLOCK_COPPER', costQty: 999, result: 'SUNDER;1', qty: 1 },
    ];
    const names: Record<string, string> = { SKYMART_NPC: 'SkyMart', ELIZABETH_NPC: 'Elizabeth' };
    const shops = buildShops(raw, {
      norm: (id) => neuToBazaarId(id, bz),
      keep: (id) => bz.has(id) || ns.has(id),
      shopName: (id) => names[id] ?? id,
    });
    expect(shops).toEqual([
      { s: 'Elizabeth', cur: 'SKYBLOCK_BIT', cq: 1350, o: 'KISMET_FEATHER', oq: 1 },
      { s: 'SkyMart', cur: 'SKYBLOCK_COPPER', cq: 10, o: 'ENCHANTMENT_SUNDER_1', oq: 1 },
      { s: 'SkyMart', cur: 'SKYBLOCK_COPPER', cq: 150, o: 'LARGE_WALNUT', oq: 1 },
      { s: 'SkyMart', cur: 'SKYBLOCK_COPPER', cq: 100, o: 'LOTUS_BELT', oq: 1 },
    ]);
    // custom exclusion + raw shop ids
    const withCoins = buildShops(raw.slice(4, 5), { norm: (id) => id, keep: () => true, excludeCurrencies: new Set() });
    expect(withCoins).toEqual([{ s: 'SKYMART_NPC', cur: 'SKYBLOCK_COIN', cq: 5000, o: 'LARGE_WALNUT', oq: 1 }]);
  });
});

describe('books', () => {
  it('enchantBase', () => {
    expect(enchantBase('ENCHANTMENT_SHARPNESS_5')).toEqual({ base: 'ENCHANTMENT_SHARPNESS', level: 5 });
    expect(enchantBase('ENCHANTMENT_ULTIMATE_WISE_1')).toEqual({ base: 'ENCHANTMENT_ULTIMATE_WISE', level: 1 });
    expect(enchantBase('ENCHANTED_GOLD')).toBeNull();
    expect(enchantBase('ENCHANTMENT_')).toBeNull();
  });

  it('tableMaxLevels upper-cases keys and skips junk', () => {
    const t = tableMaxLevels({ max_xp_table_levels: { sharpness: 5, PROSECUTE: 5, looting: 3, bad: 'x', zero: 0, frac: 2.5 } });
    expect([...t]).toEqual([['SHARPNESS', 5], ['PROSECUTE', 5], ['LOOTING', 3]]);
    expect(tableMaxLevels(null).size).toBe(0);
  });

  it('parseBookRules reads groups and ignores $ comments', () => {
    const m = parseBookRules({ $source: 'x', groups: [{ $source: 'a', max: { $note: 'y', ENCHANTMENT_SHARPNESS: 5 } }, { max: { ENCHANTMENT_ULTIMATE_WISE: 5 } }] });
    expect([...m]).toEqual([['ENCHANTMENT_SHARPNESS', 5], ['ENCHANTMENT_ULTIMATE_WISE', 5]]);
  });

  it('parseBookRules rejects malformed files', () => {
    expect(() => parseBookRules({})).toThrow(/groups/);
    expect(() => parseBookRules({ groups: [{}] })).toThrow(/max/);
    expect(() => parseBookRules({ groups: [{ max: { SHARPNESS: 5 } }] })).toThrow(/bad base/);
    expect(() => parseBookRules({ groups: [{ max: { ENCHANTMENT_X: 0 } }] })).toThrow(/positive integer/);
    expect(() => parseBookRules({ groups: [{ max: { ENCHANTMENT_X: 1 } }, { max: { ENCHANTMENT_X: 2 } }] })).toThrow(/duplicate/);
  });

  it('buildBookRules: t from the table, m from curated, bases with neither omitted', () => {
    const bz = ['ENCHANTMENT_SHARPNESS_5', 'ENCHANTMENT_SHARPNESS_6', 'ENCHANTMENT_LOOTING_3', 'ENCHANTMENT_ULTIMATE_WISE_1', 'ENCHANTMENT_MYSTERY_1', 'ENCHANTED_GOLD'];
    const rules = buildBookRules(bz, new Map([['SHARPNESS', 5], ['LOOTING', 3]]), new Map([['ENCHANTMENT_SHARPNESS', 5], ['ENCHANTMENT_ULTIMATE_WISE', 5], ['ENCHANTMENT_NOT_ON_BZ', 2]]));
    expect(rules).toEqual({
      ENCHANTMENT_LOOTING: { t: 3 },
      ENCHANTMENT_SHARPNESS: { t: 5, m: 5 },
      ENCHANTMENT_ULTIMATE_WISE: { m: 5 },
    });
  });

  it('the curated scripts/data/book-rules.json parses and says Sharpness combines to V', () => {
    const json = JSON.parse(readFileSync(fileURLToPath(new URL('../../scripts/data/book-rules.json', import.meta.url)), 'utf8')) as unknown;
    const m = parseBookRules(json);
    expect(m.get('ENCHANTMENT_SHARPNESS')).toBe(5);
    expect(m.get('ENCHANTMENT_ULTIMATE_WISE')).toBe(5);
    expect(typeof (json as { $source?: unknown }).$source).toBe('string');
  });
});

describe('cache dir', () => {
  it('BAZAAR_CACHE_DIR overrides .cache', () => {
    expect(cacheDir({})).toBe('.cache');
    expect(cacheDir({ BAZAAR_CACHE_DIR: '  ' })).toBe('.cache');
    expect(cacheDir({ BAZAAR_CACHE_DIR: '/tmp/c' })).toBe('/tmp/c');
    expect(cachePath('bazaar.json', { BAZAAR_CACHE_DIR: '/tmp/c' })).toBe('/tmp/c/bazaar.json');
    expect(cachePath('items.json', {})).toBe('.cache/items.json');
  });
});

describe('extra recipes', () => {
  const ok = {
    $source: 'x',
    recipes: [{ output: 'TOP', outCount: 1, inputs: [{ id: 'B', qty: 2 }, { id: 'A', qty: 160 }], source: 'https://example.wiki/Top' }],
  };

  it('parses entries with sorted inputs and ignores $ comments', () => {
    expect(parseExtraRecipes(ok)).toEqual([{ output: 'TOP', outCount: 1, inputs: [['A', 160], ['B', 2]] }]);
    expect(parseExtraRecipes(JSON.parse(readFileSync(fileURLToPath(new URL('../../scripts/data/extra-recipes.json', import.meta.url)), 'utf8')))).toEqual(expect.any(Array));
  });

  it('rejects malformed entries', () => {
    const one = (r: Record<string, unknown>) => ({ recipes: [{ ...ok.recipes[0], ...r }] });
    expect(() => parseExtraRecipes({})).toThrow(/expected/);
    expect(() => parseExtraRecipes(one({ source: '' }))).toThrow(/source/);
    expect(() => parseExtraRecipes(one({ output: 'bad id' }))).toThrow(/bad output/);
    expect(() => parseExtraRecipes(one({ outCount: 0 }))).toThrow(/outCount/);
    expect(() => parseExtraRecipes(one({ inputs: [] }))).toThrow(/inputs/);
    expect(() => parseExtraRecipes(one({ inputs: [{ id: 'A', qty: 0 }] }))).toThrow(/qty/);
    expect(() => parseExtraRecipes({ recipes: [ok.recipes[0], ok.recipes[0]] })).toThrow(/duplicate/);
  });

  it('only fills outputs NEU has no recipe for', () => {
    const x = parseExtraRecipes({ recipes: [ok.recipes[0], { ...ok.recipes[0], output: 'OTHER' }] });
    const m = mergeExtraRecipes(x, (id) => id === 'OTHER');
    expect(m.added.map((r) => r.output)).toEqual(['TOP']);
    expect(m.skipped).toEqual(['OTHER']);
  });
});

const readData = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../scripts/data/${name}`, import.meta.url)), 'utf8')) as unknown;

describe('bits rules', () => {
  const ok = {
    $source: 'x',
    extraOffers: [{ output: 'ENCHANTMENT_ABSORB_1', bits: 4000, source: 'https://example.wiki/Bits_Shop' }],
    auctionable: [{ id: 'ABICASE_REZAR', source: 'https://example.wiki/Abicases' }],
    untradeable: [{ id: 'RUNE_SACK', source: 'https://example.wiki/Rune_Sack' }],
  };

  it('parses offers and id lists; every list is optional', () => {
    expect(parseBitsRules(ok)).toEqual({
      extraOffers: [{ output: 'ENCHANTMENT_ABSORB_1', bits: 4000 }],
      auctionable: ['ABICASE_REZAR'],
      untradeable: ['RUNE_SACK'],
    });
    expect(parseBitsRules({ $source: 'x' })).toEqual({ extraOffers: [], auctionable: [], untradeable: [] });
  });

  it('rejects malformed entries', () => {
    const offer = (r: Record<string, unknown>) => ({ extraOffers: [{ ...ok.extraOffers[0], ...r }] });
    expect(() => parseBitsRules([])).toThrow(/expected/);
    expect(() => parseBitsRules({ extraOffers: {} })).toThrow(/must be an array/);
    expect(() => parseBitsRules({ untradeable: ['RUNE_SACK'] })).toThrow(/must be an object/);
    expect(() => parseBitsRules(offer({ output: 'bad id' }))).toThrow(/bad output/);
    expect(() => parseBitsRules(offer({ source: ' ' }))).toThrow(/source/);
    expect(() => parseBitsRules(offer({ bits: 0 }))).toThrow(/bits/);
    expect(() => parseBitsRules(offer({ bits: 1.5 }))).toThrow(/bits/);
    expect(() => parseBitsRules({ extraOffers: [ok.extraOffers[0], ok.extraOffers[0]] })).toThrow(/duplicate/);
    expect(() => parseBitsRules({ untradeable: [{ id: 'RUNE_SACK' }] })).toThrow(/source/);
    expect(() => parseBitsRules({ auctionable: [{ id: 'x', source: 's' }] })).toThrow(/bad auctionable/);
    expect(() => parseBitsRules({ untradeable: [ok.untradeable[0], ok.untradeable[0]] })).toThrow(/duplicate/);
  });

  it('the hand-kept scripts/data/bits-rules.json parses', () => {
    const json = readData('bits-rules.json');
    const r = parseBitsRules(json);
    expect(r.extraOffers).toContainEqual({ output: 'ENCHANTMENT_ABSORB_1', bits: 4000 });
    expect(r.untradeable).toEqual(expect.arrayContaining(['LARGE_DUNGEON_SACK', 'RUNE_SACK', 'FLOWER_SACK', 'DWARVEN_MINES_SACK', 'CRYSTAL_HOLLOWS_SACK']));
    expect(r.untradeable.filter((id) => r.auctionable.includes(id))).toEqual([]);
    expect(typeof (json as { $source?: unknown }).$source).toBe('string');
  });

  it('keep rule: sellable outputs for any currency, auctionable / listed outputs only for bits', () => {
    const keep = shopKeep((id) => id === 'KISMET_FEATHER', (id) => id === 'GOD_POTION_2', { auctionable: ['ABICASE_REZAR'], untradeable: ['RUNE_SACK'] });
    expect(keep('KISMET_FEATHER', 'SKYBLOCK_COPPER')).toBe(true);
    expect(keep('KISMET_FEATHER', 'SKYBLOCK_BIT')).toBe(true);
    for (const id of ['GOD_POTION_2', 'ABICASE_REZAR', 'RUNE_SACK']) {
      expect(keep(id, 'SKYBLOCK_BIT')).toBe(true);
      expect(keep(id, 'SKYBLOCK_COPPER')).toBe(false);
    }
    expect(keep('JUNK', 'SKYBLOCK_BIT')).toBe(false);
    // through buildShops: other currencies stay as before
    const raw: ShopOfferRaw[] = [
      { shop: 'ELIZABETH_NPC', currency: 'SKYBLOCK_BIT', costQty: 1500, result: 'GOD_POTION_2', qty: 1 },
      { shop: 'ELIZABETH_NPC', currency: 'SKYBLOCK_BIT', costQty: 14000, result: 'RUNE_SACK', qty: 1 },
      { shop: 'ELIZABETH_NPC', currency: 'SKYBLOCK_BIT', costQty: 1, result: 'JUNK', qty: 1 },
      { shop: 'SKYMART_NPC', currency: 'SKYBLOCK_COPPER', costQty: 5, result: 'GOD_POTION_2', qty: 1 },
    ];
    expect(buildShops(raw, { norm: (id) => id, keep }).map((s) => `${s.cur}:${s.o}`)).toEqual(['SKYBLOCK_BIT:GOD_POTION_2', 'SKYBLOCK_BIT:RUNE_SACK']);
  });

  it('extra offers become Elizabeth bits offers unless NEU already sells the output for bits', () => {
    const m = mergeBitsOffers([{ output: 'ENCHANTMENT_ABSORB_1', bits: 4000 }, { output: 'KISMET_FEATHER', bits: 1350 }], (id) => id === 'KISMET_FEATHER');
    expect(m.added).toEqual([{ shop: 'ELIZABETH_NPC', currency: 'SKYBLOCK_BIT', costQty: 4000, result: 'ENCHANTMENT_ABSORB_1', qty: 1 }]);
    expect(m.skipped).toEqual(['KISMET_FEATHER']);
  });
});

describe('Kat upgrades', () => {
  it('extractKatSteps reads katgrade recipes; bare ids are qty 1; bad recipes are skipped', () => {
    const steps = extractKatSteps({
      internalname: 'OCELOT;2',
      recipes: [
        { type: 'katgrade', coins: 10000, time: 600, input: 'OCELOT;1', output: 'OCELOT;2', items: ['ENCHANTED_JUNGLE_LOG:8', 'LOG-3', ''] },
        { type: 'katgrade', coins: 900000, time: 604800, input: 'TIGER;2', output: 'TIGER;3', items: [] },
        { type: 'katgrade', coins: 1, time: 1, input: 'OCELOT;1', output: 'TIGER;2', items: [] },
        { type: 'katgrade', coins: 1, time: 1, input: 'OCELOT;2', output: 'OCELOT;1', items: [] },
        { type: 'katgrade', coins: -1, time: 1, input: 'OCELOT;1', output: 'OCELOT;2' },
        { type: 'katgrade', coins: 1, input: 'OCELOT;1', output: 'OCELOT;2' },
        { type: 'katgrade', coins: 1, time: 1, input: 'OCELOT', output: 'OCELOT;2' },
        { type: 'npc_shop', cost: ['SKYBLOCK_BIT:5'], result: 'X' },
      ],
    });
    expect(steps).toEqual([
      { pet: 'OCELOT', from: 1, to: 2, coins: 10000, seconds: 600, items: [{ id: 'ENCHANTED_JUNGLE_LOG', qty: 8 }, { id: 'LOG-3', qty: 1 }] },
      { pet: 'TIGER', from: 2, to: 3, coins: 900000, seconds: 604800, items: [] },
    ]);
    expect(extractKatSteps({ internalname: 'X' })).toEqual([]);
  });

  it('buildKatSteps normalizes and merges ingredients, drops tiers above MYTHIC, dedupes and sorts', () => {
    const r = buildKatSteps(
      [
        { pet: 'OCELOT', from: 1, to: 2, coins: 10000, seconds: 600, items: [{ id: 'LOG-3', qty: 500 }, { id: 'ENCHANTED_JUNGLE_LOG', qty: 8 }, { id: 'LOG:3', qty: 12 }] },
        { pet: 'OCELOT', from: 0, to: 1, coins: 5000, seconds: 300, items: [] },
        { pet: 'OCELOT', from: 1, to: 2, coins: 1, seconds: 1, items: [] },
        { pet: 'PHOENIX', from: 7, to: 8, coins: 100000000, seconds: 1728000, items: [{ id: 'ENCHANTED_BLAZE_POWDER', qty: 1024 }] },
        { pet: 'BEE', from: 4, to: 5, coins: 1, seconds: 1, items: [] },
      ],
      (id) => id.replace('-', ':'),
    );
    expect(r.steps).toEqual([
      { p: 'BEE', f: 4, t: 5, c: 1, s: 1 },
      { p: 'OCELOT', f: 0, t: 1, c: 5000, s: 300 },
      { p: 'OCELOT', f: 1, t: 2, c: 10000, s: 600, i: [['ENCHANTED_JUNGLE_LOG', 8], ['LOG:3', 512]] },
    ]);
    expect(r.dropped).toEqual(['PHOENIX;7>8']);
    expect(r.duplicates).toBe(1);
  });
});

describe('pets', () => {
  const pets = {
    pet_rarity_offset: { COMMON: 0, UNCOMMON: 6, LEGENDARY: 20, BAD: -1, ALSO_BAD: 'x' },
    pet_levels: [100, 110, 120],
    custom_pet_leveling: {
      GOLDEN_DRAGON: { type: 1, pet_levels: [1886700, 1886700], max_level: 200 },
      REPLACED: { type: 2, pet_levels: [5, 6] },
      CAPPED: { max_level: 50 },
      BINGO: { rarity_offset: { COMMON: 0 } },
      REINDEER: { xp_multiplier: 2 },
      BAD_LEVELS: { type: 1, pet_levels: [1, -1] },
      JUNK: 'x',
    },
    id_to_display_name: { TYRANNOSAURUS: 'T-Rex', BAD: 3 },
  };

  it('extractPetLeveling maps offsets, base levels and custom tables (type 1 = append)', () => {
    const r = extractPetLeveling(pets);
    expect(r.leveling).toEqual({
      o: { COMMON: 0, UNCOMMON: 6, LEGENDARY: 20 },
      l: [100, 110, 120],
      c: { GOLDEN_DRAGON: { l: [1886700, 1886700], a: 1, m: 200 }, REPLACED: { l: [5, 6] }, CAPPED: { m: 50 } },
    });
    expect(r.ignored).toEqual(['BINGO.rarity_offset', 'REINDEER.xp_multiplier']);
    expect(extractPetLeveling(null).leveling).toBeNull();
    expect(extractPetLeveling({ pet_levels: [] }).leveling).toBeNull();
    expect(extractPetLeveling({ pet_levels: [1, 'x'] }).leveling).toBeNull();
    expect(extractPetLeveling({ pet_levels: [1] }).leveling).toEqual({ o: {}, l: [1], c: {} });
  });

  it('petDisplayNames reads pet item files, then id_to_display_name overrides', () => {
    const names = petDisplayNames(
      [
        { internalname: 'OCELOT;2', displayname: '§f§7[Lvl {LVL}] §9Ocelot' },
        { internalname: 'OCELOT;3', displayname: '§7[Lvl {LVL}] §5Ocelot' },
        { internalname: 'TYRANNOSAURUS;4', displayname: '§7[Lvl {LVL}] §6Tyrannosaurus' },
        { internalname: 'SHARPNESS;5', displayname: '§fEnchanted Book' },
        { internalname: 'GOLD_INGOT', displayname: '§fGold Ingot' },
      ],
      pets,
    );
    expect(names).toEqual({ OCELOT: 'Ocelot', TYRANNOSAURUS: 'T-Rex' });
    expect(Object.keys(names)).toEqual(['OCELOT', 'TYRANNOSAURUS']);
    expect(petDisplayNames([], null)).toEqual({});
  });
});

describe('George', () => {
  it('extractGeorge keeps TYPE;0-5 keys with a positive price, sorted, and reports the rest', () => {
    const r = extractGeorge({
      license1: 'x',
      prices: { OCELOT: 1, 'OCELOT;4': 50000, 'BEE;0': 100, 'PHOENIX;7': 1e6, 'BAT;2': 0, 'WOLF;3': '5', 'lower;1': 9, 'ENDER_DRAGON;4': 5e6 },
    });
    expect(r.george).toEqual({ 'BEE;0': 100, 'ENDER_DRAGON;4': 5e6, 'OCELOT;4': 50000 });
    expect(Object.keys(r.george)).toEqual(['BEE;0', 'ENDER_DRAGON;4', 'OCELOT;4']);
    expect(r.dropped).toEqual(['OCELOT', 'PHOENIX;7', 'BAT;2', 'WOLF;3', 'lower;1']);
    expect(extractGeorge(undefined)).toEqual({ george: {}, dropped: [] });
    expect(extractGeorge({ prices: [1, 2] }).george).toEqual({});
  });
});
