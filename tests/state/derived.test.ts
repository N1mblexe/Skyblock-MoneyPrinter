import { describe, expect, it, vi } from 'vitest';
import { AH_SALES } from '../../src/config.ts';
import { ahRate } from '../../src/domain/market.ts';
import { initialState } from '../../src/state/appState.ts';
import { CALC_SETTINGS, calcSettingsKey, createDerived, georgeFlips, MARKET_SETTINGS, THROUGHPUT_SETTINGS } from '../../src/state/derived.ts';
import { createStore } from '../../src/state/store.ts';
import type { AhSalesSnapshot, AppState, CalcCtx, MarketStat, PriceStats, Settings } from '../../src/types/contracts.ts';
import { baseSettings, catalog, snap } from '../domain/helpers.ts';
import { fakeHistory } from '../helpers/fakes.ts';

const flipSpy = vi.hoisted(() => ({ n: 0, ctx: null as unknown }));
vi.mock('../../src/domain/flip.ts', async (orig) => {
  const m = await orig<typeof import('../../src/domain/flip.ts')>();
  return { ...m, computeFlips: (...a: Parameters<typeof m.computeFlips>) => (flipSpy.n++, (flipSpy.ctx = a[0]), m.computeFlips(...a)) };
});

function setup(over: Partial<AppState> = {}) {
  const stats = new Map<string, MarketStat>();
  const price = new Map<string, PriceStats>();
  const history = fakeHistory({ marketStats: vi.fn(() => stats), statsAll: vi.fn(() => ({ price, market: stats })) });
  const store = createStore<AppState>({ ...initialState(baseSettings), snapshot: snap, catalog, ...over });
  return { store, history, stats, price, d: createDerived(store, history) };
}

const KAT = [{ pet: 'TESTPET', from: 3, to: 4, coins: 1_000_000, hours: 24, items: [] }];
const KAT_AH = { v: 3, fetchedAt: 0, lastUpdated: 0, lowestBin: { 'TESTPET;3': { price: 1e6, count: 5 }, 'TESTPET;4': { price: 1e7, count: 5 } } };
const sales = (perHour: number): AhSalesSnapshot => ({
  v: 1,
  updatedAt: 0,
  coverageHours: 3,
  byId: { HYPERION: { n: 5, items: 5, median: 5e8, perHour, coverageHours: 3, last: 0 } },
});

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

  it('every calc setting recomputes what reads it and changes calcCtx()', () => {
    const { store, d } = setup({ catalog: { ...catalog, kat: KAT }, ah: KAT_AH });
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
    expect([...MARKET_SETTINGS, ...THROUGHPUT_SETTINGS, 'ahEnabled', 'bitsMultiplier'].sort()).toEqual([...CALC_SETTINGS].sort());
    const flipSide = new Set<string>([...MARKET_SETTINGS, ...THROUGHPUT_SETTINGS]);
    expect(d.kat()).toHaveLength(1);
    for (const k of CALC_SETTINGS) {
      const before = { flips: d.flips(), crafts: d.crafts(), kat: d.kat(), ctx: d.calcCtx() };
      const key = calcSettingsKey(store.get().settings);
      patch(store, { [k]: alt[k] });
      expect(calcSettingsKey(store.get().settings)).not.toBe(key);
      expect(d.calcCtx(), k).not.toBe(before.ctx);
      expect(d.calcCtx()!.settings[k]).toBe(alt[k]);
      // ahEnabled and bitsMultiplier: flips read neither
      if (flipSide.has(k)) expect(d.flips(), k).not.toBe(before.flips);
      else expect(d.flips(), k).toBe(before.flips);
      if (k === 'ahEnabled') {
        expect(d.crafts()).not.toBe(before.crafts);
        expect(d.kat()).toEqual([]);
      }
      if (k === 'bitsMultiplier') {
        expect(d.crafts()).toBe(before.crafts);
        expect(d.kat()).not.toBe(before.kat);
      }
    }
  });

  it('snapshot, catalog and historyTick changes recompute everything; an AH change only what reads the AH', () => {
    const { store, d } = setup();
    let f = d.flips();
    for (const p of [{ snapshot: { ...snap } }, { catalog: { ...catalog } }, { historyTick: 1 }]) {
      const c = d.crafts();
      store.set(p);
      expect(d.flips()).not.toBe(f);
      expect(d.crafts()).not.toBe(c);
      f = d.flips();
    }
    const r = { flips: d.flips(), books: d.books(), npc: d.npc(), fusion: d.fusion(), crafts: d.crafts(), chains: d.chains(), shops: d.shops() };
    const core = d.calcCtx()!.core;
    flipSpy.n = 0;
    store.set({ ah: { fetchedAt: 0, lastUpdated: 0, lowestBin: {} } });
    expect(d.flips()).toBe(r.flips);
    expect(d.books()).toBe(r.books);
    expect(d.npc()).toBe(r.npc);
    expect(d.fusion()).toBe(r.fusion);
    expect(flipSpy.n).toBe(0);
    expect(d.crafts()).not.toBe(r.crafts);
    expect(d.chains()).not.toBe(r.chains);
    expect(d.shops()).not.toBe(r.shops);
    expect(d.calcCtx()!.core).not.toBe(core); // the core is keyed on the AH part
  });

  it('a capital change keeps the market core and recomputes flips, not shops', () => {
    const { store, d } = setup();
    const ctx = d.calcCtx()!;
    const core = ctx.core;
    expect(core).toBeDefined();
    const r = { flips: d.flips(), crafts: d.crafts(), shops: d.shops() };
    flipSpy.n = 0;
    patch(store, { capital: 1e9 });
    const next = d.calcCtx()!;
    expect(next).not.toBe(ctx);
    expect(next.settings.capital).toBe(1e9);
    expect(next.core).toBe(core);
    expect(d.flips()).not.toBe(r.flips);
    expect(flipSpy.n).toBe(1);
    expect((flipSpy.ctx as CalcCtx).settings.capital).toBe(1e9);
    expect((flipSpy.ctx as CalcCtx).core).toBe(core);
    expect(d.crafts()).not.toBe(r.crafts);
    expect(d.shops()).toBe(r.shops);
    // a market setting rebuilds it
    patch(store, { share: 0.2 });
    expect(d.calcCtx()!.core).not.toBe(core);
    expect(d.calcCtx()!.core!.ctx.settings.share).toBe(0.2);
  });

  it('contexts keep their identity while their inputs hold; trade rows get no AH accessors', () => {
    const ah = { fetchedAt: 0, lastUpdated: 0, lowestBin: { HYPERION: { price: 5e8, count: 3 } } };
    const { store, d } = setup({ ah });
    const c = d.calcCtx();
    expect(d.calcCtx()).toBe(c);
    d.flips();
    const fc = flipSpy.ctx as CalcCtx;
    expect(fc.ah).toBeUndefined();
    expect(fc.ahSales).toBeUndefined();
    expect(fc.core).toBe(c!.core);
    store.set({ nextPollAt: 1 });
    expect(d.calcCtx()).toBe(c);
    patch(store, { taming: 10 }); // Taming only drops Kat rows
    expect(d.calcCtx()).toBe(c);
    patch(store, { bitsMultiplier: 2 });
    d.flips();
    expect(flipSpy.ctx).toBe(fc);
  });

  it('an AH update builds a new core over the new AH data; the pinned stats stay', () => {
    const ah = { fetchedAt: 0, lastUpdated: 0, lowestBin: { HYPERION: { price: 5e8, count: 3 } } };
    const { store, d, history } = setup({ ah, ahSales: sales(2) });
    const core = d.calcCtx()!.core!;
    expect(core.ahBuy('HYPERION')).toMatchObject({ price: 5e8, rate: ahRate(2, store.get().settings.share), count: 3 });
    d.calcCtx()!.stats!('X');
    store.set({ ah: { ...ah, lowestBin: { HYPERION: { price: 4e8, count: 1 } } } });
    const next = d.calcCtx()!.core!;
    expect(next).not.toBe(core);
    expect(next.ahBuy('HYPERION')).toMatchObject({ price: 4e8, count: 1 });
    expect(core.ahBuy('HYPERION')).toMatchObject({ price: 5e8, count: 3 }); // an old core keeps its own data
    store.set({ ahSales: sales(200) });
    expect(d.calcCtx()!.core!.ahBuy('HYPERION')).toMatchObject({ rate: ahRate(200, store.get().settings.share) });
    patch(store, { ahEnabled: false });
    expect(d.calcCtx()!.core!.ahBuy('HYPERION')).toBeNull();
    d.calcCtx()!.stats!('X');
    expect(history.statsAll).toHaveBeenCalledTimes(1);
  });

  it('ctx.ahSales follows store.ahSales while ahEnabled; a sales update recomputes crafts, not flips', () => {
    const { store, d } = setup({ ahSales: sales(2) });
    expect(d.calcCtx()!.ahSales!('HYPERION')!.perHour).toBe(2);
    // the feed covered 3 h: an id it doesn't hold sold nothing
    expect(d.calcCtx()!.ahSales!('NOPE')).toEqual({ n: 0, items: 0, median: 0, perHour: 0, coverageHours: 3, last: 0 });
    const r = { flips: d.flips(), crafts: d.crafts() };
    store.set({ ahSales: sales(3) });
    expect(d.calcCtx()!.ahSales!('HYPERION')!.perHour).toBe(3);
    expect(d.flips()).toBe(r.flips);
    expect(d.crafts()).not.toBe(r.crafts);
    patch(store, { ahEnabled: false });
    expect(d.calcCtx()!.ahSales).toBeUndefined();
    patch(store, { ahEnabled: true });
    store.set({ ahSales: null });
    expect(d.calcCtx()!.ahSales).toBeUndefined();
    // below AH_SALES.minCoverageHours an absent id is no data
    store.set({ ahSales: { ...sales(2), coverageHours: AH_SALES.minCoverageHours - 1 } });
    expect(d.calcCtx()!.ahSales!('NOPE')).toBeNull();
  });

  it('ahFlips: memoized on the AH scan, catalog and ahEnabled', () => {
    const ah = { fetchedAt: 0, lastUpdated: 0, lowestBin: {} };
    const { store, d } = setup({ ah });
    const rows = d.ahFlips();
    expect(d.ahFlips()).toBe(rows);
    patch(store, { capital: 1 });
    store.set({ historyTick: 3 });
    expect(d.ahFlips()).toBe(rows);
    store.set({ ah: { ...ah } });
    expect(d.ahFlips()).not.toBe(rows);
    patch(store, { ahEnabled: false });
    expect(d.ahFlips()).toEqual([]);
    store.set({ snapshot: null });
    expect(d.ahFlips()).toEqual([]);
  });

  it('ahFlips: the sales feed and conservatism cap the relist price at the median sold', () => {
    // 2 listings at 1e8 / 3e8 (count 5): relist just under 3e8, or at the 2e8 median sold once sales are in
    const ah = { v: 4, fetchedAt: 0, lastUpdated: 0, lowestBin: { HYPERION: { price: 1e8, next: 3e8, count: 5 } } };
    const feed: AhSalesSnapshot = { v: 1, updatedAt: 0, coverageHours: 3, byId: { HYPERION: { n: 5, items: 5, median: 2e8, perHour: 2, coverageHours: 3, last: 0 } } };
    const { store, d } = setup({ ah, ahSales: feed });
    patch(store, { conservative: true });
    const [row] = d.ahFlips();
    expect(row).toMatchObject({ key: 'ah:HYPERION', sellAt: 2e8, sellRef: 3e8 - 1, salesPerHour: 2 });
    expect(d.ahFlips()).toBe(d.ahFlips());
    expect(d.calcCtx()!.ahSales!('NOPE')!.perHour).toBe(0);
    // an id that sold nothing over the 3 h covered: measured 0, the flip doesn't sell
    store.set({ ah: { ...ah, lowestBin: { ...ah.lowestBin, TERMINATOR: { price: 1e8, next: 3e8, count: 5 } } } });
    expect(d.ahFlips().find((r) => r.id === 'TERMINATOR')).toMatchObject({ salesPerHour: 0, profitPerHour: 0, sellHours: Infinity });
    // too little coverage: unmeasured, the default rate
    store.set({ ahSales: { ...feed, coverageHours: 1 } });
    expect(d.ahFlips().find((r) => r.id === 'TERMINATOR')!.salesPerHour).toBeNull();
    patch(store, { conservative: false });
    expect(d.ahFlips().find((r) => r.id === 'HYPERION')!.sellRef).toBeUndefined();
  });

  it('opportunities: AH and George flips join as kind ahflip; George flips are memoized on scan, catalog and cycle', () => {
    const ah = { v: 4, fetchedAt: 0, lastUpdated: 0, lowestBin: { HYPERION: { price: 1e8, next: 3e8, count: 5 }, 'BEE;1': { price: 100, count: 3, prices: [100, 200] } } };
    const cat = { ...catalog, george: { 'BEE;1': 500 } };
    const { store, d } = setup({ ah, catalog: cat });
    const keys = d.opportunities().filter((o) => o.kind === 'ahflip').map((o) => o.key);
    expect(keys).toEqual(['ahflip:ah:HYPERION', 'ahflip:george:BEE;1']);
    const s = store.get();
    const g = georgeFlips(s, cat);
    expect(g).toHaveLength(1);
    expect(georgeFlips({ ...s }, cat)).toBe(g);
    expect(georgeFlips({ ...s, settings: { ...s.settings, cycleHours: 2 } }, cat)).not.toBe(g);
    expect(georgeFlips({ ...s, settings: { ...s.settings, ahEnabled: false } }, cat)).toEqual([]);
    patch(store, { ahEnabled: false });
    expect(d.opportunities().some((o) => o.kind === 'ahflip')).toBe(false);
  });

  it('stats are read once per historyTick (one statsAll call, pinned)', () => {
    const { store, d, history, price } = setup({ catalog: { ...catalog, kat: KAT }, ah: KAT_AH });
    const statsAll = history.statsAll as ReturnType<typeof vi.fn>;
    const st: PriceStats = { n: 50, medianAsk: 10, medianBid: 9, madAsk: 1, madBid: 1, change24h: null };
    price.set('X', st);
    expect(statsAll).not.toHaveBeenCalled(); // lazily, on the first read
    d.opportunities();
    d.shops();
    d.fusion();
    d.ahFlips();
    expect(d.calcCtx()!.stats!('X')).toBe(st);
    expect(d.calcCtx()!.market!('X')).toBeNull();
    d.marketStats();
    patch(store, { capital: 1 }); // a throughput change keeps the pinned stats
    d.flips();
    expect(d.calcCtx()!.stats!('X')).toBe(st);
    expect(statsAll).toHaveBeenCalledTimes(1);
    expect(statsAll).toHaveBeenLastCalledWith(baseSettings.taxRate);
    store.set({ historyTick: 1 });
    d.opportunities();
    d.calcCtx()!.stats!('X');
    d.calcCtx()!.stats!('Y');
    expect(statsAll).toHaveBeenCalledTimes(2);
    patch(store, { taxRate: 0.01 });
    d.calcCtx()!.stats!('X');
    expect(statsAll).toHaveBeenLastCalledWith(0.01);
    expect(statsAll).toHaveBeenCalledTimes(3);
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

  it('ctx.stats come from the pinned sweep; marketStats from history.marketStats (its own memo), once per call', () => {
    const { store, d, history, stats } = setup({ snapshot: null });
    expect(d.marketStats()).toBe(stats);
    expect(history.marketStats).toHaveBeenLastCalledWith(baseSettings.taxRate);
    expect(history.statsAll).not.toHaveBeenCalled();
    store.set({ snapshot: snap });
    expect(d.calcCtx()!.stats!('X')).toBeNull();
    expect(history.statsAll).toHaveBeenLastCalledWith(baseSettings.taxRate);
    expect(d.marketStats()).toBe(stats);
    expect(history.marketStats).toHaveBeenCalledTimes(2);
    expect(history.statsAll).toHaveBeenCalledTimes(1);
  });
});
