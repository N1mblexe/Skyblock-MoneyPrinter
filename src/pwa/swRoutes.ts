// Service-worker routing (pure, unit-tested; bundled into sw.js by the pwaPlugin in vite.config.ts).
//   bypass                  Hypixel API and anything not ours: always live, never cached
//   cache-first             hashed build assets and icons: immutable
//   network-first           the page, the catalog and the manifest: fresh when online, cached copy offline
//   stale-while-revalidate  Google Fonts
export type SwStrategy = 'bypass' | 'cache-first' | 'network-first' | 'stale-while-revalidate';

const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

/** Strategy for one request. `scope` is the service worker's scope URL (ends with '/'). */
export function routeFor(url: string, method: string, scope: string, navigation: boolean): SwStrategy {
  if (method !== 'GET') return 'bypass';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'bypass';
  }
  if (FONT_HOSTS.has(u.hostname)) return 'stale-while-revalidate';
  if (!url.startsWith(scope)) return 'bypass';
  if (navigation) return 'network-first';
  const path = u.pathname.slice(new URL(scope).pathname.length);
  if (path === 'sw.js') return 'bypass';
  if (path.startsWith('assets/') || path.startsWith('icons/')) return 'cache-first';
  return 'network-first';
}

/** Cache name for a build; old caches (other versions) are deleted on activate. */
export const cacheName = (version: string): string => `bazaar-desk-${version}`;
export const isOurCache = (name: string): boolean => name.startsWith('bazaar-desk-');
