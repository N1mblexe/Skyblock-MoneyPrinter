// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bazaarRaw from '../../fixtures/bazaar.json';
import catalogRaw from '../../fixtures/catalog.json';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { catalogFromFile } from '../../../src/data/catalog.ts';
import { dictKeys, setLang, t } from '../../../src/i18n/index.ts';
import '../../../src/i18n/common.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AppState, CatalogFile, FusionRecipe, HistoryRepo, Store, ViewContext } from '../../../src/types/contracts.ts';
import { fmtCoins } from '../../../src/ui/format.ts';
import { createFusionView } from '../../../src/ui/views/fusion/fusionView.ts';
import { itemSuggestions } from '../../../src/ui/views/fusion/fusionCalc.ts';

const snap = toSnapshot(validateRaw(bazaarRaw), 1_700_000_000_000, 'fixture');
const catalog = catalogFromFile(catalogRaw as unknown as CatalogFile);

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
let view: ReturnType<typeof createFusionView>;

const flush = () => new Promise((r) => setTimeout(r, 40));
const rowsEls = () => [...root.querySelectorAll<HTMLElement>('.fu-row')];
const field = (row: number, f: string) => rowsEls()[row]!.querySelector<HTMLInputElement>(`[data-f="${f}"]`)!;
const stat = (row: number, k: string) => rowsEls()[row]!.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
function type(el: HTMLInputElement, v: string) {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const RECIPE: FusionRecipe = { a: 'SHARD_SALMON', qa: 2, b: 'Wiki Tiki Shard', qb: 1, out: 'shard_beeheemoth', qo: 1 };

function mount(state: Partial<AppState> = {}) {
  store = createStore<AppState>({ ...initialState({ ...defaultSettings }), snapshot: snap, catalog, ...state });
  const ctx: ViewContext = { store, history, navigate: vi.fn(), t, refresh: vi.fn(async () => {}) };
  view = createFusionView();
  view.mount(root, ctx, { id: 'fusion' });
}

beforeEach(() => {
  setLang('tr');
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  view?.unmount();
  document.body.innerHTML = '';
  setLang('tr');
});

describe('fusion view', () => {
  it('has identical TR/EN keys', () => {
    const k = dictKeys('fusion');
    expect(k.tr.length).toBeGreaterThan(10);
    expect(k.en).toEqual(k.tr);
  });

  it('shows an empty state and adds a recipe', async () => {
    mount();
    await flush();
    expect(root.querySelector('.fu-empty')).not.toBeNull();
    expect(rowsEls()).toHaveLength(0);
    root.querySelector<HTMLButtonElement>('.fu-add')!.click();
    expect(store.get().fusion).toEqual([{ a: '', qa: 1, b: '', qb: 1, out: '', qo: 1 }]);
    expect(rowsEls()).toHaveLength(1);
    expect(root.querySelector('.fu-empty')).toBeNull();
    await flush();
    expect(rowsEls()[0]!.querySelector('.fu-msg')!.textContent).toBe(t('fusion.incomplete'));
  });

  it('editing inputs updates store.fusion', async () => {
    mount({ fusion: [{ ...RECIPE }] });
    await flush();
    type(field(0, 'a'), 'Salmon Shard');
    expect(store.get().fusion[0]!.a).toBe('Salmon Shard');
    type(field(0, 'qb'), '3');
    expect(store.get().fusion[0]!.qb).toBe(3);
    // invalid qty is not stored; restored on change
    type(field(0, 'qo'), '0');
    expect(store.get().fusion[0]!.qo).toBe(1);
    expect(field(0, 'qo').getAttribute('aria-invalid')).toBe('true');
    field(0, 'qo').dispatchEvent(new Event('change'));
    expect(field(0, 'qo').value).toBe('1');
  });

  it('computes cost, value, profit and margin for a fixture recipe', async () => {
    mount({ fusion: [{ ...RECIPE }] });
    await flush();
    // order/offer mode, tax 1.25%: salmon bid 1440.2 -> 1440.3, wiki tiki bid 16246.9 -> 16247, beeheemoth ask 94782.3 -> 94782.2
    const cost = 2 * 1440.3 + 16247;
    const value = 94782.2 * (1 - 0.0125);
    expect(Number(stat(0, 'cost').dataset.raw)).toBeCloseTo(cost, 6);
    expect(Number(stat(0, 'value').dataset.raw)).toBeCloseTo(value, 6);
    expect(Number(stat(0, 'profit').dataset.raw)).toBeCloseTo(value - cost, 6);
    expect(Number(stat(0, 'margin').dataset.raw)).toBeCloseTo((value - cost) / cost, 9);
    expect(stat(0, 'cost').textContent).toBe(fmtCoins(cost));
    expect(stat(0, 'profit').classList.contains('pos')).toBe(true);
    const units = rowsEls()[0]!.querySelectorAll('.fu-unit');
    expect(units[0]!.textContent).toContain('Salmon Shard');
    expect(units[0]!.textContent).toContain(fmtCoins(1440.3));
    expect(units[1]!.textContent).toContain('SHARD_WIKI_TIKI');
    expect(units[2]!.textContent).toContain(fmtCoins(94782.2));
    expect(rowsEls()[0]!.querySelector('.fu-missing')).toBeNull();

    // settings change recomputes (insta-sell = walk bids)
    store.set({ settings: { ...store.get().settings, sellMode: 'insta' } });
    await flush();
    expect(Number(stat(0, 'value').dataset.raw)).toBeCloseTo(67465.2 * (1 - 0.0125), 6);
  });

  it('shows a missing state for unknown items', async () => {
    mount({ fusion: [{ ...RECIPE, b: 'SHARD_DOES_NOT_EXIST' }] });
    await flush();
    const missing = rowsEls()[0]!.querySelector('.fu-missing')!;
    expect(missing.textContent).toBe(t('fusion.missing', { ids: 'SHARD_DOES_NOT_EXIST' }));
    expect(stat(0, 'margin').textContent).toBe('—');
    expect(stat(0, 'cost').textContent).toBe('—');
    expect(stat(0, 'profit').textContent).toBe('—');
    expect(rowsEls()[0]!.querySelectorAll('.fu-unit')[1]!.textContent).toBe(t('fusion.notFound'));
  });

  it('keeps editor elements (and focus) across snapshot updates', async () => {
    mount({ fusion: [{ ...RECIPE }] });
    await flush();
    const input = field(0, 'a');
    input.focus();
    type(input, 'Salmon Sha');
    expect(document.activeElement).toBe(input);
    const before = Number(stat(0, 'value').dataset.raw);
    const products = { ...snap.products };
    const bee = products.SHARD_BEEHEEMOTH!;
    products.SHARD_BEEHEEMOTH = { ...bee, ask: 100_000.1 };
    store.set({ snapshot: { ...snap, products, lastUpdated: snap.lastUpdated + 60_000 } });
    await flush();
    expect(field(0, 'a')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Salmon Sha');
    expect(Number(stat(0, 'value').dataset.raw)).not.toBe(before);
    expect(Number(stat(0, 'value').dataset.raw)).toBeCloseTo(100_000 * (1 - 0.0125), 6);
  });

  it('deletes a recipe without rebuilding the others', async () => {
    mount({ fusion: [{ ...RECIPE }, { ...RECIPE, qa: 5 }, { ...RECIPE, qa: 7 }] });
    await flush();
    const third = field(2, 'qa');
    rowsEls()[0]!.querySelector<HTMLButtonElement>('.fu-del')!.click();
    expect(store.get().fusion.map((r) => r.qa)).toEqual([5, 7]);
    expect(field(1, 'qa')).toBe(third);
    expect(rowsEls()[0]!.querySelector('.fu-title')!.textContent).toBe(t('fusion.recipeN', { n: 1 }));
  });

  it('handles a missing catalog: still editable, results show the state', async () => {
    mount({ catalog: null, fusion: [{ ...RECIPE }] });
    await flush();
    expect(root.querySelector('.banner')!.textContent).toBe(t('fusion.catalogLoading'));
    type(field(0, 'qa'), '4');
    expect(store.get().fusion[0]!.qa).toBe(4);
    expect(stat(0, 'cost').textContent).toBe('—');
    store.set({ catalogError: 'boom' });
    await flush();
    expect(root.querySelector('.banner-err')!.textContent).toContain('boom');
    store.set({ catalog, catalogError: null });
    await flush();
    expect(Number(stat(0, 'cost').dataset.raw)).toBeCloseTo(4 * 1440.3 + 16247, 6);
  });

  it('shows a waiting message without a snapshot', async () => {
    mount({ snapshot: null, fusion: [{ ...RECIPE }] });
    await flush();
    expect(root.querySelector('.banner')!.textContent).toBe(t('common.waitingData'));
  });

  it('suggests shards first and feeds the datalist', async () => {
    const s = itemSuggestions(catalog, '', 30);
    expect(s.slice(0, 3).every((i) => i.id.startsWith('SHARD_'))).toBe(true);
    expect(s.every((i) => i.bazaar)).toBe(true);
    mount({ fusion: [{ ...RECIPE }] });
    await flush();
    const input = field(0, 'b');
    type(input, 'wiki');
    const dl = root.querySelector('datalist')!;
    expect(input.getAttribute('list')).toBe(dl.id);
    expect([...dl.querySelectorAll('option')].map((o) => o.value)).toContain('Wiki Tiki Shard');
  });

  it('quick add creates a recipe with the shard as output', async () => {
    mount();
    await flush();
    const sel = root.querySelector<HTMLSelectElement>('.fu-quick')!;
    expect(sel.options.length).toBe(4);
    expect(sel.options[1]!.value).toBe('Beeheemoth Shard');
    sel.value = 'Beeheemoth Shard';
    sel.dispatchEvent(new Event('change'));
    expect(store.get().fusion).toEqual([{ a: '', qa: 1, b: '', qb: 1, out: 'Beeheemoth Shard', qo: 1 }]);
  });

  it('re-renders on language change and cleans up on unmount', async () => {
    mount({ fusion: [{ ...RECIPE }] });
    await flush();
    setLang('en');
    await flush();
    expect(root.querySelector('.fu-add')!.textContent).toBe('Add recipe');
    expect(stat(0, 'cost').dataset.raw).toBeDefined();
    view.unmount();
    expect(root.childElementCount).toBe(0);
    store.set({ fusion: [] });
    setLang('tr');
    await flush();
    expect(root.childElementCount).toBe(0);
  });
});
