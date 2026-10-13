import type { Route, RouteId } from '../types/contracts.ts';

const IDS: ReadonlySet<RouteId> = new Set<RouteId>(['flip', 'craft', 'fusion', 'npc', 'item']);

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "#/item/ENCHANTED_GOLD" -> {id:'item', param:'ENCHANTED_GOLD'}; "#/craft?q=gold" -> {id:'craft', query:{q:'gold'}}; unknown -> flip. */
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

  if (!IDS.has(head)) return { id: 'flip' };
  const r: Route = { id: head };
  if (head === 'item') {
    const param = safeDecode(segs.slice(1).join('/'));
    if (!param) return { id: 'flip' };
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
  destroy(): void;
}

/** Listens to hashchange and calls onRoute (also once immediately). */
export function createRouter(onRoute: (r: Route) => void): Router {
  let cur = parseHash(location.hash);
  const onHash = () => {
    cur = parseHash(location.hash);
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
    destroy() {
      window.removeEventListener('hashchange', onHash);
    },
  };
}
