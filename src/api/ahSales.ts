// Realized AH sales from /v2/skyblock/auctions_ended (the last 60 s of sales), polled every minute and kept per id
// for AH_SALES.windowMs in IndexedDB. Owner: s1/ahdata.
import { AH_SALES, API_AUCTIONS_ENDED, FETCH_TIMEOUT_MS, KAT, POLL_BACKOFF_MS } from '../config.ts';
import { petLevelFromName } from '../domain/ids.ts';
import { median } from '../domain/stats.ts';
import type { AhSalesSnapshot, AhSalesStat } from '../types/contracts.ts';
import { petBandKey } from './auctions.ts';
import { sharedAhSalesStore, type AhSale, type AhSalesMeta, type AhSalesRecord, type AhSalesStore } from './ahSalesStore.ts';
import { decodeRoot, itemCount, itemFromNbt, itemName, SALES_SKIP } from './nbt.ts';

export interface AhSalesPoller {
  start(): void;
  stop(): void;
  /** the stored sales, summarized (null when nothing is stored) */
  loadCached(): Promise<AhSalesSnapshot | null>;
  /** drop every stored sale */
  clear(): Promise<void>;
  /** stored sales count and covered hours, for Settings -> Data */
  info(): Promise<{ sales: number; ids: number; coverageHours: number }>;
}

export interface AhSalesPollerOptions {
  onUpdate(s: AhSalesSnapshot): void;
  onError(e: Error): void;
  /** polling only runs while this returns true (settings.ahEnabled) */
  enabled?: () => boolean;
  /** defaults to fetching API_AUCTIONS_ENDED */
  fetch?: (signal: AbortSignal) => Promise<unknown>;
  intervalMs?: number;
  /** clock for pruning and updatedAt (tests); defaults to Date.now */
  now?: () => number;
  /** persistence (tests); defaults to the shared store on AH_SALES_DB_NAME */
  store?: AhSalesStore;
}

// ---------------------------------------------------------------- raw response

/** One `/v2/skyblock/auctions_ended` entry (seller / buyer are not read). */
export interface RawEndedAuction {
  auction_id: string;
  seller?: string;
  buyer?: string;
  /** ms epoch of the sale */
  timestamp: number;
  /** total price (the whole stack) */
  price: number;
  bin: boolean;
  item_bytes: string;
}

export interface RawEndedPage {
  success: boolean;
  lastUpdated: number;
  auctions: RawEndedAuction[];
}

/** Throw if `v` isn't a usable auctions_ended response. */
export function validateEnded(v: unknown): RawEndedPage {
  if (typeof v !== 'object' || v === null) throw new Error('AH sales: response is not an object');
  const p = v as RawEndedPage;
  if (p.success !== true) throw new Error('AH sales: success=false');
  if (typeof p.lastUpdated !== 'number' || !Number.isFinite(p.lastUpdated)) throw new Error('AH sales: bad lastUpdated');
  if (!Array.isArray(p.auctions)) throw new Error('AH sales: auctions missing');
  return p;
}

/** GET API_AUCTIONS_ENDED as JSON (the poller adds the FETCH_TIMEOUT_MS timeout). */
export async function fetchEndedAuctions(signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(API_AUCTIONS_ENDED, signal ? { signal } : {});
  if (!res.ok) throw new Error(`AH sales: HTTP ${res.status}`);
  return res.json();
}

/** One parsed BIN sale. */
export interface ParsedSale {
  auctionId: string;
  /** the id, plus the pet band / `@MAX` key for pets (the scan's key rules) */
  keys: string[];
  /** ms epoch */
  t: number;
  /** price per item */
  p: number;
  /** items */
  q: number;
}

/**
 * The BIN sales of one response, decoded with the AH scan's id rules: itemFromNbt (pets `TYPE;IDX`, books, runes,
 * potions), plus the pet's level key from its display name (petBandKey: `@MAX` at max level, else `@L49` / `@L89` /
 * `@L99`). Price per item = price / Count. Pets holding a Tier Boost are left out (as in the scan). Auction ids
 * repeated within the response are kept once. `skipped` counts BIN entries that could not be used.
 */
export function parseEndedSales(page: RawEndedPage): { sales: ParsedSale[]; skipped: number } {
  const sales: ParsedSale[] = [];
  const ids = new Set<string>();
  let skipped = 0;
  for (const a of page.auctions) {
    if (a?.bin !== true) continue;
    const { auction_id: auctionId, price, timestamp: t } = a;
    if (typeof auctionId !== 'string' || !auctionId || ids.has(auctionId)) {
      if (typeof auctionId !== 'string' || !auctionId) skipped++;
      continue;
    }
    ids.add(auctionId);
    if (typeof price !== 'number' || !(price > 0) || typeof t !== 'number' || !Number.isFinite(t) || typeof a.item_bytes !== 'string') {
      skipped++;
      continue;
    }
    let keys: string[] | null = null;
    let q = 1;
    try {
      const root = decodeRoot(a.item_bytes, { skip: SALES_SKIP });
      const { id, pet } = itemFromNbt(root);
      if (id && pet?.heldItem !== KAT.tierBoostId) {
        const band = pet ? petBandKey(id, pet, petLevelFromName(itemName(root))) : null;
        keys = band ? [id, band] : [id];
        q = itemCount(root);
      }
    } catch {
      keys = null;
    }
    if (!keys) {
      skipped++;
      continue;
    }
    sales.push({ auctionId, keys, t, p: price / q, q });
  }
  return { sales, skipped };
}

// ---------------------------------------------------------------- state

const HOUR = 3600_000;
/** auction ids are remembered this long after their sale, for dedupe across responses */
const RECENT_KEEP_MS = 15 * 60_000;
/** response lastUpdated values remembered (the CDN repeats the latest one for up to 5 min) */
const UPDATES_KEEP = 32;

/** In-memory feed state: one record per id plus the shared meta. */
export interface AhSalesState {
  records: Map<string, AhSalesRecord>;
  windows: [number, number][];
  recent: Map<string, number>;
  updates: number[];
}

export const emptySalesState = (): AhSalesState => ({ records: new Map(), windows: [], recent: new Map(), updates: [] });

export function stateFrom(records: readonly AhSalesRecord[], meta: AhSalesMeta | null): AhSalesState {
  return {
    records: new Map(records.map((r) => [r.id, r])),
    windows: meta ? meta.windows.map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0]) : [],
    recent: new Map(meta?.recent ?? []),
    updates: meta ? [...meta.updates] : [],
  };
}

export const metaOf = (s: AhSalesState): AhSalesMeta => ({ windows: s.windows, recent: [...s.recent], updates: s.updates });

/** Add [a, b] to the disjoint, sorted `windows` (merging overlaps and touching ranges). */
export function addWindow(windows: [number, number][], a: number, b: number): [number, number][] {
  const out: [number, number][] = [];
  let cur: [number, number] = [a, b];
  let placed = false;
  for (const w of windows) {
    if (w[1] < cur[0]) out.push(w);
    else if (w[0] > cur[1]) {
      if (!placed) out.push(cur);
      placed = true;
      out.push(w);
    } else cur = [Math.min(cur[0], w[0]), Math.max(cur[1], w[1])];
  }
  if (!placed) out.push(cur);
  return out;
}

/** Hours covered by `windows`. */
export const coverageHours = (windows: readonly [number, number][]): number => windows.reduce((s, [a, b]) => s + (b - a), 0) / HOUR;

/** Changes to persist: records written and ids deleted. */
export interface SalesChanges {
  put: Set<string>;
  remove: Set<string>;
}

/** Insert a sale into a record (sales kept by time, newest AH_SALES.maxPrices; hourly counts). */
function addSale(r: AhSalesRecord, sale: AhSale): void {
  let i = r.sales.length;
  while (i > 0 && r.sales[i - 1]!.t > sale.t) i--;
  r.sales.splice(i, 0, sale);
  if (r.sales.length > AH_SALES.maxPrices) r.sales.splice(0, r.sales.length - AH_SALES.maxPrices);
  const h = Math.floor(sale.t / HOUR) * HOUR;
  let j = r.hours.length;
  while (j > 0 && r.hours[j - 1]![0] > h) j--;
  const bucket = r.hours[j - 1];
  if (bucket && bucket[0] === h) {
    bucket[1]++;
    bucket[2] += sale.q;
  } else r.hours.splice(j, 0, [h, 1, sale.q]);
}

/**
 * Fold one response into `s`. Returns null (and changes nothing) when its lastUpdated was already seen (a CDN
 * repeat). Otherwise: its window [lastUpdated − AH_SALES.windowSpanMs, lastUpdated] joins the coverage, and every BIN
 * sale whose auction id is not already known is added under each of its keys.
 */
export function ingestPage(s: AhSalesState, page: RawEndedPage): (SalesChanges & { added: number; skipped: number }) | null {
  if (s.updates.includes(page.lastUpdated)) return null;
  s.updates.push(page.lastUpdated);
  if (s.updates.length > UPDATES_KEEP) s.updates.splice(0, s.updates.length - UPDATES_KEEP);
  s.windows = addWindow(s.windows, page.lastUpdated - AH_SALES.windowSpanMs, page.lastUpdated);
  const { sales, skipped } = parseEndedSales(page);
  const put = new Set<string>();
  let added = 0;
  for (const sale of sales) {
    if (s.recent.has(sale.auctionId)) continue;
    s.recent.set(sale.auctionId, sale.t);
    added++;
    for (const key of sale.keys) {
      let r = s.records.get(key);
      if (!r) s.records.set(key, (r = { id: key, sales: [], hours: [] }));
      addSale(r, { t: sale.t, p: sale.p, q: sale.q });
      put.add(key);
    }
  }
  for (const [id, t] of s.recent) if (t < page.lastUpdated - RECENT_KEEP_MS) s.recent.delete(id);
  return { put, remove: new Set(), added, skipped };
}

/** Drop sales, hourly counts and coverage older than `now − AH_SALES.windowMs`; records left empty are removed. */
export function pruneState(s: AhSalesState, now: number, into: SalesChanges = { put: new Set(), remove: new Set() }): SalesChanges {
  const cutoff = now - AH_SALES.windowMs;
  s.windows = s.windows.filter(([, b]) => b > cutoff).map(([a, b]) => [Math.max(a, cutoff), b] as [number, number]);
  for (const [id, r] of s.records) {
    const oldSale = (r.sales[0]?.t ?? Infinity) < cutoff;
    const oldHour = (r.hours[0]?.[0] ?? Infinity) + HOUR <= cutoff;
    if (!oldSale && !oldHour) continue;
    r.sales = r.sales.filter((x) => x.t >= cutoff);
    r.hours = r.hours.filter((h) => h[0] + HOUR > cutoff);
    if (!r.hours.length) {
      s.records.delete(id);
      into.put.delete(id);
      into.remove.add(id);
    } else into.put.add(id);
  }
  return into;
}

/**
 * Summarize `s` (null when nothing is stored). Per id: `n` sales and `items` from the hourly counts in the window,
 * `median` per-item price over the stored (newest AH_SALES.maxPrices) sales, `perHour` = items / coverage hours (null
 * while coverage < AH_SALES.minCoverageHours), `last` = the newest sale.
 */
export function summarize(s: AhSalesState, now: number): AhSalesSnapshot | null {
  if (!s.records.size && !s.windows.length) return null;
  const cov = coverageHours(s.windows);
  const measured = cov >= AH_SALES.minCoverageHours;
  const byId: Record<string, AhSalesStat> = {};
  for (const [id, r] of s.records) {
    let n = 0;
    let items = 0;
    for (const h of r.hours) {
      n += h[1];
      items += h[2];
    }
    byId[id] = {
      n,
      items,
      median: median(r.sales.map((x) => x.p)),
      perHour: measured ? items / cov : null,
      coverageHours: cov,
      last: r.sales.at(-1)?.t ?? 0,
    };
  }
  return { v: 1, updatedAt: now, coverageHours: cov, byId };
}

/** Sales and ids stored, counting base ids only (pet band / `@MAX` keys repeat their base id's sales). */
export function salesInfo(s: AhSalesState): { sales: number; ids: number; coverageHours: number } {
  let sales = 0;
  let ids = 0;
  for (const [id, r] of s.records) {
    if (id.includes('@')) continue;
    ids++;
    for (const h of r.hours) sales += h[1];
  }
  return { sales, ids, coverageHours: coverageHours(s.windows) };
}

// ---------------------------------------------------------------- poller

const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
const safe = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    console.error('AH sales callback failed', e);
  }
};

/** Reject after `ms` (aborting `ctl`) unless `p` settles first. */
function withTimeout<T>(p: Promise<T>, ctl: AbortController, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`AH sales: no response after ${ms} ms`);
      ctl.abort(e);
      reject(e);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * Poll API_AUCTIONS_ENDED every `intervalMs` (AH_SALES.pollMs) while enabled() (while disabled nothing is fetched;
 * it re-checks every interval). Each request has FETCH_TIMEOUT_MS. After a failure the next try waits
 * POLL_BACKOFF_MS[failures-1] (capped at the last step, never sooner than the interval); a success resets it.
 * A response whose lastUpdated was already seen is skipped; a new one is folded in (ingestPage), old data is pruned
 * (pruneState), only the changed ids are written, and onUpdate gets the new summary. loadCached() emits the stored
 * summary through onUpdate as well.
 */
export function createAhSalesPoller(opts: AhSalesPollerOptions): AhSalesPoller {
  const doFetch = opts.fetch ?? fetchEndedAuctions;
  const intervalMs = opts.intervalMs ?? AH_SALES.pollMs;
  const now = opts.now ?? Date.now;
  const store = opts.store ?? sharedAhSalesStore();
  const enabled = opts.enabled ?? (() => true);

  let running = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ctl: AbortController | null = null;
  let readyP: Promise<AhSalesState> | null = null;
  /** serializes ingest / clear / reads, so a write never interleaves with another */
  let queue: Promise<unknown> = Promise.resolve();

  /** changes not yet written (a failed save is retried with the next one) */
  const unsaved: SalesChanges = { put: new Set(), remove: new Set() };
  async function persist(s: AhSalesState, ch: SalesChanges): Promise<void> {
    for (const id of ch.put) {
      unsaved.put.add(id);
      unsaved.remove.delete(id);
    }
    for (const id of ch.remove) {
      unsaved.remove.add(id);
      unsaved.put.delete(id);
    }
    const put = [...unsaved.put].flatMap((id) => s.records.get(id) ?? []);
    await store.save(put, [...unsaved.remove], metaOf(s));
    unsaved.put.clear();
    unsaved.remove.clear();
  }

  function ready(): Promise<AhSalesState> {
    readyP ??= (async () => {
      let s: AhSalesState;
      try {
        const { records, meta } = await store.load();
        s = stateFrom(records, meta);
      } catch (e) {
        console.warn('AH sales: loading stored sales failed', e);
        s = emptySalesState();
      }
      const ch = pruneState(s, now());
      if (ch.put.size || ch.remove.size) await persist(s, ch);
      return s;
    })();
    return readyP;
  }

  function serial<T>(fn: (s: AhSalesState) => Promise<T> | T): Promise<T> {
    const p = queue.then(() => ready()).then(fn);
    queue = p.catch(() => {});
    return p;
  }

  const emit = (snap: AhSalesSnapshot | null) => {
    if (snap) safe(() => opts.onUpdate(snap));
    return snap;
  };

  function schedule(delay: number): void {
    if (timer !== null) clearTimeout(timer);
    timer = running ? setTimeout(() => void poll(), delay) : null;
  }

  async function poll(): Promise<void> {
    timer = null;
    if (!running) return;
    if (!enabled()) return schedule(intervalMs);
    const c = new AbortController();
    ctl = c;
    try {
      const page = validateEnded(await withTimeout(doFetch(c.signal), c, FETCH_TIMEOUT_MS));
      if (ctl !== c) return;
      failures = 0;
      await serial(async (s) => {
        const ch = ingestPage(s, page);
        if (!ch) return;
        pruneState(s, now(), ch);
        await persist(s, ch);
        emit(summarize(s, now()));
      });
    } catch (e) {
      if (ctl !== c) return;
      failures++;
      safe(() => opts.onError(toError(e)));
    }
    if (ctl !== c) return;
    ctl = null;
    if (!running) return;
    schedule(failures ? Math.max(intervalMs, POLL_BACKOFF_MS[Math.min(failures, POLL_BACKOFF_MS.length) - 1]!) : intervalMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      void ready().then(() => {
        if (running && timer === null && ctl === null) void poll();
      });
    },
    stop() {
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      ctl?.abort();
      ctl = null;
    },
    loadCached: () => serial((s) => emit(summarize(s, now()))),
    clear: () =>
      serial(async (s) => {
        s.records.clear();
        s.windows = [];
        s.recent.clear();
        s.updates = [];
        unsaved.put.clear();
        unsaved.remove.clear();
        await store.clear();
      }),
    info: () => serial((s) => salesInfo(s)),
  };
}
