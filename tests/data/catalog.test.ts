import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/catalog.json';
import { catalogFromFile, loadCatalog } from '../../src/data/catalog.ts';
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

describe('loadCatalog', () => {
  it('fetches and builds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fixture))));
    const cat = await loadCatalog('/data/catalog.json');
    expect(cat.items.MELON!.name).toBe('Melon');
  });

  it('descriptive errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 404 })));
    await expect(loadCatalog('/c.json')).rejects.toThrow('Catalog HTTP 404 (/c.json)');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>')));
    await expect(loadCatalog('/c.json')).rejects.toThrow(/not valid JSON/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...fixture, v: 2 }))));
    await expect(loadCatalog('/c.json')).rejects.toThrow(/Unsupported catalog version: 2/);
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
