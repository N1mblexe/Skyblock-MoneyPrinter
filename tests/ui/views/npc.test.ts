// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_VIEWPREFS } from '../../../src/config.ts';
import { catalogFromFile } from '../../../src/data/catalog.ts';
import { dictKeys, setLang } from '../../../src/i18n/index.ts';
import '../../../src/i18n/common.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AppState, Catalog, CatalogFile, HistoryRepo, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { createNpcView } from '../../../src/ui/views/npc/npcView.ts';
import { createNpcMemo, filterRows, defaultPrefs } from '../../../src/ui/views/npc/npcData.ts';
import { computeNpcFlips } from '../../../src/domain/npc.ts';
import rawBazaar from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';

const snapshot: Snapshot = toSnapshot(validateRaw(rawBazaar as unknown), Date.now(), 'fixture');
const catalog: Catalog = catalogFromFile(catalogJson as unknown as CatalogFile);

const history: HistoryRepo = {
  init: async () => {},
  record: async () => {},
  series: async () => [],
  recent: () => [],
  stats: () => null,
  saveLatest: async () => {},
  loadLatest: async () => null,
};

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext;

const flush = () => new Promise((r) => setTimeout(r, 30));
const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const rowIds = () => [...root.querySelectorAll<HTMLTableRowElement>('tbody tr[data-key]')].map((tr) => tr.dataset.key!.split(':')[1]!);
const dirBtn = (d: string) => q<HTMLButtonElement>(`[data-dir="${d}"]`);
const setInput = (el: HTMLInputElement, v: string) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

function mount(state: Partial<AppState> = { snapshot, catalog }): void {
  store = createStore<AppState>({ ...initialState({ ...defaultSettings }), ...state });
  ctx = { store, history, navigate: vi.fn(), t: (k) => k, refresh: async () => {} };
  view = createNpcView();
  view.mount(root, ctx, { id: 'npc' });
}

beforeEach(() => {
  localStorage.clear();
  setLang('tr');
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  view?.unmount();
  document.body.innerHTML = '';
  setLang('tr');
});

describe('npc view', () => {
  it('renders bz2npc rows by default, sorted by profit/hour, suspects hidden', async () => {
    mount();
    await flush();
    expect(dirBtn('bz2npc').getAttribute('aria-pressed')).toBe('true');
    const ids = rowIds();
    expect(ids).toContain('ENCHANTED_GOLD');
    expect(ids).toContain('ENCHANTED_GOLD_BLOCK');
    expect(ids[0]).toBe('ENCHANTED_GOLD_BLOCK');
    // suspect rows (dead 0.1 bid on GOLD_INGOT etc.) hidden by default
    expect(ids).not.toContain('GOLD_INGOT');
    const btn = q<HTMLButtonElement>('[data-testid="npc-hidden"]');
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toMatch(/gizli/);
    // the enchanted gold row: buy 456 via buy order, sell 480 to NPC
    const tr = q(`tr[data-key="bz2npc:ENCHANTED_GOLD"]`);
    expect(tr.textContent).toContain('456');
    expect(tr.textContent).toContain('480');
    expect(tr.querySelector('.src-order')).not.toBeNull();
    expect(tr.querySelector('.src-npc')).not.toBeNull();
    expect(q('.npc-note').textContent).toMatch(/limit/i);
    expect(root.querySelectorAll('input[data-filter]').length).toBe(2);
  });

  it('reveals hidden suspect rows with the hidden-count button (floored buy hint shown)', async () => {
    mount();
    await flush();
    q<HTMLButtonElement>('[data-testid="npc-hidden"]').click();
    await flush();
    expect(rowIds()).toContain('GOLD_INGOT');
    const tr = q(`tr[data-key="bz2npc:GOLD_INGOT"]`);
    expect(tr.querySelector('.npc-floor')).not.toBeNull(); // bid 0.1 -> assumed 0.9 x NPC 3 = 2.7
    expect(tr.textContent).toContain('2,7');
    expect(tr.classList.contains('npc-suspect')).toBe(true);
  });

  it('direction toggle switches to npc2bz rows and persists', async () => {
    mount({ snapshot, catalog, settings: { ...defaultSettings, hideSuspicious: false } });
    await flush();
    const before = rowIds();
    expect(before).toContain('ENCHANTED_GOLD');
    dirBtn('npc2bz').click();
    await flush();
    expect(dirBtn('npc2bz').getAttribute('aria-pressed')).toBe('true');
    const ids = rowIds().sort();
    expect(ids).toEqual(['MELON', 'WHEAT']);
    const melon = q('tr[data-key="npc2bz:MELON"]');
    expect(melon.querySelector('.src-npc')).not.toBeNull();
    expect(melon.textContent).toMatch(/Sell offer/);
    expect(JSON.parse(localStorage.getItem(LS_VIEWPREFS + 'npc')!).dir).toBe('npc2bz');

    // remount restores direction
    view.unmount();
    view = createNpcView();
    view.mount(root, ctx, { id: 'npc' });
    await flush();
    expect(rowIds().sort()).toEqual(['MELON', 'WHEAT']);
  });

  it('filters by search, min margin and min profit/hour', async () => {
    mount();
    await flush();
    const search = q<HTMLInputElement>('[data-testid="npc-search"]');
    setInput(search, 'gold');
    await flush();
    expect(rowIds().every((id) => id.includes('GOLD'))).toBe(true);
    expect(rowIds().length).toBeGreaterThan(0);
    setInput(search, '');
    const margin = q<HTMLInputElement>('input[data-filter="minMargin"]');
    setInput(margin, '5');
    await flush();
    expect(rowIds()).toContain('ENCHANTED_GOLD'); // 5.3%
    expect(rowIds()).not.toContain('ENCHANTED_DIAMOND'); // 2.9%
    setInput(margin, '0');
    const pph = q<HTMLInputElement>('input[data-filter="minPph"]');
    setInput(pph, '200000');
    await flush();
    expect(rowIds()).toContain('ENCHANTED_GOLD_BLOCK');
    expect(rowIds()).not.toContain('ENCHANTED_SUGAR');
    setInput(pph, '1e12');
    await flush();
    expect(rowIds()).toEqual([]);
    expect(q('td.empty').textContent).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem(LS_VIEWPREFS + 'npc')!);
    expect(saved.minPph).toBe(1e12);
  });

  it('row click navigates to the item view', async () => {
    mount();
    await flush();
    q<HTMLElement>('tr[data-key="bz2npc:ENCHANTED_GOLD"] td.num').click();
    expect(ctx.navigate).toHaveBeenCalledWith({ id: 'item', param: 'ENCHANTED_GOLD' });
  });

  it('shows loading / catalog error / waiting states', async () => {
    mount({ snapshot, catalog: null });
    await flush();
    expect(q('.npc-state').hidden).toBe(false);
    expect(q('.npc-state').textContent).toMatch(/katalog/i);
    expect(root.querySelector('.tbl')!.hasAttribute('hidden')).toBe(true);
    store.set({ catalogError: 'boom' });
    await flush();
    expect(q('.npc-state').className).toContain('banner-err');
    expect(q('.npc-state').textContent).toContain('boom');
    store.set({ catalog, catalogError: null, snapshot: null });
    await flush();
    expect(q('.npc-state').textContent).toBe('Fiyat verisi bekleniyor…');
    store.set({ snapshot });
    await flush();
    expect(q('.npc-state').hidden).toBe(true);
    expect(rowIds().length).toBeGreaterThan(0);
  });

  it('switches language live', async () => {
    mount();
    await flush();
    expect(q('h2').textContent).toBe('NPC flip');
    expect(q('th').textContent).toContain('Ürün');
    setLang('en');
    await flush();
    expect(q('th').textContent).toContain('Item');
    expect(q('.npc-note').textContent).toContain('Important');
  });

  it('unmount cleans up and stops reacting to the store', async () => {
    mount();
    await flush();
    view.unmount();
    expect(root.childElementCount).toBe(0);
    store.set({ snapshot: { ...snapshot } });
    setLang('en');
    await flush();
    expect(root.childElementCount).toBe(0);
  });

  it('has TR/EN key parity', () => {
    const k = dictKeys('npc');
    expect(k.tr.length).toBeGreaterThan(10);
    expect(k.en).toEqual(k.tr);
  });
});

describe('npc helpers', () => {
  it('memoizes by snapshot/catalog/settings fields', () => {
    const spy = vi.fn(computeNpcFlips);
    const memo = createNpcMemo(spy);
    const c = { snap: snapshot, catalog, settings: defaultSettings };
    const a = memo(c, 0);
    expect(memo({ ...c, settings: { ...defaultSettings, lang: 'en' } }, 0)).toBe(a);
    expect(spy).toHaveBeenCalledTimes(1);
    memo({ ...c, settings: { ...defaultSettings, costMode: 'insta' } }, 0);
    memo({ ...c, settings: { ...defaultSettings, costMode: 'insta' } }, 1);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('filters by direction and counts suspects', () => {
    const rows = computeNpcFlips({ snap: snapshot, catalog, settings: defaultSettings });
    const p = { ...defaultPrefs(), dir: 'npc2bz' as const };
    const hidden = filterRows(rows, p, catalog, true);
    expect(hidden.rows).toEqual([]);
    expect(hidden.total).toBe(2);
    expect(hidden.suspect).toBe(2);
    const shown = filterRows(rows, { ...p, showHidden: true }, catalog, true);
    expect(shown.rows.map((r) => r.id).sort()).toEqual(['MELON', 'WHEAT']);
    expect(shown.rows.every((r) => r.direction === 'npc2bz')).toBe(true);
  });
});
