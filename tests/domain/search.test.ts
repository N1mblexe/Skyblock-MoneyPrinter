import { describe, expect, it } from 'vitest';
import { matchesQuery, normalizeText, resolveUserInput, searchItems } from '../../src/domain/search.ts';
import { catalog } from './helpers.ts';

describe('normalizeText', () => {
  it.each([
    ['Jalapeño Book', 'jalapeno book'],
    ['ENCHANTED_MELON', 'enchanted melon'],
    ['İSTANBUL ışık', 'istanbul isik'],
    ['ŞĞÇÖÜ şğçöü', 'sgcou sgcou'],
    ['  Büyülü   Karpuz  ', 'buyulu karpuz'],
    ['Crème Brûlée', 'creme brulee'],
    ['', ''],
  ])('%s -> %s', (a, b) => expect(normalizeText(a)).toBe(b));
});

describe('matchesQuery', () => {
  it('matches name or id, diacritic/case-insensitive', () => {
    expect(matchesQuery(catalog, 'JALAPENO_BOOK', 'jalapeño')).toBe(true);
    expect(matchesQuery(catalog, 'JALAPENO_BOOK', 'JALAPENO_B')).toBe(true);
    expect(matchesQuery(catalog, 'LOG:1', 'spruce')).toBe(true);
    expect(matchesQuery(catalog, 'LOG:1', 'log:1')).toBe(true);
    expect(matchesQuery(catalog, 'INK_SACK:4', 'lapis')).toBe(true);
    expect(matchesQuery(catalog, 'INK_SACK:4', 'ink sack')).toBe(true);
    expect(matchesQuery(catalog, 'MELON', 'gold')).toBe(false);
    expect(matchesQuery(catalog, 'MELON', '   ')).toBe(true);
  });

  it('works without a catalog via deriveName', () => {
    expect(matchesQuery(null, 'ENCHANTMENT_LIFE_STEAL_2', 'life steal ii')).toBe(true);
    expect(matchesQuery(null, 'SHARD_BLUE_JAY', 'blue jay shard')).toBe(true);
    expect(matchesQuery(null, 'SHARD_BLUE_JAY', 'zzz')).toBe(false);
  });
});

describe('searchItems', () => {
  const ids = (q: string, limit?: number, f?: Parameters<typeof searchItems>[3]) => searchItems(catalog, q, limit, f).map((i) => i.id);

  it('ranks exact > prefix > word-prefix > substring, ties by name', () => {
    expect(ids('melon')).toEqual(['MELON', 'ENCHANTED_MELON', 'ENCHANTED_MELON_BLOCK']);
    expect(ids('enchanted melon')).toEqual(['ENCHANTED_MELON', 'ENCHANTED_MELON_BLOCK']);
    expect(ids('elon')).toEqual(['ENCHANTED_MELON', 'ENCHANTED_MELON_BLOCK', 'MELON']);
    expect(ids('shard')[0]).toBe('SHARD_BEEHEEMOTH'); // id prefix beats word-prefix "... Shard"
    expect(ids('jalapeno')).toEqual(['JALAPENO_BOOK']);
    expect(ids('lapis')).toEqual(['INK_SACK:4']);
    expect(ids('1')).toContain('LOG:1');
  });

  it('limit, filter, empty query', () => {
    expect(ids('enchanted', 3)).toHaveLength(3);
    expect(ids('paper', 10, (i) => i.bazaar)).toEqual(['ENCHANTED_PAPER']);
    expect(ids('paper')).toEqual(['PAPER', 'ENCHANTED_PAPER']);
    const all = ids('', 1000);
    expect(all).toHaveLength(Object.keys(catalog.items).length);
    expect(ids('nothing-like-this')).toEqual([]);
  });
});

describe('resolveUserInput', () => {
  it('bazaar id, case-insensitive, spaces as underscores', () => {
    expect(resolveUserInput(catalog, 'ENCHANTED_MELON')).toBe('ENCHANTED_MELON');
    expect(resolveUserInput(catalog, '  enchanted_melon ')).toBe('ENCHANTED_MELON');
    expect(resolveUserInput(catalog, 'shard salmon')).toBe('SHARD_SALMON');
    expect(resolveUserInput(catalog, 'log:1')).toBe('LOG:1');
  });

  it('exact display name (normalized)', () => {
    expect(resolveUserInput(catalog, 'Spruce Log')).toBe('LOG:1');
    expect(resolveUserInput(catalog, 'lapis lazuli')).toBe('INK_SACK:4');
    expect(resolveUserInput(catalog, 'Life Steal II')).toBe('ENCHANTMENT_LIFE_STEAL_2');
    expect(resolveUserInput(catalog, 'Wiki Tiki Shard')).toBe('SHARD_WIKI_TIKI');
    expect(resolveUserInput(catalog, 'JALAPEÑO BOOK')).toBe('JALAPENO_BOOK');
  });

  it('null for empty, unknown, or non-bazaar items', () => {
    expect(resolveUserInput(catalog, '')).toBeNull();
    expect(resolveUserInput(catalog, '   ')).toBeNull();
    expect(resolveUserInput(catalog, 'Paper')).toBeNull();
    expect(resolveUserInput(catalog, 'definitely not an item')).toBeNull();
  });

  it('honours a custom bazaar id set', () => {
    const set = new Set(['MELON']);
    expect(resolveUserInput(catalog, 'Melon', set)).toBe('MELON');
    expect(resolveUserInput(catalog, 'ENCHANTED_MELON', set)).toBeNull();
  });
});
