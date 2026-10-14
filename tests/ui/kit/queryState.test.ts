// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindQueryState, decodeField, encodeField } from '../../../src/ui/kit/queryState.ts';
import type { QuerySchema } from '../../../src/ui/kit/types.ts';
import type { Route } from '../../../src/types/contracts.ts';

const SCHEMA = {
  q: { kind: 'string', def: '' },
  minVol: { kind: 'number', def: 1000, min: 0 },
  maxPrice: { kind: 'number', def: null },
  verified: { kind: 'bool', def: true },
  risk: { kind: 'enum', def: 'all', values: ['all', 'ok', 'caution'] },
  sort: { kind: 'sort', def: { key: 'pph', dir: 'desc' }, keys: ['pph', 'name'] },
} as const satisfies QuerySchema;

const LS = 'test.qs';
const tick = () => Promise.resolve();

/** A tiny fake router: setQuery patches the route and (like app.ts) calls view.update -> fromRoute. */
function harness(initial: Route) {
  let route: Route = initial;
  let qs: ReturnType<typeof bindQueryState<typeof SCHEMA>> | null = null;
  const setQuery = vi.fn((patch: Record<string, string | undefined>) => {
    const query = { ...route.query };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') delete query[k];
      else query[k] = v;
    }
    route = { ...route, query };
    qs?.fromRoute(route);
  });
  qs = bindQueryState(SCHEMA, initial, setQuery, LS);
  return { qs, setQuery, route: () => route };
}

beforeEach(() => localStorage.clear());

describe('bindQueryState', () => {
  it('starts at defaults with nothing stored', async () => {
    const { qs, setQuery } = harness({ id: 'flip' });
    expect(qs.get()).toEqual({ q: '', minVol: 1000, maxPrice: null, verified: true, risk: 'all', sort: { key: 'pph', dir: 'desc' } });
    expect(qs.activeCount()).toBe(0);
    await tick();
    expect(setQuery).not.toHaveBeenCalled();
  });

  it('round trips through URL and localStorage', async () => {
    const a = harness({ id: 'flip' });
    const seen = vi.fn();
    a.qs.onChange(seen);
    a.qs.set({ q: 'gold ingot', minVol: 0.5, maxPrice: 200, verified: false, risk: 'ok', sort: { key: 'name', dir: 'asc' } });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(a.route().query).toEqual({ q: 'gold ingot', minVol: '0.5', maxPrice: '200', verified: '0', risk: 'ok', sort: 'name.asc' });
    expect(JSON.parse(localStorage.getItem(LS)!)).toEqual(a.route().query);
    expect(a.qs.activeCount()).toBe(5);

    // same URL in a fresh mount -> same values
    const b = harness(a.route());
    expect(b.qs.get()).toEqual(a.qs.get());
    // bare route -> restored from localStorage and pushed back to the URL
    const c = harness({ id: 'flip' });
    expect(c.qs.get()).toEqual(a.qs.get());
    await tick();
    expect(c.route().query).toEqual(a.route().query);

    // no-op set does nothing
    a.setQuery.mockClear();
    a.qs.set({ q: 'gold ingot' });
    expect(a.setQuery).not.toHaveBeenCalled();
    // setting back to the default removes the key
    a.qs.set({ minVol: 1000, maxPrice: null });
    expect(a.route().query!.minVol).toBeUndefined();
    expect(a.route().query!.maxPrice).toBeUndefined();
  });

  it('URL beats localStorage on mount (wholesale)', () => {
    localStorage.setItem(LS, JSON.stringify({ q: 'stored', risk: 'caution' }));
    const { qs } = harness({ id: 'flip', query: { risk: 'ok', other: 'x' } });
    expect(qs.get().q).toBe('');
    expect(qs.get().risk).toBe('ok');
    const fromLs = harness({ id: 'flip', query: { other: 'x' } });
    expect(fromLs.qs.get()).toMatchObject({ q: 'stored', risk: 'caution' });
  });

  it('validates on parse', () => {
    const { qs } = harness({
      id: 'flip',
      query: { minVol: '-5', maxPrice: 'abc', verified: 'maybe', risk: 'evil', sort: 'hack.up', q: 'ok' },
    });
    expect(qs.get()).toMatchObject({ minVol: 1000, maxPrice: null, verified: true, risk: 'all', sort: { key: 'pph', dir: 'desc' } });
    expect(harness({ id: 'flip', query: { sort: 'other.asc' } }).qs.get().sort).toEqual({ key: 'pph', dir: 'desc' });
    expect(harness({ id: 'flip', query: { minVol: 'none', verified: 'false', maxPrice: '1,5' } }).qs.get()).toMatchObject({
      minVol: null,
      verified: false,
      maxPrice: 1.5,
    });
    localStorage.setItem(LS, '[1,2]');
    expect(harness({ id: 'flip' }).qs.get().q).toBe('');
    // set() validates too
    qs.set({ risk: 'nope', minVol: Number.NaN, verified: 'yes' as unknown as boolean });
    expect(qs.get()).toMatchObject({ risk: 'all', minVol: 1000, verified: true });
    qs.set({ minVol: null });
    expect(qs.get().minVol).toBeNull();
  });

  it('fromRoute applies new URL values, keeps state on a bare route, reset clears', async () => {
    const { qs, setQuery, route } = harness({ id: 'flip' });
    const seen = vi.fn();
    const off = qs.onChange(seen);
    qs.fromRoute({ id: 'flip', query: { q: 'x' } });
    expect(qs.get().q).toBe('x');
    expect(seen).toHaveBeenCalledTimes(1);
    qs.fromRoute({ id: 'flip', query: { q: 'x' } });
    expect(seen).toHaveBeenCalledTimes(1);
    setQuery.mockClear();
    qs.fromRoute({ id: 'flip' });
    expect(qs.get().q).toBe('x');
    await tick();
    expect(setQuery).toHaveBeenCalledWith(expect.objectContaining({ q: 'x' }));
    qs.reset();
    expect(qs.get().q).toBe('');
    expect(route().query ?? {}).toEqual({});
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    qs.set({ q: 'y' });
    expect(seen).toHaveBeenCalledTimes(2);
    // get() hands out copies
    (qs.get().sort as { key: string }).key = 'mutated';
    expect(qs.get().sort.key).toBe('pph');
  });

  it('works without a localStorage key; codec helpers', () => {
    const qs = bindQueryState({ n: { kind: 'number', def: 1, max: 10 } }, { id: 'npc' }, () => {});
    qs.set({ n: 5 });
    expect(qs.get().n).toBe(5);
    qs.set({ n: 50 });
    expect(qs.get().n).toBe(1);
    expect(encodeField({ kind: 'bool', def: false }, true)).toBe('1');
    expect(encodeField({ kind: 'string', def: 'a' }, '')).toBeUndefined();
    expect(decodeField({ kind: 'enum', def: 'a', values: ['a', 'b'] }, 'b')).toBe('b');
    expect(decodeField({ kind: 'number', def: 3 }, '')).toBeNull();
  });
});
