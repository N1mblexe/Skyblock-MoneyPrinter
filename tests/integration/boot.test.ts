// @vitest-environment happy-dom
// Boot the real app (bootstrap) against stubbed Hypixel endpoints: live status, overview, AH, election.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AhSalesPollerOptions } from '../../src/api/ahSales.ts';
import type { AhSalesSnapshot } from '../../src/types/contracts.ts';
import { bootApp, expectNoConsoleErrors, freshBazaar, go, settle, teardownApp, waitFor, type Booted } from './harness.ts';

afterEach(teardownApp);

const AH_ID = 'ASPECT_OF_THE_VOID'; // a BIN listing in tests/fixtures/ah-page.json (not a bazaar product)

/** AH page scans; '/skyblock/auctions' also matches the auctions_ended sales feed */
const ahPageCalls = (b: Booted) => b.net.calls('/skyblock/auctions') - b.net.calls('/skyblock/auctions_ended');

describe('boot', () => {
  it('reaches a live status, renders the overview, logs no errors or warnings', async () => {
    const b = await bootApp();
    await settle(5);
    const s = b.store.get();
    expect(s.status).toBe('live');
    expect(s.snapshot?.source).toBe('live');
    expect(Object.keys(s.snapshot!.products).length).toBe(35);
    expect(s.catalog).not.toBeNull();
    expect(s.catalogError).toBeNull();
    expect(s.route).toEqual({ id: 'overview' });

    const pill = document.querySelector<HTMLElement>('[data-testid="status-pill"]')!;
    expect(pill.dataset.status).toBe('live');
    expect(pill.getAttribute('role')).toBe('status');

    const view = document.querySelector('#view')!;
    expect(view.querySelectorAll('h1')).toHaveLength(1);
    expect(view.querySelector('h1')!.textContent).toBe('Overview');
    expect(document.querySelector('[data-testid="tab-overview"]')!.getAttribute('aria-current')).toBe('page');
    expect(view.textContent!.length).toBeGreaterThan(100);

    // every endpoint fetched once, nothing else
    expect(b.net.calls('/skyblock/bazaar')).toBe(1);
    expect(b.net.calls('data/catalog.json')).toBe(1);
    expect(b.net.calls('/skyblock/election')).toBe(1);
    expect(ahPageCalls(b)).toBe(1);
    const sales = b.net.calls('/skyblock/auctions_ended'); // the sales poller (at most its first poll)
    expect(sales).toBeLessThanOrEqual(1);
    expect(b.net.fetch).toHaveBeenCalledTimes(4 + sales);

    expect(s.election?.mayor?.name).toBe('Paul');
    expectNoConsoleErrors(b);
    expect(b.warns).not.toHaveBeenCalled();
  });
});

describe('reload', () => {
  it('a reload with the bazaar down shows the cached snapshot from IndexedDB with an error status', async () => {
    const first = await bootApp();
    await settle(3); // history write
    const lastUpdated = first.store.get().snapshot!.lastUpdated;
    teardownApp();

    const b = await bootApp({ keepDb: true, waitLive: false, beforeBoot: (net) => net.setBazaar(null) });
    await waitFor(() => b.store.get().status === 'error' && !!b.store.get().catalog, 'error status');
    await settle(3);
    const s = b.store.get();
    expect(s.snapshot?.lastUpdated).toBe(lastUpdated);
    expect(s.snapshot?.source).toBe('cache');
    expect(s.lastError).toEqual({ key: 'err.http', params: { status: 503 } });
    const pill = document.querySelector<HTMLElement>('[data-testid="status-pill"]')!;
    expect(pill.dataset.status).toBe('error');
    expect(document.querySelector('.status-err')!.textContent).toBe('HTTP 503');
    // data is still there: the overview renders and the manual-load panel stays closed
    expect(document.querySelector('#view h1')!.textContent).toBe('Overview');
    expect(document.querySelector('.manual-inline')!.children).toHaveLength(0);
    // AH comes from its own IndexedDB cache (no rescan within AH.pollMs)
    await waitFor(() => b.store.get().ah !== null, 'cached AH');
    expect(ahPageCalls(b)).toBe(0);
    expectNoConsoleErrors(b);
  });

  it('with the bazaar down and no cache, the manual-load panel opens inline', async () => {
    const b = await bootApp({ waitLive: false, beforeBoot: (net) => net.setBazaar(null) });
    await waitFor(() => b.store.get().status === 'error', 'error status');
    await settle(3);
    expect(b.store.get().snapshot).toBeNull();
    expect(document.querySelector('.manual-inline')!.children.length).toBeGreaterThan(0);
    expectNoConsoleErrors(b);
  });
});

describe('auction house', () => {
  it('ahEnabled=false: no auctions request; switching it on scans', async () => {
    const b = await bootApp({ ls: { 'bazaarMasasi.settings': { ahEnabled: false } }, waitLive: false });
    await waitFor(() => b.store.get().status === 'live' && b.store.get().election !== null, 'live');
    await settle(3);
    expect(b.net.calls('/skyblock/auctions')).toBe(0); // no scan, no sales feed
    expect(b.store.get().ah).toBeNull();
    b.store.set((s) => ({ settings: { ...s.settings, ahEnabled: true } }));
    await waitFor(() => b.store.get().ah !== null && b.store.get().ahProgress === null, 'AH scan');
    expect(ahPageCalls(b)).toBe(1);
    expectNoConsoleErrors(b);
  });

  it('Worker is undefined in happy-dom, so the scanner runs inline and store.ah comes from the fixture', async () => {
    expect(typeof Worker).toBe('undefined');
    const b = await bootApp();
    await waitFor(() => b.store.get().ah !== null && b.store.get().ahProgress === null, 'AH scan');
    const ah = b.store.get().ah!;
    expect(ah.lastUpdated).toBe(1791969906275);
    expect(Object.keys(ah.lowestBin).length).toBeGreaterThan(10);
    expect(ah.lowestBin[AH_ID]).toMatchObject({ price: expect.any(Number), count: expect.any(Number) });
    expect(ah.lowestBin[AH_ID]!.price).toBeGreaterThan(0);
    expect(b.warns).not.toHaveBeenCalled();
    expectNoConsoleErrors(b);
  });

  it('the item page of an AH-only item shows the AH card', async () => {
    const b = await bootApp();
    await waitFor(() => b.store.get().ah !== null, 'AH scan');
    await go(b, `#/item/${AH_ID}`);
    const card = await (async () => {
      await waitFor(() => !!document.querySelector('[data-testid="item-ah"]'), 'AH card');
      return document.querySelector<HTMLElement>('[data-testid="item-ah"]')!;
    })();
    expect(document.querySelectorAll('#view h1')).toHaveLength(1);
    expect(document.querySelector('[data-testid="item-name"]')!.textContent).toMatch(/Aspect of the Void/i);
    // the lowest BIN price (en formatting: 22,500,000) and the listing count appear in the card
    const { price, count } = b.store.get().ah!.lowestBin[AH_ID]!;
    expect(price).toBe(22_500_000);
    expect(card.textContent).toContain('22,500,000');
    expect(card.textContent).toContain(`BIN listings${count}`);
    expectNoConsoleErrors(b);
  });
});

describe('snapshots', () => {
  it('one store update per snapshot: history is recorded first, then snapshot and historyTick change together', async () => {
    const b = await bootApp();
    await settle(3);
    expect(b.store.get().historyTick).toBeGreaterThanOrEqual(1);
    const changes: { snap: boolean; tick: boolean }[] = [];
    b.store.subscribe((s, prev) => {
      const snap = s.snapshot !== prev.snapshot;
      const tick = s.historyTick !== prev.historyTick;
      if (snap || tick) changes.push({ snap, tick });
    });
    const at = Date.now() - 1_000;
    b.net.setBazaar(freshBazaar(at));
    document.querySelector<HTMLButtonElement>('[data-testid="refresh-btn"]')!.click();
    await waitFor(() => b.store.get().snapshot?.lastUpdated === at, 'new snapshot');
    await settle(3);
    expect(changes).toEqual([{ snap: true, tick: true }]);
    expectNoConsoleErrors(b);
    expect(b.warns).not.toHaveBeenCalled();
  });

  it('a failed history write still shows the snapshot (no historyTick) and warns', async () => {
    const b = await bootApp();
    await settle(3);
    const tick = b.store.get().historyTick;
    const proto = IDBDatabase.prototype;
    const orig = proto.transaction;
    proto.transaction = function () {
      throw new Error('boom');
    } as typeof orig;
    try {
      const at = Date.now() - 1_000;
      b.net.setBazaar(freshBazaar(at));
      document.querySelector<HTMLButtonElement>('[data-testid="refresh-btn"]')!.click();
      await waitFor(() => b.store.get().snapshot?.lastUpdated === at, 'new snapshot');
      await settle(2);
    } finally {
      proto.transaction = orig;
    }
    // the in-memory record succeeds and the IndexedDB write failure is only logged by history
    expect(b.store.get().historyTick).toBe(tick + 1);
    expect(b.warns).toHaveBeenCalled();
  });
});

describe('AH sales poller', () => {
  const salesSnap = (perHour: number): AhSalesSnapshot => ({
    v: 1,
    updatedAt: 1,
    coverageHours: 3,
    byId: { [AH_ID]: { n: 4, items: 4, median: 2e7, perHour, coverageHours: 3, last: 1 } },
  });

  function mockSales(cached: AhSalesSnapshot | null) {
    const m = { opts: null as AhSalesPollerOptions | null, start: vi.fn(), stop: vi.fn(), loadCached: vi.fn(async () => cached) };
    vi.doMock('../../src/api/ahSales.ts', () => ({
      createAhSalesPoller: (opts: AhSalesPollerOptions) => {
        m.opts = opts;
        return { start: m.start, stop: m.stop, loadCached: m.loadCached, clear: async () => {}, info: async () => ({ sales: 0, ids: 0, coverageHours: 0 }) };
      },
    }));
    return m;
  }
  afterEach(() => vi.doUnmock('../../src/api/ahSales.ts'));

  it('loads the cache at boot, follows the AH toggle, and its updates reach the store and calcCtx()', async () => {
    const m = mockSales(salesSnap(1));
    const b = await bootApp();
    await waitFor(() => b.store.get().ahSales !== null, 'cached AH sales');
    expect(m.loadCached).toHaveBeenCalledTimes(1);
    expect(m.start).toHaveBeenCalledTimes(1);
    expect(m.opts!.enabled!()).toBe(true);
    m.opts!.onUpdate(salesSnap(5));
    expect(b.store.get().ahSales!.byId[AH_ID]!.perHour).toBe(5);
    b.store.set((s) => ({ settings: { ...s.settings, ahEnabled: false } }));
    expect(m.stop).toHaveBeenCalledTimes(1);
    expect(m.opts!.enabled!()).toBe(false);
    expect(b.store.get().ahSales).not.toBeNull(); // kept, like store.ah; derived ignores both while off
    b.store.set((s) => ({ settings: { ...s.settings, ahEnabled: true } }));
    expect(m.start).toHaveBeenCalledTimes(2);
    await waitFor(() => b.store.get().ahProgress === null && b.store.get().ah !== null, 'AH rescan');
    const warn = b.warns.mockImplementation(() => {});
    m.opts!.onError(new Error('down'));
    expect(warn).toHaveBeenCalledWith('AH sales fetch failed', expect.any(Error));
    expectNoConsoleErrors(b);
  });

  it('a cached summary does not replace one that arrived first; not started while the AH is off', async () => {
    const m = mockSales(salesSnap(1));
    m.loadCached.mockImplementation(async () => {
      m.opts!.onUpdate(salesSnap(9));
      return salesSnap(1);
    });
    const b = await bootApp({ ls: { 'bazaarMasasi.settings': { ahEnabled: false } }, waitLive: false });
    await waitFor(() => b.store.get().status === 'live' && b.store.get().election !== null, 'live');
    await settle(2);
    expect(m.start).not.toHaveBeenCalled();
    expect(b.store.get().ahSales!.byId[AH_ID]!.perHour).toBe(9);
    expectNoConsoleErrors(b);
  });
});

