// Shared test fakes. When HistoryRepo / ViewContext grow, update only this file.
import { vi } from 'vitest';
import { createDerived } from '../../src/state/derived.ts';
import type { AppState, HistoryRepo, MarketStat, PriceStats, Store, ViewContext } from '../../src/types/contracts.ts';

type BaseHistory = Pick<HistoryRepo, 'init' | 'record' | 'series' | 'recent' | 'stats' | 'saveLatest' | 'loadLatest'>;

/**
 * A read-only map over `load()`, called on first use: statsAll's maps over a fake's own marketStats / stats, so
 * reading one map doesn't count as a read of the other. `get` / `has` use `lookup` when given (per-id stats(), whose
 * ids a fake can't enumerate).
 */
class LazyMap<K, V> implements ReadonlyMap<K, V> {
  private m: ReadonlyMap<K, unknown> | null = null;
  constructor(
    private readonly load: () => ReadonlyMap<K, V> | ReadonlyMap<K, unknown>,
    private readonly lookup?: (k: K) => V | null | undefined,
  ) {}
  private map(): ReadonlyMap<K, unknown> {
    return (this.m ??= this.load());
  }
  get(k: K): V | undefined {
    return this.lookup ? (this.lookup(k) ?? undefined) : (this.map().get(k) as V | undefined);
  }
  has(k: K): boolean {
    return this.get(k) !== undefined;
  }
  get size(): number {
    return this.map().size;
  }
  forEach(cb: (v: V, k: K, m: ReadonlyMap<K, V>) => void): void {
    for (const [k, v] of this) cb(v, k, this);
  }
  *entries(): MapIterator<[K, V]> {
    for (const k of this.map().keys()) {
      const v = this.get(k);
      if (v !== undefined) yield [k, v];
    }
  }
  *keys(): MapIterator<K> {
    for (const [k] of this.entries()) yield k;
  }
  *values(): MapIterator<V> {
    for (const [, v] of this.entries()) yield v;
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}

/**
 * HistoryRepo members beyond the per-item basics; spread into hand-written fakes. statsAll is the naive one over the
 * fake's own stats() and marketStats() (read lazily, at most one marketStats call per statsAll), so a fake that
 * overrides those two needs no statsAll of its own.
 */
export const historyExtras: Pick<HistoryRepo, 'marketStats' | 'statsAll' | 'info' | 'clear'> = {
  marketStats: () => new Map(),
  statsAll(this: HistoryRepo, taxRate: number) {
    const market = new LazyMap<string, MarketStat>(() => this.marketStats(taxRate));
    const price = new LazyMap<string, PriceStats>(
      () => market,
      (id) => this.stats(id),
    );
    return { price, market };
  },
  info: () => ({ raw: 0, q15: 0, oldest: null, persistent: false }),
  clear: async () => {},
};

/** Empty in-memory history; override any member. */
export function fakeHistory<O extends Partial<HistoryRepo>>(over: O = {} as O): HistoryRepo & O {
  const base: BaseHistory = {
    init: async () => {},
    record: async () => {},
    series: async () => [],
    recent: () => [],
    stats: () => null,
    saveLatest: async () => {},
    loadLatest: async () => null,
  };
  return { ...base, ...historyExtras, ...over } as HistoryRepo & O;
}

/** ViewContext members added in round 2 (derived, setQuery, toast, watch). */
export function ctxExtras(store: Store<AppState>, history: HistoryRepo): Pick<ViewContext, 'derived' | 'setQuery' | 'toast' | 'watch'> {
  return {
    derived: createDerived(store, history),
    setQuery: vi.fn(),
    toast: vi.fn(),
    watch: {
      has: (id) => store.get().watchlist.some((w) => w.id === id),
      toggle: (id) =>
        store.set((s) => ({
          watchlist: s.watchlist.some((w) => w.id === id)
            ? s.watchlist.filter((w) => w.id !== id)
            : [...s.watchlist, { id, addedAt: 0 }],
        })),
    },
  };
}

/** Full ViewContext over a store + history. */
export function fakeViewCtx(store: Store<AppState>, history: HistoryRepo = fakeHistory(), over: Partial<ViewContext> = {}): ViewContext {
  return {
    store,
    history,
    navigate: vi.fn(),
    t: (k) => k,
    refresh: async () => {},
    ...ctxExtras(store, history),
    ...over,
  };
}
