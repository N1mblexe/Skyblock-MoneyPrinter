import type { Route, RouteId } from '../types/contracts.ts';

const IDS: ReadonlySet<RouteId> = new Set<RouteId>(['overview', 'flip', 'ahflip', 'craft', 'forge', 'books', 'npc', 'fusion', 'plan', 'sell', 'trades', 'watch', 'item']);
export const DEFAULT_ROUTE: Route = { id: 'overview' };

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "#/item/ENCHANTED_GOLD" -> {id:'item', param:'ENCHANTED_GOLD'}; "#/craft?q=gold" -> {id:'craft', query:{q:'gold'}}; unknown -> overview. */
export function parseHash(hash: string): Route {
  let s = hash.startsWith('#') ? hash.slice(1) : hash;
  const qi = s.indexOf('?');
  const qs = qi >= 0 ? s.slice(qi + 1) : '';
  if (qi >= 0) s = s.slice(0, qi);
  const segs = s.split('/').filter((x) => x !== '');
  const head = (segs[0] ?? '').toLowerCase() as RouteId;

  let query: Record<string, string> | undefined;
  if (qs) {
    const q: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(qs)) q[k] = v;
    if (Object.keys(q).length) query = q;
  }

  if (!IDS.has(head)) return { ...DEFAULT_ROUTE };
  // Craft and Forge used to be one page with a kind filter: #/craft?kind=forge is now #/forge
  if (head === 'craft' && query?.kind) {
    const { kind, ...rest } = query;
    query = Object.keys(rest).length ? rest : undefined;
    if (kind === 'forge') return query ? { id: 'forge', query } : { id: 'forge' };
  }
  const r: Route = { id: head };
  if (head === 'item') {
    const param = safeDecode(segs.slice(1).join('/'));
    if (!param) return { ...DEFAULT_ROUTE };
    r.param = param;
  }
  if (query) r.query = query;
  return r;
}

export function routeToHash(r: Route): string {
  let s = `#/${r.id}`;
  if (r.id === 'item' && r.param) s += `/${encodeURIComponent(r.param)}`;
  if (r.query) {
    const qs = new URLSearchParams(r.query).toString();
    if (qs) s += `?${qs}`;
  }
  return s;
}

export interface Router {
  current(): Route;
  navigate(r: Route): void;
  /** Replace the URL without a history entry or hashchange (filters -> URL); calls onRoute. */
  replace(r: Route): void;
  destroy(): void;
}

/**
 * Listens to hashchange and calls onRoute (also once immediately).
 * An empty hash uses `initial()` (e.g. the last visited route), else the default route.
 */
export function createRouter(onRoute: (r: Route) => void, initial?: () => Route | null): Router {
  let cur = location.hash.replace(/^#\/?/, '') === '' ? (initial?.() ?? parseHash('')) : parseHash(location.hash);
  const onHash = () => {
    const next = parseHash(location.hash);
    // replace() already handled this URL (some environments fire hashchange on replaceState)
    if (routeToHash(next) === routeToHash(cur)) return;
    cur = next;
    onRoute(cur);
  };
  window.addEventListener('hashchange', onHash);
  onRoute(cur);
  return {
    current: () => cur,
    navigate(r) {
      const hash = routeToHash(r);
      if (hash === location.hash) return;
      location.hash = hash;
    },
    replace(r) {
      const hash = routeToHash(r);
      cur = parseHash(hash);
      if (hash !== location.hash) history.replaceState(history.state, '', hash);
      onRoute(cur);
    },
    destroy() {
      window.removeEventListener('hashchange', onHash);
    },
  };
}
