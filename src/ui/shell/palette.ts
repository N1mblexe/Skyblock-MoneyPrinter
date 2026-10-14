// Command palette providers: pages (NAV), commands, and bazaar items (catalog ranking + snapshot ids).
import { t } from '../../i18n/index.ts';
import { deriveName } from '../../domain/ids.ts';
import { matchesQuery, normalizeText, resolveUserInput, searchItems } from '../../domain/search.ts';
import type { AppState, Route, Store } from '../../types/contracts.ts';
import type { PaletteItem, PaletteProvider } from '../kit/index.ts';
import { NAV } from '../views/index.ts';
import { navHotkey } from './nav.ts';
import './i18n.ts';

/** Max item results per query. */
export const PALETTE_ITEMS = 30;

/** Bazaar product ids matching q: exact resolve first, then catalog ranking, then snapshot-only ids. */
export function searchBazaar(s: Pick<AppState, 'snapshot' | 'catalog'>, q: string, limit = PALETTE_ITEMS): string[] {
  const query = q.trim();
  if (!query) return [];
  const { snapshot: snap, catalog } = s;
  const ids = snap ? new Set(Object.keys(snap.products)) : null;
  const has = (id: string) => (ids ? ids.has(id) : !!catalog?.items[id]?.bazaar);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (out.length < limit && !seen.has(id) && has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  if (catalog) {
    const exact = resolveUserInput(catalog, query, ids ?? undefined);
    if (exact) push(exact);
    for (const i of searchItems(catalog, query, limit, (i) => has(i.id))) push(i.id);
  } else if (ids && ids.has(query.toUpperCase())) push(query.toUpperCase());
  if (out.length < limit && ids) {
    for (const id of [...ids].sort()) {
      if (out.length >= limit) break;
      if (catalog?.items[id]) continue; // ranked above
      if (matchesQuery(catalog, id, query)) push(id);
    }
  }
  return out;
}

export interface PaletteAction {
  id: string;
  /** label key (shell.act_*) or a function returning the label */
  label: () => string;
  hint?: string;
  run(): void;
}

const hit = (label: string, q: string) => !q || normalizeText(label).includes(normalizeText(q));

/** Pages from NAV (label, hotkey hint). */
export function pagesProvider(navigate: (r: Route) => void): PaletteProvider {
  return (q) =>
    NAV.filter((n) => hit(t(`common.nav_${n.id}`), q) || hit(n.id, q)).map(
      (n): PaletteItem => ({
        id: `page:${n.id}`,
        label: t(`common.nav_${n.id}`),
        hint: navHotkey(n.id),
        group: t('shell.grpPages'),
        run: () => navigate({ id: n.id }),
      }),
    );
}

/** Commands (refresh, theme, language, …). */
export function actionsProvider(actions: () => PaletteAction[]): PaletteProvider {
  return (q) =>
    actions()
      .filter((a) => hit(a.label(), q))
      .map((a): PaletteItem => ({ id: `act:${a.id}`, label: a.label(), hint: a.hint, group: t('shell.grpActions'), run: a.run }));
}

/** Bazaar items; Enter opens #/item/ID. */
export function itemsProvider(store: Store<AppState>, navigate: (r: Route) => void): PaletteProvider {
  return (q) => {
    const s = store.get();
    return searchBazaar(s, q).map(
      (id): PaletteItem => ({
        id: `item:${id}`,
        label: s.catalog ? s.catalog.name(id) : deriveName(id),
        hint: id,
        group: t('shell.grpItems'),
        run: () => navigate({ id: 'item', param: id }),
      }),
    );
  };
}
