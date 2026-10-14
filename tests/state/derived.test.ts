import { describe, expect, it, vi } from 'vitest';
import { initialState } from '../../src/state/appState.ts';
import { CALC_SETTINGS, calcSettingsKey, createDerived } from '../../src/state/derived.ts';
import { createStore } from '../../src/state/store.ts';
import type { AppState, MarketStat, Settings } from '../../src/types/contracts.ts';
import { baseSettings, catalog, snap } from '../domain/helpers.ts';
import { fakeHistory } from '../helpers/fakes.ts';

const flipSpy = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../src/domain/flip.ts', async (orig) => {
  const m = await orig<typeof import('../../src/domain/flip.ts')>();
  return { ...m, computeFlips: (...a: Parameters<typeof m.computeFlips>) => (flipSpy.n++, m.computeFlips(...a)) };
});

function setup(over: Partial<AppState> = {}) {
  const stats = new Map<string, MarketStat>();
  const history = fakeHistory({ marketStats: vi.fn(() => stats) });
  const store = createStore<AppState>({ ...initialState(baseSettings), snapshot: snap, catalog, ...over });
  return { store, history, stats, d: createDerived(store, history) };
}

const patch = (store: ReturnType<typeof setup>['store'], s: Partial<Settings>) => store.set((st) => ({ settings: { ...st.settings, ...s } }));

describe('createDerived', () => {
  it('empty results without snapshot or catalog', () => {
    const { d } = setup({ catalog: null });
    expect(d.calcCtx()).toBeNull();
    expect(d.flips()).toEqual([]);
    expect(d.crafts()).toEqual([]);
    expect(d.fusion()).toEqual([]);
    expect(d.opportunities()).toEqual([]);
  });

  it('display-only settings do not recompute anything', () => {
    const { store, d } = setup({ fusion: [{ a: 'X', qa: 1, b: 'Y', qb: 1, out: 'Z', qo: 1 }] });
    const ctx = d.calcCtx();
    flipSpy.n = 0;
    const r = { flips: d.flips(), crafts: d.crafts(), npc: d.npc(), books: d.books(), shops: d.shops(), fusion: d.fusion(), opps: d.opportunities() };
    expect(flipSpy.n).toBe(1);
    expect(r.flips.length).toBeGreaterThan(0);
    patch(store, { lang: 'tr' });
    patch(store, { theme: 'dark' });
    patch(store, { density: 'compact' });
    patch(store, { notify: true });
    patch(store, { hideSuspicious: false });
    patch(store, { autoRefresh: false });
    store.set({ route: { id: 'flip' }, nextPollAt: 5 });
    expect(d.calcCtx()).toBe(ctx);
    expect(d.flips()).toBe(r.flips);
    expect(d.crafts()).toBe(r.crafts);
    expect(d.npc()).toBe(r.npc);
    expect(d.books()).toBe(r.books);
    expect(d.shops()).toBe(r.shops);
    expect(d.fusion()).toBe(r.fusion);
    expect(d.opportunities()).toBe(r.opps);
    expect(flipSpy.n).toBe(1);
  });

  it('every calc setting recomputes', () => {
    const { store, d } = setup();
    const alt: Partial<Settings> = {
      taxRate: 0.01,
      capital: 1,
      share: 0.5,
      cycleHours: 3,
      costMode: 'insta',
      sellMode: 'insta',
      forgeSlots: 5,
      orderSlots: 3,
      npcDailyLimit: 10,
      fillModel: 'pipelined',
      ahEnabled: false,
    };
    expect(Object.keys(alt).sort()).toEqual([...CALC_SETTINGS].sort());
    for (const k of CALC_SETTINGS) {
      const before = d.flips();
      const key = calcSettingsKey(store.get().settings);
      patch(store, { [k]: alt[k] });
      expect(calcSettingsKey(store.get().settings)).not.toBe(key);
      expect(d.flips(), k).not.toBe(before);
      expect(d.calcCtx()!.settings[k]).toBe(alt[k]);
    }
  });

  it('snapshot, catalog, historyTick and ah changes recompute', () => {
    const { store, d } = setup();
    let f = d.flips();
    for (const p of [{ snapshot: { ...snap } }, { catalog: { ...catalog } }, { historyTick: 1 }, { ah: { fetchedAt: 0, lastUpdated: 0, lowestBin: {} } }]) {
      store.set(p);
      expect(d.flips()).not.toBe(f);
      f = d.flips();
    }
  });

  it('fusion recomputes on recipe changes only (other results kept)', () => {
    const { store, d } = setup({ fusion: [] });
    const flips = d.flips();
    const fu = d.fusion();
    store.set({ fusion: [{ a: 'X', qa: 1, b: 'Y', qb: 1, out: 'Z', qo: 1 }] });
    expect(d.fusion()).not.toBe(fu);
    expect(d.fusion()).toBe(d.fusion());
    expect(d.flips()).toBe(flips);
  });

  it('ctx.ah is set only when ahEnabled and a scan exists', () => {
    const ah = { fetchedAt: 0, lastUpdated: 0, lowestBin: { HYPERION: { price: 5e8, count: 3 } } };
    const { store, d } = setup({ ah });
    expect(d.calcCtx()!.ah!('HYPERION')).toEqual({ price: 5e8, count: 3 });
    expect(d.calcCtx()!.ah!('NOPE')).toBeNull();
    patch(store, { ahEnabled: false });
    expect(d.calcCtx()!.ah).toBeUndefined();
    patch(store, { ahEnabled: true });
    store.set({ ah: null });
    expect(d.calcCtx()!.ah).toBeUndefined();
  });

  it('ctx.stats and marketStats delegate to history', () => {
    const { store, d, history, stats } = setup();
    expect(d.calcCtx()!.stats!('X')).toBeNull();
    expect(d.marketStats()).toBe(stats);
    expect(history.marketStats).toHaveBeenLastCalledWith(baseSettings.taxRate);
    patch(store, { taxRate: 0.01 });
    d.marketStats();
    expect(history.marketStats).toHaveBeenLastCalledWith(0.01);
  });
});
