import { describe, expect, it, vi } from 'vitest';
import { searchBazaar, pagesProvider } from '../../../src/ui/shell/palette.ts';
import { catalog, snap } from '../../domain/helpers.ts';
import { setLang } from '../../../src/i18n/index.ts';

describe('palette search', () => {
  it('ranks an exact id first and only returns bazaar products', () => {
    const ids = searchBazaar({ snapshot: snap, catalog }, 'enchanted gold');
    expect(ids[0]).toBe('ENCHANTED_GOLD');
    for (const id of ids) expect(snap.products[id]).toBeDefined();
    expect(searchBazaar({ snapshot: snap, catalog }, 'ENCHANTED_GOLD')[0]).toBe('ENCHANTED_GOLD');
    expect(searchBazaar({ snapshot: snap, catalog }, '   ')).toEqual([]);
  });

  it('works without a catalog (snapshot ids only) and without a snapshot (catalog bazaar flag)', () => {
    const noCat = searchBazaar({ snapshot: snap, catalog: null }, 'enchanted gold');
    expect(noCat).toContain('ENCHANTED_GOLD');
    const noSnap = searchBazaar({ snapshot: null, catalog }, 'enchanted gold');
    expect(noSnap.length).toBeGreaterThan(0);
    for (const id of noSnap) expect(catalog.items[id]?.bazaar).toBe(true);
  });

  it('pages provider filters by label (diacritics-insensitive)', () => {
    setLang('tr');
    const nav = vi.fn();
    const items = pagesProvider(nav)('izleme');
    expect(items.map((i) => i.id)).toEqual(['page:watch']);
    items[0]!.run();
    expect(nav).toHaveBeenCalledWith({ id: 'watch' });
    expect(pagesProvider(nav)('')).toHaveLength(10);
  });
});
