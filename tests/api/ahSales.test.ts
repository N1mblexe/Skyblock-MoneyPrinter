import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addWindow,
  coverageHours,
  createAhSalesPoller,
  emptySalesState,
  fetchEndedAuctions,
  ingestPage,
  metaOf,
  parseEndedSales,
  pruneState,
  salesInfo,
  stateFrom,
  summarize,
  validateEnded,
  type AhSalesPollerOptions,
  type RawEndedAuction,
  type RawEndedPage,
} from '../../src/api/ahSales.ts';
import { createAhSalesStore, type AhSalesMeta, type AhSalesRecord, type AhSalesStore } from '../../src/api/ahSalesStore.ts';
import { AH_SALES, API_AUCTIONS_ENDED, FETCH_TIMEOUT_MS, KAT, POLL_BACKOFF_MS } from '../../src/config.ts';
import type { AhSalesSnapshot } from '../../src/types/contracts.ts';
import raw from '../fixtures/ah-ended.json' with { type: 'json' };
import { itemB64, petEa, str } from './nbtWriter.ts';

const FIXTURE = raw as RawEndedPage;
const HOUR = 3600_000;
const T0 = Date.UTC(2026, 9, 14);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- builders

let seq = 0;
interface SaleSpec {
  id?: string;
  t: number;
  price: number;
  count?: number;
  name?: string;
  pet?: Record<string, unknown>;
  bin?: boolean;
  auctionId?: string;
}

function sale(s: SaleSpec): RawEndedAuction {
  const ea = s.pet ? petEa(s.pet) : { id: str(s.id ?? 'HYPERION') };
  return {
    auction_id: s.auctionId ?? `a${++seq}`,
    seller: 'x',
    buyer: 'y',
    timestamp: s.t,
    price: s.price,
    bin: s.bin ?? true,
    item_bytes: itemB64(ea, { ...(s.count ? { count: s.count } : {}), ...(s.name !== undefined ? { name: s.name } : {}) }),
  };
}

const page = (lastUpdated: number, auctions: RawEndedAuction[]): RawEndedPage => ({ success: true, lastUpdated, auctions });

// ---------------------------------------------------------------- response

describe('validateEnded / fetchEndedAuctions', () => {
  it('accepts the fixture and rejects broken responses', () => {
    expect(validateEnded(FIXTURE).auctions).toHaveLength(FIXTURE.auctions.length);
    expect(() => validateEnded(null)).toThrow(/not an object/);
    expect(() => validateEnded({ ...FIXTURE, success: false })).toThrow(/success/);
    expect(() => validateEnded({ ...FIXTURE, lastUpdated: 'x' })).toThrow(/lastUpdated/);
    expect(() => validateEnded({ ...FIXTURE, lastUpdated: NaN })).toThrow(/lastUpdated/);
    expect(() => validateEnded({ ...FIXTURE, auctions: {} })).toThrow(/auctions/);
  });

  it('fetches API_AUCTIONS_ENDED as JSON, throws on HTTP errors', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(FIXTURE)));
    vi.stubGlobal('fetch', f);
    expect(await fetchEndedAuctions()).toEqual(FIXTURE);
    expect(f.mock.calls[0]![0]).toBe(API_AUCTIONS_ENDED);
    expect(f.mock.calls[0]![1]).toEqual({});
    const sig = new AbortController().signal;
    await fetchEndedAuctions(sig);
    expect(f.mock.calls[1]![1]).toEqual({ signal: sig });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(fetchEndedAuctions()).rejects.toThrow('HTTP 503');
  });
});

describe('parseEndedSales', () => {
  it('real sales: BIN only, deduped, the scan id rules plus pet level keys', () => {
    const { sales, skipped } = parseEndedSales(FIXTURE);
    const bins = new Set(FIXTURE.auctions.filter((a) => a.bin).map((a) => a.auction_id));
    expect(sales).toHaveLength(bins.size);
    expect(skipped).toBe(0);
    expect(new Set(sales.map((s) => s.auctionId)).size).toBe(sales.length);
    const keys = (id: string) => sales.filter((s) => s.keys[0] === id).map((s) => s.keys);
    expect(keys('MOSQUITO;4')).toEqual([['MOSQUITO;4', 'MOSQUITO;4@L89']]);
    expect(keys('BAL;3')).toEqual([['BAL;3', 'BAL;3@L49']]);
    expect(keys('ENCHANT_RUNE;1')).toEqual([['ENCHANT_RUNE;1']]);
    expect(keys('EVERBURNING_FLAME')).toHaveLength(3);
    // non-BIN sales (the ROCK pet, a Frozen Scythe auction) are not prices
    expect(keys('ROCK;3')).toEqual([]);
    expect(keys('FROZEN_SCYTHE')).toEqual([]);
    expect(sales.every((s) => s.q === 1 && s.p > 0)).toBe(true);
  });

  it('stacks are priced per item; @MAX comes from the display name; Tier Boosts and junk are skipped', () => {
    const T = T0;
    const boosted = { type: 'SCATHA', tier: 'EPIC', exp: 1, heldItem: KAT.tierBoostId };
    const { sales, skipped } = parseEndedSales(
      page(T, [
        sale({ id: 'ENCHANTED_DIAMOND', t: T, price: 6_400, count: 64, auctionId: 'stack' }),
        sale({ pet: { type: 'ENDERMAN', tier: 'LEGENDARY', exp: 2e7 }, name: '§7[Lvl 100] §6Enderman', t: T, price: 9e6, auctionId: 'max' }),
        sale({ pet: { type: 'GOLDEN_DRAGON', tier: 'LEGENDARY' }, name: '[Lvl 100] Golden Dragon', t: T, price: 6e8, auctionId: 'gd' }),
        sale({ pet: { type: 'ENDERMAN', tier: 'LEGENDARY' }, t: T, price: 1e5, auctionId: 'noname' }),
        sale({ pet: boosted, name: '[Lvl 100] Scatha', t: T, price: 1e8, auctionId: 'boost' }),
        sale({ id: 'HYPERION', t: T, price: 5e8, auctionId: 'stack' }), // repeated auction id
        { ...sale({ t: T, price: 1 }), auction_id: '' },
        { ...sale({ t: T, price: 1 }), auction_id: 5 as never },
        sale({ t: T, price: 0 }),
        sale({ t: T, price: -1 }),
        { ...sale({ t: T, price: 1 }), timestamp: NaN },
        { ...sale({ t: T, price: 1 }), timestamp: 'x' as never },
        { ...sale({ t: T, price: 1 }), item_bytes: 5 as never },
        { ...sale({ t: T, price: 1 }), item_bytes: btoa('not gzip') },
        { ...sale({ t: T, price: 1 }), item_bytes: itemB64({ nope: str('x') }) },
        { ...sale({ t: T, price: 1 }), bin: false },
        null as never,
      ]),
    );
    expect(sales).toEqual([
      { auctionId: 'stack', keys: ['ENCHANTED_DIAMOND'], t: T, p: 100, q: 64 },
      { auctionId: 'max', keys: ['ENDERMAN;4', 'ENDERMAN;4@MAX'], t: T, p: 9e6, q: 1 },
      { auctionId: 'gd', keys: ['GOLDEN_DRAGON;4'], t: T, p: 6e8, q: 1 },
      { auctionId: 'noname', keys: ['ENDERMAN;4'], t: T, p: 1e5, q: 1 },
    ]);
    // boost + empty id + non-string id + 2 bad prices + 2 bad timestamps + bad bytes type + not gzip + no id
    expect(skipped).toBe(10);
  });
});

// ---------------------------------------------------------------- state

describe('coverage windows', () => {
  it('addWindow merges overlapping and touching ranges, keeps them sorted', () => {
    let w: [number, number][] = [];
    w = addWindow(w, 10, 20);
    w = addWindow(w, 40, 50);
    expect(w).toEqual([
      [10, 20],
      [40, 50],
    ]);
    w = addWindow(w, 0, 5);
    expect(w[0]).toEqual([0, 5]);
    w = addWindow(w, 20, 30);
    expect(w).toEqual([
      [0, 5],
      [10, 30],
      [40, 50],
    ]);
    w = addWindow(w, 25, 45);
    expect(w).toEqual([
      [0, 5],
      [10, 50],
    ]);
    w = addWindow(w, 60, 70);
    expect(w.at(-1)).toEqual([60, 70]);
    w = addWindow(w, -10, 100);
    expect(w).toEqual([[-10, 100]]);
    expect(coverageHours([[0, HOUR], [2 * HOUR, 2.5 * HOUR]])).toBe(1.5);
    expect(coverageHours([])).toBe(0);
  });
});

describe('ingestPage / pruneState / summarize', () => {
  it('folds a response once (CDN repeats skipped) and dedupes auction ids across responses', () => {
    const s = emptySalesState();
    const a = sale({ id: 'X', t: T0 - 10_000, price: 100 });
    const r1 = ingestPage(s, page(T0, [a, sale({ pet: { type: 'LION', tier: 'LEGENDARY' }, name: '[Lvl 1] Lion', t: T0 - 5_000, price: 2e7 })]));
    expect(r1).toMatchObject({ added: 2, skipped: 0 });
    expect([...r1!.put].sort()).toEqual(['LION;4', 'LION;4@L49', 'X']);
    expect(ingestPage(s, page(T0, [sale({ id: 'X', t: T0, price: 1 })]))).toBeNull();
    // the next window repeats sale `a` (overlap): counted once
    const r2 = ingestPage(s, page(T0 + 60_000, [a, sale({ id: 'X', t: T0 - 5_000, price: 300 })]));
    expect(r2).toMatchObject({ added: 1 });
    expect(s.records.get('X')!.sales.map((x) => x.p)).toEqual([100, 300]);
    expect(s.records.get('X')!.hours).toEqual([[Math.floor((T0 - 10_000) / HOUR) * HOUR, 2, 2]]);
    expect(s.windows).toEqual([[T0 - AH_SALES.windowSpanMs, T0 + 60_000]]);
    expect(s.updates).toEqual([T0, T0 + 60_000]);
  });

  it('keeps sales by time (newest AH_SALES.maxPrices), counts per hour, caps remembered updates and ids', () => {
    const s = emptySalesState();
    // out of order within the response: inserted by time, into the right hour
    ingestPage(s, page(T0, [sale({ id: 'X', t: T0 + 2 * HOUR, price: 3, count: 2 }), sale({ id: 'X', t: T0, price: 1 }), sale({ id: 'X', t: T0 + HOUR, price: 2 })]));
    ingestPage(s, page(T0 + 1, [sale({ id: 'X', t: T0 + 10, price: 1.5 })]));
    const r = s.records.get('X')!;
    expect(r.sales.map((x) => x.p)).toEqual([1, 1.5, 2, 1.5]);
    expect(r.hours).toEqual([
      [T0, 2, 2],
      [T0 + HOUR, 1, 1],
      [T0 + 2 * HOUR, 1, 2],
    ]);
    for (let i = 0; i < AH_SALES.maxPrices + 10; i++) ingestPage(s, page(T0 + 100 + i, [sale({ id: 'X', t: T0 + 3 * HOUR + i, price: 1000 + i })]));
    expect(r.sales).toHaveLength(AH_SALES.maxPrices);
    expect(r.sales.at(-1)!.p).toBe(1000 + AH_SALES.maxPrices + 9);
    expect(s.updates).toHaveLength(32);
    // auction ids are forgotten 15 min after their sale
    ingestPage(s, page(T0 + 10 * HOUR, []));
    expect(s.recent.size).toBe(0);
  });

  it('pruneState drops sales, hours and coverage older than the window; empty records are removed', () => {
    const s = emptySalesState();
    ingestPage(s, page(T0, [sale({ id: 'OLD', t: T0 - 1000, price: 1 }), sale({ id: 'BOTH', t: T0 - 1000, price: 1 })]));
    ingestPage(s, page(T0 + 3 * HOUR, [sale({ id: 'BOTH', t: T0 + 3 * HOUR - 1000, price: 2 }), sale({ id: 'NEW', t: T0 + 3 * HOUR - 1, price: 3 })]));
    const now = T0 + AH_SALES.windowMs + HOUR;
    const pending = { put: new Set(['OLD', 'NEW']), remove: new Set<string>() };
    const ch = pruneState(s, now, pending);
    expect(ch).toBe(pending);
    expect([...ch.remove]).toEqual(['OLD']);
    expect([...ch.put].sort()).toEqual(['BOTH', 'NEW']);
    expect(s.records.has('OLD')).toBe(false);
    expect(s.records.get('BOTH')!.sales.map((x) => x.p)).toEqual([2]);
    expect(s.records.get('BOTH')!.hours).toHaveLength(1);
    expect(s.windows).toEqual([[T0 + 3 * HOUR - AH_SALES.windowSpanMs, T0 + 3 * HOUR]]);
    // a window straddling the cutoff is clipped
    const c = emptySalesState();
    c.windows = [[0, 10 * HOUR]];
    pruneState(c, AH_SALES.windowMs + 5 * HOUR);
    expect(c.windows).toEqual([[5 * HOUR, 10 * HOUR]]);
    // nothing old: nothing changes
    expect(pruneState(s, now)).toEqual({ put: new Set(), remove: new Set() });
  });

  it('summarize: medians per item, perHour only once coverage reaches minCoverageHours', () => {
    expect(summarize(emptySalesState(), T0)).toBeNull();
    const s = emptySalesState();
    ingestPage(s, page(T0, [sale({ id: 'X', t: T0 - 1, price: 300, count: 3 }), sale({ id: 'X', t: T0 - 2, price: 500 }), sale({ id: 'X', t: T0 - 3, price: 900 })]));
    const a = summarize(s, T0 + 5)!;
    expect(a).toEqual({
      v: 1,
      updatedAt: T0 + 5,
      coverageHours: AH_SALES.windowSpanMs / HOUR,
      byId: { X: { n: 3, items: 5, median: 500, perHour: null, coverageHours: AH_SALES.windowSpanMs / HOUR, last: T0 - 1 } },
    } satisfies AhSalesSnapshot);
    s.windows = addWindow(s.windows, T0 - 4 * HOUR, T0);
    const b = summarize(s, T0)!;
    expect(b.coverageHours).toBe(4);
    expect(b.byId.X!.perHour).toBe(5 / 4);
    // coverage alone (no records yet) still summarizes
    const c = emptySalesState();
    ingestPage(c, page(T0, []));
    expect(summarize(c, T0)).toMatchObject({ byId: {}, coverageHours: AH_SALES.windowSpanMs / HOUR });
    // a record whose sales were all pruned keeps last = 0
    s.records.get('X')!.sales = [];
    expect(summarize(s, T0)!.byId.X!.last).toBe(0);
  });

  it('salesInfo counts base ids only; stateFrom / metaOf round-trip', () => {
    const s = emptySalesState();
    ingestPage(s, page(T0, [sale({ pet: { type: 'LION', tier: 'LEGENDARY' }, name: '[Lvl 1] Lion', t: T0, price: 1 }), sale({ id: 'X', t: T0, price: 1 })]));
    expect(salesInfo(s)).toEqual({ sales: 2, ids: 2, coverageHours: AH_SALES.windowSpanMs / HOUR });
    const meta = metaOf(s);
    const back = stateFrom([...s.records.values()], meta);
    expect(back.records).toEqual(s.records);
    expect(back.windows).toEqual(s.windows);
    expect(back.recent).toEqual(s.recent);
    expect(back.updates).toEqual(s.updates);
    expect(back.updates).not.toBe(s.updates);
    expect(stateFrom([], { windows: [[5, 6], [1, 2]], recent: [], updates: [] }).windows).toEqual([[1, 2], [5, 6]]);
    expect(stateFrom([], null)).toEqual(emptySalesState());
  });
});

// ---------------------------------------------------------------- poller

/** In-memory AhSalesStore with spies. */
function memStore(init: { records?: AhSalesRecord[]; meta?: AhSalesMeta | null } = {}) {
  const data = { records: new Map((init.records ?? []).map((r) => [r.id, structuredClone(r)])), meta: init.meta ?? null };
  const store = {
    data,
    load: vi.fn(async () => ({ records: [...data.records.values()].map((r) => structuredClone(r)), meta: data.meta && structuredClone(data.meta) })),
    save: vi.fn(async (put: readonly AhSalesRecord[], remove: readonly string[], meta: AhSalesMeta) => {
      for (const r of put) data.records.set(r.id, structuredClone(r));
      for (const id of remove) data.records.delete(id);
      data.meta = structuredClone(meta);
    }),
    clear: vi.fn(async () => {
      data.records.clear();
      data.meta = null;
    }),
    persistent: () => true,
  } satisfies AhSalesStore & { data: unknown };
  return store;
}

function setup(over: Partial<AhSalesPollerOptions> & { pages?: (n: number) => RawEndedPage } = {}) {
  const updates: AhSalesSnapshot[] = [];
  const errors: Error[] = [];
  const ev = { enabled: true };
  let n = 0;
  const pages = over.pages ?? ((i: number) => page(Date.now(), [sale({ id: 'X', t: Date.now() - 1000, price: 100 + i })]));
  const fetch = vi.fn(async (_s: AbortSignal): Promise<unknown> => pages(n++));
  const store = (over.store as ReturnType<typeof memStore> | undefined) ?? memStore();
  const poller = createAhSalesPoller({
    onUpdate: (s) => updates.push(s),
    onError: (e) => errors.push(e),
    enabled: () => ev.enabled,
    fetch,
    now: () => Date.now(),
    ...over,
    store,
  });
  return { poller, updates, errors, fetch, store, ev };
}

describe('createAhSalesPoller', () => {
  it('fetches at start, then every AH_SALES.pollMs; persists changed ids and emits a summary', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    t.poller.start();
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0]!.byId.X).toMatchObject({ n: 1, median: 100, perHour: null });
    expect(t.store.save).toHaveBeenCalledTimes(1);
    expect(t.store.save.mock.calls[0]![0].map((r) => r.id)).toEqual(['X']);
    await vi.advanceTimersByTimeAsync(AH_SALES.pollMs - 1);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(t.updates.at(-1)!.byId.X!.n).toBe(2);
    expect(t.updates.at(-1)!.coverageHours).toBeCloseTo((2 * AH_SALES.windowSpanMs) / HOUR);
    t.poller.stop();
    await vi.advanceTimersByTimeAsync(AH_SALES.pollMs * 3);
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it('a CDN repeat (lastUpdated already seen) changes nothing', async () => {
    vi.useFakeTimers({ now: T0 });
    const same = page(T0, [sale({ id: 'X', t: T0 - 1, price: 5 })]);
    const t = setup({ pages: () => structuredClone(same) });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(AH_SALES.pollMs * 2);
    expect(t.fetch).toHaveBeenCalledTimes(3);
    expect(t.updates).toHaveLength(1);
    expect(t.store.save).toHaveBeenCalledTimes(1);
    t.poller.stop();
  });

  it('measures perHour after minCoverageHours of feed', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup({ intervalMs: AH_SALES.windowSpanMs });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(AH_SALES.minCoverageHours * HOUR);
    const last = t.updates.at(-1)!;
    expect(last.coverageHours).toBeGreaterThanOrEqual(AH_SALES.minCoverageHours);
    expect(last.byId.X!.perHour).toBeCloseTo(last.byId.X!.items / last.coverageHours);
    t.poller.stop();
  });

  it('does not fetch while disabled, re-checks every interval', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    t.ev.enabled = false;
    t.poller.start();
    await vi.advanceTimersByTimeAsync(AH_SALES.pollMs * 3);
    expect(t.fetch).not.toHaveBeenCalled();
    t.ev.enabled = true;
    await vi.advanceTimersByTimeAsync(AH_SALES.pollMs);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t.poller.stop();
    // enabled defaults to always on
    const u = createAhSalesPoller({ onUpdate: () => {}, onError: () => {}, fetch: async () => page(T0, []), store: memStore() });
    u.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await u.info()).toEqual({ sales: 0, ids: 0, coverageHours: AH_SALES.windowSpanMs / HOUR });
    u.stop();
  });

  it('backs off on errors like the election poller and resets after a success', async () => {
    vi.useFakeTimers({ now: T0 });
    let fail = 4;
    const t = setup();
    t.fetch.mockImplementation(async () => {
      if (fail-- > 0) throw fail === 2 ? 'plain' : new Error('down');
      return page(Date.now(), []);
    });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    expect(t.errors).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MS[1]);
    expect(t.errors).toHaveLength(3);
    expect(t.errors[1]).toBeInstanceOf(Error);
    expect(t.errors[1]!.message).toBe('plain');
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MS[2] - 1);
    expect(t.errors).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.errors).toHaveLength(4);
    // capped at the last step
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MS[2]);
    expect(t.fetch).toHaveBeenCalledTimes(5);
    expect(t.updates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(AH_SALES.pollMs);
    expect(t.fetch).toHaveBeenCalledTimes(6);
    t.poller.stop();
  });

  it('invalid responses count as failures', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup({ pages: () => ({ success: false }) as never });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors[0]!.message).toMatch(/success/);
    t.poller.stop();
  });

  it('times out a hanging request after FETCH_TIMEOUT_MS and aborts it', async () => {
    vi.useFakeTimers({ now: T0 });
    let signal!: AbortSignal;
    const t = setup();
    t.fetch.mockImplementation((s) => {
      signal = s;
      return new Promise(() => {});
    });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1);
    expect(t.errors).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.errors[0]!.message).toMatch(/no response/);
    expect(signal.aborted).toBe(true);
    t.poller.stop();
  });

  it('stop aborts the in-flight request and drops its result; start again resumes', async () => {
    vi.useFakeTimers({ now: T0 });
    let signal!: AbortSignal;
    let resolve!: (p: RawEndedPage) => void;
    const t = setup();
    t.fetch.mockImplementationOnce(
      (s) =>
        new Promise((r) => {
          signal = s;
          resolve = r;
        }),
    );
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    t.poller.stop();
    expect(signal.aborted).toBe(true);
    resolve(page(T0, [sale({ id: 'X', t: T0, price: 1 })]));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.updates).toEqual([]);
    expect(t.errors).toEqual([]);
    // a rejection after stop is dropped too
    let reject!: (e: Error) => void;
    t.fetch.mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    t.poller.stop();
    reject(new Error('aborted'));
    await vi.advanceTimersByTimeAsync(AH_SALES.pollMs);
    expect(t.errors).toEqual([]);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.updates).toHaveLength(1);
    t.poller.stop();
  });

  it('stop during the store write: the write finishes, no next poll is scheduled', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const save = t.store.save.getMockImplementation()!;
    t.store.save.mockImplementationOnce(async (...a) => {
      await gate;
      return save(...a);
    });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    t.poller.stop();
    release();
    await vi.advanceTimersByTimeAsync(AH_SALES.pollMs * 2);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.store.data.records.has('X')).toBe(true);
  });

  it('loadCached summarizes the stored sales (pruning old ones) and emits them; null when empty', async () => {
    vi.useFakeTimers({ now: T0 });
    const empty = setup();
    expect(await empty.poller.loadCached()).toBeNull();
    expect(empty.updates).toEqual([]);

    const s = emptySalesState();
    ingestPage(s, page(T0 - AH_SALES.windowMs - HOUR, [sale({ id: 'OLD', t: T0 - AH_SALES.windowMs - HOUR, price: 1 })]));
    ingestPage(s, page(T0 - HOUR, [sale({ id: 'X', t: T0 - HOUR, price: 7 })]));
    const store = memStore({ records: [...s.records.values()], meta: metaOf(s) });
    const t = setup({ store });
    const snap = await t.poller.loadCached();
    expect(Object.keys(snap!.byId)).toEqual(['X']);
    expect(snap!.byId.X!.median).toBe(7);
    expect(t.updates).toEqual([snap]);
    // pruning on load is written back once
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save.mock.calls[0]![1]).toEqual(['OLD']);
    expect(store.load).toHaveBeenCalledTimes(1);
    await t.poller.loadCached();
    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('a store that fails to load starts empty; info and clear work', async () => {
    vi.useFakeTimers({ now: T0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = memStore();
    store.load.mockRejectedValueOnce(new Error('broken'));
    const t = setup({ store });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalled();
    expect(await t.poller.info()).toEqual({ sales: 1, ids: 1, coverageHours: AH_SALES.windowSpanMs / HOUR });
    await t.poller.clear();
    expect(store.clear).toHaveBeenCalled();
    expect(await t.poller.info()).toEqual({ sales: 0, ids: 0, coverageHours: 0 });
    expect(await t.poller.loadCached()).toBeNull();
    // after a clear the same lastUpdated is new again
    t.fetch.mockImplementationOnce(async () => page(T0, [sale({ id: 'X', t: T0 - 1, price: 3 })]));
    await vi.advanceTimersByTimeAsync(AH_SALES.pollMs);
    expect((await t.poller.info()).sales).toBe(1);
    t.poller.stop();
  });

  it('a failing store write is an error but the next poll goes on', async () => {
    vi.useFakeTimers({ now: T0 });
    const store = memStore();
    store.save.mockRejectedValueOnce(new Error('quota'));
    const ids = ['Y', 'Z'];
    const t = setup({ store, pages: (i) => page(Date.now(), [sale({ id: ids[i] ?? 'X', t: Date.now() - 1, price: 1 })]) });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors[0]!.message).toBe('quota');
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    expect(t.updates.length).toBeGreaterThan(0);
    // the unsaved Y goes out with the next write
    expect(store.save.mock.calls[1]![0].map((r) => r.id).sort()).toEqual(['Y', 'Z']);
    expect([...store.data.records.keys()].sort()).toEqual(['Y', 'Z']);
    t.poller.stop();
  });

  it('callback exceptions are contained', async () => {
    vi.useFakeTimers({ now: T0 });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setup({
      onUpdate: () => {
        throw new Error('ui');
      },
      onError: () => {
        throw new Error('ui2');
      },
    });
    t.fetch.mockRejectedValueOnce(new Error('down'));
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    expect(err).toHaveBeenCalledTimes(2);
    t.poller.stop();
  });

  it('end to end on IndexedDB: a new poller (page reload) picks up the stored sales', async () => {
    const name = `ahsales-poller-${Math.random()}`;
    const fixture = structuredClone(FIXTURE);
    const a = createAhSalesPoller({ onUpdate: () => {}, onError: () => {}, fetch: async () => fixture, store: createAhSalesStore(name), now: () => FIXTURE.lastUpdated });
    a.start();
    await vi.waitFor(async () => expect((await a.info()).sales).toBeGreaterThan(0));
    a.stop();
    const before = await a.loadCached();
    const b = createAhSalesPoller({ onUpdate: () => {}, onError: () => {}, store: createAhSalesStore(name), now: () => FIXTURE.lastUpdated });
    const after = await b.loadCached();
    expect(after).toEqual(before);
    expect(after!.byId.EVERBURNING_FLAME).toMatchObject({ n: 3, items: 3, median: 11_000_000, perHour: null });
    expect(after!.byId['MOSQUITO;4@L89']).toMatchObject({ n: 1, median: 190_000_000 });
  });
});
