import {
  HISTORY_DB_NAME,
  HISTORY_Q15_BUCKET_MS,
  HISTORY_Q15_KEEP_MS,
  HISTORY_RAW_KEEP_MS,
  HISTORY_RECENT_MS,
  LATEST_BOOK_DEPTH,
} from '../config.ts';
import { marketStatFromColumns } from '../domain/marketStats.ts';
import { pctChange } from '../domain/stats.ts';
import type { HistoryPoint, HistoryRange, HistoryRepo, MarketStat, PriceStats, Product, Snapshot } from '../types/contracts.ts';
import { openDb, reqP, txDone } from './db.ts';

/*
 * Schema (db version 1):
 *   latest  out-of-line key 'latest' -> Snapshot (books trimmed to LATEST_BOOK_DEPTH)
 *   ids     keyPath 'v'  -> { v, ids: string[] }            product order of the Float32 rows
 *   raw     keyPath 'ts' -> { ts, v, data: Float32Array }    every snapshot, kept HISTORY_RAW_KEEP_MS
 *   q15     keyPath 'ts' -> { ts, at, v, data }              ts = bucket start, at = snapshot lastUpdated;
 *                                                            last snapshot per bucket wins, kept HISTORY_Q15_KEEP_MS
 * Row layout: data[i*FIELDS + k], k = [bid, ask, instaBuysWeek, instaSellsWeek, buyOrders, sellOrders]; NaN = null.
 */
const DB_VERSION = 1;
const FIELDS = 6;
const LATEST_KEY = 'latest';
const CHANGE_MIN_SPAN_MS = 20 * 3600_000;
/** ids per block in marketStats (keeps the column buffers cache-sized) */
const STATS_CHUNK = 256;

interface IdsRec {
  v: number;
  ids: string[];
}
interface RawRec {
  ts: number;
  v: number;
  data: Float32Array;
}
interface Q15Rec {
  ts: number;
  at: number;
  v: number;
  data: Float32Array;
}
interface Version {
  ids: string[];
  index: Map<string, number>;
}

const bucketOf = (ts: number) => Math.floor(ts / HISTORY_Q15_BUCKET_MS) * HISTORY_Q15_BUCKET_MS;

function upgrade(db: IDBDatabase): void {
  const names = db.objectStoreNames;
  if (!names.contains('latest')) db.createObjectStore('latest');
  if (!names.contains('ids')) db.createObjectStore('ids', { keyPath: 'v' });
  if (!names.contains('raw')) db.createObjectStore('raw', { keyPath: 'ts' });
  if (!names.contains('q15')) db.createObjectStore('q15', { keyPath: 'ts' });
}

function trimProduct(p: Product): Product {
  return { ...p, bids: p.bids.slice(0, LATEST_BOOK_DEPTH), asks: p.asks.slice(0, LATEST_BOOK_DEPTH) };
}

function trimSnapshot(s: Snapshot): Snapshot {
  const products: Record<string, Product> = {};
  for (const [id, p] of Object.entries(s.products)) products[id] = trimProduct(p);
  return { ...s, products };
}

function looksLikeSnapshot(x: unknown): x is Snapshot {
  if (!x || typeof x !== 'object') return false;
  const s = x as Partial<Snapshot>;
  return typeof s.lastUpdated === 'number' && Number.isFinite(s.lastUpdated) && !!s.products && typeof s.products === 'object';
}

/** Insert into an array sorted by `key`, replacing an element with the same key. */
function upsertSorted<T>(arr: T[], item: T, key: (t: T) => number): void {
  const k = key(item);
  let i = arr.length;
  while (i > 0 && key(arr[i - 1]!) > k) i--;
  if (i > 0 && key(arr[i - 1]!) === k) arr[i - 1] = item;
  else arr.splice(i, 0, item);
}

function dropBefore<T>(arr: T[], cut: number, key: (t: T) => number): void {
  let n = 0;
  while (n < arr.length && key(arr[n]!) < cut) n++;
  if (n) arr.splice(0, n);
}

/** median + MAD on a scratch typed array (sorted in place); same results as domain/stats median/mad, much faster. */
function medMad(xs: Float64Array): [number, number] {
  const n = xs.length;
  if (n === 0) return [NaN, NaN];
  const mid = n >> 1;
  xs.sort();
  const med = n % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  for (let i = 0; i < n; i++) xs[i] = Math.abs(xs[i]! - med);
  xs.sort();
  const madv = n % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
  return [med, madv];
}

const warn = (what: string, e: unknown) => console.warn(`history: ${what}`, e);

/**
 * IndexedDB-backed price history (see plan: stores latest, ids, raw (Float32Array rows, 3h), q15 (15-min buckets, 7d)).
 * Must degrade gracefully (in-memory only) if IndexedDB is unavailable.
 */
export function createHistoryRepo(dbName: string = HISTORY_DB_NAME, now: () => number = Date.now): HistoryRepo {
  let db: IDBDatabase | null = null;
  let initP: Promise<void> | null = null;
  const versions = new Map<number, Version>();
  let curV = 0;
  /** sorted by ts */
  const raw: RawRec[] = [];
  /** sorted by bucket ts; last 24h with a DB, last 7d in memory-only mode */
  const q15: Q15Rec[] = [];
  /** lastUpdated values already recorded */
  const seen = new Set<number>();
  /** bucket keys of every stored q15 record (the DB holds 7d, memory only 24h of them); for info() */
  const q15Keys: number[] = [];
  let latestMem: Snapshot | null = null;
  let queue: Promise<void> = Promise.resolve();

  // derived-data cache, invalidated on every record()
  let rev = 0;
  const cache = new Map<string, { key: string; points: HistoryPoint[]; stats: PriceStats | null | undefined }>();
  /** marketStats memo per taxRate */
  const statsMemo = new Map<number, { key: string; stats: ReadonlyMap<string, MarketStat> }>();

  function addVersion(v: number, ids: string[]): void {
    versions.set(v, { ids, index: new Map(ids.map((id, i) => [id, i])) });
    if (v > curV) curV = v;
  }

  function memQ15Keep(): number {
    return db ? HISTORY_RECENT_MS : HISTORY_Q15_KEEP_MS;
  }

  function pruneMemory(t: number): void {
    dropBefore(raw, t - HISTORY_RAW_KEEP_MS, (r) => r.ts);
    dropBefore(q15, t - memQ15Keep(), (r) => r.at);
    const cut = t - HISTORY_Q15_KEEP_MS;
    dropBefore(q15Keys, cut, (k) => k); // same cut as the DB prune (keys below t - 7d)
    for (const ts of seen) if (ts < cut) seen.delete(ts);
  }

  async function doInit(): Promise<void> {
    const t = now();
    try {
      db = await openDb(dbName, DB_VERSION, upgrade);
    } catch (e) {
      if (typeof indexedDB !== 'undefined') warn('IndexedDB unavailable, using memory only', e);
      db = null;
      return;
    }
    try {
      // prune expired records and load what's left (one transaction, no awaits inside it)
      const tx = db.transaction(['ids', 'raw', 'q15'], 'readwrite');
      const done = txDone(tx);
      const rawS = tx.objectStore('raw');
      const q15S = tx.objectStore('q15');
      rawS.delete(IDBKeyRange.upperBound(t - HISTORY_RAW_KEEP_MS, true));
      q15S.delete(IDBKeyRange.upperBound(t - HISTORY_Q15_KEEP_MS, true));
      const firstV = (store: IDBObjectStore) => reqP(store.openCursor()).then((c) => (c ? (c.value as { v: number }).v : Infinity));
      const all = Promise.all([
        firstV(rawS),
        firstV(q15S),
        reqP(tx.objectStore('ids').getAll() as IDBRequest<IdsRec[]>),
        reqP(rawS.getAll() as IDBRequest<RawRec[]>),
        reqP(q15S.getAll(IDBKeyRange.lowerBound(bucketOf(t - HISTORY_RECENT_MS))) as IDBRequest<Q15Rec[]>),
        reqP(q15S.getAllKeys() as IDBRequest<number[]>),
      ]);
      all.catch(() => undefined); // surfaced via `done` if the transaction fails
      await done;
      const [vRaw, vQ15, allIds, rawRecs, q15Recs, keys] = await all;
      const maxV = allIds.reduce((m, r) => Math.max(m, r.v), 0);
      const keepFrom = Math.min(vRaw, vQ15, maxV);
      const stale: number[] = [];
      for (const r of allIds) {
        if (r.v < keepFrom) stale.push(r.v);
        else addVersion(r.v, r.ids);
      }
      for (const r of rawRecs) if (r.data instanceof Float32Array) raw.push(r);
      for (const r of q15Recs) if (r.data instanceof Float32Array) q15.push(r);
      raw.sort((a, b) => a.ts - b.ts);
      q15.sort((a, b) => a.ts - b.ts);
      for (const r of raw) seen.add(r.ts);
      for (const r of q15) seen.add(r.at);
      for (const k of keys) if (typeof k === 'number') q15Keys.push(k);
      q15Keys.sort((a, b) => a - b);
      pruneMemory(t);
      if (stale.length) await deleteIds(stale);
    } catch (e) {
      // Unknown on-disk state: don't risk mixing id versions, run in memory only.
      warn('loading history failed, using memory only', e);
      db?.close();
      db = null;
      versions.clear();
      curV = 0;
      raw.length = 0;
      q15.length = 0;
      q15Keys.length = 0;
      seen.clear();
    }
  }

  /** Drop id versions no stored record references anymore (non-critical). */
  async function deleteIds(vs: number[]): Promise<void> {
    if (!db) return;
    try {
      const tx = db.transaction('ids', 'readwrite');
      const done = txDone(tx);
      for (const v of vs) tx.objectStore('ids').delete(v);
      await done;
    } catch (e) {
      warn('pruning id versions failed', e);
    }
  }

  function ensureInit(): Promise<void> {
    initP ??= doInit();
    return initP;
  }

  /** Returns the version for this snapshot's id set, creating one if needed. */
  function versionFor(s: Snapshot): { v: number; created: IdsRec | null } {
    const ids = Object.keys(s.products);
    const cur = versions.get(curV);
    if (cur && cur.ids.length === ids.length && ids.every((id) => cur.index.has(id))) return { v: curV, created: null };
    const v = curV + 1;
    const sorted = ids.sort();
    addVersion(v, sorted);
    return { v, created: { v, ids: sorted } };
  }

  function buildRow(s: Snapshot, ver: Version): Float32Array {
    const data = new Float32Array(ver.ids.length * FIELDS).fill(NaN);
    ver.ids.forEach((id, i) => {
      const p = s.products[id];
      if (!p) return;
      const o = i * FIELDS;
      data[o] = p.bid ?? NaN;
      data[o + 1] = p.ask ?? NaN;
      data[o + 2] = p.instaBuysWeek;
      data[o + 3] = p.instaSellsWeek;
      data[o + 4] = p.quick.buyOrders;
      data[o + 5] = p.quick.sellOrders;
    });
    return data;
  }

  function pointOf(rec: { v: number; data: Float32Array }, ts: number, id: string): HistoryPoint | null {
    const i = versions.get(rec.v)?.index.get(id);
    if (i === undefined) return null;
    const o = i * FIELDS;
    const d = rec.data;
    const bid = d[o]!;
    const ask = d[o + 1]!;
    if (Number.isNaN(bid) && Number.isNaN(ask)) return null;
    return {
      ts,
      bid,
      ask,
      instaBuysWeek: d[o + 2]!,
      instaSellsWeek: d[o + 3]!,
      buyOrders: d[o + 4]!,
      sellOrders: d[o + 5]!,
    };
  }

  function rawPoints(id: string, from: number): HistoryPoint[] {
    const out: HistoryPoint[] = [];
    for (const r of raw) {
      if (r.ts < from) continue;
      const p = pointOf(r, r.ts, id);
      if (p) out.push(p);
    }
    return out;
  }

  /** q15 points (ts = snapshot time) followed by raw points newer than the last q15 one. */
  function q15PlusNewest(recs: readonly Q15Rec[], id: string, from: number): HistoryPoint[] {
    const out: HistoryPoint[] = [];
    let last = -Infinity;
    for (const r of recs) {
      if (r.at < from) continue;
      const p = pointOf(r, r.at, id);
      if (p) out.push(p);
      if (r.at > last) last = r.at;
    }
    for (const p of rawPoints(id, Math.max(from, last + 1))) out.push(p);
    return out.sort((a, b) => a.ts - b.ts);
  }

  /** Records making up recent(): q15 + raw for the last 24h, deduped by snapshot time (raw wins), sorted. */
  let recentList: { key: string; recs: { ts: number; v: number; data: Float32Array }[] } | null = null;

  function cacheKey(): string {
    return `${rev}:${Math.floor(now() / 60_000)}`;
  }

  function recentRecords(key: string) {
    if (recentList?.key === key) return recentList.recs;
    const from = now() - HISTORY_RECENT_MS;
    const rawTs = new Set(raw.map((r) => r.ts));
    const recs: { ts: number; v: number; data: Float32Array }[] = [];
    for (const r of q15) if (r.at >= from && !rawTs.has(r.at)) recs.push({ ts: r.at, v: r.v, data: r.data });
    for (const r of raw) if (r.ts >= from) recs.push(r);
    recs.sort((a, b) => a.ts - b.ts);
    recentList = { key, recs };
    return recs;
  }

  function cacheEntry(id: string) {
    const key = cacheKey();
    let e = cache.get(id);
    if (!e || e.key !== key) {
      const points: HistoryPoint[] = [];
      for (const r of recentRecords(key)) {
        const p = pointOf(r, r.ts, id);
        if (p) points.push(p);
      }
      e = { key, points, stats: undefined };
      cache.set(id, e);
    }
    return e;
  }

  /**
   * Stats baseline: medians/MADs use the recent points thinned to the last point per 15-min bucket (like q15),
   * minus points newer than now - 15 min, so a fresh multi-hour spike in the dense raw data can't become the
   * median it is compared against. n counts those baseline points. change24h uses the full-resolution points.
   */
  function computeStats(points: readonly HistoryPoint[]): PriceStats | null {
    if (points.length === 0) return null;
    const cut = now() - HISTORY_Q15_BUCKET_MS;
    const asks = new Float64Array(points.length);
    const bids = new Float64Array(points.length);
    let n = 0;
    let na = 0;
    let nb = 0;
    let first: HistoryPoint | null = null;
    let last: HistoryPoint | null = null;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (Number.isFinite(p.ask) && Number.isFinite(p.bid)) {
        first ??= p;
        last = p;
      }
      // points are sorted: p is its bucket's last point iff the next one is in another bucket
      const next = points[i + 1];
      if (next && bucketOf(next.ts) === bucketOf(p.ts)) continue;
      if (p.ts > cut) continue;
      n++;
      if (Number.isFinite(p.ask)) asks[na++] = p.ask;
      if (Number.isFinite(p.bid)) bids[nb++] = p.bid;
    }
    const [medianAsk, madAsk] = medMad(asks.subarray(0, na));
    const [medianBid, madBid] = medMad(bids.subarray(0, nb));
    const mid = (p: HistoryPoint) => (p.bid + p.ask) / 2;
    const change24h = first && last && last.ts - first.ts >= CHANGE_MIN_SPAN_MS ? pctChange(mid(first), mid(last)) : null;
    return { n, medianAsk, medianBid, madAsk, madBid, change24h };
  }

  function invalidate(): void {
    rev++;
    cache.clear();
    recentList = null;
    statsMemo.clear();
  }

  /**
   * MarketStat for every id in the recent (24h) records without building point objects: ids are processed in
   * blocks of STATS_CHUNK; for each block one sweep over the records copies the block's Float32 cells into per-id
   * column buffers (cache-sized), then marketStatFromColumns summarises each id from subarray views.
   * Every record cell is read once. ~20 ms for 2,200 ids x 280 records on a desktop (see the bench test).
   */
  function computeMarketStats(taxRate: number, key: string): ReadonlyMap<string, MarketStat> {
    const recs = recentRecords(key);
    const R = recs.length;
    const out = new Map<string, MarketStat>();
    if (R === 0) return out;
    // global id numbering across the id versions in use
    const gIndex = new Map<string, number>();
    const gIds: string[] = [];
    const used = [...new Set(recs.map((r) => r.v))];
    for (const v of used) {
      for (const id of versions.get(v)?.ids ?? []) {
        if (gIndex.has(id)) continue;
        gIndex.set(id, gIds.length);
        gIds.push(id);
      }
    }
    const N = gIds.length;
    // per version: global index -> row (-1 = absent)
    const inv = new Map<number, Int32Array>();
    for (const v of used) {
      const a = new Int32Array(N).fill(-1);
      (versions.get(v)?.ids ?? []).forEach((id, row) => (a[gIndex.get(id)!] = row));
      inv.set(v, a);
    }
    const recInv = recs.map((r) => inv.get(r.v)!);
    const C = Math.min(N, STATS_CHUNK);
    const cnt = new Int32Array(C);
    const ts = new Float64Array(C * R);
    const bid = new Float32Array(C * R);
    const ask = new Float32Array(C * R);
    const bw = new Float32Array(C * R);
    const sw = new Float32Array(C * R);
    const t = now();
    const scratch = new Float64Array(2 * R);
    for (let g0 = 0; g0 < N; g0 += C) {
      const g1 = Math.min(N, g0 + C);
      cnt.fill(0);
      for (let r = 0; r < R; r++) {
        const rowOf = recInv[r]!;
        const d = recs[r]!.data;
        const rts = recs[r]!.ts;
        for (let g = g0; g < g1; g++) {
          const row = rowOf[g]!;
          if (row < 0) continue;
          const o = row * FIELDS;
          const b = d[o]!;
          const a = d[o + 1]!;
          if (Number.isNaN(b) && Number.isNaN(a)) continue; // same rule as pointOf
          const j = g - g0;
          const k = j * R + cnt[j]!++;
          ts[k] = rts;
          bid[k] = b;
          ask[k] = a;
          bw[k] = d[o + 2]!;
          sw[k] = d[o + 3]!;
        }
      }
      for (let g = g0; g < g1; g++) {
        const j = g - g0;
        const n = cnt[j]!;
        if (n === 0) continue;
        const lo = j * R;
        const cols = {
          ts: ts.subarray(lo, lo + n),
          bid: bid.subarray(lo, lo + n),
          ask: ask.subarray(lo, lo + n),
          buyWeek: bw.subarray(lo, lo + n),
          sellWeek: sw.subarray(lo, lo + n),
        };
        out.set(gIds[g]!, marketStatFromColumns(gIds[g]!, cols, n, t, taxRate, scratch));
      }
    }
    return out;
  }

  async function doClear(): Promise<void> {
    await ensureInit();
    raw.length = 0;
    q15.length = 0;
    q15Keys.length = 0;
    seen.clear();
    versions.clear();
    curV = 0;
    latestMem = null;
    invalidate();
    if (!db) return;
    try {
      // ids go too: they only describe rows of the deleted records. Schema/version untouched.
      const tx = db.transaction(['latest', 'ids', 'raw', 'q15'], 'readwrite');
      const done = txDone(tx);
      for (const name of ['latest', 'ids', 'raw', 'q15']) tx.objectStore(name).clear();
      await done;
    } catch (e) {
      warn('clearing history failed', e);
    }
  }

  async function writeRecord(ts: number, ver: { v: number; created: IdsRec | null }, data: Float32Array, t: number): Promise<void> {
    if (!db) return;
    const tx = db.transaction(['ids', 'raw', 'q15'], 'readwrite');
    const done = txDone(tx);
    if (ver.created) tx.objectStore('ids').put(ver.created);
    const rawS = tx.objectStore('raw');
    const q15S = tx.objectStore('q15');
    if (ts >= t - HISTORY_RAW_KEEP_MS) {
      const k = rawS.getKey(ts);
      k.onsuccess = () => {
        if (k.result === undefined) rawS.put({ ts, v: ver.v, data } satisfies RawRec);
      };
    }
    if (ts >= t - HISTORY_Q15_KEEP_MS) {
      const bucket = bucketOf(ts);
      const g = q15S.get(bucket);
      g.onsuccess = () => {
        const cur = g.result as Q15Rec | undefined;
        if (!cur || cur.at < ts) q15S.put({ ts: bucket, at: ts, v: ver.v, data } satisfies Q15Rec);
      };
    }
    rawS.delete(IDBKeyRange.upperBound(t - HISTORY_RAW_KEEP_MS, true));
    q15S.delete(IDBKeyRange.upperBound(t - HISTORY_Q15_KEEP_MS, true));
    await done;
  }

  async function doRecord(s: Snapshot): Promise<void> {
    await ensureInit();
    const ts = s.lastUpdated;
    if (!Number.isFinite(ts) || seen.has(ts)) return;
    seen.add(ts);
    const t = now();
    const ver = versionFor(s);
    const data = buildRow(s, versions.get(ver.v)!);

    if (ts >= t - HISTORY_RAW_KEEP_MS) upsertSorted(raw, { ts, v: ver.v, data }, (r) => r.ts);
    const bucket = bucketOf(ts);
    if (ts >= t - memQ15Keep()) {
      const existing = q15.find((r) => r.ts === bucket);
      if (!existing || existing.at < ts) upsertSorted(q15, { ts: bucket, at: ts, v: ver.v, data }, (r) => r.ts);
    }
    if (ts >= t - HISTORY_Q15_KEEP_MS) upsertSorted(q15Keys, bucket, (k) => k);
    pruneMemory(t);
    invalidate();

    try {
      await writeRecord(ts, ver, data, t);
    } catch (e) {
      warn('write failed', e);
    }
  }

  async function readQ15FromDb(from: number): Promise<Q15Rec[] | null> {
    if (!db) return null;
    try {
      const tx = db.transaction('q15', 'readonly');
      const recs = await reqP(tx.objectStore('q15').getAll(IDBKeyRange.lowerBound(bucketOf(from))) as IDBRequest<Q15Rec[]>);
      return recs.filter((r) => r.data instanceof Float32Array);
    } catch (e) {
      warn('reading 7d history failed', e);
      return null;
    }
  }

  return {
    init: ensureInit,

    record(s: Snapshot): Promise<void> {
      const p = queue.then(() => doRecord(s));
      queue = p.catch(() => undefined);
      return p;
    },

    async series(id: string, range: HistoryRange): Promise<HistoryPoint[]> {
      await ensureInit();
      await queue;
      const t = now();
      if (range === '3h') return rawPoints(id, t - HISTORY_RAW_KEEP_MS);
      if (range === '24h') return q15PlusNewest(q15, id, t - HISTORY_RECENT_MS);
      const from = t - HISTORY_Q15_KEEP_MS;
      const recs = (await readQ15FromDb(from)) ?? q15;
      return q15PlusNewest(recs, id, from);
    },

    recent(id: string): HistoryPoint[] {
      return cacheEntry(id).points;
    },

    stats(id: string): PriceStats | null {
      const e = cacheEntry(id);
      if (e.stats === undefined) e.stats = computeStats(e.points);
      return e.stats;
    },

    async saveLatest(s: Snapshot): Promise<void> {
      const trimmed = trimSnapshot(s);
      latestMem = trimmed;
      await ensureInit();
      if (!db) return;
      try {
        const tx = db.transaction('latest', 'readwrite');
        const done = txDone(tx);
        tx.objectStore('latest').put(trimmed, LATEST_KEY);
        await done;
      } catch (e) {
        warn('saving latest snapshot failed', e);
      }
    },

    async loadLatest(): Promise<Snapshot | null> {
      await ensureInit();
      let s: unknown = null;
      if (db) {
        try {
          const tx = db.transaction('latest', 'readonly');
          s = await reqP(tx.objectStore('latest').get(LATEST_KEY));
        } catch (e) {
          warn('loading latest snapshot failed', e);
        }
      }
      if (!looksLikeSnapshot(s)) s = latestMem;
      return looksLikeSnapshot(s) ? { ...s, source: 'cache' } : null;
    },

    marketStats(taxRate: number): ReadonlyMap<string, MarketStat> {
      // keyed like recent(): new record or a new minute (the 24h window slides) -> recompute
      const key = cacheKey();
      const hit = statsMemo.get(taxRate);
      if (hit?.key === key) return hit.stats;
      const stats = computeMarketStats(taxRate, key);
      statsMemo.set(taxRate, { key, stats });
      return stats;
    },

    /**
     * raw = raw records (3h); q15 = stored 15-min buckets (7d, persistent store when there is one);
     * oldest = earliest snapshot time still stored (for DB-only buckets: the bucket start).
     */
    info() {
      const k0 = q15Keys[0];
      const q0 = q15[0];
      const qOldest = k0 === undefined || q0?.ts === k0 ? (q0?.at ?? Infinity) : k0;
      const oldest = Math.min(raw[0]?.ts ?? Infinity, qOldest);
      return { raw: raw.length, q15: q15Keys.length, oldest: Number.isFinite(oldest) ? oldest : null, persistent: !!db };
    },

    clear(): Promise<void> {
      const p = queue.then(doClear);
      queue = p.catch(() => undefined);
      return p;
    },
  };
}
