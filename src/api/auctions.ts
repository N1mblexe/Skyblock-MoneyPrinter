// Auction house lowest-BIN scanner. Owner: s1/ahdata.
import { AH, API_AUCTIONS, FETCH_TIMEOUT_MS, KAT } from '../config.ts';
import type { AhPrice, AhScanProgress, AhSnapshot } from '../types/contracts.ts';
import { petLevelFromName } from '../domain/ids.ts';
import { loadAh, saveAh } from './ahStore.ts';
import { decodeRoot, itemCount, itemFromNbt, SCAN_SKIP, type PetInfo } from './nbt.ts';

export interface AhScannerOptions {
  onSnapshot(s: AhSnapshot): void;
  onProgress(p: AhScanProgress | null): void;
  onError(e: Error): void;
  /** checked before every scheduled scan */
  enabled(): boolean;
  /** run the scan in a Web Worker; defaults to `typeof Worker !== 'undefined'` */
  useWorker?: boolean;
  /** page fetcher for the inline scan; defaults to fetchAhPage */
  fetchPage?: AhPageFetcher;
  now?: () => number;
  /** persistence; defaults to ahStore */
  store?: { saveAh(s: AhSnapshot): Promise<void>; loadAh(): Promise<AhSnapshot | null> };
}

export interface AhScanner {
  /**
   * schedule scans every AH.pollMs (first scan immediately if the cache is older than that, or is from an older scan
   * version than AH_SCAN_VERSION: the old snapshot still loads meanwhile)
   */
  start(): void;
  stop(): void;
  scanNow(): Promise<void>;
  /** last scan persisted in IndexedDB, if any */
  loadCached(): Promise<AhSnapshot | null>;
}

// ---------------------------------------------------------------- raw page + fetch

/** The fields of one `/v2/skyblock/auctions` entry the scanner reads. */
export interface RawAuction {
  uuid?: string;
  item_name?: string;
  tier?: string;
  bin?: boolean;
  starting_bid: number;
  claimed?: boolean;
  item_bytes: string;
}

export interface RawAhPage {
  success: boolean;
  page: number;
  totalPages: number;
  totalAuctions?: number;
  lastUpdated: number;
  auctions: RawAuction[];
}

export type AhPageFetcher = (page: number, signal?: AbortSignal) => Promise<RawAhPage>;

/** Result of one scan: the snapshot plus scan diagnostics (extra fields are harmless to AhSnapshot consumers). */
export interface AhScanResult extends AhSnapshot {
  /** pages that failed twice and were skipped */
  failedPages: number[];
  /** pages whose lastUpdated still differed from page 0's after a refetch (scan v4) */
  mixedPages: number;
  /** BIN listings counted */
  binCount: number;
  /** unclaimed BIN listings skipped because item_bytes / price were unusable */
  decodeErrors: number;
  /** valid BIN pet listings left out of pricing because they hold a Tier Boost (scan v3+) */
  tierBoosted: number;
  /** BIN listings seen again under an auction uuid already counted (another page, or the same one; scan v4) */
  dupes: number;
}

/** While opts.enabled() is false, scheduled scans re-check this often (so toggling AH on takes effect quickly). */
const DISABLED_RECHECK_MS = 60_000;

/** Throw if `v` isn't a usable auctions page. */
export function validateAhPage(v: unknown): RawAhPage {
  if (typeof v !== 'object' || v === null) throw new Error('AH page is not an object');
  const p = v as RawAhPage;
  if (p.success !== true) throw new Error('AH page: success=false');
  if (!Array.isArray(p.auctions)) throw new Error('AH page: auctions missing');
  if (!Number.isInteger(p.totalPages) || p.totalPages < 1) throw new Error('AH page: bad totalPages');
  if (typeof p.lastUpdated !== 'number') throw new Error('AH page: bad lastUpdated');
  return p;
}

/** Fetch and validate one auctions page; FETCH_TIMEOUT_MS covers the whole request. */
export async function fetchAhPage(page: number, signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS): Promise<RawAhPage> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(`${API_AUCTIONS}?page=${page}`, { signal: sig });
  if (!res.ok) throw new Error(`AH page ${page}: HTTP ${res.status}`);
  return validateAhPage(await res.json());
}

// ---------------------------------------------------------------- id keys

/**
 * AhSnapshot.v written by this scanner. 2: next / uuid / name per id. 3: pets carry `exp`, max-level pets also go to
 * `${id}${AH.petMaxSuffix}`, and pets holding a Tier Boost are left out. 4: prices per item (a stack's price divided by
 * its Count, `stack` on the cheapest listing), the lowest AH.keepPrices in `prices`, listings deduped by uuid, pets
 * also filed by level band (`${id}@L<upTo>`), RUNE / POTION split into NEU ids, `mixedPages`. Older saved snapshots
 * still load (and start a rescan at once); each page decides which version it needs.
 */
export const AH_SCAN_VERSION = 4;

/**
 * Pets whose max level is 200 (Golden Dragon and its siblings): their `[Lvl 100]` listings are not max level.
 * Every other pet maxes at 100. The source of truth is the catalog (`petLeveling.custom[type].maxLevel`), which this
 * scan cannot read (it runs in a Web Worker); src/domain/kat.ts ignores `@MAX` entries whose level disagrees with it.
 * Hand-kept; add a type here when Hypixel adds another 200-level pet.
 */
export const PET_MAX_200: ReadonlySet<string> = new Set(['GOLDEN_DRAGON', 'JADE_DRAGON', 'ROSE_DRAGON']);

/** Level-band key infix: a pet listing is also filed under `${id}${PET_BAND_PREFIX}${upTo}` (e.g. `ENDERMAN;3@L49`). */
export const PET_BAND_PREFIX = '@L';

export { petLevelFromName };

/** Max level of a pet type (200 for PET_MAX_200, else 100). */
export const petMaxLevel = (type: string): number => (PET_MAX_200.has(type) ? 200 : 100);

/**
 * The second key a pet listing of `id` at `level` is filed under (scan v4, shared with the sales feed):
 *  - max level (`petMaxLevel`): `${id}@MAX` (AH.petMaxSuffix), as in scan v3;
 *  - else the first band of AH.petBands = [49, 89, 99] holding the level: `${id}@L49` (1-49), `@L89` (50-89), `@L99`
 *    (90-99);
 *  - null without a level, and above the last band below max (levels 100-199 of 200-level pets).
 */
export function petBandKey(id: string, pet: Pick<PetInfo, 'type'>, level: number | null): string | null {
  if (level === null || level < 1) return null;
  if (level === petMaxLevel(pet.type)) return id + AH.petMaxSuffix;
  const upTo = AH.petBands.find((b) => level <= b);
  return upTo === undefined ? null : `${id}${PET_BAND_PREFIX}${upTo}`;
}

// ---------------------------------------------------------------- scan

const abortError = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('Aborted', 'AbortError');

/** One decoded BIN listing, priced per item. */
export interface AhListing {
  id: string;
  /** the band / `@MAX` key for pets, else null */
  band: string | null;
  /** price per item (starting_bid / count) */
  price: number;
  /** stack size (item Count) */
  count: number;
  uuid?: string;
  name?: string;
  /** pets: total XP */
  exp?: number;
}

/** Insert `p` into the ascending `prices`, keeping at most `keep`. */
function insertPrice(prices: number[], p: number, keep: number): void {
  let lo = 0;
  let hi = prices.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prices[mid]! <= p) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= keep) return;
  prices.splice(lo, 0, p);
  if (prices.length > keep) prices.length = keep;
}

/** Count one listing under `key`: the lowest AH.keepPrices per-item prices and the cheapest listing's details. */
function addListing(acc: Record<string, AhPrice>, key: string, l: AhListing): void {
  const who: Partial<AhPrice> = {
    ...(l.uuid ? { uuid: l.uuid } : {}),
    ...(l.name ? { name: l.name } : {}),
    ...(l.exp !== undefined ? { exp: l.exp } : {}),
    ...(l.count > 1 ? { stack: l.count } : {}),
  };
  const cur = acc[key];
  if (!cur) {
    acc[key] = { price: l.price, count: 1, prices: [l.price], ...who };
    return;
  }
  cur.count++;
  // entries carried over from an older scan (tests) have no prices: rebuild them from price / next
  const prices = (cur.prices ??= cur.next === undefined ? [cur.price] : [cur.price, cur.next]);
  insertPrice(prices, l.price, AH.keepPrices);
  if (l.price < cur.price) {
    delete cur.uuid;
    delete cur.name;
    delete cur.exp;
    delete cur.stack;
    Object.assign(cur, who);
  }
  cur.price = prices[0]!;
  if (prices.length > 1) cur.next = prices[1]!;
}

/** Decode stats of one page. */
export interface AhPageStats {
  bins: number;
  errors: number;
  tierBoosted: number;
  dupes: number;
}

/**
 * Decode one page's unclaimed BIN listings (synchronously, before any folding). `seen` holds the auction uuids already
 * counted; a listing whose uuid is in it is a dupe, and every uuid read is added to it.
 */
export function decodeListings(auctions: readonly RawAuction[], seen?: Set<string>): { listings: AhListing[]; stats: AhPageStats } {
  const stats: AhPageStats = { bins: 0, errors: 0, tierBoosted: 0, dupes: 0 };
  const listings: AhListing[] = [];
  for (const a of auctions) {
    if (a.bin !== true || a.claimed === true) continue;
    if (seen && a.uuid) {
      if (seen.has(a.uuid)) {
        stats.dupes++;
        continue;
      }
      seen.add(a.uuid);
    }
    const total = a.starting_bid;
    let id: string | null = null;
    let pet: PetInfo | null = null;
    let count = 1;
    if (typeof total === 'number' && total > 0 && typeof a.item_bytes === 'string') {
      try {
        const root = decodeRoot(a.item_bytes, { skip: SCAN_SKIP });
        ({ id, pet } = itemFromNbt(root));
        count = itemCount(root);
      } catch {
        id = null;
      }
    }
    if (!id) {
      stats.errors++;
      continue;
    }
    if (pet?.heldItem === KAT.tierBoostId) {
      stats.tierBoosted++;
      continue;
    }
    stats.bins++;
    listings.push({
      id,
      band: pet ? petBandKey(id, pet, petLevelFromName(a.item_name)) : null,
      price: total / count,
      count,
      ...(a.uuid ? { uuid: a.uuid } : {}),
      ...(a.item_name ? { name: a.item_name } : {}),
      ...(pet ? { exp: pet.exp } : {}),
    });
  }
  return { listings, stats };
}

/** Fold decoded listings into `acc`, in order: each under its id, pets also under their band / `@MAX` key. */
export function foldListings(acc: Record<string, AhPrice>, listings: readonly AhListing[]): void {
  for (const l of listings) {
    addListing(acc, l.id, l);
    if (l.band) addListing(acc, l.band, l);
  }
}

/**
 * Decode one page (decodeListings) and fold it into `acc` (foldListings): per normalized id the count, the lowest
 * AH.keepPrices per-item prices (`price` = the lowest, `next` = the second) and the cheapest listing's uuid, name and
 * stack size (pets: also its exp). Pets:
 *  - each listing is also filed under one level key (petBandKey): `${id}@MAX` at max level (`[Lvl 100]`, or
 *    `[Lvl 200]` for PET_MAX_200 types), else `${id}@L49` / `@L89` / `@L99` by its `[Lvl N]` name. The plain id's
 *    lowest BIN is almost always a level 1 pet. Skinned listings are kept: a skin only raises the price.
 *  - a pet holding a Tier Boost is skipped: its id has the base rarity but it sells as the boosted one, so it would
 *    distort both rarities' prices (Kat flips compare them). It is a valid listing, so it is neither a bin nor an
 *    error; it is counted in `tierBoosted`.
 */
export function aggregatePage(auctions: readonly RawAuction[], acc: Record<string, AhPrice>, seen?: Set<string>): AhPageStats {
  const { listings, stats } = decodeListings(auctions, seen);
  foldListings(acc, listings);
  return stats;
}

/**
 * Scan every auctions page: page 0 first (for totalPages), the rest with `concurrency` parallel fetches.
 * A failing page is retried once, then skipped and listed in `failedPages` (the scan goes on). A page whose
 * lastUpdated differs from page 0's (the AH refreshed mid-scan, or the CDN served an older copy) is fetched once more;
 * if it still differs, it is used and counted in `mixedPages`. Listings are deduped by auction uuid across pages.
 * Page 0 failing twice, or `signal` aborting, rejects. onProgress gets the number of pages done so far.
 */
export async function scanAuctions(
  fetchFn: AhPageFetcher,
  onProgress: (p: AhScanProgress) => void,
  signal?: AbortSignal,
  now: () => number = Date.now,
  concurrency: number = AH.concurrency,
): Promise<AhScanResult> {
  const check = () => {
    if (signal?.aborted) throw abortError(signal);
  };
  const lowestBin = Object.create(null) as Record<string, AhPrice>;
  const seen = new Set<string>();
  let binCount = 0;
  let decodeErrors = 0;
  let tierBoosted = 0;
  let dupes = 0;
  let mixedPages = 0;

  async function loadPage(n: number): Promise<RawAhPage> {
    check();
    try {
      return await fetchFn(n, signal);
    } catch {
      check();
      return fetchFn(n, signal);
    }
  }
  function fold(p: RawAhPage): void {
    const r = aggregatePage(p.auctions, lowestBin, seen);
    binCount += r.bins;
    decodeErrors += r.errors;
    tierBoosted += r.tierBoosted;
    dupes += r.dupes;
    check();
  }

  const first = await loadPage(0);
  fold(first);
  const totalPages = first.totalPages;
  let done = 1;
  onProgress({ page: done, totalPages });

  /** A page from another AH refresh than page 0 gets one more fetch; still mixed (or that fetch failing) -> counted. */
  async function sameRefresh(n: number, page: RawAhPage): Promise<RawAhPage> {
    if (page.lastUpdated === first.lastUpdated) return page;
    let again: RawAhPage | null = null;
    try {
      check();
      again = await fetchFn(n, signal);
    } catch {
      check();
    }
    const use = again ?? page;
    if (use.lastUpdated !== first.lastUpdated) mixedPages++;
    return use;
  }

  const failedPages: number[] = [];
  let next = 1;
  async function worker(): Promise<void> {
    while (next < totalPages) {
      const n = next++;
      let page: RawAhPage | null = null;
      try {
        page = await loadPage(n);
      } catch (e) {
        check();
        console.warn(`AH scan: page ${n} skipped`, e);
        failedPages.push(n);
      }
      if (page) fold(await sameRefresh(n, page));
      onProgress({ page: ++done, totalPages });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, totalPages - 1)) }, worker));
  failedPages.sort((a, b) => a - b);
  // Object.create(null) keeps odd ids like "__proto__" safe while aggregating; hand out a plain object.
  return {
    v: AH_SCAN_VERSION,
    fetchedAt: now(),
    lastUpdated: first.lastUpdated,
    lowestBin: { ...lowestBin },
    failedPages,
    mixedPages,
    binCount,
    decodeErrors,
    tierBoosted,
    dupes,
  };
}

// ---------------------------------------------------------------- worker bridge

/** Messages between createAhScanner and ahWorker.ts. */
export type AhWorkerRequest = { type: 'scan' } | { type: 'abort' };
export type AhWorkerResponse =
  | { type: 'progress'; progress: AhScanProgress }
  | { type: 'done'; result: AhScanResult }
  | { type: 'error'; message: string };

/* v8 ignore start -- needs a real module Worker (browser / Vite); the message protocol is tested via ahWorker.ts */
function scanInWorker(onProgress: (p: AhScanProgress) => void, signal: AbortSignal): Promise<AhScanResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./ahWorker.ts', import.meta.url), { type: 'module' });
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      w.terminate();
    };
    const onAbort = () => {
      finish();
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    w.onmessage = (ev: MessageEvent<AhWorkerResponse>) => {
      const m = ev.data;
      if (m.type === 'progress') onProgress(m.progress);
      else {
        finish();
        if (m.type === 'done') resolve(m.result);
        else reject(new Error(m.message));
      }
    };
    w.onerror = (ev) => {
      finish();
      reject(new Error(`AH worker failed: ${ev.message || 'unknown error'}`));
    };
    w.postMessage({ type: 'scan' } satisfies AhWorkerRequest);
  });
}
/* v8 ignore stop */

// ---------------------------------------------------------------- scanner

const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
const safe = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    console.error('AH scanner callback failed', e);
  }
};

/**
 * Lowest-BIN scanner. Scans run in a module Web Worker when available (decoding ~40k item_bytes would jank
 * the UI), inline otherwise. start() scans at once when the cache is older than AH.pollMs or has `v` below
 * AH_SCAN_VERSION (loadCached still hands out that old snapshot until the new scan lands), then every AH.pollMs
 * while opts.enabled() (while disabled it re-checks every minute). scanNow() ignores enabled() and shares an
 * in-flight scan; it never rejects (failures go to onError). Each finished scan is persisted via ahStore and passed
 * to onSnapshot; onProgress(null) ends every scan, including one cut short by stop().
 */
export function createAhScanner(opts: AhScannerOptions): AhScanner {
  const now = opts.now ?? Date.now;
  const store = opts.store ?? { saveAh, loadAh };
  const useWorker = opts.useWorker ?? typeof Worker !== 'undefined';
  const fetchPage = opts.fetchPage ?? fetchAhPage;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let ctl: AbortController | null = null;
  let last: AhSnapshot | null = null;
  let cacheP: Promise<unknown> | null = null;

  function loadCached(): Promise<AhSnapshot | null> {
    cacheP ??= store.loadAh().then(
      (s) => {
        if (s && (!last || s.fetchedAt > last.fetchedAt)) last = s;
      },
      (e: unknown) => console.warn('AH scanner: loading cache failed', e),
    );
    return cacheP.then(() => last);
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule(delay: number): void {
    clearTimer();
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, Math.max(0, delay));
  }

  function tick(): void {
    if (!running) return;
    if (!opts.enabled()) return schedule(DISABLED_RECHECK_MS);
    // a snapshot from an older scan version is due at once (it stays loaded until the new scan replaces it)
    const current = last !== null && (last.v ?? 0) >= AH_SCAN_VERSION;
    const due = (current ? last!.fetchedAt : -Infinity) + AH.pollMs;
    if (due > now()) return schedule(due - now());
    void scanNow();
  }

  async function run(c: AbortController): Promise<void> {
    const onProgress = (p: AhScanProgress) => {
      if (ctl === c) safe(() => opts.onProgress(p));
    };
    let res: AhScanResult;
    try {
      res = useWorker ? await scanInWorker(onProgress, c.signal) : await scanAuctions(fetchPage, onProgress, c.signal, now);
    } catch (e) {
      if (ctl === c) safe(() => opts.onError(toError(e)));
      return;
    }
    if (ctl !== c) return;
    if (res.failedPages.length) console.warn(`AH scan: ${res.failedPages.length} page(s) skipped`, res.failedPages);
    last = res;
    try {
      await store.saveAh(res);
    } catch (e) {
      console.warn('AH scanner: saving snapshot failed', e);
    }
    if (ctl === c) safe(() => opts.onSnapshot(res));
  }

  function scanNow(): Promise<void> {
    if (inFlight) return inFlight;
    clearTimer();
    const c = new AbortController();
    ctl = c;
    const p = run(c).finally(() => {
      if (ctl !== c) return; // stopped meanwhile
      ctl = null;
      inFlight = null;
      safe(() => opts.onProgress(null));
      schedule(AH.pollMs);
    });
    inFlight = p;
    return p;
  }

  function start(): void {
    if (running) return;
    running = true;
    if (inFlight) return; // its completion schedules the next scan
    void loadCached().then(() => {
      if (running && !inFlight && timer === null) tick();
    });
  }

  function stop(): void {
    running = false;
    clearTimer();
    const c = ctl;
    ctl = null;
    inFlight = null;
    if (c) {
      c.abort();
      safe(() => opts.onProgress(null));
    }
  }

  return { start, stop, scanNow, loadCached };
}
