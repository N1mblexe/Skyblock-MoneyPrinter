import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aggregatePage,
  createAhScanner,
  fetchAhPage,
  scanAuctions,
  validateAhPage,
  type AhPageFetcher,
  type AhScannerOptions,
  type RawAhPage,
  type RawAuction,
} from '../../src/api/auctions.ts';
import { attachAhWorker, type AhWorkerScope } from '../../src/api/ahWorker.ts';
import { AH, API_AUCTIONS } from '../../src/config.ts';
import type { AhPrice, AhScanProgress, AhSnapshot } from '../../src/types/contracts.ts';
import fixture from '../fixtures/api/auctions-page.json' with { type: 'json' };

const AUCTIONS = fixture.auctions as RawAuction[];
const T0 = Date.UTC(2026, 9, 14);

/** Split the fixture auctions over `n` pages. */
function pages(n: number, auctions: RawAuction[] = AUCTIONS): RawAhPage[] {
  const per = Math.ceil(auctions.length / n);
  return Array.from({ length: n }, (_, i) => ({
    success: true,
    page: i,
    totalPages: n,
    lastUpdated: fixture.lastUpdated,
    auctions: auctions.slice(i * per, (i + 1) * per),
  }));
}

const emptyPages = (n: number): RawAhPage[] =>
  Array.from({ length: n }, (_, i) => ({ success: true, page: i, totalPages: n, lastUpdated: T0, auctions: [] }));

const fetcher = (ps: RawAhPage[]): AhPageFetcher & ReturnType<typeof vi.fn> =>
  vi.fn(async (n: number) => structuredClone(ps[n]!)) as never;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('validateAhPage', () => {
  it('accepts the fixture and rejects broken pages', () => {
    expect(validateAhPage(fixture).totalPages).toBe(fixture.totalPages);
    expect(() => validateAhPage(null)).toThrow(/not an object/);
    expect(() => validateAhPage({ ...fixture, success: false })).toThrow(/success/);
    expect(() => validateAhPage({ ...fixture, auctions: undefined })).toThrow(/auctions/);
    expect(() => validateAhPage({ ...fixture, totalPages: 0 })).toThrow(/totalPages/);
    expect(() => validateAhPage({ ...fixture, lastUpdated: 'x' })).toThrow(/lastUpdated/);
  });
});

describe('aggregatePage', () => {
  it('lowest BIN + count per id; non-BIN and claimed ignored', async () => {
    const acc: Record<string, AhPrice> = {};
    const r = await aggregatePage(AUCTIONS, acc);
    expect(acc.HYPERION).toEqual({ price: 525_000_000, count: 4 });
    expect(acc.GOD_POTION_2).toEqual({ price: 1_500_000, count: 3 });
    expect(acc['BLACK_CAT;5']).toEqual({ price: 60_800_000, count: 2 });
    // non-BIN fixture listings
    expect(acc.MACHINE_GUN_BOW).toBeUndefined();
    expect(acc['SCATHA;3']).toBeUndefined();
    expect(r).toEqual({ bins: 21, errors: 0 });
    expect(Object.keys(acc)).toHaveLength(15);
  });

  it('claimed listings are skipped, broken ones counted as errors, accumulation continues', async () => {
    const hype = AUCTIONS.find((a) => a.item_name?.includes('Hyperion'))!;
    const acc: Record<string, AhPrice> = { HYPERION: { price: 400_000_000, count: 1 } };
    const r = await aggregatePage(
      [
        { ...hype, starting_bid: 1, claimed: true },
        { ...hype, starting_bid: 300_000_000 },
        { ...hype, starting_bid: 900_000_000 },
        { ...hype, item_bytes: 'bm90IGd6aXA=' },
        { ...hype, starting_bid: 0 },
        { ...hype, item_bytes: undefined as never },
      ],
      acc,
    );
    expect(acc.HYPERION).toEqual({ price: 300_000_000, count: 3 });
    expect(r).toEqual({ bins: 2, errors: 3 });
  });
});

describe('scanAuctions', () => {
  it('scans all pages and reports progress', async () => {
    const f = fetcher(pages(5));
    const progress: AhScanProgress[] = [];
    const res = await scanAuctions(f, (p) => progress.push(p), undefined, () => T0);
    expect(f).toHaveBeenCalledTimes(5);
    expect(res.fetchedAt).toBe(T0);
    expect(res.lastUpdated).toBe(fixture.lastUpdated);
    expect(res.lowestBin.HYPERION).toEqual({ price: 525_000_000, count: 4 });
    expect(res.failedPages).toEqual([]);
    expect(res.binCount).toBe(21);
    expect(progress.map((p) => p.page)).toEqual([1, 2, 3, 4, 5]);
    expect(progress.every((p) => p.totalPages === 5)).toBe(true);
    expect(Object.getPrototypeOf(res.lowestBin)).toBe(Object.prototype);
  });

  it('retries a failed page once; a page failing twice is skipped, not fatal', async () => {
    const ps = pages(4);
    const calls = new Map<number, number>();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f: AhPageFetcher = async (n) => {
      const c = (calls.get(n) ?? 0) + 1;
      calls.set(n, c);
      if (n === 1 && c === 1) throw new Error('flaky');
      if (n === 2) throw new Error('HTTP 503');
      return structuredClone(ps[n]!);
    };
    const progress: number[] = [];
    const res = await scanAuctions(f, (p) => progress.push(p.page));
    expect(calls.get(1)).toBe(2);
    expect(calls.get(2)).toBe(2);
    expect(res.failedPages).toEqual([2]);
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(warn).toHaveBeenCalled();
    // pages 0, 1 and 3 still counted
    const expected: Record<string, AhPrice> = {};
    for (const i of [0, 1, 3]) await aggregatePage(ps[i]!.auctions, expected);
    expect(res.lowestBin).toEqual(expected);
  });

  it('page 0 failing twice rejects', async () => {
    const f = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(scanAuctions(f, () => {})).rejects.toThrow('down');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('honors the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const ps = emptyPages(20);
    const f: AhPageFetcher = async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return ps[n]!;
    };
    await scanAuctions(f, () => {});
    expect(peak).toBe(AH.concurrency);
    peak = 0;
    await scanAuctions(f, () => {}, undefined, Date.now, 2);
    expect(peak).toBe(2);
  });

  it('single-page scans work', async () => {
    const res = await scanAuctions(fetcher(pages(1)), () => {});
    expect(res.binCount).toBe(21);
  });

  it('aborting rejects with the abort reason and stops fetching', async () => {
    const ctl = new AbortController();
    const ps = emptyPages(30);
    const f = vi.fn(async (n: number) => {
      if (n === 3) ctl.abort(new Error('stopped'));
      return ps[n]!;
    });
    await expect(scanAuctions(f, () => {}, ctl.signal, Date.now, 1)).rejects.toThrow('stopped');
    expect(f.mock.calls.length).toBeLessThan(6);
    const pre = new AbortController();
    pre.abort();
    await expect(scanAuctions(f, () => {}, pre.signal)).rejects.toBeDefined();
  });

  it('a page whose fetch fails after an abort rejects instead of being skipped', async () => {
    const ctl = new AbortController();
    const ps = emptyPages(5);
    const f: AhPageFetcher = async (n) => {
      if (n === 2) {
        ctl.abort(new Error('bye'));
        throw new Error('aborted fetch');
      }
      return ps[n]!;
    };
    await expect(scanAuctions(f, () => {}, ctl.signal, Date.now, 1)).rejects.toThrow('bye');
  });
});

describe('fetchAhPage', () => {
  it('fetches ?page=N and validates', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(fixture)));
    vi.stubGlobal('fetch', fetchMock);
    const p = await fetchAhPage(7);
    expect(p.auctions).toHaveLength(AUCTIONS.length);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${API_AUCTIONS}?page=7`);
    await fetchAhPage(0, new AbortController().signal);
  });

  it('throws on HTTP errors and bad payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    await expect(fetchAhPage(1)).rejects.toThrow('HTTP 503');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":false}')));
    await expect(fetchAhPage(1)).rejects.toThrow(/success/);
  });
});

// ---------------------------------------------------------------- scanner (inline fallback)

function memStore(initial: AhSnapshot | null = null) {
  const s = {
    value: initial,
    saveAh: vi.fn(async (x: AhSnapshot) => {
      s.value = x;
    }),
    loadAh: vi.fn(async () => s.value),
  };
  return s;
}

function setup(over: Partial<AhScannerOptions> & { cache?: AhSnapshot | null; pageCount?: number } = {}) {
  const store = memStore(over.cache ?? null);
  const f = fetcher(emptyPages(over.pageCount ?? 3));
  const ev = {
    snapshots: [] as AhSnapshot[],
    progress: [] as (AhScanProgress | null)[],
    errors: [] as Error[],
    enabled: true,
  };
  const scanner = createAhScanner({
    onSnapshot: (s) => ev.snapshots.push(s),
    onProgress: (p) => ev.progress.push(p),
    onError: (e) => ev.errors.push(e),
    enabled: () => ev.enabled,
    useWorker: false,
    fetchPage: f,
    now: () => Date.now(),
    store,
    ...over,
  });
  return { scanner, store, f, ev };
}

const pageZeroCalls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter((c) => c[0] === 0).length;

describe('createAhScanner (inline fallback)', () => {
  it('start with no cache scans immediately, persists, then rescans every AH.pollMs', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    t.scanner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pageZeroCalls(t.f)).toBe(1);
    expect(t.ev.snapshots).toHaveLength(1);
    expect(t.ev.progress).toEqual([{ page: 1, totalPages: 3 }, { page: 2, totalPages: 3 }, { page: 3, totalPages: 3 }, null]);
    expect(t.store.saveAh).toHaveBeenCalledWith(t.ev.snapshots[0]);
    expect(t.ev.snapshots[0]!.fetchedAt).toBe(T0);
    await vi.advanceTimersByTimeAsync(AH.pollMs - 1);
    expect(pageZeroCalls(t.f)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pageZeroCalls(t.f)).toBe(2);
    t.scanner.start(); // idempotent
    t.scanner.stop();
    await vi.advanceTimersByTimeAsync(AH.pollMs * 3);
    expect(pageZeroCalls(t.f)).toBe(2);
    expect(t.ev.errors).toEqual([]);
  });

  it('a fresh cache delays the first scan until it is pollMs old', async () => {
    vi.useFakeTimers({ now: T0 });
    const cache: AhSnapshot = { fetchedAt: T0 - 4 * 60_000, lastUpdated: T0, lowestBin: { X: { price: 1, count: 1 } } };
    const t = setup({ cache });
    expect(await t.scanner.loadCached()).toEqual(cache);
    t.scanner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AH.pollMs - 4 * 60_000 - 1);
    expect(t.f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pageZeroCalls(t.f)).toBe(1);
    expect(await t.scanner.loadCached()).toBe(t.ev.snapshots[0]);
    t.scanner.stop();
  });

  it('a stale cache scans at once', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup({ cache: { fetchedAt: T0 - AH.pollMs, lastUpdated: 0, lowestBin: {} } });
    t.scanner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pageZeroCalls(t.f)).toBe(1);
    t.scanner.stop();
  });

  it('checks enabled() before scheduled scans; re-checks every minute while disabled', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    t.ev.enabled = false;
    t.scanner.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.f).not.toHaveBeenCalled();
    t.ev.enabled = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pageZeroCalls(t.f)).toBe(1);
    t.ev.enabled = false;
    await vi.advanceTimersByTimeAsync(AH.pollMs * 2);
    expect(pageZeroCalls(t.f)).toBe(1);
    t.scanner.stop();
  });

  it('scanNow ignores enabled(), dedupes in-flight scans and works without start()', async () => {
    const t = setup();
    t.ev.enabled = false;
    const a = t.scanner.scanNow();
    const b = t.scanner.scanNow();
    expect(a).toBe(b);
    await a;
    expect(pageZeroCalls(t.f)).toBe(1);
    expect(t.ev.snapshots).toHaveLength(1);
    expect(t.ev.progress.at(-1)).toBeNull();
  });

  it('scan errors go to onError, still end progress, and polling continues', async () => {
    vi.useFakeTimers({ now: T0 });
    const f = vi.fn(async () => {
      throw new Error('AH down');
    });
    const t = setup({ fetchPage: f });
    t.scanner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.ev.errors.map((e) => e.message)).toEqual(['AH down']);
    expect(t.ev.progress).toEqual([null]);
    expect(t.ev.snapshots).toEqual([]);
    expect(t.store.saveAh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AH.pollMs);
    expect(t.ev.errors).toHaveLength(2);
    t.scanner.stop();
  });

  it('non-Error rejections are wrapped', async () => {
    const t = setup({
      fetchPage: async () => {
        throw 'boom';
      },
    });
    await t.scanner.scanNow();
    expect(t.ev.errors[0]).toBeInstanceOf(Error);
    expect(t.ev.errors[0]!.message).toBe('boom');
  });

  it('stop() mid-scan aborts it: no snapshot, progress reset to null', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ps = emptyPages(3);
    let signal: AbortSignal | undefined;
    const f: AhPageFetcher = async (n, s) => {
      signal = s;
      if (n >= 1) await gate;
      return ps[n]!;
    };
    const t = setup({ fetchPage: f });
    t.scanner.start();
    await vi.waitFor(() => expect(t.ev.progress).toHaveLength(1));
    t.scanner.stop();
    expect(signal?.aborted).toBe(true);
    expect(t.ev.progress.at(-1)).toBeNull();
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(t.ev.snapshots).toEqual([]);
    expect(t.ev.errors).toEqual([]);
    expect(t.ev.progress.at(-1)).toBeNull();
  });

  it('skipped pages are logged but the snapshot is still delivered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ps = emptyPages(3);
    const t = setup({
      fetchPage: async (n) => {
        if (n === 2) throw new Error('bad page');
        return ps[n]!;
      },
    });
    await t.scanner.scanNow();
    expect(t.ev.snapshots).toHaveLength(1);
    expect((t.ev.snapshots[0] as { failedPages?: number[] }).failedPages).toEqual([2]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('1 page(s) skipped'))).toBe(true);
  });

  it('survives store failures and throwing callbacks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = {
      saveAh: vi.fn(async () => {
        throw new Error('quota');
      }),
      loadAh: vi.fn(async () => {
        throw new Error('corrupt');
      }),
    };
    const t = setup({
      store,
      onSnapshot: () => {
        throw new Error('ui bug');
      },
    });
    expect(await t.scanner.loadCached()).toBeNull();
    await t.scanner.scanNow();
    expect(store.saveAh).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith('AH scanner callback failed', expect.any(Error));
    expect(await t.scanner.loadCached()).not.toBeNull(); // the fresh scan, not the failed cache
  });

  it('keeps the newer of cache and memory', async () => {
    const old: AhSnapshot = { fetchedAt: 1, lastUpdated: 1, lowestBin: {} };
    const t = setup({ cache: old });
    await t.scanner.scanNow();
    expect((await t.scanner.loadCached())!.fetchedAt).toBeGreaterThan(1);
  });

  it('start() during an in-flight scanNow waits for it, then schedules', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    const p = t.scanner.scanNow();
    t.scanner.start();
    await p;
    await vi.advanceTimersByTimeAsync(0);
    expect(pageZeroCalls(t.f)).toBe(1);
    await vi.advanceTimersByTimeAsync(AH.pollMs);
    expect(pageZeroCalls(t.f)).toBe(2);
    t.scanner.stop();
  });

  it('defaults to the inline path when Worker is missing', async () => {
    expect(typeof Worker).toBe('undefined');
    const t = setup({ useWorker: undefined });
    await t.scanner.scanNow();
    expect(t.ev.snapshots).toHaveLength(1);
  });
});

describe('ahWorker protocol', () => {
  function scope() {
    const posted: unknown[] = [];
    const s: AhWorkerScope = { onmessage: null, postMessage: (m) => posted.push(m) };
    const send = (data: unknown) => s.onmessage!({ data } as MessageEvent);
    return { s, posted, send };
  }

  it('scan posts progress then the result; duplicate scans are ignored', async () => {
    const w = scope();
    const f = fetcher(pages(2));
    attachAhWorker(w.s, f);
    w.send({ type: 'scan' });
    w.send({ type: 'scan' });
    w.send({ type: 'other' });
    await vi.waitFor(() => expect(w.posted.at(-1)).toMatchObject({ type: 'done' }));
    expect(w.posted.slice(0, 2)).toEqual([
      { type: 'progress', progress: { page: 1, totalPages: 2 } },
      { type: 'progress', progress: { page: 2, totalPages: 2 } },
    ]);
    expect((w.posted.at(-1) as { result: AhSnapshot }).result.lowestBin.HYPERION!.count).toBe(4);
    expect(pageZeroCalls(f)).toBe(1);
  });

  it('errors and aborts are posted as error messages', async () => {
    const w = scope();
    attachAhWorker(w.s, async () => {
      throw new Error('net');
    });
    w.send({ type: 'scan' });
    await vi.waitFor(() => expect(w.posted).toEqual([{ type: 'error', message: 'net' }]));

    const w2 = scope();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    attachAhWorker(w2.s, async (_n, signal) => {
      await gate;
      if (signal?.aborted) throw 'aborted';
      return emptyPages(1)[0]!;
    });
    w2.send({ type: 'scan' });
    w2.send({ type: 'abort' });
    w2.send({ type: 'abort' });
    release();
    await vi.waitFor(() => expect(w2.posted).toHaveLength(1));
    expect(w2.posted[0]).toMatchObject({ type: 'error' });
  });
});
