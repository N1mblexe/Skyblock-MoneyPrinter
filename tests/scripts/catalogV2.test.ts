import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildBookRules,
  buildShops,
  enchantBase,
  extractShardMeta,
  itemApiFlags,
  parseBookRules,
  shopDisplayName,
  skymartOffers,
  tableMaxLevels,
} from '../../scripts/lib/catalogV2.ts';
import { extractShopOffers, type ShopOfferRaw } from '../../scripts/lib/neu.ts';
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
