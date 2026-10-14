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

  it('tolerates non-array shops / non-object books', () => {
    const c = catalogFromFile({ ...f2, shops: 'x' as any, books: [] as any, itemsApiUpdated: -1 });
    expect(c.shops).toEqual([]);
    expect(c.bookRule('ENCHANTMENT_SHARPNESS')).toBeNull();
    expect(c.meta.itemsApiUpdated).toBeUndefined();
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
});
