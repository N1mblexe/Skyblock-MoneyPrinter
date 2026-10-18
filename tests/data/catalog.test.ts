import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fixture from '../fixtures/catalog.json';
import fixtureV2 from '../fixtures/catalog-v2.json';
import { catalogFromFile, loadCatalog, validateCatalogFile } from '../../src/data/catalog.ts';
import type { CatalogFile } from '../../src/types/contracts.ts';

const file = fixture as unknown as CatalogFile;

afterEach(() => vi.unstubAllGlobals());

describe('catalogFromFile', () => {
  const cat = catalogFromFile(file);

  it('builds ItemInfo', () => {
    expect(cat.items.MELON).toEqual({ id: 'MELON', name: 'Melon', npcSell: 2, npcBuy: 2.5, bazaar: true });
    expect(cat.items.STICK).toEqual({ id: 'STICK', name: 'Stick', npcBuy: 1, bazaar: false });
    expect(cat.items.PAPER!.bazaar).toBe(false);
    expect(cat.meta.generatedAt).toBe(file.generatedAt);
  });

  it('builds recipes with unique keys and indexes', () => {
    expect(cat.recipes.length).toBe(file.recipes.length);
    expect(new Set(cat.recipes.map((r) => r.key)).size).toBe(cat.recipes.length);
    expect(cat.recipes[0]).toEqual({
      key: 'ENCHANTED_GOLD#0',
      output: 'ENCHANTED_GOLD',
      outCount: 1,
      inputs: [{ id: 'GOLD_INGOT', qty: 160 }],
      kind: 'craft',
    });
    const forge = cat.byOutput.get('REFINED_MITHRIL')!;
    expect(forge).toHaveLength(1);
    expect(forge[0]).toMatchObject({ kind: 'forge', durationSec: 21600, req: 'HOTM 2' });
    expect(cat.byOutput.get('ENCHANTED_BREAD')).toHaveLength(2);
    expect(cat.byInput.get('WHEAT')!.map((r) => r.output).sort()).toEqual(['ENCHANTED_BREAD', 'ENCHANTED_BREAD', 'HAY_BLOCK']);
    expect(cat.byInput.get('CYCLE_A')!.map((r) => r.output).sort()).toEqual(['CYCLE_B', 'ENCHANTED_COAL']);
    expect(cat.byOutput.get('PAPER')![0]!.outCount).toBe(3);
  });

  it('name() uses catalog names with deriveName fallback', () => {
    expect(cat.name('JALAPENO_BOOK')).toBe('Jalapeño Book');
    expect(cat.name('LOG:1')).toBe('Spruce Log');
    expect(cat.name('ENCHANTMENT_SHARPNESS_5')).toBe('Sharpness V');
    expect(cat.name('SHARD_BLUE_JAY')).toBe('Blue Jay Shard');
  });

  it('skips malformed recipes and falls back for empty names', () => {
    const c = catalogFromFile({
      v: 1,
      generatedAt: 'x',
      items: { ENCHANTED_GOLD: { n: '' } as any },
      recipes: [{ o: 'X', c: 1, i: [], k: 'craft' }, { o: '', c: 1, i: [['A', 1]], k: 'craft' } as any, { o: 'Y', c: 0, i: [['A', 2]], k: 'craft' }],
    });
    expect(c.items.ENCHANTED_GOLD!.name).toBe('Enchanted Gold');
    expect(c.recipes.map((r) => r.key)).toEqual(['Y#2']);
    expect(c.recipes[0]!.outCount).toBe(1);
  });
});

describe('catalogFromFile v1 compatibility', () => {
  const cat = catalogFromFile(file);

  it('v1 has no shops, no book rules and no v2 item fields', () => {
    expect(file.v).toBe(1);
    expect(cat.shops).toEqual([]);
    expect(cat.kat).toEqual([]);
    expect(cat.petLeveling).toBeNull();
    expect(cat.petNames).toEqual({});
    expect(cat.untradeable.size).toBe(0);
    expect(cat.bookRule('ENCHANTMENT_SHARPNESS')).toBeNull();
    for (const info of Object.values(cat.items)) {
      expect(info.category).toBeUndefined();
      expect(info.auctionable).toBeUndefined();
      expect(info.shard).toBeUndefined();
    }
    expect(cat.meta.itemsApiUpdated).toBeUndefined();
  });
});

describe('catalogFromFile v2', () => {
  const f2 = validateCatalogFile(fixtureV2);
  const cat = catalogFromFile(f2);

  it('passes meta through', () => {
    expect(cat.meta).toEqual({ generatedAt: '2026-10-14T00:00:00Z', neuCommit: f2.neuCommit, itemsApiUpdated: 1791302445914 });
  });

  it('parses category, auctionable and shard metadata', () => {
    expect(cat.items.ASPECT_OF_THE_END).toEqual({
      id: 'ASPECT_OF_THE_END', name: 'Aspect of the End', tier: 'RARE', npcSell: 56000, bazaar: false, category: 'SWORD', auctionable: true,
    });
    expect(cat.items.CACTUS_KNIFE!.category).toBe('FARMING_TOOL');
    expect(cat.items.CACTUS_KNIFE!.auctionable).toBeUndefined();
    expect(cat.items.SHARD_GROVE!.shard).toEqual({ rarity: 'COMMON', family: ['Elemental'], alignment: 'Forest' });
    expect(cat.items.SHARD_LONE!.shard).toEqual({ rarity: 'RARE', family: [] });
    expect(cat.items.SHARD_BAD!.shard).toBeUndefined();
    expect(cat.items.GOLD_INGOT).toMatchObject({ npcBuy: 5.5, auctionable: true, bazaar: true });
  });

  it('builds shops and drops malformed offers', () => {
    expect(cat.shops).toEqual([
      { shop: 'Elizabeth', currency: 'SKYBLOCK_BIT', costQty: 1350, output: 'KISMET_FEATHER', outQty: 1 },
      { shop: 'SkyMart', currency: 'SKYBLOCK_COPPER', costQty: 10, output: 'ENCHANTMENT_SUNDER_1', outQty: 1 },
      { shop: 'SkyMart', currency: 'SKYBLOCK_COPPER', costQty: 150, output: 'LARGE_WALNUT', outQty: 1 },
    ]);
  });

  it('bookRule: curated anvil max is verified, table max is not, unknown is null', () => {
    expect(cat.bookRule('ENCHANTMENT_SHARPNESS')).toEqual({ maxLevel: 5, verified: true });
    expect(cat.bookRule('ENCHANTMENT_LOOTING')).toEqual({ maxLevel: 3, verified: false });
    expect(cat.bookRule('ENCHANTMENT_ULTIMATE_WISE')).toEqual({ maxLevel: 5, verified: true });
    expect(cat.bookRule('ENCHANTMENT_BROKEN')).toBeNull();
    expect(cat.bookRule('ENCHANTMENT_JUNK')).toBeNull();
    expect(cat.bookRule('ENCHANTMENT_NOPE')).toBeNull();
    expect(cat.bookRule('ENCHANTMENT_SHARPNESS_5')).toBeNull();
  });

  it('parses shop recipes (with their shop id) and George prices', () => {
    const c = catalogFromFile({
      ...f2,
      recipes: [
        { o: 'WOOD_SINGULARITY', c: 1, i: [['ENCHANTED_EMERALD', 6]], k: 'shop', s: 'trade' },
        { o: 'STRING', c: 3, i: [['GOLD_INGOT', 2], ['SKYBLOCK_COIN', 10]], k: 'shop', s: 'ALCHEMIST_NPC' },
        { o: 'BONE', c: 1, i: [['GOLD_INGOT', 1]], k: 'craft', s: 'IGNORED' },
      ],
      george: { 'OCELOT;4': 50000, 'BEE;0': 100, 'BAD;1': -1, 'WORSE;2': '5' as any },
    });
    expect(c.recipes.map((r) => [r.output, r.kind, r.shop])).toEqual([
      ['WOOD_SINGULARITY', 'shop', 'trade'],
      ['STRING', 'shop', 'ALCHEMIST_NPC'],
      ['BONE', 'craft', undefined],
    ]);
    expect(c.byInput.get('SKYBLOCK_COIN')!.map((r) => r.output)).toEqual(['STRING']);
    expect(c.george).toEqual({ 'OCELOT;4': 50000, 'BEE;0': 100 });
    expect(catalogFromFile({ ...f2, george: undefined }).george).toEqual({});
  });

  it('tolerates non-array shops / non-object books', () => {
    const c = catalogFromFile({ ...f2, shops: 'x' as any, books: [] as any, itemsApiUpdated: -1 });
    expect(c.shops).toEqual([]);
    expect(c.bookRule('ENCHANTMENT_SHARPNESS')).toBeNull();
    expect(c.meta.itemsApiUpdated).toBeUndefined();
  });
});

describe('catalogFromFile Kat / pets / untradeable', () => {
  const f2 = validateCatalogFile(fixtureV2);
  const withPets = (x: Partial<CatalogFile>) => catalogFromFile({ ...f2, ...x });

  it('older v2 catalogs without the fields parse to empty values', () => {
    const c = catalogFromFile(f2);
    expect(c.kat).toEqual([]);
    expect(c.petLeveling).toBeNull();
    expect(c.petNames).toEqual({});
    expect(c.untradeable.size).toBe(0);
  });

  it('kat: seconds -> hours, missing items -> [], malformed steps dropped', () => {
    const c = withPets({
      kat: [
        { p: 'OCELOT', f: 1, t: 2, c: 10000, s: 600, i: [['ENCHANTED_JUNGLE_LOG', 8], ['BAD', 0], [3, 1]] },
        { p: 'TIGER', f: 0, t: 1, c: 15000, s: 86400 },
        { p: 'ENDERMAN', f: 3, t: 4, c: 0, s: 0, i: [] },
        { p: '', f: 0, t: 1, c: 1, s: 1 },
        { p: 'X', f: 2, t: 2, c: 1, s: 1 },
        { p: 'X', f: 0.5, t: 1, c: 1, s: 1 },
        { p: 'X', f: 0, t: 1, c: -1, s: 1 },
        { p: 'X', f: 0, t: 1, c: 1, s: 'x' },
        { p: 'X', f: 0, t: 1, c: 1, s: 1, i: 'x' },
        'junk',
      ],
    });
    expect(c.kat).toEqual([
      { pet: 'OCELOT', from: 1, to: 2, coins: 10000, hours: 600 / 3600, items: [{ id: 'ENCHANTED_JUNGLE_LOG', qty: 8 }] },
      { pet: 'TIGER', from: 0, to: 1, coins: 15000, hours: 24, items: [] },
      { pet: 'ENDERMAN', from: 3, to: 4, coins: 0, hours: 0, items: [] },
    ]);
    expect(withPets({ kat: { p: 'OCELOT' } }).kat).toEqual([]);
  });

  it('petLeveling: offsets, levels and custom tables; unusable shapes -> null', () => {
    const c = withPets({
      petLeveling: {
        o: { COMMON: 0, LEGENDARY: 20, BAD: -1, ALSO: 'x' },
        l: [100, 110],
        c: { GOLDEN_DRAGON: { l: [5, 6], a: 1, m: 200 }, REPLACED: { l: [7] }, CAPPED: { m: 50 }, BAD: { l: [1, -1], m: 0 }, JUNK: 3 },
      },
    });
    expect(c.petLeveling).toEqual({
      offsets: { COMMON: 0, LEGENDARY: 20 },
      levels: [100, 110],
      custom: { GOLDEN_DRAGON: { levels: [5, 6], append: true, maxLevel: 200 }, REPLACED: { levels: [7] }, CAPPED: { maxLevel: 50 } },
    });
    expect(withPets({ petLeveling: { l: [100] } }).petLeveling).toEqual({ offsets: {}, levels: [100], custom: {} });
    for (const bad of [null, [], { l: [] }, { l: [1, 'x'] }, { o: { COMMON: 0 } }]) expect(withPets({ petLeveling: bad }).petLeveling).toBeNull();
  });

  it('petNames and untradeable keep only strings', () => {
    const c = withPets({ petNames: { OCELOT: 'Ocelot', BAD: 3, EMPTY: '' } as any, untradeable: ['RUNE_SACK', 5, ''] as any });
    expect(c.petNames).toEqual({ OCELOT: 'Ocelot' });
    expect([...c.untradeable]).toEqual(['RUNE_SACK']);
    const d = withPets({ petNames: ['x'] as any, untradeable: 'RUNE_SACK' as any });
    expect(d.petNames).toEqual({});
    expect(d.untradeable.size).toBe(0);
  });
});

describe('loadCatalog', () => {
  it('fetches and builds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fixture))));
    const cat = await loadCatalog('/data/catalog.json');
    expect(cat.items.MELON!.name).toBe('Melon');
  });

  it('loads a v2 file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fixtureV2))));
    const cat = await loadCatalog('/data/catalog.json');
    expect(cat.bookRule('ENCHANTMENT_SHARPNESS')).toEqual({ maxLevel: 5, verified: true });
    expect(cat.shops).toHaveLength(3);
  });

  it('descriptive errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 404 })));
    await expect(loadCatalog('/c.json')).rejects.toThrow('Catalog HTTP 404 (/c.json)');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>')));
    await expect(loadCatalog('/c.json')).rejects.toThrow(/not valid JSON/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...fixture, v: 3 }))));
    await expect(loadCatalog('/c.json')).rejects.toThrow(/Unsupported catalog version: 3/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ v: 1, recipes: [] }))));
    await expect(loadCatalog('/c.json')).rejects.toThrow(/items/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(loadCatalog('/c.json')).rejects.toThrow(/Catalog request failed.*Failed to fetch/);
  });
});

describe('generated public/data/catalog.json', () => {
  const real = validateCatalogFile(JSON.parse(readFileSync(fileURLToPath(new URL('../../public/data/catalog.json', import.meta.url)), 'utf8')));
  const cat = catalogFromFile(real);

  it('is a v2 catalog within the size budget', () => {
    expect(real.v).toBe(2);
    expect(JSON.stringify(real).length).toBeLessThanOrEqual(600 * 1024);
    expect(cat.meta.itemsApiUpdated).toBeGreaterThan(0);
  });

  it('has book rules, shops and shard metadata', () => {
    expect(cat.bookRule('ENCHANTMENT_SHARPNESS')).toEqual({ maxLevel: 5, verified: true });
    const copper = cat.shops.filter((o) => o.currency === 'SKYBLOCK_COPPER' && cat.items[o.output]?.bazaar);
    expect(copper.length).toBeGreaterThanOrEqual(7);
    expect(cat.shops.every((o) => o.currency !== 'SKYBLOCK_COIN')).toBe(true);
    expect(Object.values(cat.items).filter((i) => i.shard).length).toBeGreaterThan(100);
  });

  it('has Kat steps, the pet XP table and pet names', () => {
    expect(cat.kat.length).toBeGreaterThanOrEqual(200);
    const step = (pet: string, from: number) => cat.kat.find((s) => s.pet === pet && s.from === from);
    expect(step('OCELOT', 1)).toEqual({ pet: 'OCELOT', from: 1, to: 2, coins: 10000, hours: 600 / 3600, items: [{ id: 'ENCHANTED_JUNGLE_LOG', qty: 8 }] });
    expect(step('ENDERMAN', 3)).toEqual({ pet: 'ENDERMAN', from: 3, to: 4, coins: 40_000_000, hours: 288, items: [{ id: 'ENCHANTED_EYE_OF_ENDER', qty: 8 }] });
    expect(cat.kat.every((s) => s.to <= 5)).toBe(true);
    for (const s of cat.kat) {
      expect(cat.petNames[s.pet]).toBeTruthy();
      for (const i of s.items) expect(cat.items[i.id]).toBeDefined();
    }
    expect(cat.petLeveling!.levels).toHaveLength(119);
    expect(cat.petLeveling!.offsets).toMatchObject({ COMMON: 0, UNCOMMON: 6, RARE: 11, EPIC: 16, LEGENDARY: 20, MYTHIC: 20 });
    expect(cat.petLeveling!.custom.GOLDEN_DRAGON).toMatchObject({ append: true, maxLevel: 200 });
  });

  it('has the whole bits shop, every output named, untradeable sacks without ah', () => {
    const bits = cat.shops.filter((o) => o.currency === 'SKYBLOCK_BIT');
    expect(bits.length).toBeGreaterThanOrEqual(50);
    const price = (id: string) => bits.find((o) => o.output === id)?.costQty;
    expect(price('GOD_POTION_2')).toBe(1500);
    expect(price('ENCHANTMENT_ABSORB_1')).toBe(4000);
    expect(price('ENCHANTMENT_EXPERTISE_1')).toBe(4000);
    expect(price('SHARD_BITBUG')).toBe(5000);
    for (const o of bits) expect(cat.items[o.output]?.name).toBeTruthy();
    expect([...cat.untradeable].sort()).toEqual(['CRYSTAL_HOLLOWS_SACK', 'DWARVEN_MINES_SACK', 'FLOWER_SACK', 'LARGE_DUNGEON_SACK', 'RUNE_SACK']);
    for (const id of cat.untradeable) expect(cat.items[id]!.auctionable).toBeUndefined();
    expect(cat.items.ABICASE_REZAR!.auctionable).toBe(true);
  });

  it('has shop recipes, AH crafts and George prices', () => {
    const shop = cat.recipes.filter((r) => r.kind === 'shop');
    expect(shop.length).toBeGreaterThanOrEqual(60);
    expect(shop.some((r) => r.shop === 'trade')).toBe(true);
    for (const r of shop) {
      expect(r.shop).toBeTruthy();
      // sellable or auctionable, or a sub-craft of an included recipe (SILKY_LICHEN for SILK_EDGE_SWORD)
      const out = cat.items[r.output];
      expect(out?.bazaar || (out?.npcSell ?? 0) > 0 || out?.auctionable || cat.byInput.has(r.output)).toBeTruthy();
      expect(r.inputs.some((i) => i.id !== r.output)).toBe(true);
    }
    const ahCrafts = cat.recipes.filter((r) => r.kind === 'craft' && !cat.items[r.output]?.bazaar && cat.items[r.output]?.auctionable);
    expect(ahCrafts.length).toBeGreaterThanOrEqual(400);
    expect(Object.keys(cat.george).length).toBeGreaterThanOrEqual(100);
    expect(cat.george['ENDER_DRAGON;4']).toBeGreaterThan(0);
    expect(Object.keys(cat.george).every((k) => /^[A-Z0-9_]+;[0-5]$/.test(k))).toBe(true);
  });
});
