// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_VIEWPREFS } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import '../../../src/i18n/common.ts';
import { dictKeys, setLang } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AppState, Catalog, HistoryPoint, HistoryRepo, MarketStat, Product, Route, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { createFlipView } from '../../../src/ui/views/flip/flipView.ts';
import { makeProduct } from '../../domain/helpers.ts';
import bazaarJson from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';
import { ctxExtras, historyExtras } from '../../helpers/fakes.ts';

// tests/domain/helpers.ts reads fixtures via import.meta.url, which is root-relative ('/tests/...') under happy-dom's
// web transform. Map those paths onto the project root (no-op once helpers.ts resolves them itself).
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  const fix = (p: unknown) => (typeof p === 'string' && p.startsWith('/tests/') ? process.cwd() + p : p);
  return { ...fs, default: fs, readFileSync: (p: string, ...a: unknown[]) => (fs.readFileSync as (...x: unknown[]) => unknown)(fix(p), ...a) };
});

const SNAP: Snapshot = toSnapshot(validateRaw(bazaarJson as unknown), 1_700_000_000_000, 'fixture');
const CATALOG: Catalog = catalogFromFile(validateCatalogFile(catalogJson as unknown));
const MELON = 'ENCHANTED_MELON';

const flush = () => new Promise((r) => setTimeout(r, 30));

const melonStat: MarketStat = {
  id: MELON,
  n: 40,
  change1h: -0.02,
  change24h: 0.05,
  volatility: 0.03,
  spreadMedian: 0.06,
  consistency: 0.8,
  buyVolTrend: 1.4,
  sellVolTrend: 0.7,
};

function fakeHistory() {
  const pts = (id: string): HistoryPoint[] =>
    id === MELON ? [0, 1, 2, 3].map((i) => ({ ts: i, bid: 300, ask: 320 + i * 5, instaBuysWeek: 0, instaSellsWeek: 0, buyOrders: 1, sellOrders: 1 })) : [];
  const repo = {
    statsCalls: 0,
    marketStatsCalls: 0,
    init: async () => {},
    record: async () => {},
    series: async () => [],
    recent: (id: string) => pts(id),
    stats(id: string) {
      repo.statsCalls++;
      return id === MELON ? { n: 4, medianAsk: 325, medianBid: 300, madAsk: 1, madBid: 1, change24h: 0.05 } : null;
    },
    saveLatest: async () => {},
    loadLatest: async () => null,
    ...historyExtras,
    marketStats() {
      repo.marketStatsCalls++;
      return new Map([[MELON, melonStat]]);
    },
  };
  return repo satisfies HistoryRepo;
}

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext & { history: ReturnType<typeof fakeHistory>; setQuery: ReturnType<typeof vi.fn>; toast: ReturnType<typeof vi.fn> };

const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const rowKeys = () => [...root.querySelectorAll<HTMLElement>('tbody tr[data-key]')].map((r) => r.dataset.key!);
const count = () => Number(q('[data-testid="flip-count"]').textContent!.replace(/\D/g, ''));
const panel = () => q('.kit-panel');
/** Type into a filter-bar field and commit it (change flushes the debounce). */
function setFilter(key: string, v: string) {
  const inp = q<HTMLInputElement>(`input[data-filter="${key}"]`);
  inp.value = v;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}
const openFilters = () => {
  for (const k of ['minVol', 'minMargin', 'minPph']) setFilter(k, '0');
};
const key = (k: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

function mount(route: Route = { id: 'flip' }) {
  view.mount(root, ctx, route);
}

beforeEach(() => {
  localStorage.clear();
  setLang('tr');
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  const history = fakeHistory();
  ctx = { store, history, navigate: vi.fn(), t: (k: string) => k, refresh: async () => {}, ...ctxExtras(store, history) } as never;
  view = createFlipView();
});
afterEach(() => {
  view.unmount();
  document.body.innerHTML = '';
  setLang('tr');
  vi.restoreAllMocks();
});

describe('flip view', () => {
  it('TR/EN dictionaries have identical keys', () => {
    const k = dictKeys('flip');
    expect(k.tr.length).toBeGreaterThan(50);
    expect(k.en).toEqual(k.tr);
  });

  it('has the page h1, shows loading states, then rows once snapshot + catalog are present', async () => {
    mount();
    expect(q('h1').textContent).toBe('Flip bulucu');
    expect(q('[data-testid="flip-msg"]').textContent).toBe('Fiyat verisi bekleniyor…');
    store.set({ snapshot: SNAP });
    await flush();
    expect(q('[data-testid="flip-msg"]').textContent).toBe('Ürün adları yükleniyor…');
    store.set({ catalog: CATALOG });
    await flush();
    expect(q('[data-testid="flip-msg"]').hidden).toBe(true);
    expect(rowKeys().length).toBeGreaterThan(0);
    expect(count()).toBe(rowKeys().length);
    expect(q('th.sorted').textContent).toContain('Kâr / saat'); // default sort: profit/hour desc
  });

  it('filters write the URL (setQuery) + localStorage and narrow rows; search does not recompute', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    const before = count();
    openFilters();
    expect(ctx.setQuery).toHaveBeenCalledWith({ minVol: '0' });
    expect(ctx.setQuery).toHaveBeenCalledWith({ minMargin: '0' });
    await flush();
    const all = count();
    expect(all).toBeGreaterThanOrEqual(before);

    setFilter('minVol', '1e15');
    await flush();
    expect(count()).toBe(0);
    expect(q('td.empty').textContent).toMatch(/Filtreye uyan/);
    setFilter('minVol', '0');
    await flush();

    const calls = ctx.history.statsCalls;
    setFilter('q', 'enchanted melon');
    expect(ctx.setQuery).toHaveBeenLastCalledWith({ q: 'enchanted melon' });
    await flush();
    expect(rowKeys()).toContain(MELON);
    expect(count()).toBeLessThan(all);
    setFilter('q', 'enchanted_melon'); // id-ish query (underscore normalised)
    await flush();
    expect(rowKeys()).toContain(MELON);
    expect(ctx.history.statsCalls).toBe(calls); // memoized flips: no recompute on keystrokes

    const saved = JSON.parse(localStorage.getItem(LS_VIEWPREFS + 'flip')!);
    expect(saved).toMatchObject({ minVol: '0', minMargin: '0', q: 'enchanted_melon' });
  });

  it('risk segment and sort header write the URL', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    openFilters();
    await flush();
    q<HTMLButtonElement>('[data-filter="risk"] button[data-value="ok"]').click();
    expect(ctx.setQuery).toHaveBeenLastCalledWith({ risk: 'ok' });
    await flush();
    for (const tr of root.querySelectorAll('tbody tr[data-key]')) expect(tr.querySelector('.badge.risk-ok')).not.toBeNull();

    q<HTMLButtonElement>('th button[data-sort="margin"]').click();
    expect(ctx.setQuery).toHaveBeenLastCalledWith({ sort: 'margin.desc' });
    expect(q('th.sorted').textContent).toContain('Marj');
  });

  it('URL state wins on mount and update() re-reads it (idempotent)', async () => {
    localStorage.setItem(LS_VIEWPREFS + 'flip', JSON.stringify({ q: 'gold' }));
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount({ id: 'flip', query: { q: 'melon', minVol: '0', sort: 'margin.asc' } });
    expect(q<HTMLInputElement>('input[data-filter="q"]').value).toBe('melon');
    expect(q<HTMLInputElement>('input[data-filter="minVol"]').value).toBe('0');
    expect(q('th.sorted').textContent).toContain('Marj');
    expect(q('th.sorted').getAttribute('aria-sort')).toBe('ascending');

    view.update!({ id: 'flip', query: { q: 'gold', sort: 'pph.desc' } });
    await flush();
    expect(q<HTMLInputElement>('input[data-filter="q"]').value).toBe('gold');
    expect(q<HTMLInputElement>('input[data-filter="minVol"]').value).toBe('10000'); // absent key = default
    expect(q('th.sorted').textContent).toContain('Kâr / saat');
    const calls = ctx.setQuery.mock.calls.length;
    view.update!({ id: 'flip', query: { q: 'gold', sort: 'pph.desc' } });
    expect(ctx.setQuery.mock.calls.length).toBe(calls);
  });

  it('restores persisted prefs, including the round-1 typed format', async () => {
    localStorage.setItem(LS_VIEWPREFS + 'flip', JSON.stringify({ minVol: 5, minMargin: 2, minPph: 7, q: 'x', sort: { key: 'margin', dir: 'asc' } }));
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    expect(q<HTMLInputElement>('input[data-filter="minVol"]').value).toBe('5');
    expect(q<HTMLInputElement>('input[data-filter="minPph"]').value).toBe('7');
    expect(q<HTMLInputElement>('input[data-filter="q"]').value).toBe('x');
    expect(q('th.sorted').textContent).toContain('Marj');
    await flush();
    expect(ctx.setQuery).toHaveBeenCalledWith(expect.objectContaining({ minVol: '5', sort: 'margin.asc' })); // pushed to the URL
  });

  it('renders cells: sparkline, 24h/1h change, consistency, slots, fill, limitedBy, risk', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount({ id: 'flip', query: { q: MELON } });
    await flush();
    const tr = q(`tr[data-key="${MELON}"]`);
    expect(tr.querySelector('svg.spark.pos polyline')).not.toBeNull();
    expect(tr.querySelector('.badge')).not.toBeNull();
    expect(tr.textContent).toContain('Enchanted Melon');
    expect(tr.innerHTML).toContain('+%5,0');
    expect(tr.innerHTML).toContain('-%2,0');
    expect(tr.textContent).toContain('%80');
    expect(tr.textContent).toMatch(/\d.* \+ /); // "buy h + sell h"
    expect(tr.textContent).toMatch(/Hacim|Sermaye|Derinlik|Slot/);
    expect(ctx.history.marketStatsCalls).toBeGreaterThan(0);
  });

  it('opens the detail panel on row activation with plan, risk, stats, order book and links', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount({ id: 'flip', query: { q: MELON } });
    await flush();
    expect(panel().hidden).toBe(true);
    (q(`tr[data-key="${MELON}"] td.num`) as HTMLElement).click();
    expect(panel().hidden).toBe(false);
    expect(q('.kit-panel-title').textContent).toBe('Enchanted Melon');
    expect(q(`tr[data-key="${MELON}"]`).getAttribute('aria-selected')).toBe('true');
    const steps = [...panel().querySelectorAll('.dp-steps li')].map((li) => li.textContent);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatch(/adetlik buy order ver/);
    expect(steps[1]).toMatch(/sell offer ver/);
    expect(panel().textContent).toContain('Sipariş slotu');
    expect(panel().textContent).toContain('Insta-buy hacmi (tahmini)');
    expect(panel().querySelectorAll('.dp-book table')).toHaveLength(2);
    expect(panel().querySelectorAll('.dp-book table')[0]!.querySelectorAll('tbody tr').length).toBeLessThanOrEqual(5);
    expect(panel().querySelector(`a[href="#/item/${MELON}"]`)).not.toBeNull();
    expect(ctx.navigate).not.toHaveBeenCalled();

    // panel watch button
    q<HTMLButtonElement>('.kit-panel [data-panel="watch"]').click();
    expect(ctx.watch.has(MELON)).toBe(true);
    await flush();
    expect(q('.kit-panel [data-panel="watch"]').getAttribute('aria-pressed')).toBe('true');

    q<HTMLButtonElement>('.kit-panel .kit-x').click();
    expect(panel().hidden).toBe(true);
    expect(q(`tr[data-key="${MELON}"]`).getAttribute('aria-selected')).toBeNull();
  });

  it('★ row action toggles the watchlist with a toast; hotkeys s and e work while mounted', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount({ id: 'flip', query: { q: MELON } });
    await flush();
    const btn = () => q<HTMLButtonElement>(`tr[data-key="${MELON}"] button[data-action="watch"]`);
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    btn().click();
    expect(store.get().watchlist.map((w) => w.id)).toEqual([MELON]);
    expect(ctx.toast).toHaveBeenCalledWith(expect.stringContaining('Enchanted Melon'), 'ok');
    expect(panel().hidden).toBe(true); // action click does not activate the row
    await flush();
    expect(btn().getAttribute('aria-pressed')).toBe('true');

    key('s'); // nothing selected yet
    expect(ctx.toast).toHaveBeenLastCalledWith('Önce bir satır seç.', 'info');
    (q(`tr[data-key="${MELON}"] td.num`) as HTMLElement).click();
    key('s');
    expect(store.get().watchlist).toHaveLength(0);

    const create = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    key('e');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('hides suspect rows when hideSuspicious is on, with a reveal toggle (URL-backed)', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    openFilters();
    await flush();
    const btn = q<HTMLButtonElement>('[data-testid="flip-hidden"]');
    expect(btn.hidden).toBe(false); // fixture contains suspect flips
    const visible = count();
    const hiddenN = Number(btn.textContent!.match(/\d+/)![0]);
    expect(btn.textContent).toBe(`${hiddenN} gizli`);
    btn.click();
    expect(ctx.setQuery).toHaveBeenLastCalledWith({ sus: '1' });
    await flush();
    expect(count()).toBe(visible + hiddenN);
    expect(btn.textContent).toBe('Gizlileri sakla');
    expect(q<HTMLInputElement>('input[data-filter="sus"]').checked).toBe(true);
    btn.click();
    await flush();
    expect(count()).toBe(visible);

    store.set({ settings: { ...store.get().settings, hideSuspicious: false } });
    await flush();
    expect(btn.hidden).toBe(true);
    expect(count()).toBe(visible + hiddenN);
  });

  it('shows a banner and a message when the catalog failed', async () => {
    store.set({ snapshot: SNAP, catalogError: 'boom' });
    mount();
    expect(q('.banner').hidden).toBe(false);
    expect(q('.banner').textContent).toContain('boom');
    expect(q('[data-testid="flip-msg"]').textContent).toContain('Katalog');
  });

  it('switches language', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    setLang('en');
    expect(q('h1').textContent).toBe('Flip finder');
    expect(q('th.sorted').textContent).toContain('Profit / hour');
    expect(q('[data-testid="flip-count"]').textContent).toMatch(/items$/);
    expect(q('.note').textContent).toContain('Settings');
    expect(q('[data-tool="csv"]').textContent).toBe('Download CSV');
  });

  it('virtualizes ~2,200 rows and reads marketStats once per render', async () => {
    const products: Record<string, Product> = {};
    for (let i = 0; i < 2200; i++) {
      const id = `SYNTH_${i}`;
      products[id] = makeProduct({ id, bids: [{ price: 100 + i, amount: 5000, orders: 10 }], asks: [{ price: (100 + i) * 1.1, amount: 5000, orders: 10 }] });
    }
    const snap: Snapshot = { lastUpdated: 0, fetchedAt: 0, source: 'fixture', products };
    store.set({ snapshot: snap, catalog: CATALOG });
    const t0 = performance.now();
    mount();
    const ms = performance.now() - t0;
    expect(count()).toBe(2200);
    expect(rowKeys().length).toBeLessThan(80);
    expect(root.querySelector('.tbl-virtual')).not.toBeNull();
    expect(ctx.history.marketStatsCalls).toBe(1);
    expect(ms).toBeLessThan(1500);
    setFilter('q', 'synth 1');
    await flush();
    expect(ctx.history.marketStatsCalls).toBe(2);
  });

  it('unmount removes DOM, listeners, panel and hotkeys', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount({ id: 'flip', query: { q: MELON } });
    await flush();
    (q(`tr[data-key="${MELON}"] td.num`) as HTMLElement).click();
    view.unmount();
    expect(root.children).toHaveLength(0);
    expect(document.querySelector('.kit-panel, .kit-backdrop')).toBeNull();
    key('s');
    expect(store.get().watchlist).toHaveLength(0);
    store.set({ snapshot: { ...SNAP } });
    setLang('en');
    await flush();
    expect(root.children).toHaveLength(0);
  });
});
