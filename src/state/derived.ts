// Memoized domain results shared by all views. Owner: s1/state.
import { catalogFromFile } from '../data/catalog.ts';
import { computeAhFlips, computeGeorgeFlips, type AhFlipRow } from '../domain/ahFlips.ts';
import { computeBookCombines } from '../domain/books.ts';
import { computeChains } from '../domain/chains.ts';
import { computeCrafts } from '../domain/craft.ts';
import { computeFlips } from '../domain/flip.ts';
import { computeFusion } from '../domain/fusion.ts';
import { computeKatFlips, KAT_DERIVED_SKIP, katScanReady } from '../domain/kat.ts';
import { createMarketCore, salesLookup } from '../domain/market.ts';
import { computeNpcFlips } from '../domain/npc.ts';
import { toOpportunities } from '../domain/optimizer.ts';
import { computeShopRows } from '../domain/shops.ts';
import type { AppState, CalcCtx, Catalog, Derived, HistoryRepo, Settings, Store } from '../types/contracts.ts';

/** Settings that change computed numbers. Display-only ones (lang, theme, density, notify, hideSuspicious, autoRefresh) are left out. */
export const CALC_SETTINGS = [
  'taxRate',
  'capital',
  'share',
  'cycleHours',
  'costMode',
  'sellMode',
  'forgeSlots',
  'orderSlots',
  'npcDailyLimit',
  'fillModel',
  'ahEnabled',
  'conservative',
  'bitsMultiplier',
] as const satisfies readonly (keyof Settings)[];

/** Settings the market core (quotes, risk, conservatism, NPC legs) reads: part of the market key. */
export const MARKET_SETTINGS = [
  'taxRate',
  'share',
  'costMode',
  'sellMode',
  'npcDailyLimit',
  'conservative',
  'cycleHours',
] as const satisfies readonly (typeof CALC_SETTINGS)[number][];

/** Settings that only size trades (capital, slots, fill model): rows are re-planned, the core is kept. */
export const THROUGHPUT_SETTINGS = ['capital', 'orderSlots', 'forgeSlots', 'fillModel'] as const satisfies readonly (typeof CALC_SETTINGS)[number][];

const keyOf = (s: Settings, keys: readonly (keyof Settings)[]): string => keys.map((k) => String(s[k])).join('|');

/** Memo key of the calc-relevant settings. */
export function calcSettingsKey(s: Settings): string {
  return keyOf(s, CALC_SETTINGS);
}

/** Mayor Derpy quadruples the AH claim tax. */
export const isDerpy = (e: AppState['election']): boolean => e?.mayor?.key.toLowerCase() === 'derpy';

const same = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

type StatsAll = ReturnType<HistoryRepo['statsAll']>;

/**
 * Domain results, each memoized on exactly what it reads (by identity, or by the values of its settings):
 *
 *  - bazaar key: snapshot, catalog, MARKET_SETTINGS, historyTick, Derpy. One plain context per bazaar key makes
 *    ONE history.statsAll(taxRate) call, on first use, and pins it for the key: `ctx.stats` / `ctx.market` read its
 *    maps, so stats can't slide mid-tick (nor on an AH update).
 *  - core key: the bazaar key + the AH part (the AH scan and the AH sales feed, both null when !ahEnabled). One base
 *    context per core key holds the market core (`ctx.core`), built over the AH part, so nothing the core memoizes
 *    (risk, quotes, AH legs) outlives the data it came from.
 *  - throughput: THROUGHPUT_SETTINGS.
 *
 *  | function               | depends on                                                   |
 *  |------------------------|--------------------------------------------------------------|
 *  | flips, books, npc      | bazaar key + throughput                                      |
 *  | fusion                 | bazaar key + throughput + fusion recipes                     |
 *  | crafts, chains         | core key + throughput                                        |
 *  | kat                    | calcCtx() (core key + all calc settings), taming, scan version |
 *  | shops                  | core key                                                     |
 *  | ahFlips                | AH scan + sales + catalog + ahEnabled, conservative, share, Derpy|
 *  | George flips           | AH scan + catalog + ahEnabled + cycleHours (georgeFlips)     |
 *  | opportunities          | the row sets above (AH and George flips as 'ahflip') + calcCtx() |
 *  | marketStats            | taxRate (history.marketStats, memoized there per record/minute) |
 *
 * flips / books / npc / fusion trade the bazaar and NPCs only: they get a context without AH accessors, computed on
 * the current core but kept across AH updates (their rows don't change with it). calcCtx() is the full context
 * (every calc setting and the AH accessors). Contexts keep their identity while their inputs hold, as per-context
 * memos (getPricer) rely on that. A context's `settings` is the object it was built from: read display settings
 * from the store, not from calcCtx().settings. Changing lang/theme/density/notify/hideSuspicious/autoRefresh
 * recomputes nothing.
 */
export function createDerived(store: Store<AppState>, history: HistoryRepo): Derived {
  let bazaarKey: readonly unknown[] = [];
  let plain: CalcCtx | null = null;
  let coreKey: readonly unknown[] = [];
  let base: CalcCtx | null = null;
  /** the base context's AH accessors (the core reads the same ones) */
  let baseAh: Pick<CalcCtx, 'ah' | 'ahSales'> = {};
  let tKey: readonly unknown[] = [];
  let tctx: CalcCtx | null = null;
  let fKey: readonly unknown[] = [];
  let fctx: CalcCtx | null = null;
  const memos = new Map<string, { deps: readonly unknown[]; value: unknown }>();

  function memo<T>(name: string, deps: readonly unknown[], fn: () => T): T {
    const m = memos.get(name);
    if (m && same(m.deps, deps)) return m.value as T;
    const value = fn();
    memos.set(name, { deps, value });
    return value;
  }

  /** snapshot, catalog, market settings and the pinned history stats; no core, no AH */
  function plainCtx(s: AppState): CalcCtx | null {
    // catalog failed to load: flips/NPC still work with id-derived names
    if (!s.snapshot || !(s.catalog || s.catalogError)) return null;
    const derpy = isDerpy(s.election);
    const k = [s.snapshot, s.catalog, keyOf(s.settings, MARKET_SETTINGS), s.historyTick, derpy];
    if (plain && same(k, bazaarKey)) return plain;
    bazaarKey = k;
    const taxRate = s.settings.taxRate;
    let all: StatsAll | null = null;
    const stats = () => (all ??= history.statsAll(taxRate));
    return (plain = {
      snap: s.snapshot,
      catalog: s.catalog ?? emptyCatalog(),
      settings: s.settings,
      stats: (id) => stats().price.get(id) ?? null,
      market: (id) => stats().market.get(id) ?? null,
      derpy,
    });
  }

  /** the AH scan and sales feed in use: null when the AH is off */
  const ahPart = (s: AppState) => (s.settings.ahEnabled ? ([s.ah, s.ahSales] as const) : ([null, null] as const));
  const throughput = (s: AppState) => keyOf(s.settings, THROUGHPUT_SETTINGS);

  /** the plain context + the market core over the AH part (the core's own context has the AH accessors) */
  function marketCtx(s: AppState): CalcCtx | null {
    const p = plainCtx(s);
    if (!p) return null;
    const [ah, sales] = ahPart(s);
    const k = [p, ah, sales];
    if (base && same(k, coreKey)) return base;
    coreKey = k;
    baseAh = {
      ah: ah ? (id) => ah.lowestBin[id] ?? null : undefined,
      ahSales: sales ? salesLookup(sales) : undefined,
    };
    return (base = { ...p, core: createMarketCore({ ...p, ...baseAh }) });
  }

  /** base + current throughput settings, no AH accessors */
  function tradeCtx(s: AppState, b: CalcCtx): CalcCtx {
    const k = [b, throughput(s)];
    if (!tctx || !same(k, tKey)) {
      tKey = k;
      tctx = { ...b, settings: s.settings };
    }
    return tctx;
  }

  /** base + every calc setting + the AH accessors */
  function fullCtx(s: AppState, b: CalcCtx): CalcCtx {
    const k = [b, calcSettingsKey(s.settings)];
    if (!fctx || !same(k, fKey)) {
      fKey = k;
      fctx = { ...b, settings: s.settings, ...baseAh };
    }
    return fctx;
  }

  /** memoized on the bazaar key + throughput and `extra` (not on the AH part: bazaar / NPC trades only) */
  function trade<T>(name: string, empty: T, fn: (c: CalcCtx) => T, extra: readonly unknown[] = []): T {
    const s = store.get();
    const b = marketCtx(s);
    if (!b) return empty;
    return memo(name, [plain, throughput(s), ...extra], () => fn(tradeCtx(s, b)));
  }

  /** memoized on the core key and the throughput settings (unless `noThroughput`); gets calcCtx() */
  function withAh<T>(name: string, empty: T, fn: (c: CalcCtx) => T, noThroughput = false): T {
    const s = store.get();
    const b = marketCtx(s);
    if (!b) return empty;
    return memo(name, [b, noThroughput ? null : throughput(s)], () => fn(fullCtx(s, b)));
  }

  function current(): CalcCtx | null {
    const s = store.get();
    const b = marketCtx(s);
    return b && fullCtx(s, b);
  }

  const d: Derived = {
    calcCtx: current,
    flips: () => trade('flips', [], computeFlips),
    books: () => trade('books', [], computeBookCombines),
    npc: () => trade('npc', [], computeNpcFlips),
    fusion: () => {
      const recipes = store.get().fusion;
      return trade('fusion', [], (c) => computeFusion(c, recipes), [recipes]);
    },
    crafts: () => withAh('crafts', [], computeCrafts),
    chains: (start = 'bazaar') => withAh(`chains:${start}`, [], (c) => computeChains(c, start)),
    shops: () => withAh('shops', [], computeShopRows, true),
    // the Kat page's defaults: skip items when they pay (KAT_DERIVED_SKIP). settings.taming is not in CALC_SETTINGS (it only drops rows), so the
    // Kat results and the opportunities built from them are memoized per Taming level
    kat: () => {
      const c = current();
      if (!c) return [];
      const { ah, settings } = store.get();
      const taming = settings.taming;
      return memo('kat', [c, ah, taming], () => (katScanReady(ah) ? computeKatFlips(c, { skip: KAT_DERIVED_SKIP, taming }) : []));
    },
    // AH flips read the scan, sales, Derpy, conservatism and share, nothing else from the context
    ahFlips: () => {
      const s = store.get();
      const b = marketCtx(s);
      if (!b) return [];
      const derpy = isDerpy(s.election);
      const sales = s.ahSales;
      const { conservative, share } = s.settings;
      return memo('ahFlips', [s.ah, sales, b.catalog, s.settings.ahEnabled, conservative, share, derpy], () =>
        s.ah && s.settings.ahEnabled
          ? computeAhFlips(s.ah, b.catalog, { derpy, conservative, share, ...(sales ? { sales: salesLookup(sales) } : {}) })
          : [],
      );
    },
    // AH and George flips join as kind 'ahflip' (the planner leaves them out unless asked: AH_FLIP.plannerDefault)
    opportunities: () => {
      const c = current();
      if (!c) return [];
      const ah = d.ahFlips();
      const george = georgeFlips(store.get(), c.catalog);
      const rows = { flips: d.flips(), crafts: d.crafts(), chains: d.chains(), books: d.books(), npc: d.npc(), kat: d.kat() };
      return memo('opps', [c, ...Object.values(rows), ah, george], () => toOpportunities({ ...rows, ahFlips: [...ah, ...george] }));
    },
    // history's own memo (a new record or minute): the same map as the pinned sweep's while that is current. Views
    // read it once per render; the rows' ctx.market / ctx.stats stay pinned to the tick they were computed on.
    marketStats: () => history.marketStats(store.get().settings.taxRate),
  };
  return d;
}

let george: { deps: readonly unknown[]; rows: AhFlipRow[] } | null = null;

/**
 * George flips of the current AH scan ([] without one or with the AH off), memoized on the scan, the catalog and
 * cycleHours: the planner and the market alerts share them.
 */
export function georgeFlips(s: AppState, catalog: Catalog): AhFlipRow[] {
  const ah = s.settings.ahEnabled ? s.ah : null;
  const deps = [ah, catalog, s.settings.cycleHours];
  if (george && same(george.deps, deps)) return george.rows;
  george = { deps, rows: ah ? computeGeorgeFlips(ah, catalog, { cycleHours: s.settings.cycleHours }) : [] };
  return george.rows;
}

let empty: Catalog | null = null;
function emptyCatalog(): Catalog {
  return (empty ??= catalogFromFile({ v: 1, generatedAt: '', items: {}, recipes: [] }));
}
