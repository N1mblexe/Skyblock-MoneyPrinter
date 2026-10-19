import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AH_SCAN_VERSION,
  aggregatePage,
  createAhScanner,
  decodeListings,
  fetchAhPage,
  foldListings,
  PET_BAND_PREFIX,
  PET_MAX_200,
  petBandKey,
  petLevelFromName,
  petMaxLevel,
  scanAuctions,
  validateAhPage,
  type AhPageFetcher,
  type AhScannerOptions,
  type RawAhPage,
  type RawAuction,
} from '../../src/api/auctions.ts';
import { attachAhWorker, type AhWorkerScope } from '../../src/api/ahWorker.ts';
import { AH, API_AUCTIONS, KAT } from '../../src/config.ts';
import type { AhPrice, AhScanProgress, AhSnapshot } from '../../src/types/contracts.ts';
import fixture from '../fixtures/api/auctions-page.json' with { type: 'json' };
import { itemB64, str } from './nbtWriter.ts';

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
    expect(acc.HYPERION).toMatchObject({ price: 525_000_000, count: 4 });
    expect(acc.GOD_POTION_2).toMatchObject({ price: 1_500_000, count: 3 });
    expect(acc['BLACK_CAT;5']).toMatchObject({ price: 60_800_000, count: 2 });
    // the second-lowest price and the cheapest listing's uuid / name ride along
    const bins = (name: string) =>
      AUCTIONS.filter((a) => a.bin && !a.claimed && a.item_name?.includes(name)).sort((x, y) => x.starting_bid - y.starting_bid);
    const hype = bins('Hyperion');
    expect(acc.HYPERION!.next).toBe(hype[1]!.starting_bid);
    expect(acc.HYPERION).toMatchObject({ uuid: hype[0]!.uuid, name: hype[0]!.item_name });
    expect(acc.HYPERION!.next!).toBeGreaterThanOrEqual(acc.HYPERION!.price);
    // non-BIN fixture listings
    expect(acc.MACHINE_GUN_BOW).toBeUndefined();
    expect(acc['SCATHA;3']).toBeUndefined();
    expect(r).toEqual({ bins: 21, errors: 0, tierBoosted: 0, dupes: 0 });
    // scan v4: the lowest prices, ascending
    expect(acc.HYPERION!.prices).toEqual(hype.map((a) => a.starting_bid));
    expect(acc.HYPERION!.stack).toBeUndefined();
    // pets: the cheapest listing's exp; the one [Lvl 100] Black Cat also lands in the max-level bucket
    expect(acc['BLACK_CAT;5']).toMatchObject({ exp: 0, name: '[Lvl 1] Black Cat' });
    expect(acc[`BLACK_CAT;5${AH.petMaxSuffix}`]).toEqual({
      price: 99_350_749,
      count: 1,
      uuid: bins('[Lvl 100] Black Cat')[0]!.uuid,
      name: '[Lvl 100] Black Cat',
      exp: 2.603692896466553e7,
      prices: [99_350_749],
    });
    // and the level 1 one in the 1-49 band
    expect(acc['BLACK_CAT;5@L49']).toMatchObject({ price: 60_800_000, count: 1, name: '[Lvl 1] Black Cat' });
    expect(acc.HYPERION!.exp).toBeUndefined();
    expect(Object.keys(acc)).toHaveLength(17);
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
    // 400M seen before, 300M is the new lowest: 400M becomes next; 900M changes nothing
    expect(acc.HYPERION).toEqual({
      price: 300_000_000,
      count: 3,
      next: 400_000_000,
      prices: [300_000_000, 400_000_000, 900_000_000],
      uuid: hype.uuid,
      name: hype.item_name,
    });
    expect(r).toEqual({ bins: 2, errors: 3, tierBoosted: 0, dupes: 0 });
  });

  /** A synthetic BIN pet listing. */
  const petBin = (uuid: string, item_name: string, price: number, info: Record<string, unknown>): RawAuction => ({
    uuid,
    item_name,
    bin: true,
    starting_bid: price,
    item_bytes: itemB64({ id: str('PET'), petInfo: str(JSON.stringify(info)) }),
  });
  const MAX = AH.petMaxSuffix;

  it('pets: the cheapest listing exp rides along and follows a new lowest', async () => {
    const acc: Record<string, AhPrice> = {};
    await aggregatePage(
      [
        petBin('a', '[Lvl 50] Enderman', 500_000, { type: 'ENDERMAN', tier: 'EPIC', exp: 2_000_000 }),
        petBin('b', '[Lvl 60] Enderman', 600_000, { type: 'ENDERMAN', tier: 'EPIC', exp: 3_000_000 }),
        petBin('c', '[Lvl 1] Enderman', 100_000, { type: 'ENDERMAN', tier: 'EPIC' }),
      ],
      acc,
    );
    expect(acc['ENDERMAN;3']).toEqual({ price: 100_000, next: 500_000, prices: [100_000, 500_000, 600_000], count: 3, uuid: 'c', name: '[Lvl 1] Enderman', exp: 0 });
    await aggregatePage([petBin('d', '[Lvl 30] Enderman', 50_000, { type: 'ENDERMAN', tier: 'EPIC', exp: 400_000 })], acc);
    expect(acc['ENDERMAN;3']).toMatchObject({ price: 50_000, next: 100_000, uuid: 'd', exp: 400_000 });
    // a new lowest without petInfo drops the old listing's exp (like uuid / name)
    const plain: Record<string, AhPrice> = { HYPERION: { price: 9, count: 1, uuid: 'x', name: 'x', exp: 5 } };
    const hype = AUCTIONS.find((a) => a.bin && a.item_name?.includes('Hyperion'))!;
    await aggregatePage([{ ...hype, starting_bid: 1 }], plain);
    expect(plain.HYPERION!.exp).toBeUndefined();
  });

  it('pets holding a Tier Boost are left out of pricing and counted apart', async () => {
    const acc: Record<string, AhPrice> = {};
    const r = await aggregatePage(
      [
        petBin('boost', '[Lvl 100] Scatha', 1_000, { type: 'SCATHA', tier: 'EPIC', exp: 4e7, heldItem: KAT.tierBoostId }),
        petBin('fair', '[Lvl 100] Scatha', 90_000_000, { type: 'SCATHA', tier: 'EPIC', exp: 4e7, heldItem: 'PET_ITEM_COMBAT_SKILL_BOOST_EPIC' }),
      ],
      acc,
    );
    expect(r).toEqual({ bins: 1, errors: 0, tierBoosted: 1, dupes: 0 });
    expect(acc['SCATHA;3']).toMatchObject({ price: 90_000_000, count: 1, uuid: 'fair' });
    expect(acc[`SCATHA;3${MAX}`]).toMatchObject({ price: 90_000_000, count: 1, uuid: 'fair' });
    expect(Object.keys(acc)).toHaveLength(2);
  });

  it('max-level pets also fold into `${id}@MAX`: level 100, or 200 for the Golden Dragon family', async () => {
    const acc: Record<string, AhPrice> = {};
    await aggregatePage(
      [
        petBin('e1', '[Lvl 1] Enderman', 30_000, { type: 'ENDERMAN', tier: 'EPIC' }),
        petBin('e99', '[Lvl 99] Enderman', 700_000, { type: 'ENDERMAN', tier: 'EPIC', exp: 1.7e7 }),
        petBin('e100', '[Lvl 100] Enderman', 900_000, { type: 'ENDERMAN', tier: 'EPIC', exp: 1.9e7 }),
        petBin('e100b', '[Lvl 100] Enderman ✦', 950_000, { type: 'ENDERMAN', tier: 'EPIC', exp: 2e7, skin: 'ENDERMAN_X' }),
        petBin('g100', '[Lvl 100] Golden Dragon', 600_000_000, { type: 'GOLDEN_DRAGON', tier: 'LEGENDARY', exp: 3e7 }),
        petBin('g200', '[Lvl 200] Golden Dragon', 1_000_000_000, { type: 'GOLDEN_DRAGON', tier: 'LEGENDARY', exp: 2.1e8 }),
        petBin('j200', '[Lvl 200] Jade Dragon', 900_000_000, { type: 'JADE_DRAGON', tier: 'LEGENDARY', exp: 2.1e8 }),
        petBin('odd', 'Enderman', 10, { type: 'ENDERMAN', tier: 'RARE' }),
      ],
      acc,
    );
    expect(acc['ENDERMAN;3']).toMatchObject({ price: 30_000, count: 4 });
    // skinned listings are not excluded: a skin only raises the price
    expect(acc[`ENDERMAN;3${MAX}`]).toEqual({
      price: 900_000,
      next: 950_000,
      prices: [900_000, 950_000],
      count: 2,
      uuid: 'e100',
      name: '[Lvl 100] Enderman',
      exp: 1.9e7,
    });
    expect(acc['GOLDEN_DRAGON;4']).toMatchObject({ price: 600_000_000, count: 2 });
    expect(acc[`GOLDEN_DRAGON;4${MAX}`]).toMatchObject({ price: 1_000_000_000, count: 1, uuid: 'g200' });
    expect(acc[`JADE_DRAGON;4${MAX}`]).toMatchObject({ count: 1, uuid: 'j200' });
    expect(acc[`ENDERMAN;2${MAX}`]).toBeUndefined();
    expect(Object.keys(acc).sort()).toEqual(
      [
        'ENDERMAN;2',
        'ENDERMAN;3',
        'ENDERMAN;3@L49',
        'ENDERMAN;3@L99',
        `ENDERMAN;3${MAX}`,
        'GOLDEN_DRAGON;4',
        `GOLDEN_DRAGON;4${MAX}`,
        'JADE_DRAGON;4',
        `JADE_DRAGON;4${MAX}`,
      ].sort(),
    );
  });

  it('petLevelFromName and the 200-level set', () => {
    expect(petLevelFromName('[Lvl 84] Owl')).toBe(84);
    expect(petLevelFromName('[Lvl 200] Golden Dragon ✦')).toBe(200);
    expect(petLevelFromName('Hyperion')).toBeNull();
    expect(petLevelFromName(undefined)).toBeNull();
    expect([...PET_MAX_200].sort()).toEqual(['GOLDEN_DRAGON', 'JADE_DRAGON', 'ROSE_DRAGON']);
  });

  it('petBandKey: @L49 / @L89 / @L99 bands, @MAX at max level, null otherwise', () => {
    const pet = { type: 'ENDERMAN' };
    const gold = { type: 'GOLDEN_DRAGON' };
    expect(AH.petBands).toEqual([49, 89, 99]);
    expect(petBandKey('E;3', pet, 1)).toBe(`E;3${PET_BAND_PREFIX}49`);
    expect(petBandKey('E;3', pet, 49)).toBe('E;3@L49');
    expect(petBandKey('E;3', pet, 50)).toBe('E;3@L89');
    expect(petBandKey('E;3', pet, 89)).toBe('E;3@L89');
    expect(petBandKey('E;3', pet, 90)).toBe('E;3@L99');
    expect(petBandKey('E;3', pet, 99)).toBe('E;3@L99');
    expect(petBandKey('E;3', pet, 100)).toBe(`E;3${AH.petMaxSuffix}`);
    expect(petBandKey('G;4', gold, 100)).toBeNull();
    expect(petBandKey('G;4', gold, 150)).toBeNull();
    expect(petBandKey('G;4', gold, 200)).toBe('G;4@MAX');
    expect(petBandKey('G;4', gold, 60)).toBe('G;4@L89');
    expect(petBandKey('E;3', pet, null)).toBeNull();
    expect(petBandKey('E;3', pet, 0)).toBeNull();
    expect(petMaxLevel('ROSE_DRAGON')).toBe(200);
    expect(petMaxLevel('ENDERMAN')).toBe(100);
  });

  it('scan v4: stacks are priced per item, the lowest AH.keepPrices kept, `stack` follows the cheapest', () => {
    const acc: Record<string, AhPrice> = {};
    const stackBin = (uuid: string, total: number, count: number): RawAuction => ({
      uuid,
      item_name: 'Enchanted Diamond',
      bin: true,
      starting_bid: total,
      item_bytes: itemB64({ id: str('ENCHANTED_DIAMOND') }, { count }),
    });
    const r = aggregatePage([stackBin('a', 6_400, 64), stackBin('b', 150, 1), stackBin('c', 1_200, 16)], acc);
    expect(r).toEqual({ bins: 3, errors: 0, tierBoosted: 0, dupes: 0 });
    expect(acc.ENCHANTED_DIAMOND).toEqual({ price: 75, next: 100, prices: [75, 100, 150], count: 3, uuid: 'c', name: 'Enchanted Diamond', stack: 16 });
    // a single-item listing taking the lowest drops `stack`
    aggregatePage([stackBin('d', 50, 1)], acc);
    expect(acc.ENCHANTED_DIAMOND).toMatchObject({ price: 50, next: 75, uuid: 'd', count: 4 });
    expect(acc.ENCHANTED_DIAMOND!.stack).toBeUndefined();
    // only the lowest keepPrices survive
    aggregatePage(
      Array.from({ length: 20 }, (_, i) => stackBin(`x${i}`, 1_000 + i, 1)),
      acc,
    );
    expect(acc.ENCHANTED_DIAMOND!.prices).toHaveLength(AH.keepPrices);
    expect(acc.ENCHANTED_DIAMOND!.prices!.slice(0, 4)).toEqual([50, 75, 100, 150]);
    expect(acc.ENCHANTED_DIAMOND!.count).toBe(24);
    // an entry carried over from an older scan (no prices) is rebuilt from price / next
    const old: Record<string, AhPrice> = { ENCHANTED_DIAMOND: { price: 90, next: 95, count: 2 }, X: { price: 5, count: 1 } };
    aggregatePage([stackBin('e', 92, 1)], old);
    expect(old.ENCHANTED_DIAMOND).toMatchObject({ price: 90, next: 92, prices: [90, 92, 95], count: 3 });
  });

  it('scan v4: listings are deduped by uuid through `seen`', () => {
    const acc: Record<string, AhPrice> = {};
    const seen = new Set<string>();
    const one = (uuid: string, price: number): RawAuction => ({ uuid, bin: true, starting_bid: price, item_bytes: itemB64({ id: str('HYPERION') }) });
    expect(aggregatePage([one('a', 10), one('a', 10), one('b', 20)], acc, seen)).toEqual({ bins: 2, errors: 0, tierBoosted: 0, dupes: 1 });
    expect(aggregatePage([one('b', 20), one('c', 30)], acc, seen)).toEqual({ bins: 1, errors: 0, tierBoosted: 0, dupes: 1 });
    expect(acc.HYPERION).toMatchObject({ count: 3, prices: [10, 20, 30] });
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
    // listings without a uuid are never deduped
    const noId = { bin: true, starting_bid: 5, item_bytes: itemB64({ id: str('HYPERION') }) } as RawAuction;
    expect(aggregatePage([noId, noId], acc, seen).bins).toBe(2);
  });

  it('decodeListings / foldListings split decoding from folding', () => {
    const { listings, stats } = decodeListings([petBin('p', '[Lvl 95] Enderman', 700, { type: 'ENDERMAN', tier: 'EPIC', exp: 5e6 })]);
    expect(stats).toEqual({ bins: 1, errors: 0, tierBoosted: 0, dupes: 0 });
    expect(listings).toEqual([{ id: 'ENDERMAN;3', band: 'ENDERMAN;3@L99', price: 700, count: 1, uuid: 'p', name: '[Lvl 95] Enderman', exp: 5e6 }]);
    const acc: Record<string, AhPrice> = {};
    foldListings(acc, listings);
    expect(Object.keys(acc).sort()).toEqual(['ENDERMAN;3', 'ENDERMAN;3@L99']);
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
    expect(res.lowestBin.HYPERION).toMatchObject({ price: 525_000_000, count: 4 });
    expect(res.v).toBe(AH_SCAN_VERSION);
    expect(AH_SCAN_VERSION).toBe(4);
    expect(res.mixedPages).toBe(0);
    expect(res.dupes).toBe(0);
    expect(res.failedPages).toEqual([]);
    expect(res.binCount).toBe(21);
    expect(res.tierBoosted).toBe(0);
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

  it('a page from another AH refresh is fetched once more; still mixed, it is used and counted in mixedPages', async () => {
    const ps = emptyPages(5);
    const calls = new Map<number, number>();
    const f: AhPageFetcher = async (n) => {
      const c = (calls.get(n) ?? 0) + 1;
      calls.set(n, c);
      const p = structuredClone(ps[n]!);
      // page 1: stale on the first fetch only; page 2: stale twice; page 3: stale, then the refetch fails
      if ((n === 1 && c === 1) || n === 2 || (n === 3 && c === 1)) p.lastUpdated = T0 - 60_000;
      if (n === 3 && c === 2) throw new Error('flaky');
      if (n === 2) p.auctions = [{ uuid: 'm', bin: true, starting_bid: 7, item_bytes: itemB64({ id: str('MIXED') }) }];
      return p;
    };
    const res = await scanAuctions(f, () => {}, undefined, () => T0, 1);
    expect(calls.get(1)).toBe(2);
    expect(calls.get(2)).toBe(2);
    expect(calls.get(3)).toBe(2);
    expect(calls.get(4)).toBe(1);
    expect(res.mixedPages).toBe(2);
    expect(res.failedPages).toEqual([]);
    expect(res.lowestBin.MIXED).toMatchObject({ price: 7, count: 1 });
  });

  it('dedupes listings repeated across pages (the AH shifted mid-scan)', async () => {
    const ps = pages(2);
    ps[1]!.auctions.push(...ps[0]!.auctions.filter((a) => a.bin && !a.claimed));
    const res = await scanAuctions(fetcher(ps), () => {});
    const single = await scanAuctions(fetcher(pages(2)), () => {});
    expect(res.dupes).toBeGreaterThan(0);
    expect(res.binCount).toBe(single.binCount);
    expect(res.lowestBin).toEqual(single.lowestBin);
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
    const cache: AhSnapshot = { v: AH_SCAN_VERSION, fetchedAt: T0 - 4 * 60_000, lastUpdated: T0, lowestBin: { X: { price: 1, count: 1 } } };
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

  it('a fresh cache from an older scan version scans at once and stays loaded until the new scan lands', async () => {
    vi.useFakeTimers({ now: T0 });
    for (const v of [undefined, 2, AH_SCAN_VERSION - 1]) {
      const cache: AhSnapshot = { ...(v === undefined ? {} : { v }), fetchedAt: T0 - 60_000, lastUpdated: T0, lowestBin: { X: { price: 1, count: 1 } } };
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const ps = emptyPages(1);
      const f = vi.fn(async (n: number) => {
        await gate;
        return ps[n]!;
      });
      const t = setup({ cache, fetchPage: f });
      t.scanner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(f).toHaveBeenCalledTimes(1);
      expect(await t.scanner.loadCached()).toBe(cache);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.ev.snapshots).toHaveLength(1);
      expect((await t.scanner.loadCached())!.v).toBe(AH_SCAN_VERSION);
      t.scanner.stop();
    }
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
