// Shared test fakes. When HistoryRepo / ViewContext grow, update only this file.
import { vi } from 'vitest';
import { createDerived } from '../../src/state/derived.ts';
import type { AppState, HistoryRepo, Store, ViewContext } from '../../src/types/contracts.ts';

type BaseHistory = Pick<HistoryRepo, 'init' | 'record' | 'series' | 'recent' | 'stats' | 'saveLatest' | 'loadLatest'>;

/** HistoryRepo members beyond the per-item basics; spread into hand-written fakes. */
export const historyExtras: Pick<HistoryRepo, 'marketStats' | 'info' | 'clear'> = {
  marketStats: () => new Map(),
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
