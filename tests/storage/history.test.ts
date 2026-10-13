import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHistoryRepo } from '../../src/storage/history.ts';
import { BOOK_DEPTH, HISTORY_Q15_BUCKET_MS, LATEST_BOOK_DEPTH } from '../../src/config.ts';
import type { Product, Snapshot } from '../../src/types/contracts.ts';

const MIN = 60_000;
const H = 3600_000;
const T0 = Date.UTC(2026, 9, 1); // bucket aligned

let dbn = 0;
const newName = () => `hist-test-${++dbn}-${Math.random()}`;

function product(id: string, bid: number | null, ask: number | null, depth = 3): Product {
  const lv = (p: number | null, d: number) => (p == null ? [] : Array.from({ length: depth }, (_, i) => ({ price: p + d * i, amount: 10, orders: 1 })));
  return {
    id,
    bid,
    ask,
    bids: lv(bid, -1),
    asks: lv(ask, 1),
    quick: { buyPrice: 0, sellPrice: 0, buyVolume: 0, sellVolume: 0, buyMovingWeek: 700, sellMovingWeek: 800, buyOrders: 7, sellOrders: 9 },
    instaBuysWeek: 700,
    instaSellsWeek: 800,
  };
}

function snap(ts: number, prices: Record<string, [number | null, number | null]>, depth = 3): Snapshot {
  const products: Record<string, Product> = {};
  for (const [id, [b, a]] of Object.entries(prices)) products[id] = product(id, b, a, depth);
  return { lastUpdated: ts, fetchedAt: ts, source: 'live', products };
}

function clock(t = T0) {
  const c = { t, now: () => c.t };
  return c;
}

async function countStore(name: string, store: string): Promise<number> {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const n = await new Promise<number>((res, rej) => {
    const r = db.transaction(store).objectStore(store).count();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  db.close();
  return n;
}

async function getAll<T>(name: string, store: string): Promise<T[]> {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const v = await new Promise<T[]>((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result as T[]);
    r.onerror = () => rej(r.error);
  });
  db.close();
  return v;
}

afterEach(() => vi.unstubAllGlobals());

describe('history repo', () => {
  it('records, dedupes by lastUpdated, and serves recent()', async () => {
    const name = newName();
    const c = clock();
    const repo = createHistoryRepo(name, c.now);
    await repo.init();
    await repo.record(snap(T0, { A: [10, 12], B: [null, 5] }));
    await repo.record(snap(T0, { A: [99, 99], B: [1, 2] })); // same lastUpdated -> ignored
    c.t += MIN;
    await repo.record(snap(T0 + MIN, { A: [11, 13], B: [null, null] }));

    const a = repo.recent('A');
    expect(a.map((p) => p.ts)).toEqual([T0, T0 + MIN]);
    expect(a[0]).toMatchObject({ bid: 10, ask: 12, instaBuysWeek: 700, instaSellsWeek: 800, buyOrders: 7, sellOrders: 9 });
    // B: null bid -> NaN; all-null row skipped
    const b = repo.recent('B');
    expect(b.length).toBe(1);
    expect(b[0]!.bid).toBeNaN();
    expect(b[0]!.ask).toBe(5);
    expect(repo.recent('UNKNOWN')).toEqual([]);
    expect(await countStore(name, 'raw')).toBe(2);
  });

  it('dedupes against the store across instances', async () => {
    const name = newName();
    const c = clock();
    const r1 = createHistoryRepo(name, c.now);
    await r1.record(snap(T0, { A: [10, 12] })); // record() inits lazily
    const r2 = createHistoryRepo(name, c.now);
    await r2.init();
    await r2.record(snap(T0, { A: [50, 60] }));
    expect(r2.recent('A').map((p) => p.bid)).toEqual([10]);
    expect(await countStore(name, 'raw')).toBe(1);
  });

  it('keeps one q15 record per bucket (last wins)', async () => {
    const name = newName();
    const c = clock();
    const repo = createHistoryRepo(name, c.now);
    for (let i = 0; i < 20; i++) {
      c.t = T0 + i * MIN;
      await repo.record(snap(c.t, { A: [100 + i, 200 + i] }));
    }
    const q = await getAll<{ ts: number; at: number }>(name, 'q15');
    expect(q.map((r) => r.ts)).toEqual([T0, T0 + HISTORY_Q15_BUCKET_MS]);
    expect(q.map((r) => r.at)).toEqual([T0 + 14 * MIN, T0 + 19 * MIN]);
    // an older snapshot arriving late must not overwrite the bucket
    await repo.record(snap(T0 + 30 * 1000, { A: [1, 1] }));
    const q2 = await getAll<{ ts: number; at: number }>(name, 'q15');
    expect(q2.find((r) => r.ts === T0)!.at).toBe(T0 + 14 * MIN);
  });

  it('prunes raw after 3h and q15 after 7d', async () => {
    const name = newName();
    const c = clock();
    const repo = createHistoryRepo(name, c.now);
    await repo.record(snap(T0, { A: [1, 2] }));
    c.t = T0 + 3 * H + MIN;
    await repo.record(snap(c.t, { A: [1, 2] }));
    expect(await countStore(name, 'raw')).toBe(1);
    expect(await countStore(name, 'q15')).toBe(2);
    expect((await repo.series('A', '3h')).map((p) => p.ts)).toEqual([c.t]);
    c.t = T0 + 7 * 24 * H + MIN;
    await repo.record(snap(c.t, { A: [1, 2] }));
    expect(await countStore(name, 'raw')).toBe(1);
    const q = await getAll<{ at: number }>(name, 'q15');
    expect(q.map((r) => r.at)).toEqual([T0 + 3 * H + MIN, c.t]);
  });

  it('series: 3h from raw, 24h/7d from q15 + newest raw', async () => {
    const name = newName();
    const c = clock();
    const repo = createHistoryRepo(name, c.now);
    // one snapshot per 5 minutes for 2 days
    for (let t = T0; t <= T0 + 48 * H; t += 5 * MIN) {
      c.t = t;
      await repo.record(snap(t, { A: [t / MIN, t / MIN + 2] }));
    }
    const end = c.t;
    const s3 = await repo.series('A', '3h');
    expect(s3.length).toBe(37); // raw every 5 min over 3h inclusive
    expect(s3[0]!.ts).toBe(end - 3 * H);
    expect(s3.at(-1)!.ts).toBe(end);

    const s24 = await repo.series('A', '24h');
    expect(s24.at(-1)!.ts).toBe(end);
    expect(s24[0]!.ts).toBeGreaterThanOrEqual(end - 24 * H);
    expect(s24.length).toBeLessThanOrEqual(24 * 4 + 1);
    expect(s24.length).toBeGreaterThanOrEqual(24 * 4 - 1);

    const s7 = await repo.series('A', '7d');
    expect(s7[0]!.ts).toBe(T0 + 10 * MIN); // last snapshot of the first bucket
    expect(s7.at(-1)!.ts).toBe(end);
    for (let i = 1; i < s7.length; i++) expect(s7[i]!.ts).toBeGreaterThan(s7[i - 1]!.ts);

    // recent() = last 24h of q15 merged with raw (denser recent part)
    const rec = repo.recent('A');
    expect(rec.at(-1)!.ts).toBe(end);
    expect(rec.filter((p) => p.ts >= end - 3 * H).length).toBe(37);
    expect(new Set(rec.map((p) => p.ts)).size).toBe(rec.length);
  });

  it('stats: medians/MADs and change24h', async () => {
    const c = clock();
    const repo = createHistoryRepo(newName(), c.now);
    expect(repo.stats('A')).toBeNull();
    await repo.record(snap(T0, { A: [100, 110] }));
    // the only point is in the current bucket -> not part of the baseline yet
    let st = repo.stats('A')!;
    expect(st).toMatchObject({ n: 0, change24h: null });
    expect(st.medianBid).toBeNaN();
    c.t = T0 + 15 * MIN;
    st = repo.stats('A')!;
    expect(st).toMatchObject({ n: 1, medianBid: 100, medianAsk: 110, madBid: 0, madAsk: 0, change24h: null });

    // hourly points for 23h: bid 100..122, ask = bid + 10; mid rises 105 -> 127
    for (let h = 1; h <= 22; h++) {
      c.t = T0 + h * H;
      await repo.record(snap(c.t, { A: [100 + h, 110 + h] }));
    }
    st = repo.stats('A')!;
    // baseline = h 0..21 (the newest point is in the current bucket): bids 100..121
    expect(st.n).toBe(22);
    expect(st.medianBid).toBe(110.5);
    expect(st.medianAsk).toBe(120.5);
    expect(st.madBid).toBe(5.5);
    // change24h still uses the newest point
    expect(st.change24h).toBeCloseTo((127 - 105) / 105, 6);

    // only 10h of history -> change unknown
    const c2 = clock();
    const r2 = createHistoryRepo(newName(), c2.now);
    for (let h = 0; h <= 10; h++) {
      c2.t = T0 + h * H;
      await r2.record(snap(c2.t, { A: [100, 110] }));
    }
    expect(r2.stats('A')!.change24h).toBeNull();
  });

  it('stats thin raw points to one per 15-min bucket so a multi-hour spike stays detectable', async () => {
    const c = clock();
    const repo = createHistoryRepo(newName(), c.now);
    const end = T0 + 24 * H;
    const spikeFrom = end - 150 * MIN; // 2.5h of manipulated prices
    // every 15 min until 3h before the end, then every minute
    for (let t = T0 + 15 * MIN; t <= end; t += t < end - 3 * H ? 15 * MIN : MIN) {
      c.t = t;
      const price = t >= spikeFrom ? 300 : 100;
      await repo.record(snap(t, { A: [price, price + 10] }));
    }
    // full resolution kept for sparklines: 21h of q15 + 3h of per-minute raw
    const rec = repo.recent('A');
    expect(rec.filter((p) => p.ts > end - 3 * H).length).toBe(180);
    const spiked = rec.filter((p) => p.bid === 300).length;
    expect(spiked).toBeGreaterThan(rec.length / 2); // unthinned, the spike would be the median

    const st = repo.stats('A')!;
    expect(st.medianBid).toBe(100);
    expect(st.medianAsk).toBe(110);
    // 96 buckets (T0+15m .. end); dropped: the current bucket (holds `end`) and the previous one,
    // whose last point (end - 1 min) is newer than now - 15 min
    expect(st.n).toBe(96 - 2);
    expect(st.change24h).toBeCloseTo((305 - 105) / 105, 6);
  });

  it('stats ignore non-finite sides', async () => {
    const c = clock();
    const repo = createHistoryRepo(newName(), c.now);
    await repo.record(snap(T0, { A: [null, 10] }));
    c.t = T0 + H;
    await repo.record(snap(c.t, { A: [5, 20] }));
    c.t = T0 + 2 * H;
    const st = repo.stats('A')!;
    expect(st.n).toBe(2);
    expect(st.medianBid).toBe(5);
    expect(st.medianAsk).toBe(15);
  });

  it('handles id-set changes with a new ids version', async () => {
    const name = newName();
    const c = clock();
    const repo = createHistoryRepo(name, c.now);
    await repo.record(snap(T0, { A: [1, 2], B: [3, 4] }));
    c.t += MIN;
    await repo.record(snap(c.t, { B: [5, 6], A: [7, 8] })); // same set, different order
    c.t += MIN;
    await repo.record(snap(c.t, { A: [9, 10], C: [11, 12] }));
    const ids = await getAll<{ v: number; ids: string[] }>(name, 'ids');
    expect(ids.map((r) => r.ids)).toEqual([['A', 'B'], ['A', 'C']]);
    expect(repo.recent('A').map((p) => p.bid)).toEqual([1, 7, 9]);
    expect(repo.recent('B').map((p) => p.bid)).toEqual([3, 5]);
    expect(repo.recent('C').map((p) => p.bid)).toEqual([11]);

    // a reloaded repo resolves both versions
    const r2 = createHistoryRepo(name, c.now);
    await r2.init();
    expect(r2.recent('A').map((p) => p.bid)).toEqual([1, 7, 9]);
    expect(r2.recent('B').map((p) => p.bid)).toEqual([3, 5]);
  });

  it('persists across instances (init loads raw + q15), prunes unused id versions', async () => {
    const name = newName();
    const c = clock();
    const r1 = createHistoryRepo(name, c.now);
    await r1.record(snap(T0, { OLD: [1, 2] }));
    for (let h = 1; h <= 10; h++) {
      c.t = T0 + h * H;
      await r1.record(snap(c.t, { A: [h, h + 1] }));
    }
    const r2 = createHistoryRepo(name, c.now);
    await r2.init();
    expect(r2.recent('A').length).toBe(10);
    expect(r2.recent('OLD').length).toBe(1); // q15 kept
    expect(r2.stats('A')!.n).toBe(9); // newest point is in the current bucket

    // 8 days later the OLD version has no records left -> its ids row is dropped on init
    c.t = T0 + 8 * 24 * H;
    const r3 = createHistoryRepo(name, c.now);
    await r3.init();
    expect(r3.recent('A')).toEqual([]);
    expect(await countStore(name, 'q15')).toBe(0);
    const ids = await getAll<{ ids: string[] }>(name, 'ids');
    expect(ids.map((r) => r.ids)).toEqual([['A']]);
    // a new record continues with a fresh version number
    await r3.record(snap(c.t, { A: [1, 2] }));
    expect(r3.recent('A').length).toBe(1);
  });

  it('saveLatest/loadLatest trims books and marks source cache', async () => {
    const name = newName();
    const c = clock();
    const r1 = createHistoryRepo(name, c.now);
    expect(await r1.loadLatest()).toBeNull();
    const s = snap(T0, { A: [100, 110] }, BOOK_DEPTH);
    await r1.saveLatest(s);
    expect(s.products.A!.bids.length).toBe(BOOK_DEPTH); // input not mutated
    const r2 = createHistoryRepo(name, c.now);
    const got = (await r2.loadLatest())!;
    expect(got.source).toBe('cache');
    expect(got.lastUpdated).toBe(T0);
    expect(got.products.A!.bids.length).toBe(LATEST_BOOK_DEPTH);
    expect(got.products.A!.asks.length).toBe(LATEST_BOOK_DEPTH);
    expect(got.products.A!.bid).toBe(100);
  });

  it('works in memory when indexedDB is undefined', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const c = clock();
    const repo = createHistoryRepo(newName(), c.now);
    await expect(repo.init()).resolves.toBeUndefined();
    await repo.record(snap(T0, { A: [1, 2] }));
    c.t += 5 * H;
    await repo.record(snap(c.t, { A: [3, 4] }));
    expect(repo.recent('A').map((p) => p.bid)).toEqual([1, 3]);
    expect((await repo.series('A', '3h')).map((p) => p.bid)).toEqual([3]);
    expect((await repo.series('A', '7d')).map((p) => p.bid)).toEqual([1, 3]);
    await repo.saveLatest(snap(c.t, { A: [3, 4] }, 20));
    const l = (await repo.loadLatest())!;
    expect(l.source).toBe('cache');
    expect(l.products.A!.bids.length).toBe(LATEST_BOOK_DEPTH);
  });

  it('falls back to memory when open fails', async () => {
    vi.stubGlobal('indexedDB', {
      open() {
        throw new Error('SecurityError');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repo = createHistoryRepo(newName(), clock().now);
    await repo.init();
    await repo.record(snap(T0, { A: [1, 2] }));
    expect(repo.recent('A').length).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
