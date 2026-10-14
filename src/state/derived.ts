// Memoized domain results shared by all views. Owner: history package (Wave 1 adds finer-grained memoization).
import { computeBookCombines } from '../domain/books.ts';
import { computeCrafts } from '../domain/craft.ts';
import { computeFlips } from '../domain/flip.ts';
import { computeFusion } from '../domain/fusion.ts';
import { computeNpcFlips } from '../domain/npc.ts';
import { toOpportunities } from '../domain/optimizer.ts';
import { computeShopRows } from '../domain/shops.ts';
import type { AppState, CalcCtx, Derived, HistoryRepo, Store } from '../types/contracts.ts';

/**
 * Wave 0 version: recomputes each result at most once per (snapshot, catalog, settings, fusion,
 * historyTick, ah) identity tuple.
 */
export function createDerived(store: Store<AppState>, history: HistoryRepo): Derived {
  let key: unknown[] = [];
  let ctx: CalcCtx | null = null;
  const memo = new Map<string, unknown>();

  function current(): CalcCtx | null {
    const s = store.get();
    const k = [s.snapshot, s.catalog, s.settings, s.fusion, s.historyTick, s.ah];
    if (k.some((v, i) => v !== key[i])) {
      key = k;
      memo.clear();
      ctx =
        s.snapshot && s.catalog
          ? {
              snap: s.snapshot,
              catalog: s.catalog,
              settings: s.settings,
              stats: (id) => history.stats(id),
              ah: s.ah ? (id) => s.ah!.lowestBin[id] ?? null : undefined,
            }
          : null;
    }
    return ctx;
  }

  function cached<T>(name: string, empty: T, fn: (c: CalcCtx) => T): () => T {
    return () => {
      const c = current();
      if (!c) return empty;
      if (!memo.has(name)) memo.set(name, fn(c));
      return memo.get(name) as T;
    };
  }

  const d: Derived = {
    calcCtx: current,
    flips: cached('flips', [], computeFlips),
    crafts: cached('crafts', [], computeCrafts),
    npc: cached('npc', [], computeNpcFlips),
    books: cached('books', [], computeBookCombines),
    shops: cached('shops', [], computeShopRows),
    fusion: cached('fusion', [], (c) => computeFusion(c, store.get().fusion)),
    opportunities: cached('opps', [], (c) =>
      toOpportunities({ flips: d.flips(), crafts: d.crafts(), books: d.books(), npc: d.npc() }, c.settings),
    ),
    marketStats: () => {
      current();
      return history.marketStats(store.get().settings.taxRate);
    },
  };
  return d;
}
