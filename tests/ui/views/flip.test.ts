// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_VIEWPREFS } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import '../../../src/i18n/common.ts';
import { dictKeys, setLang } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AppState, Catalog, HistoryPoint, HistoryRepo, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { createFlipView } from '../../../src/ui/views/flip/flipView.ts';
import bazaarJson from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';

const SNAP: Snapshot = toSnapshot(validateRaw(bazaarJson as unknown), 1_700_000_000_000, 'fixture');
const CATALOG: Catalog = catalogFromFile(validateCatalogFile(catalogJson as unknown));

const flush = () => new Promise((r) => setTimeout(r, 30));

function fakeHistory(): HistoryRepo & { statsCalls: number } {
  const pts = (id: string): HistoryPoint[] =>
    id === 'ENCHANTED_MELON'
      ? [0, 1, 2, 3].map((i) => ({ ts: i, bid: 300, ask: 320 + i * 5, instaBuysWeek: 0, instaSellsWeek: 0, buyOrders: 1, sellOrders: 1 }))
      : [];
  const repo = {
    statsCalls: 0,
    init: async () => {},
    record: async () => {},
    series: async () => [],
    recent: (id: string) => pts(id),
    stats(id: string) {
      repo.statsCalls++;
      return id === 'ENCHANTED_MELON' ? { n: 4, medianAsk: 325, medianBid: 300, madAsk: 1, madBid: 1, change24h: 0.05 } : null;
    },
    saveLatest: async () => {},
    loadLatest: async () => null,
  };
  return repo;
}

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext & { history: ReturnType<typeof fakeHistory> };

const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const rowKeys = () => [...root.querySelectorAll<HTMLElement>('tbody tr[data-key]')].map((r) => r.dataset.key!);
function setInput(sel: string, v: string) {
  const inp = q<HTMLInputElement>(sel);
  inp.value = v;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  setLang('tr');
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  ctx = { store, history: fakeHistory(), navigate: vi.fn(), t: (k: string) => k, refresh: async () => {} } as never;
  view = createFlipView();
});
afterEach(() => {
  view.unmount();
  document.body.innerHTML = '';
  setLang('tr');
});

describe('flip view', () => {
  it('TR/EN dictionaries have identical keys', () => {
    const k = dictKeys('flip');
    expect(k.tr.length).toBeGreaterThan(10);
    expect(k.en).toEqual(k.tr);
  });

  it('shows loading states, then rows once snapshot + catalog are present', async () => {
    view.mount(root, ctx, { id: 'flip' });
    expect(q('[data-testid="flip-msg"]').textContent).toBe('Fiyat verisi bekleniyor…');
    store.set({ snapshot: SNAP });
    await flush();
    expect(q('[data-testid="flip-msg"]').textContent).toBe('Ürün adları yükleniyor…');
    expect(rowKeys()).toHaveLength(0);
    store.set({ catalog: CATALOG });
    await flush();
    expect(q('[data-testid="flip-msg"]').hidden).toBe(true);
    const keys = rowKeys();
    expect(keys.length).toBeGreaterThan(0);
    expect(q('[data-testid="flip-count"]').textContent).toBe(`${keys.length} ürün`);
    // default sort: profit/hour desc
    expect(q('th.sorted').textContent).toContain('Kâr / saat');
  });

  it('numeric filters carry data-filter and filter rows; search narrows without recomputing', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    view.mount(root, ctx, { id: 'flip' });
    const filters = root.querySelectorAll('input[type="number"][data-filter]');
    expect(filters).toHaveLength(3);
    for (const f of filters) setInput(`[data-filter="${(f as HTMLElement).dataset.filter}"]`, '0');
    await flush();
    const all = rowKeys().length;
    expect(all).toBeGreaterThan(0);

    setInput('[data-filter="minVol"]', '1e15');
    await flush();
    expect(rowKeys()).toHaveLength(0);
    expect(q('td.empty').textContent).toMatch(/Filtreye uyan/);
    setInput('[data-filter="minVol"]', '0');
    await flush();

    const calls = ctx.history.statsCalls;
    setInput('[data-testid="flip-q"]', 'enchanted melon');
    await flush();
    expect(rowKeys()).toContain('ENCHANTED_MELON');
    expect(rowKeys().length).toBeLessThan(all);
    setInput('[data-testid="flip-q"]', 'ench_melon'); // id-ish query (underscore normalised)
    await flush();
    expect(ctx.history.statsCalls).toBe(calls); // no computeFlips rerun on keystrokes

    // persisted prefs
    const saved = JSON.parse(localStorage.getItem(LS_VIEWPREFS + 'flip')!);
    expect(saved).toMatchObject({ minVol: 0, minMargin: 0, minPph: 0, q: 'ench_melon', sort: { key: 'pph', dir: 'desc' } });
  });

  it('restores persisted prefs and route query', async () => {
    localStorage.setItem(LS_VIEWPREFS + 'flip', JSON.stringify({ minVol: 5, minMargin: 2, minPph: 7, q: 'x', sort: { key: 'margin', dir: 'asc' } }));
    store.set({ snapshot: SNAP, catalog: CATALOG });
    view = createFlipView();
    view.mount(root, ctx, { id: 'flip', query: { q: 'melon' } });
    expect(q<HTMLInputElement>('[data-filter="minVol"]').value).toBe('5');
    expect(q<HTMLInputElement>('[data-filter="minPph"]').value).toBe('7');
    expect(q<HTMLInputElement>('[data-testid="flip-q"]').value).toBe('melon');
    expect(q('th.sorted').textContent).toContain('Marj');
    view.update!({ id: 'flip', query: { q: 'gold' } });
    expect(q<HTMLInputElement>('[data-testid="flip-q"]').value).toBe('gold');
  });

  it('renders cells: sparkline, 24h change, risk badge; row click navigates', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    view.mount(root, ctx, { id: 'flip' });
    setInput('[data-testid="flip-q"]', 'ENCHANTED_MELON');
    await flush();
    const tr = q('tr[data-key="ENCHANTED_MELON"]');
    expect(tr.querySelector('svg.spark.pos polyline')).not.toBeNull();
    expect(tr.querySelector('.badge')).not.toBeNull();
    expect(tr.textContent).toContain('Enchanted Melon');
    expect(tr.innerHTML).toContain('+%5,0');
    (tr.querySelector('td.num') as HTMLElement).click();
    expect(ctx.navigate).toHaveBeenCalledWith({ id: 'item', param: 'ENCHANTED_MELON' });
  });

  it('hides suspect rows when hideSuspicious is on, with a reveal toggle', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    view.mount(root, ctx, { id: 'flip' });
    for (const k of ['minVol', 'minMargin', 'minPph']) setInput(`[data-filter="${k}"]`, '0');
    await flush();
    const btn = q<HTMLButtonElement>('[data-testid="flip-hidden"]');
    expect(btn.hidden).toBe(false); // fixture contains suspect flips
    const visible = rowKeys().length;
    const hiddenN = Number(btn.textContent!.match(/\d+/)![0]);
    expect(btn.textContent).toBe(`${hiddenN} gizli`);
    btn.click();
    expect(rowKeys().length).toBe(Math.min(visible + hiddenN, 300));
    expect(btn.textContent).toBe('Gizlileri sakla');
    btn.click();
    expect(rowKeys().length).toBe(visible);

    store.set({ settings: { ...store.get().settings, hideSuspicious: false } });
    await flush();
    expect(btn.hidden).toBe(true);
    expect(rowKeys().length).toBe(Math.min(visible + hiddenN, 300));
  });

  it('computes with derived names and shows a banner when the catalog failed', async () => {
    store.set({ snapshot: SNAP, catalogError: 'boom' });
    view.mount(root, ctx, { id: 'flip' });
    expect(q('.banner').hidden).toBe(false);
    expect(q('.banner').textContent).toContain('boom');
    expect(rowKeys().length).toBeGreaterThan(0);
  });

  it('switches language', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    view.mount(root, ctx, { id: 'flip' });
    setLang('en');
    expect(q('th.sorted').textContent).toContain('Profit / hour');
    expect(q('[data-testid="flip-count"]').textContent).toMatch(/items$/);
    expect(q('.note').textContent).toContain('Global settings');
  });

  it('unmount removes DOM and listeners', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    view.mount(root, ctx, { id: 'flip' });
    view.unmount();
    expect(root.children).toHaveLength(0);
    store.set({ snapshot: { ...SNAP } });
    setLang('en');
    await flush();
    expect(root.children).toHaveLength(0);
  });
});
