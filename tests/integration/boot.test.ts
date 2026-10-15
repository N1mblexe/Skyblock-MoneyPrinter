// @vitest-environment happy-dom
// Boot the real app (bootstrap) against stubbed Hypixel endpoints: live status, overview, AH, election.
import { afterEach, describe, expect, it } from 'vitest';
import { bootApp, expectNoConsoleErrors, go, settle, teardownApp, waitFor } from './harness.ts';

afterEach(teardownApp);

const AH_ID = 'ASPECT_OF_THE_VOID'; // a BIN listing in tests/fixtures/ah-page.json (not a bazaar product)

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
    expect(b.net.calls('/skyblock/auctions')).toBe(1);
    expect(b.net.fetch).toHaveBeenCalledTimes(4);

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
    expect(b.net.calls('/skyblock/auctions')).toBe(0);
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
    expect(b.net.calls('/skyblock/auctions')).toBe(0);
    expect(b.store.get().ah).toBeNull();
    b.store.set((s) => ({ settings: { ...s.settings, ahEnabled: true } }));
    await waitFor(() => b.store.get().ah !== null && b.store.get().ahProgress === null, 'AH scan');
    expect(b.net.calls('/skyblock/auctions')).toBe(1);
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
