import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_Q15_BUCKET_MS } from '../../src/config.ts';
import { marketStatFromPoints } from '../../src/domain/marketStats.ts';
import { createHistoryRepo } from '../../src/storage/history.ts';
import type { Product, Snapshot } from '../../src/types/contracts.ts';

const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 9, 1); // bucket aligned
const TAX = 0.0125;

let dbn = 0;
const newName = () => `hist-stats-${++dbn}-${Math.random()}`;

function product(id: string, bid: number | null, ask: number | null, bw = 700, sw = 800): Product {
  return {
    id,
    bid,
    ask,
    bids: [],
    asks: [],
    quick: { buyPrice: 0, sellPrice: 0, buyVolume: 0, sellVolume: 0, buyMovingWeek: bw, sellMovingWeek: sw, buyOrders: 7, sellOrders: 9 },
    instaBuysWeek: bw,
    instaSellsWeek: sw,
  };
}

function snap(ts: number, prices: Record<string, [number | null, number | null, number?, number?]>): Snapshot {
  const products: Record<string, Product> = {};
  for (const [id, [b, a, bw, sw]] of Object.entries(prices)) products[id] = product(id, b, a, bw, sw);
  return { lastUpdated: ts, fetchedAt: ts, source: 'live', products };
}

function clock(t = T0) {
  const c = { t, now: () => c.t };
  return c;
}

async function openRaw(name: string): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function counts(name: string): Promise<{ version: number; stores: string[]; n: Record<string, number> }> {
  const db = await openRaw(name);
  const stores = [...db.objectStoreNames].sort();
  const n: Record<string, number> = {};
  for (const s of stores) {
    n[s] = await new Promise<number>((res, rej) => {
      const r = db.transaction(s).objectStore(s).count();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const version = db.version;
  db.close();
  return { version, stores, n };
}

afterEach(() => vi.unstubAllGlobals());

describe('history marketStats', () => {
  it('equals marketStatFromPoints(recent(id)) for every id, across id versions', async () => {
    const c = clock();
    const repo = createHistoryRepo(newName(), c.now);
    expect(repo.marketStats(TAX).size).toBe(0);
    // 22h every 15 min (q15 only), then the last 2h every minute (raw); B disappears for a while, C appears late
    for (let t = T0; t <= T0 + 24 * H; t += t < T0 + 22 * H ? 15 * MIN : MIN) {
      c.t = t;
      const k = (t - T0) / MIN;
      const prices: Record<string, [number | null, number | null, number?, number?]> = {
        A: [100 + (k % 13), 110 + (k % 7), 10_000 + k, 20_000 - k],
      };
      if (t < T0 + 10 * H || t > T0 + 15 * H) prices.B = [k % 2 ? null : 50, 60, 500, 500];
      if (t > T0 + 20 * H) prices.C = [5, 5.5, 1e6, 1e6];
      await repo.record(snap(t, prices));
    }
    const ms = repo.marketStats(TAX);
    expect([...ms.keys()].sort()).toEqual(['A', 'B', 'C']);
    for (const id of ['A', 'B', 'C']) {
      const want = marketStatFromPoints(id, repo.recent(id), c.t, TAX);
      const got = ms.get(id)!;
      for (const [k, v] of Object.entries(want)) {
        if (typeof v === 'number') expect(got[k as keyof typeof got], `${id}.${k}`).toBeCloseTo(v, 9);
        else expect(got[k as keyof typeof got], `${id}.${k}`).toBe(v);
      }
    }
    expect(ms.get('A')!.n).toBeGreaterThanOrEqual(90);
    expect(ms.get('A')!.change24h).not.toBeNull();
    expect(ms.get('C')!.change24h).toBeNull(); // only 4h of C
  });

  it('memoizes per record, minute and tax rate', async () => {
    const c = clock();
    const repo = createHistoryRepo(newName(), c.now);
    for (let h = 0; h < 3; h++) {
      c.t = T0 + h * H;
      await repo.record(snap(c.t, { A: [100, 110] }));
    }
    const a = repo.marketStats(TAX);
    expect(repo.marketStats(TAX)).toBe(a);
    const b = repo.marketStats(0.01);
    expect(b).not.toBe(a);
    expect(repo.marketStats(TAX)).toBe(a); // one memo per tax rate
    c.t += MIN;
    const a2 = repo.marketStats(TAX);
    expect(a2).not.toBe(a);
    await repo.record(snap(c.t, { A: [100, 110] }));
    expect(repo.marketStats(TAX)).not.toBe(a2);
    // a duplicate record doesn't invalidate
    const a3 = repo.marketStats(TAX);
    await repo.record(snap(c.t, { A: [1, 1] }));
    expect(repo.marketStats(TAX)).toBe(a3);
  });

  it('bench: 2,200 ids x ~280 records', async () => {
    vi.stubGlobal('indexedDB', undefined); // memory only: the bench is about marketStats, not IDB writes
    const c = clock();
    const repo = createHistoryRepo(newName(), c.now);
    const N = 2200;
    const ids = Array.from({ length: N }, (_, i) => `ITEM_${i}`);
    const products: Record<string, Product> = {};
    for (const id of ids) products[id] = product(id, 100, 110, 100_000, 100_000);
    const s: Snapshot = { lastUpdated: 0, fetchedAt: 0, source: 'live', products };
    const end = T0 + 24 * H;
    let i = 0;
    // 21h of 15-min buckets + 3h of snapshots every 55 s = 84 + 197 records in the 24h window
    for (let t = end - 24 * H + 15 * MIN; t <= end; t += t < end - 3 * H ? 15 * MIN : 55_000) {
      c.t = t;
      i++;
      for (let j = 0; j < N; j++) {
        const p = products[ids[j]!]!;
        p.bid = 100 + ((i * 7 + j) % 11);
        p.ask = p.bid + 5 + (j % 3);
        p.instaBuysWeek += j % 5;
        p.instaSellsWeek -= j % 3;
      }
      await repo.record({ ...s, lastUpdated: t });
    }
    const recs = repo.recent(ids[0]!).length;
    expect(recs).toBeGreaterThanOrEqual(280);

    for (const tax of [0.01, 0.01125]) repo.marketStats(tax); // warm up the JIT
    let dt = Infinity;
    let ms = repo.marketStats(TAX);
    for (let k = 0; k < 3; k++) {
      c.t += MIN; // new minute -> no memo hit
      const t0 = performance.now();
      ms = repo.marketStats(TAX);
      dt = Math.min(dt, performance.now() - t0);
    }
    expect(ms.size).toBe(N);
    const st = ms.get('ITEM_5')!;
    expect(st.n).toBeGreaterThan(90);
    expect(st.consistency).not.toBeNull();
    expect(st.buyVolTrend).not.toBeNull();
    // spot check against the per-item path
    const want = marketStatFromPoints('ITEM_5', repo.recent('ITEM_5'), c.t, TAX);
    expect(st.consistency).toBeCloseTo(want.consistency!, 12);
    expect(st.volatility).toBeCloseTo(want.volatility!, 12);
    console.info(`marketStats: ${N} ids x ${recs} records in ${dt.toFixed(1)} ms (best of 3)`);
    // target < 50 ms (~20 ms measured on a desktop); generous on CI / under coverage instrumentation
    // (V8 coverage deoptimizes the hot loops ~10x; vitest has no public flag for it, hence the worker config peek)
    const coverage = (globalThis as { __vitest_worker__?: { config?: { coverage?: { enabled?: boolean } } } }).__vitest_worker__?.config
      ?.coverage?.enabled;
    const slow = !!process.env.CI || coverage !== false;
    expect(dt).toBeLessThan(slow ? 500 : 50);
  }, 60_000);
});

describe('history info / clear', () => {
  it('info counts stored q15 buckets beyond the in-memory 24h and the oldest snapshot', async () => {
    const name = newName();
    const c = clock();
    const r1 = createHistoryRepo(name, c.now);
    expect(r1.info()).toEqual({ raw: 0, q15: 0, oldest: null, persistent: false }); // before init
    await r1.init();
    expect(r1.info()).toEqual({ raw: 0, q15: 0, oldest: null, persistent: true });
    for (let h = 0; h <= 48; h += 2) {
      c.t = T0 + 5 * MIN + h * H;
      await r1.record(snap(c.t, { A: [1, 2] }));
    }
    // 25 snapshots, each in its own bucket; raw keeps the ones within 3h (t-2h, t)
    // memory holds 24h of q15; info reports every stored bucket, the oldest by its bucket start
    expect(r1.info()).toMatchObject({ raw: 2, q15: 25, oldest: T0, persistent: true });
    const r2 = createHistoryRepo(name, c.now);
    await r2.init();
    expect(r2.info()).toMatchObject({ raw: 2, q15: 25, oldest: T0, persistent: true });
    c.t = T0 + 8 * 24 * H; // buckets older than 7d (h < 24) are pruned
    await r2.record(snap(c.t, { A: [1, 2] }));
    expect(r2.info()).toMatchObject({ raw: 1, q15: 13 + 1, oldest: T0 + 24 * H });
    c.t = T0 + 16 * 24 * H;
    await r2.record(snap(c.t, { A: [1, 2] }));
    expect(r2.info()).toMatchObject({ raw: 1, q15: 1, oldest: c.t });
  });

  it('info in memory-only mode', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const c = clock();
    const repo = createHistoryRepo(newName(), c.now);
    await repo.record(snap(T0 + MIN, { A: [1, 2] }));
    c.t = T0 + 5 * H;
    await repo.record(snap(c.t, { A: [1, 2] }));
    expect(repo.info()).toEqual({ raw: 1, q15: 2, oldest: T0 + MIN, persistent: false });
  });

  it('clear() wipes every store and memory, keeps the schema at version 1', async () => {
    const name = newName();
    const c = clock();
    const repo = createHistoryRepo(name, c.now);
    for (let i = 0; i < 5; i++) {
      c.t = T0 + i * HISTORY_Q15_BUCKET_MS;
      await repo.record(snap(c.t, { A: [10 + i, 12 + i] }));
    }
    await repo.saveLatest(snap(c.t, { A: [1, 2] }));
    expect((await counts(name)).n).toEqual({ ids: 1, latest: 1, q15: 5, raw: 5 });
    const before = repo.marketStats(TAX);
    expect(before.size).toBe(1);

    await repo.clear();
    expect(repo.recent('A')).toEqual([]);
    expect(repo.stats('A')).toBeNull();
    expect(repo.marketStats(TAX).size).toBe(0);
    expect(await repo.series('A', '7d')).toEqual([]);
    expect(await repo.loadLatest()).toBeNull();
    expect(repo.info()).toEqual({ raw: 0, q15: 0, oldest: null, persistent: true });
    const after = await counts(name);
    expect(after.version).toBe(1);
    expect(after.stores).toEqual(['ids', 'latest', 'q15', 'raw']);
    expect(after.n).toEqual({ ids: 0, latest: 0, q15: 0, raw: 0 });

    // the same lastUpdated can be recorded again, with a fresh id version
    await repo.record(snap(c.t, { A: [7, 8] }));
    expect(repo.recent('A').map((p) => p.bid)).toEqual([7]);
    const r2 = createHistoryRepo(name, c.now);
    await r2.init();
    expect(r2.recent('A').map((p) => p.bid)).toEqual([7]);
    expect((await counts(name)).n).toMatchObject({ ids: 1, raw: 1, q15: 1 });
  });

  it('clear() waits for pending records and works without IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const c = clock();
    const repo = createHistoryRepo(newName(), c.now);
    const p = repo.record(snap(T0, { A: [1, 2] }));
    const cl = repo.clear();
    await Promise.all([p, cl]);
    expect(repo.recent('A')).toEqual([]);
    expect(repo.info().raw).toBe(0);
  });

  it('clear() survives a failing transaction', async () => {
    const name = newName();
    const c = clock();
    const repo = createHistoryRepo(name, c.now);
    await repo.record(snap(T0, { A: [1, 2] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const orig = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function () {
      throw new Error('boom');
    } as typeof orig;
    try {
      await expect(repo.clear()).resolves.toBeUndefined();
    } finally {
      IDBDatabase.prototype.transaction = orig;
    }
    expect(warn).toHaveBeenCalled();
    expect(repo.recent('A')).toEqual([]);
    warn.mockRestore();
  });
});
