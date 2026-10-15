// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import { profitOf } from '../../../src/domain/journal.ts';
import { setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { startOrderWatch } from '../../../src/state/ordersRunner.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AppState, Catalog, MyOrder, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { createTradesView, parseJournalImport } from '../../../src/ui/views/trades/tradesView.ts';
import bazaarJson from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext;
let snap: Snapshot;
let catalog: Catalog;
const flush = () => new Promise((r) => setTimeout(r, 30));
const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const set = (sel: string, v: string) => (q<HTMLInputElement>(sel).value = v);
const submit = (form: string) => q<HTMLFormElement>(`form[data-form="${form}"]`).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const rows = (pane: string) => [...root.querySelectorAll<HTMLElement>(`.trades-${pane} tbody tr[data-key]`)];

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  snap = toSnapshot(validateRaw(structuredClone(bazaarJson) as never), Date.now(), 'live');
  catalog = catalogFromFile(validateCatalogFile(structuredClone(catalogJson)));
  store = createStore(initialState({ ...defaultSettings }));
  store.set({ snapshot: snap, catalog });
  root = document.createElement('div');
  document.body.append(root);
  ctx = fakeViewCtx(store, fakeHistory(), { t });
  view = createTradesView();
});
afterEach(() => {
  view.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('trades view: my orders', () => {
  it('tracks an order with its live status; re-price, filled buy -> sell form, filled sell -> journal', async () => {
    view.mount(root, ctx, { id: 'trades' });
    expect(q('h1').textContent).toBe('Trades');
    const gold = snap.products.ENCHANTED_GOLD!;
    set('[data-o-item]', 'Enchanted Gold');
    set('[data-o-price]', String(gold.bid! - 1)); // below the best buy order: outbid
    set('[data-o-qty]', '100');
    submit('order');
    await flush();
    const order = store.get().orders[0]!;
    expect(order).toMatchObject({ id: 'ENCHANTED_GOLD', side: 'buy', qty: 100, lastStatus: 'outbid' });
    expect(rows('orders')[0]!.querySelector('[data-status]')!.getAttribute('data-status')).toBe('outbid');

    rows('orders')[0]!.querySelector<HTMLButtonElement>('[data-action="reprice"]')!.click();
    expect(store.get().orders[0]!.price).toBeCloseTo(gold.bid! + 0.1, 9);

    rows('orders')[0]!.querySelector<HTMLButtonElement>('[data-action="filled"]')!.click();
    expect(store.get().orders).toEqual([]);
    expect(q<HTMLSelectElement>('[data-o-side]').value).toBe('sell');
    expect(Number(q<HTMLInputElement>('[data-o-cost]').value)).toBeCloseTo(gold.bid! + 0.1, 9);
    submit('order');
    await flush();
    const sellOrder = store.get().orders[0]!;
    expect(sellOrder).toMatchObject({ side: 'sell', qty: 100 });
    rows('orders')[0]!.querySelector<HTMLButtonElement>('[data-action="filled"]')!.click();
    const e = store.get().journal[0]!;
    expect(e).toMatchObject({ id: 'ENCHANTED_GOLD', qty: 100, sell: sellOrder.price, source: 'order', tax: store.get().settings.taxRate });
    expect(e.buy).toBeCloseTo(gold.bid! + 0.1, 9);
  });

  it('prefills from ?add=… and clears the query', async () => {
    view.mount(root, ctx, { id: 'trades', query: { add: 'ENCHANTED_GOLD', side: 'buy', price: '123.4', qty: '640' } });
    expect(q<HTMLInputElement>('[data-o-item]').value).toBe(catalog.name('ENCHANTED_GOLD'));
    expect(q<HTMLInputElement>('[data-o-price]').value).toBe('123.4');
    expect(q<HTMLInputElement>('[data-o-qty]').value).toBe('640');
    expect(ctx.setQuery).toHaveBeenCalledWith(expect.objectContaining({ add: undefined, price: undefined }));
  });

  it('unknown items and bad numbers are refused', () => {
    view.mount(root, ctx, { id: 'trades' });
    set('[data-o-item]', 'nothing like this');
    submit('order');
    expect(ctx.toast).toHaveBeenCalledWith(t('trades.unknownItem', { text: 'nothing like this' }), 'err');
    set('[data-o-item]', 'Enchanted Gold');
    set('[data-o-price]', '0');
    submit('order');
    expect(ctx.toast).toHaveBeenCalledWith(t('trades.badNumber'), 'err');
    expect(store.get().orders).toEqual([]);
  });
});

describe('trades view: journal', () => {
  it('logs a trade, shows the summary, deletes; planner prefill logs it untaxed', async () => {
    view.mount(root, ctx, { id: 'trades', query: { view: 'journal', add: 'ENCHANTED_GOLD', qty: '10', buy: '100', sell: '150', tax: '0', src: 'plan' } });
    expect(q('[data-pane="journal"]').hidden).toBe(false);
    expect(q<HTMLInputElement>('[data-j-taxed]').checked).toBe(false);
    submit('trade');
    await flush();
    const e = store.get().journal[0]!;
    expect(e).toMatchObject({ id: 'ENCHANTED_GOLD', qty: 10, buy: 100, sell: 150, tax: 0, source: 'plan' });
    expect(profitOf(e)).toBe(500);
    expect(q('[data-testid="journal-sums"]').textContent).toContain('500');
    expect(rows('journal')).toHaveLength(1);
    rows('journal')[0]!.querySelector<HTMLButtonElement>('[data-action="remove"]')!.click();
    expect(store.get().journal).toEqual([]);
  });

  it('import accepts the export envelope or a bare array and drops invalid entries', () => {
    const good = { key: 'a', id: 'X', qty: 1, buy: 1, sell: 2, tax: 0, fees: 0, at: 5, source: 'manual' };
    expect(parseJournalImport(JSON.stringify({ format: 'bazaarMasasi.journal', v: 1, journal: [good, { id: 'bad' }] }))).toEqual([good]);
    expect(parseJournalImport(JSON.stringify([good]))).toEqual([good]);
    expect(parseJournalImport('not json')).toEqual([]);
  });
});

describe('order watcher', () => {
  it('alerts once when an order loses the top of the book', () => {
    const gold = snap.products.ENCHANTED_GOLD!;
    const order: MyOrder = { key: 'o1', id: 'ENCHANTED_GOLD', side: 'buy', price: gold.bid! + 1, qty: 10, placedAt: 0, lastStatus: 'top' };
    store.set({ orders: [order] });
    const toast = vi.fn();
    const notify = vi.fn();
    const stop = startOrderWatch({ store, toast, notify });
    // a new snapshot where someone bids above us
    const outbid = { ...gold, bid: gold.bid! + 5, bids: [{ price: gold.bid! + 5, amount: 1000, orders: 3 }, ...gold.bids] };
    store.set({ snapshot: { ...snap, lastUpdated: snap.lastUpdated + 1, products: { ...snap.products, ENCHANTED_GOLD: outbid } } });
    expect(store.get().orders[0]!.lastStatus).toBe('outbid');
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![0]).toContain('outbid');
    expect(notify).not.toHaveBeenCalled(); // settings.notify is off
    // still outbid on the next snapshot: no second alert
    store.set({ snapshot: { ...store.get().snapshot!, lastUpdated: snap.lastUpdated + 2 } });
    expect(toast).toHaveBeenCalledTimes(1);
    stop();
  });
});
