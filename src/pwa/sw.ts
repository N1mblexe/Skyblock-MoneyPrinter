// Service worker (built to sw.js by the pwaPlugin in vite.config.ts, which fills in the precache list and version).
// Precaches the build so the app opens offline with its last saved snapshot; never touches Hypixel API requests.
import { cacheName, isOurCache, routeFor } from './swRoutes.ts';

/** replaced at build time with the built files (relative to the scope) */
const PRECACHE: string[] = JSON.parse('__PRECACHE_LIST__');
const VERSION = '__BUILD_VERSION__';

// the few ServiceWorkerGlobalScope members used here (tsconfig has no WebWorker lib)
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(r: Promise<Response>): void;
}
interface SwScope {
  registration: { scope: string };
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
}
const sw = self as unknown as SwScope;
const CACHE = cacheName(VERSION);
const scope = () => sw.registration.scope;

sw.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE.map((p) => new URL(p, scope()).href)))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => isOurCache(n) && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => sw.clients.claim()),
  );
});

/**
 * Our files are static: the same bytes whatever the request headers. Hosts send `Vary` (e.g. Origin), and module
 * scripts loaded with `crossorigin` carry an Origin header the precache requests did not, so match ignoring Vary.
 */
const MATCH = { ignoreVary: true };

async function put(req: Request, res: Response): Promise<void> {
  if (res.ok || res.type === 'opaque') await (await caches.open(CACHE)).put(req, res.clone());
}

async function cacheFirst(req: Request): Promise<Response> {
  const hit = await caches.match(req, MATCH);
  if (hit) return hit;
  const res = await fetch(req);
  await put(req, res);
  return res;
}

async function networkFirst(req: Request, navigation: boolean): Promise<Response> {
  try {
    const res = await fetch(req);
    await put(req, res);
    return res;
  } catch (err) {
    const hit = (await caches.match(req, MATCH)) ?? (navigation ? await caches.match(new URL('./', scope()).href, MATCH) : undefined);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req: Request): Promise<Response> {
  const hit = await caches.match(req, MATCH);
  const fresh = fetch(req)
    .then(async (res) => {
      await put(req, res);
      return res;
    })
    .catch(() => undefined);
  return hit ?? (await fresh) ?? Response.error();
}

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  const navigation = req.mode === 'navigate';
  const strategy = routeFor(req.url, req.method, scope(), navigation);
  if (strategy === 'bypass') return;
  e.respondWith(strategy === 'cache-first' ? cacheFirst(req) : strategy === 'stale-while-revalidate' ? staleWhileRevalidate(req) : networkFirst(req, navigation));
});
