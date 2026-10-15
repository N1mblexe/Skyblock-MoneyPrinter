// Auction house lowest-BIN scanner. Owner: market-apis package.
import { AH, API_AUCTIONS, FETCH_TIMEOUT_MS } from '../config.ts';
import type { AhPrice, AhScanProgress, AhSnapshot } from '../types/contracts.ts';
import { loadAh, saveAh } from './ahStore.ts';
import { decodeItemBytes, skyblockIdFromNbt } from './nbt.ts';

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
  /** schedule scans every AH.pollMs (first scan immediately if the cache is older than that) */
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
  /** BIN listings counted */
  binCount: number;
  /** unclaimed BIN listings skipped because item_bytes / price were unusable */
  decodeErrors: number;
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

// ---------------------------------------------------------------- scan

const abortError = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('Aborted', 'AbortError');

/** Fold one page's unclaimed BIN listings into `acc` (lowest price + count per normalized id). */
export async function aggregatePage(
  auctions: readonly RawAuction[],
  acc: Record<string, AhPrice>,
): Promise<{ bins: number; errors: number }> {
  let bins = 0;
  let errors = 0;
  for (const a of auctions) {
    if (a.bin !== true || a.claimed === true) continue;
    const price = a.starting_bid;
    let id: string | null = null;
    if (typeof price === 'number' && price > 0 && typeof a.item_bytes === 'string') {
      try {
        id = skyblockIdFromNbt(await decodeItemBytes(a.item_bytes));
      } catch {
        id = null;
      }
    }
    if (!id) {
      errors++;
      continue;
    }
    bins++;
    const cur = acc[id];
    if (!cur) acc[id] = { price, count: 1 };
    else {
      cur.count++;
      if (price < cur.price) cur.price = price;
    }
  }
  return { bins, errors };
}

/**
 * Scan every auctions page: page 0 first (for totalPages), the rest with `concurrency` parallel fetches.
 * A failing page is retried once, then skipped and listed in `failedPages` (the scan goes on).
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
  let binCount = 0;
  let decodeErrors = 0;

  async function loadPage(n: number): Promise<RawAhPage> {
    check();
    try {
      return await fetchFn(n, signal);
    } catch {
      check();
      return fetchFn(n, signal);
    }
  }
  async function fold(p: RawAhPage): Promise<void> {
    const r = await aggregatePage(p.auctions, lowestBin);
    binCount += r.bins;
    decodeErrors += r.errors;
    check();
  }

  const first = await loadPage(0);
  await fold(first);
  const totalPages = first.totalPages;
  let done = 1;
  onProgress({ page: done, totalPages });

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
      if (page) await fold(page);
      onProgress({ page: ++done, totalPages });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, totalPages - 1)) }, worker));
  failedPages.sort((a, b) => a - b);
  // Object.create(null) keeps odd ids like "__proto__" safe while aggregating; hand out a plain object.
  return { fetchedAt: now(), lastUpdated: first.lastUpdated, lowestBin: { ...lowestBin }, failedPages, binCount, decodeErrors };
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
 * the UI), inline otherwise. start() scans at once when the cache is older than AH.pollMs, then every AH.pollMs
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
    const due = (last?.fetchedAt ?? -Infinity) + AH.pollMs;
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
