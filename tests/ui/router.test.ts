// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Route } from '../../src/types/contracts.ts';
import { createRouter, parseHash, routeToHash } from '../../src/ui/router.ts';

afterEach(() => {
  location.hash = '';
});

describe('parseHash', () => {
  it.each<[string, Route]>([
    ['', { id: 'overview' }],
    ['#', { id: 'overview' }],
    ['#/', { id: 'overview' }],
    ['#/nope', { id: 'overview' }],
    ['#/flip', { id: 'flip' }],
    ['#/craft', { id: 'craft' }],
    ['#/fusion', { id: 'fusion' }],
    ['#/npc', { id: 'npc' }],
    ['#/overview', { id: 'overview' }],
    ['#/books', { id: 'books' }],
    ['#/plan', { id: 'plan' }],
    ['#/watch', { id: 'watch' }],
    ['#/item', { id: 'overview' }],
    ['#/item/ENCHANTED_GOLD', { id: 'item', param: 'ENCHANTED_GOLD' }],
    ['#/item/INK_SACK%3A4', { id: 'item', param: 'INK_SACK:4' }],
    ['#/item/INK_SACK:4', { id: 'item', param: 'INK_SACK:4' }],
    ['#/craft?q=gold', { id: 'craft', query: { q: 'gold' } }],
    ['#/craft?q=enchanted+gold&kind=forge', { id: 'craft', query: { q: 'enchanted gold', kind: 'forge' } }],
    ['#/item/%E0%A4%A', { id: 'item', param: '%E0%A4%A' }],
  ])('%s', (hash, route) => expect(parseHash(hash)).toEqual(route));
});

describe('routeToHash round trip', () => {
  it.each<Route>([
    { id: 'flip' },
    { id: 'npc' },
    { id: 'item', param: 'INK_SACK:4' },
    { id: 'item', param: 'ENCHANTMENT_LIFE_STEAL_2' },
    { id: 'item', param: 'weird/id ?&#' },
    { id: 'craft', query: { q: 'gold & co', x: '1' } },
    { id: 'item', param: 'LOG:1', query: { range: '7d' } },
  ])('%j', (r) => expect(parseHash(routeToHash(r))).toEqual(r));

  it('serializes', () => {
    expect(routeToHash({ id: 'item', param: 'INK_SACK:4' })).toBe('#/item/INK_SACK%3A4');
    expect(routeToHash({ id: 'craft', query: { q: 'gold' } })).toBe('#/craft?q=gold');
    expect(routeToHash({ id: 'craft', query: {} })).toBe('#/craft');
  });
});

describe('createRouter', () => {
  it('calls onRoute immediately and on hashchange; navigate sets hash', async () => {
    location.hash = '#/npc';
    await new Promise((res) => setTimeout(res, 20));
    const seen: Route[] = [];
    const r = createRouter((x) => seen.push(x));
    expect(seen).toEqual([{ id: 'npc' }]);
    r.navigate({ id: 'item', param: 'INK_SACK:4' });
    expect(location.hash).toBe('#/item/INK_SACK%3A4');
    await vi.waitFor(() => expect(seen.length).toBe(2));
    expect(seen[1]).toEqual({ id: 'item', param: 'INK_SACK:4' });
    expect(r.current()).toEqual({ id: 'item', param: 'INK_SACK:4' });
    r.destroy();
    location.hash = '#/craft';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise((res) => setTimeout(res, 10));
    expect(seen.length).toBe(2);
  });

  it('empty hash uses initial(); replace() updates current without a history entry', async () => {
    location.hash = '';
    await new Promise((res) => setTimeout(res, 20));
    const seen: Route[] = [];
    const r = createRouter((x) => seen.push(x), () => ({ id: 'craft' }));
    expect(seen).toEqual([{ id: 'craft' }]);
    const len = history.length;
    r.replace({ id: 'craft', query: { q: 'gold' } });
    expect(location.hash).toBe('#/craft?q=gold');
    expect(history.length).toBe(len);
    expect(r.current()).toEqual({ id: 'craft', query: { q: 'gold' } });
    expect(seen[1]).toEqual({ id: 'craft', query: { q: 'gold' } });
    await new Promise((res) => setTimeout(res, 20));
    expect(seen.length).toBe(2);
    r.destroy();
  });
});
