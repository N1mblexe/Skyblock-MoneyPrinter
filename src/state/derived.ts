// Memoized domain results shared by all views. Owner: history package.
import { catalogFromFile } from '../data/catalog.ts';
import { computeBookCombines } from '../domain/books.ts';
import { computeChains } from '../domain/chains.ts';
import { computeCrafts } from '../domain/craft.ts';
import { computeFlips } from '../domain/flip.ts';
import { computeFusion } from '../domain/fusion.ts';
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
] as const satisfies readonly (keyof Settings)[];

/** Memo key of the calc-relevant settings. */
export function calcSettingsKey(s: Settings): string {
  return CALC_SETTINGS.map((k) => String(s[k])).join('|');
}

/**
 * Domain results memoized on what they depend on: (snapshot, catalog, calc settings, historyTick, ah) identities;
 * fusion() also on the fusion recipes. Changing lang/theme/density/notify/hideSuspicious/autoRefresh recomputes
 * nothing. calcCtx() keeps its identity while that key holds, so its `settings` is the object the key was built
 * from: read display settings from the store, not from calcCtx().settings.
 * ctx.ah is only set when settings.ahEnabled.
 */
/** Mayor Derpy quadruples the AH claim tax. */
export const isDerpy = (e: AppState['election']): boolean => e?.mayor?.key.toLowerCase() === 'derpy';

export function createDerived(store: Store<AppState>, history: HistoryRepo): Derived {
  let key: unknown[] = [];
  let ctx: CalcCtx | null = null;
  const memo = new Map<string, unknown>();
  let fusionMemo: { ctx: CalcCtx; recipes: AppState['fusion']; rows: ReturnType<typeof computeFusion> } | null = null;

  function current(): CalcCtx | null {
    const s = store.get();
    const derpy = isDerpy(s.election);
    const k = [s.snapshot, s.catalog, calcSettingsKey(s.settings), s.historyTick, s.ah, derpy];
    if (k.some((v, i) => v !== key[i])) {
      key = k;
      memo.clear();
      const ah = s.settings.ahEnabled ? s.ah : null;
      ctx =
        s.snapshot && (s.catalog || s.catalogError)
          ? {
              snap: s.snapshot,
              // catalog failed to load: flips/NPC still work with id-derived names
              catalog: s.catalog ?? emptyCatalog(),
              settings: s.settings,
              stats: (id) => history.stats(id),
              ah: ah ? (id) => ah.lowestBin[id] ?? null : undefined,
              derpy,
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
    chains: (start = 'bazaar') => cached(`chains:${start}`, [], (c) => computeChains(c, start))(),
    npc: cached('npc', [], computeNpcFlips),
    books: cached('books', [], computeBookCombines),
    shops: cached('shops', [], computeShopRows),
    fusion: () => {
      const c = current();
      if (!c) return [];
      const recipes = store.get().fusion;
      if (fusionMemo?.ctx !== c || fusionMemo.recipes !== recipes) fusionMemo = { ctx: c, recipes, rows: computeFusion(c, recipes) };
      return fusionMemo.rows;
    },
    opportunities: cached('opps', [], (c) =>
      toOpportunities({ flips: d.flips(), crafts: d.crafts(), chains: d.chains(), books: d.books(), npc: d.npc() }, c.settings),
    ),
    marketStats: () => history.marketStats(store.get().settings.taxRate),
  };
  return d;
}

let empty: Catalog | null = null;
function emptyCatalog(): Catalog {
  return (empty ??= catalogFromFile({ v: 1, generatedAt: '', items: {}, recipes: [] }));
}
