import { describe, expect, it } from 'vitest';
import { cacheName, isOurCache, routeFor } from '../../src/pwa/swRoutes.ts';

const SCOPE = 'https://n1mblexe.github.io/Skyblock-MoneyPrinter/';
const r = (path: string, nav = false, method = 'GET') => routeFor(path.startsWith('http') ? path : SCOPE + path, method, SCOPE, nav);

describe('service worker routes', () => {
  it('never touches the Hypixel API or other sites, nor non-GET requests', () => {
    expect(r('https://api.hypixel.net/v2/skyblock/bazaar')).toBe('bypass');
    expect(r('https://example.com/x.js')).toBe('bypass');
    expect(r('assets/index-abc.js', false, 'POST')).toBe('bypass');
    expect(r('https://n1mblexe.github.io/other-repo/index.html')).toBe('bypass');
    expect(r('sw.js')).toBe('bypass');
  });

  it('hashed assets and icons: cache-first; page, catalog, manifest: network-first; fonts: stale-while-revalidate', () => {
    expect(r('assets/index-abc.js')).toBe('cache-first');
    expect(r('icons/icon-192.png')).toBe('cache-first');
    expect(r('', true)).toBe('network-first');
    expect(r('#/flip', true)).toBe('network-first');
    expect(r('data/catalog.json')).toBe('network-first');
    expect(r('manifest.webmanifest')).toBe('network-first');
    expect(r('https://fonts.gstatic.com/s/x.woff2')).toBe('stale-while-revalidate');
    expect(r('https://fonts.googleapis.com/css2?family=X')).toBe('stale-while-revalidate');
  });

  it('cache names carry the build version', () => {
    expect(cacheName('abc')).toBe('bazaar-desk-abc');
    expect(isOurCache('bazaar-desk-old')).toBe(true);
    expect(isOurCache('something-else')).toBe(false);
  });
});
