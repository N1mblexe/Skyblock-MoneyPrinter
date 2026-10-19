// Shared setup for the integration tests: boots the real app (src/app.ts) in happy-dom with stubbed network,
// fake IndexedDB, matchMedia and Notification. Not a test file itself.
//
// Each test file should boot the app once per test with a fresh module graph (bootApp does vi.resetModules), and
// call teardownApp() afterwards: bootstrap() has no destroy, so teardown removes every window/document listener
// the boot added and empties the DOM.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, vi, type MockInstance } from 'vitest';
import type { AppState, Store } from '../../src/types/contracts.ts';

/**
 * Every test boots the whole app (a fresh module graph, the strategies over the fixtures). Alone a boot takes well
 * under a second (the first in a file ~1.5 s, with the transforms), but with the whole suite running in parallel
 * on a loaded machine the 5 s default was sometimes hit; 30 s still fails a hang fast. waitFor's own budget below
 * is raised for the same reason. Real slowness shows in `npx vitest run tests/integration --reporter=verbose`.
 */
export const INTEGRATION_TIMEOUT_MS = 30_000;
vi.setConfig({ testTimeout: INTEGRATION_TIMEOUT_MS });

const ROOT = resolve(process.cwd());
const readJson = (rel: string): unknown => JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'));

export const BAZAAR_FIXTURE = readJson('tests/fixtures/bazaar.json') as {
  success: boolean;
  lastUpdated: number;
  products: Record<string, { product_id: string; sell_summary: { amount: number; pricePerUnit: number; orders: number }[]; buy_summary: { amount: number; pricePerUnit: number; orders: number }[]; quick_status: Record<string, number> }>;
};
const CATALOG = readJson('public/data/catalog.json');
const AH_PAGE = readJson('tests/fixtures/ah-page.json');
const ELECTION = readJson('tests/fixtures/election.json');
export const AH_ENDED = readJson('tests/fixtures/ah-ended.json') as { lastUpdated: number; auctions: { timestamp: number }[] };

/**
 * The auctions_ended fixture moved to `now` (lastUpdated and every sale), as Hypixel would serve it: a repeat poll
 * brings the same auction ids within the poller's dedupe window, and the sales never age out of AH_SALES.windowMs.
 */
export function endedNow(now = Date.now()): typeof AH_ENDED {
  const shift = now - AH_ENDED.lastUpdated;
  return { ...AH_ENDED, lastUpdated: now, auctions: AH_ENDED.auctions.map((a) => ({ ...a, timestamp: a.timestamp + shift })) };
}

export const clone = <T>(x: T): T => structuredClone(x);

/** Bazaar payload served by the stubbed fetch (fresh lastUpdated so the status pill shows "live"). */
export type BazaarPayload = typeof BAZAAR_FIXTURE;

export interface NetStub {
  fetch: ReturnType<typeof vi.fn>;
  /** bazaar payload served from now on; null -> HTTP 503 */
  setBazaar(p: BazaarPayload | null): void;
  /** serve the auctions_ended fixture (endedNow, the default) or, when false, HTTP 503 */
  setEnded(up: boolean): void;
  calls(part: string): number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => clone(body),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Bazaar fixture with lastUpdated = now - 5 s (or `at`). */
export function freshBazaar(at = Date.now() - 5_000): BazaarPayload {
  const b = clone(BAZAAR_FIXTURE);
  b.lastUpdated = at;
  return b;
}

/** Stub fetch per URL: bazaar, catalog, AH sales, AH, election. Anything else -> 404 (and recorded). */
export function stubNetwork(): NetStub {
  let bazaar: BazaarPayload | null = freshBazaar();
  let ended = true;
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/skyblock/bazaar')) return bazaar ? jsonResponse(bazaar) : jsonResponse({ success: false }, 503);
    if (url.includes('data/catalog.json')) return jsonResponse(CATALOG);
    // before the /skyblock/auctions match, which would catch it
    if (url.includes('/skyblock/auctions_ended')) return ended ? jsonResponse(endedNow()) : jsonResponse({ success: false }, 503);
    if (url.includes('/skyblock/auctions')) return jsonResponse(AH_PAGE);
    if (url.includes('/skyblock/election')) return jsonResponse(ELECTION);
    return jsonResponse({ success: false }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return {
    fetch: fn,
    setBazaar(p) {
      bazaar = p;
    },
    setEnded(up) {
      ended = up;
    },
    calls: (part) => fn.mock.calls.filter(([u]) => String(typeof u === 'string' ? u : (u as Request).url ?? u).includes(part)).length,
  };
}

/** matchMedia stand-in (desktop layout, dark scheme); listeners are tracked so leaks can be counted. */
export function stubMatchMedia(): { listeners: Set<unknown> } {
  const listeners = new Set<unknown>();
  const mm = vi.fn(
    (query: string) =>
      ({
        matches: query.includes('prefers-color-scheme: dark'),
        media: query,
        onchange: null,
        addEventListener: (_t: string, fn: unknown) => listeners.add(fn),
        removeEventListener: (_t: string, fn: unknown) => listeners.delete(fn),
        addListener: (fn: unknown) => listeners.add(fn),
        removeListener: (fn: unknown) => listeners.delete(fn),
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal('matchMedia', mm);
  Object.defineProperty(window, 'matchMedia', { value: mm, configurable: true, writable: true });
  return { listeners };
}

/** Notification stand-in with permission 'granted'; constructions are recorded. */
export function stubNotification(permission: NotificationPermission = 'granted'): { created: { title: string; body?: string }[] } {
  const created: { title: string; body?: string }[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => permission);
    constructor(title: string, opts?: NotificationOptions) {
      created.push({ title, body: opts?.body });
    }
    close(): void {}
  }
  vi.stubGlobal('Notification', FakeNotification);
  return { created };
}

// ---------------------------------------------------------------- listener tracking

type Key = { target: EventTarget; type: string; fn: unknown; capture: boolean };
const live: Key[] = [];
let patched = false;
const origAdd = new Map<EventTarget, EventTarget['addEventListener']>();
const origRemove = new Map<EventTarget, EventTarget['removeEventListener']>();

const capOf = (o: unknown): boolean => (typeof o === 'boolean' ? o : !!(o && typeof o === 'object' && (o as AddEventListenerOptions).capture));

/** Wrap window/document add/removeEventListener so live listeners can be counted (and removed on teardown). */
export function trackListeners(): void {
  if (patched) return;
  patched = true;
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    origAdd.set(target, add);
    origRemove.set(target, remove);
    target.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => {
      if (fn) {
        const capture = capOf(opts);
        if (!live.some((k) => k.target === target && k.type === type && k.fn === fn && k.capture === capture)) {
          const key: Key = { target, type, fn, capture };
          live.push(key);
          const signal = typeof opts === 'object' ? opts.signal : undefined;
          signal?.addEventListener('abort', () => drop(key), { once: true });
          if (typeof opts === 'object' && opts.once) {
            // a once-listener is gone after it ran; count it as removed on its first call
            const inner = fn;
            const wrapped = function (this: unknown, ev: Event) {
              drop(key);
              return typeof inner === 'function' ? inner.call(this, ev) : inner.handleEvent(ev);
            };
            key.fn = inner;
            return add(type, wrapped as EventListener, opts);
          }
        }
      }
      return add(type, fn, opts);
    }) as EventTarget['addEventListener'];
    target.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => {
      const capture = capOf(opts);
      const i = live.findIndex((k) => k.target === target && k.type === type && k.fn === fn && k.capture === capture);
      if (i >= 0) live.splice(i, 1);
      return remove(type, fn, opts);
    }) as EventTarget['removeEventListener'];
  }
}

function drop(k: Key): void {
  const i = live.indexOf(k);
  if (i >= 0) live.splice(i, 1);
}

/** Live window/document listeners as "window:hashchange" style keys (sorted). */
export function liveListeners(): string[] {
  return live.map((k) => `${k.target === window ? 'window' : 'document'}:${k.type}${k.capture ? '(capture)' : ''}`).sort();
}

/** Remove every tracked listener (the previous boot's router, hotkeys, poller...). */
function removeAllTracked(): void {
  for (const k of [...live]) origRemove.get(k.target)!(k.type, k.fn as EventListener, k.capture);
  live.length = 0;
}

// ---------------------------------------------------------------- boot

export interface Booted {
  root: HTMLElement;
  /** the app store (captured by wrapping createStore) */
  store: Store<AppState>;
  net: NetStub;
  notifications: { title: string; body?: string }[];
  errors: MockInstance<typeof console.error>;
  warns: MockInstance<typeof console.warn>;
  mm: { listeners: Set<unknown> };
  /** live app-store subscriptions and i18n onLangChange listeners (leak checks) */
  subs(): { store: number; lang: number };
  /** store.subscribe() calls so far (cumulative) */
  subscribeCalls(): number;
}

export interface BootOptions {
  hash?: string;
  /** localStorage entries set before boot (values are JSON-encoded unless raw strings are wanted: use `rawLs`) */
  ls?: Record<string, unknown>;
  rawLs?: Record<string, string>;
  /** wait for status 'live' + catalog before returning (default true) */
  waitLive?: boolean;
  /** keep the previous boot's IndexedDB (a page reload) */
  keepDb?: boolean;
  /** called with the network stub before bootstrap() */
  beforeBoot?: (net: NetStub) => void;
}

/** Fresh IndexedDB, stubs, module graph; then bootstrap(root). */
export async function bootApp(opts: BootOptions = {}): Promise<Booted> {
  trackListeners();
  if (!opts.keepDb) (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
  for (const [k, v] of Object.entries(opts.ls ?? {})) localStorage.setItem(k, JSON.stringify(v));
  for (const [k, v] of Object.entries(opts.rawLs ?? {})) localStorage.setItem(k, v);
  history.replaceState(null, '', opts.hash ?? '#');
  if (!opts.hash) history.replaceState(null, '', location.pathname);

  const net = stubNetwork();
  opts.beforeBoot?.(net);
  const mm = stubMatchMedia();
  const { created } = stubNotification();
  const errors = vi.spyOn(console, 'error');
  const warns = vi.spyOn(console, 'warn');
  window.scrollTo = (() => {}) as typeof window.scrollTo;

  vi.resetModules();
  const stores: Store<AppState>[] = [];
  let storeSubs = 0;
  let storeCalls = 0;
  let langSubs = 0;
  /** count an unsubscribe only once */
  const counted = (off: () => unknown, dec: () => void) => {
    let done = false;
    return () => {
      if (!done) {
        done = true;
        dec();
      }
      return off();
    };
  };
  vi.doMock('../../src/state/store.ts', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../src/state/store.ts')>();
    return {
      ...real,
      createStore: <S extends object>(init: S) => {
        const s = real.createStore(init);
        if (!('settings' in init && 'snapshot' in init)) return s;
        stores.push(s as unknown as Store<AppState>);
        const subscribe = s.subscribe;
        s.subscribe = (fn) => {
          storeSubs++;
          storeCalls++;
          return counted(subscribe(fn), () => storeSubs--) as () => void;
        };
        return s;
      },
    };
  });
  vi.doMock('../../src/i18n/index.ts', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../src/i18n/index.ts')>();
    return {
      ...real,
      onLangChange: (fn: Parameters<typeof real.onLangChange>[0]) => {
        langSubs++;
        return counted(real.onLangChange(fn), () => langSubs--) as () => boolean;
      },
    };
  });
  const { bootstrap } = await import('../../src/app.ts');
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  await bootstrap(root);
  const store = stores[0]!;
  const booted: Booted = { root, store, net, notifications: created, errors, warns, mm, subs: () => ({ store: storeSubs, lang: langSubs }), subscribeCalls: () => storeCalls };
  if (opts.waitLive !== false) {
    await waitFor(() => store.get().status === 'live' && !!store.get().catalog && !!store.get().snapshot, 'live + catalog');
    // let the background fetches (election, AH scan) finish so none is in flight at teardown
    await waitFor(
      () => store.get().election !== null && (!store.get().settings.ahEnabled || (store.get().ah !== null && store.get().ahProgress === null)),
      'election + AH scan',
    );
  }
  return booted;
}

export function teardownApp(): void {
  removeAllTracked();
  document.body.innerHTML = '';
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  vi.doUnmock('../../src/state/store.ts');
  vi.doUnmock('../../src/i18n/index.ts');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  // timers of the finished boot (pollers) must never reach happy-dom's real fetch
  vi.stubGlobal('fetch', () => Promise.reject(new Error('fetch after teardown')));
}

/** Poll `cond` on real timers (macrotasks) until true or `ms` passes. */
export async function waitFor(cond: () => boolean, what = 'condition', ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Let pending microtasks/macrotasks (IndexedDB, fetch stubs, rAF) settle. */
export const settle = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20));
};

/** Navigate by hash and wait until that route's view is mounted (store route + an h1 in the view). */
export async function go(b: Booted, hash: string): Promise<void> {
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  location.hash = hash;
  await waitFor(() => b.store.get().route.id === id && document.querySelector('#view h1') !== null, `route ${hash}`);
  await settle(1);
}

/** No console.error calls (prints them when there are). */
export function expectNoConsoleErrors(b: Booted): void {
  expect(b.errors.mock.calls.map((c) => c.map(String).join(' '))).toEqual([]);
}
