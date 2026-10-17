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
    expect(d.kat()).toEqual([]);
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
      conservative: true,
      bitsMultiplier: 2,
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

  it('kat: Kat page defaults, fed to the planner, recomputed on AH and election changes', () => {
    const kat = [{ pet: 'TESTPET', from: 3, to: 4, coins: 1_000_000, hours: 24, items: [] }];
    const ah = { v: 3, fetchedAt: 0, lastUpdated: 0, lowestBin: { 'TESTPET;3': { price: 1e6, count: 5 }, 'TESTPET;4': { price: 1e7, count: 5 } } };
    const { store, d } = setup({ catalog: { ...catalog, kat }, ah });
    const rows = d.kat();
    expect(rows.map((r) => r.key)).toEqual(['TESTPET;3>4:any']);
    expect(rows[0]!.skipCost).toBe(0); // no skip items
    expect(d.kat()).toBe(rows);
    expect(d.opportunities().filter((o) => o.kind === 'kat').map((o) => [o.key, o.group])).toEqual([['kat:TESTPET;3>4:any', 'kat']]);
    store.set({ election: { year: 1, mayor: { key: 'derpy', name: 'Derpy', perks: [] }, minister: null, fetchedAt: 0 } });
    expect(d.kat()).not.toBe(rows);
    expect(d.kat()[0]!.sellNet).toBeLessThan(rows[0]!.sellNet); // Derpy's claim tax
    store.set({ ah: { ...ah, lowestBin: {} } });
    expect(d.kat()).toEqual([]);
    store.set({ ah });
    patch(store, { ahEnabled: false });
    expect(d.kat()).toEqual([]);
    patch(store, { ahEnabled: true });
    // a pre-v3 scan (no pet XP, no @MAX keys): no rows, as the Kat page shows none
    store.set({ ah: { ...ah, v: 2 } });
    expect(d.kat()).toEqual([]);
    const { v: _v, ...noVersion } = ah;
    store.set({ ah: noVersion });
    expect(d.kat()).toEqual([]);
    expect(d.opportunities().some((o) => o.kind === 'kat')).toBe(false);
  });

  it('kat: settings.taming drops upgrades past your level, without recomputing the rest', () => {
    const kat = [{ pet: 'TESTPET', from: 3, to: 4, coins: 1_000_000, hours: 24, items: [] }];
    const ah = { v: 3, fetchedAt: 0, lastUpdated: 0, lowestBin: { 'TESTPET;3': { price: 1e6, count: 5 }, 'TESTPET;4': { price: 1e7, count: 5 } } };
    const { store, d } = setup({ catalog: { ...catalog, kat }, ah });
    const ctx = d.calcCtx();
    const flips = d.flips();
    const rows = d.kat();
    const opps = d.opportunities();
    expect(rows).toHaveLength(1);
    patch(store, { taming: 19 }); // Legendary needs 20
    expect(d.calcCtx()).toBe(ctx);
    expect(d.flips()).toBe(flips);
    expect(d.kat()).toEqual([]);
    expect(d.opportunities()).not.toBe(opps);
    expect(d.opportunities().some((o) => o.kind === 'kat')).toBe(false);
    patch(store, { taming: 20 });
    expect(d.kat()).toEqual(rows);
    expect(d.opportunities().filter((o) => o.kind === 'kat')).toHaveLength(1);
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
