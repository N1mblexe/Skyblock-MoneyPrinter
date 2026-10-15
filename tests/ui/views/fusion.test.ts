// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bazaarRaw from '../../fixtures/bazaar.json';
import catalogRaw from '../../fixtures/catalog.json';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_FUSION, LS_LEGACY_FUSION } from '../../../src/config.ts';
import { catalogFromFile } from '../../../src/data/catalog.ts';
import { setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import { loadFusion, migrateLegacy } from '../../../src/storage/local.ts';
import type { AppState, Catalog, CatalogFile, FusionRecipe, FusionRow, Store, ViewContext } from '../../../src/types/contracts.ts';
import { fmtCoins } from '../../../src/ui/format.ts';
import { displayOrder, itemSuggestions } from '../../../src/ui/views/fusion/fusionCalc.ts';
import { exportFileName, parseRecipesJson, recipesToJson } from '../../../src/ui/views/fusion/fusionIo.ts';
import { createFusionView } from '../../../src/ui/views/fusion/fusionView.ts';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';

const snap = toSnapshot(validateRaw(bazaarRaw), 1_700_000_000_000, 'fixture');
const catalog = catalogFromFile(catalogRaw as unknown as CatalogFile);

let store: Store<AppState>;
let root: HTMLElement;
let ctx: ViewContext;
let view: ReturnType<typeof createFusionView>;

const flush = () => new Promise((r) => setTimeout(r, 40));
const rowsEls = () => [...root.querySelectorAll<HTMLElement>('.fu-row')];
/** recipe numbers (1-based store index) in display order */
const order = () => rowsEls().map((r) => Number(r.querySelector('.fu-num')!.textContent));
const rowByNum = (n: number) => rowsEls().find((r) => r.querySelector('.fu-num')!.textContent === String(n))!;
const field = (row: number, f: string) => rowsEls()[row]!.querySelector<HTMLInputElement>(`[data-f="${f}"]`)!;
const stat = (row: number, k: string) => rowsEls()[row]!.querySelector<HTMLElement>(`[data-k="${k}"]`)!;
const act = (row: number, a: string) => rowsEls()[row]!.querySelector<HTMLButtonElement>(`[data-act="${a}"]`)!;
const btn = (cls: string) => root.querySelector<HTMLButtonElement>(`.${cls}`)!;
function type(el: HTMLInputElement, v: string) {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
/** happy-dom has no window.confirm */
function stubConfirm(answer: boolean) {
  const fn = vi.fn(() => answer);
  Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: fn });
  return fn;
}
function setSort(v: string) {
  const sel = root.querySelector<HTMLSelectElement>('[data-testid="fusion-sort"]')!;
  sel.value = v;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

const RECIPE: FusionRecipe = { a: 'SHARD_SALMON', qa: 2, b: 'Wiki Tiki Shard', qb: 1, out: 'shard_beeheemoth', qo: 1 };

function mount(state: Partial<AppState> = {}, query?: Record<string, string>) {
  store = createStore<AppState>({ ...initialState({ ...defaultSettings }), snapshot: snap, catalog, ...state });
  ctx = fakeViewCtx(store, fakeHistory(), { t });
  view = createFusionView();
  view.mount(root, ctx, { id: 'fusion', query });
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
  vi.restoreAllMocks();
});

describe('fusion view: editing', () => {

  it('shows an empty state, an h1 and adds a recipe', async () => {
    mount();
    await flush();
    expect(root.querySelector('h1')!.textContent).toBe('Shard fusion');
    expect(root.querySelector('.fu-empty')).not.toBeNull();
    expect(btn('fu-export').disabled).toBe(true);
    btn('fu-add').click();
    expect(store.get().fusion).toEqual([{ a: '', qa: 1, b: '', qb: 1, out: '', qo: 1 }]);
    expect(rowsEls()).toHaveLength(1);
    expect(root.querySelector('.fu-empty')).toBeNull();
    expect(document.activeElement).toBe(field(0, 'a'));
    await flush();
    expect(rowsEls()[0]!.querySelector('.fu-msg')!.textContent).toBe(t('fusion.incomplete'));
    expect(field(0, 'a').getAttribute('aria-label')).toBe('Tarif 1: Girdi 1');
  });

  it('editing inputs updates store.fusion', async () => {
    mount({ fusion: [{ ...RECIPE }] });
    await flush();
    type(field(0, 'a'), 'Salmon Shard');
    expect(store.get().fusion[0]!.a).toBe('Salmon Shard');
    type(field(0, 'qb'), '3');
    expect(store.get().fusion[0]!.qb).toBe(3);
    type(field(0, 'qo'), '0');
    expect(store.get().fusion[0]!.qo).toBe(1);
    expect(field(0, 'qo').getAttribute('aria-invalid')).toBe('true');
    field(0, 'qo').dispatchEvent(new Event('change'));
    expect(field(0, 'qo').value).toBe('1');
  });

  it('shows cost, value, profit, margin, profit/hour and risk from derived.fusion()', async () => {
    mount({ fusion: [{ ...RECIPE }] });
    await flush();
    const cost = 2 * 1440.3 + 16247;
    const value = 94782.2 * (1 - 0.0125);
    expect(Number(stat(0, 'cost').dataset.raw)).toBeCloseTo(cost, 6);
    expect(Number(stat(0, 'value').dataset.raw)).toBeCloseTo(value, 6);
    expect(Number(stat(0, 'profit').dataset.raw)).toBeCloseTo(value - cost, 6);
    expect(Number(stat(0, 'margin').dataset.raw)).toBeCloseTo((value - cost) / cost, 9);
    expect(stat(0, 'cost').textContent).toBe(fmtCoins(cost));
    expect(stat(0, 'profit').classList.contains('pos')).toBe(true);
    const row: FusionRow = ctx.derived.fusion()[0]!;
    expect(row.tp).toBeDefined();
    expect(Number(stat(0, 'pph').dataset.raw)).toBeCloseTo(row.profitPerHour!, 6);
    expect(stat(0, 'pph').textContent).toBe(fmtCoins(row.profitPerHour));
    expect(rowsEls()[0]!.querySelector('.fu-s-pph')!.getAttribute('title')).toContain(t(`fusion.lim_${row.tp!.limitedBy}`));
    expect(stat(0, 'risk').querySelector(`.badge.risk-${row.risk!.level}`)).not.toBeNull();
    const subs = rowsEls()[0]!.querySelectorAll('.fu-sub');
    expect(subs[0]!.textContent).toContain('Salmon Shard');
    expect(subs[0]!.textContent).toContain(fmtCoins(1440.3));
    expect(subs[2]!.textContent).toContain(fmtCoins(94782.2));
    // settings change recomputes
    store.set({ settings: { ...store.get().settings, sellMode: 'insta' } });
    await flush();
    expect(Number(stat(0, 'value').dataset.raw)).toBeCloseTo(67465.2 * (1 - 0.0125), 6);
  });

  it('shows a missing state for unknown items', async () => {
    mount({ fusion: [{ ...RECIPE, b: 'SHARD_DOES_NOT_EXIST' }] });
    await flush();
    expect(rowsEls()[0]!.querySelector('.fu-missing')!.textContent).toBe(t('fusion.missing', { ids: 'SHARD_DOES_NOT_EXIST' }));
    expect(stat(0, 'margin').textContent).toBe('—');
    expect(stat(0, 'pph').textContent).toBe('—');
    expect(rowsEls()[0]!.querySelectorAll('.fu-sub')[1]!.textContent).toBe(t('fusion.notFound'));
    expect(rowsEls()[0]!.classList.contains('fu-row-missing')).toBe(true);
  });

  it('keeps editor elements (and focus) across snapshot updates', async () => {
    mount({ fusion: [{ ...RECIPE }] });
    await flush();
    const input = field(0, 'a');
    input.focus();
    type(input, 'Salmon Sha');
    const products = { ...snap.products };
    products.SHARD_BEEHEEMOTH = { ...products.SHARD_BEEHEEMOTH!, ask: 100_000.1 };
    store.set({ snapshot: { ...snap, products, lastUpdated: snap.lastUpdated + 60_000 } });
    await flush();
    expect(field(0, 'a')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Salmon Sha');
    expect(Number(stat(0, 'value').dataset.raw)).toBeCloseTo(100_000 * (1 - 0.0125), 6);
  });

  it('duplicates, moves and deletes rows (DOM of the others kept)', async () => {
    mount({ fusion: [{ ...RECIPE }, { ...RECIPE, qa: 5 }, { ...RECIPE, qa: 7 }] });
    await flush();
    const third = field(2, 'qa');
    act(0, 'dup').click();
    expect(store.get().fusion.map((r) => r.qa)).toEqual([2, 2, 5, 7]);
    expect(field(3, 'qa')).toBe(third);
    expect(document.activeElement).toBe(act(1, 'dup'));
    // move: first row's up is disabled, last row's down too
    expect(act(0, 'up').disabled).toBe(true);
    expect(act(3, 'down').disabled).toBe(true);
    act(3, 'up').click();
    expect(store.get().fusion.map((r) => r.qa)).toEqual([2, 2, 7, 5]);
    expect(field(2, 'qa')).toBe(third);
    expect(document.activeElement).toBe(act(2, 'up'));
    act(2, 'down').click();
    expect(store.get().fusion.map((r) => r.qa)).toEqual([2, 2, 5, 7]);
    act(0, 'del').click();
    expect(store.get().fusion.map((r) => r.qa)).toEqual([2, 5, 7]);
    expect(field(2, 'qa')).toBe(third);
    expect(order()).toEqual([1, 2, 3]);
    expect(act(0, 'del').getAttribute('aria-label')).toBe(t('fusion.delAria', { n: 1 }));
  });

  it('clear all asks for confirmation', async () => {
    mount({ fusion: [{ ...RECIPE }, { ...RECIPE, qa: 5 }] });
    await flush();
    const confirm = stubConfirm(false);
    btn('fu-clear').click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(store.get().fusion).toHaveLength(2);
    confirm.mockReturnValue(true);
    btn('fu-clear').click();
    expect(store.get().fusion).toEqual([]);
    expect(root.querySelector('.fu-empty')).not.toBeNull();
    expect(ctx.toast).toHaveBeenCalledWith(t('fusion.cleared'), 'ok');
  });
});

describe('fusion view: sorting', () => {
  // qa=1 is the more profitable recipe (cheaper inputs, same output)
  const two = (): FusionRecipe[] => [{ ...RECIPE, qa: 2 }, { ...RECIPE, qa: 1 }];

  it('sorts by profit / profit per hour / margin and back to manual; moves only in manual', async () => {
    mount({ fusion: two() });
    await flush();
    expect(order()).toEqual([1, 2]);
    setSort('profit');
    await flush();
    expect(ctx.setQuery).toHaveBeenCalledWith({ sort: 'profit' });
    expect(order()).toEqual([2, 1]);
    expect(act(0, 'up').disabled).toBe(true);
    expect(act(0, 'down').disabled).toBe(true);
    expect(act(0, 'down').title).toBe(t('fusion.moveManualOnly'));
    setSort('margin');
    await flush();
    expect(order()).toEqual([2, 1]);
    setSort('pph');
    await flush();
    const res = ctx.derived.fusion();
    expect(order()[0]).toBe(res[0]!.profitPerHour! >= res[1]!.profitPerHour! ? 1 : 2);
    setSort('manual');
    await flush();
    expect(order()).toEqual([1, 2]);
  });

  it('does not reorder while the user types; reorders after leaving the field', async () => {
    mount({ fusion: two() }, { sort: 'profit' });
    await flush();
    expect(order()).toEqual([2, 1]);
    const input = rowByNum(2).querySelector<HTMLInputElement>('[data-f="qa"]')!;
    input.focus();
    type(input, '100'); // recipe 2 becomes a heavy loss
    await flush();
    expect(Number(rowByNum(2).querySelector<HTMLElement>('[data-k="profit"]')!.dataset.raw)).toBeLessThan(0);
    expect(order()).toEqual([2, 1]); // unchanged while typing
    expect(document.activeElement).toBe(input);
    expect(root.querySelector<HTMLElement>('.fu-sort-hint')!.hidden).toBe(false);
    // moving to another field of the list still counts as typing
    const other = rowByNum(1).querySelector<HTMLInputElement>('[data-f="qb"]')!;
    other.focus();
    await flush();
    expect(order()).toEqual([2, 1]);
    // leaving the list applies the pending order
    btn('fu-add').closest('.fu-toolbar')!.querySelector<HTMLSelectElement>('select.fu-sort')!.focus();
    await flush();
    expect(order()).toEqual([1, 2]);
    expect(root.querySelector<HTMLElement>('.fu-sort-hint')!.hidden).toBe(true);
  });

  it('reads the sort mode from the URL (update)', async () => {
    mount({ fusion: two() });
    await flush();
    view.update!({ id: 'fusion', query: { sort: 'profit' } });
    await flush();
    expect(root.querySelector<HTMLSelectElement>('[data-testid="fusion-sort"]')!.value).toBe('profit');
    expect(order()).toEqual([2, 1]);
  });
});

describe('fusion view: import / export', () => {
  it('copy JSON → clear → import round trip', async () => {
    const recipes = [{ ...RECIPE }, { ...RECIPE, a: 'Salmon Shard', qa: 3 }];
    mount({ fusion: recipes });
    await flush();
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async (s: string) => void (copied = s)) },
    });
    btn('fu-copy').click();
    await flush();
    expect(ctx.toast).toHaveBeenCalledWith(t('common.copied'), 'ok');
    expect(JSON.parse(copied)).toEqual(recipes);
    stubConfirm(true);
    btn('fu-clear').click();
    expect(store.get().fusion).toEqual([]);

    btn('fu-import').click();
    const text = document.querySelector<HTMLTextAreaElement>('[data-testid="fusion-import-text"]')!;
    expect(text).not.toBeNull();
    text.value = copied;
    document.querySelector<HTMLButtonElement>('[data-testid="fusion-import-go"]')!.click();
    expect(store.get().fusion).toEqual(recipes);
    expect(rowsEls()).toHaveLength(2);
    expect(ctx.toast).toHaveBeenCalledWith(t('fusion.importOk', { n: 2 }), 'ok');
  });

  it('download JSON writes a blob with the recipes', async () => {
    mount({ fusion: [{ ...RECIPE }] });
    await flush();
    let blob: Blob | null = null;
    const create = vi.fn((b: Blob) => ((blob = b), 'blob:x'));
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    btn('fu-export').click();
    expect(create).toHaveBeenCalledOnce();
    expect(JSON.parse(await blob!.text())).toEqual([RECIPE]);
    expect(exportFileName(new Date(2026, 0, 2, 3, 4))).toBe('fusion-recipes-20260102-0304.json');
  });

  it('imports the legacy {a, aq, b, bq, out, oq} shape, appending or replacing, and reports errors', async () => {
    mount({ fusion: [{ ...RECIPE }] });
    await flush();
    btn('fu-import').click();
    const text = document.querySelector<HTMLTextAreaElement>('[data-testid="fusion-import-text"]')!;
    const go = document.querySelector<HTMLButtonElement>('[data-testid="fusion-import-go"]')!;
    const err = document.querySelector<HTMLElement>('.fu-imp-err')!;
    text.value = '{oops';
    go.click();
    expect(err.textContent).toMatch(/^JSON okunamadı/);
    text.value = '{"x": 1}';
    go.click();
    expect(err.textContent).toBe(t('fusion.importErrShape'));
    text.value = '[{"a": "X"}]';
    go.click();
    expect(err.textContent).toBe(t('fusion.importErrEmpty'));
    expect(store.get().fusion).toHaveLength(1);

    text.value = JSON.stringify([{ a: 'SHARD_SALMON', aq: 4, b: 'SHARD_WIKI_TIKI', bq: 1, out: 'SHARD_BEEHEEMOTH', oq: 1 }, { bad: true }]);
    go.click();
    expect(store.get().fusion).toEqual([{ ...RECIPE }, { a: 'SHARD_SALMON', qa: 4, b: 'SHARD_WIKI_TIKI', qb: 1, out: 'SHARD_BEEHEEMOTH', qo: 1 }]);
    expect(ctx.toast).toHaveBeenCalledWith('1 tarif içe aktarıldı, 1 geçersiz kayıt atlandı.', 'warn');

    btn('fu-import').click();
    document.querySelector<HTMLInputElement>('input[type=radio][value=replace]')!.checked = true;
    text.value = JSON.stringify({ recipes: [{ ...RECIPE, qo: 2 }] });
    go.click();
    expect(store.get().fusion).toEqual([{ ...RECIPE, qo: 2 }]);
    await flush();
    expect(Number(stat(0, 'value').dataset.raw)).toBeGreaterThan(0);
  });

  it('parses recipe JSON like loadFusion', () => {
    expect(parseRecipesJson('[]')).toEqual({ ok: false, error: 'empty' });
    expect(parseRecipesJson('"x"')).toEqual({ ok: false, error: 'shape' });
    const legacy = { 'bazaarMasasi.recipes': [{ a: 'A', aq: 1, b: 'B', bq: 2, out: 'C', oq: 3 }] };
    expect(parseRecipesJson(JSON.stringify(legacy))).toEqual({ ok: true, recipes: [{ a: 'A', qa: 1, b: 'B', qb: 2, out: 'C', qo: 3 }], skipped: 0 });
    const r = parseRecipesJson(JSON.stringify([{ ...RECIPE, qa: 0 }, { ...RECIPE, qa: 'x' }, RECIPE]));
    expect(r).toEqual({ ok: true, recipes: [RECIPE], skipped: 2 });
    expect(parseRecipesJson('﻿' + recipesToJson([RECIPE]))).toEqual({ ok: true, recipes: [RECIPE], skipped: 0 });
    // what we export is what the app stores and loads back
    localStorage.setItem(LS_FUSION, recipesToJson([RECIPE]));
    expect(loadFusion()).toEqual([RECIPE]);
  });

  it('the lead migration still converts the legacy storage key', () => {
    localStorage.setItem(LS_LEGACY_FUSION, JSON.stringify([{ a: 'A', aq: 1, b: 'B', bq: 2, out: 'C', oq: 3 }]));
    migrateLegacy();
    expect(loadFusion()).toEqual([{ a: 'A', qa: 1, b: 'B', qb: 2, out: 'C', qo: 3 }]);
  });
});

describe('fusion view: chips, states, lifecycle', () => {
  it('renders shard chips (rarity, family, alignment) from catalog metadata', async () => {
    const items = { ...catalog.items };
    items.SHARD_SALMON = { ...items.SHARD_SALMON!, shard: { rarity: 'RARE', family: ['Elemental', 'Fish'], alignment: 'Water' } };
    items.SHARD_BEEHEEMOTH = { ...items.SHARD_BEEHEEMOTH!, shard: { rarity: 'LEGENDARY', family: [] } };
    const cat: Catalog = { ...catalog, items };
    mount({ catalog: cat, fusion: [{ ...RECIPE }] });
    await flush();
    const subs = rowsEls()[0]!.querySelectorAll('.fu-sub');
    const a = subs[0]!;
    expect(a.querySelector('.fu-chip.fu-r-rare')!.textContent).toBe('Rare');
    expect([...a.querySelectorAll('.fu-fam')].map((c) => c.textContent)).toEqual(['Elemental', 'Fish']);
    expect(a.querySelector('.fu-align')!.textContent).toBe('Water');
    expect(subs[1]!.querySelector('.fu-chip')).toBeNull(); // no metadata for Wiki Tiki here
    expect(subs[2]!.querySelector('.fu-r-legendary')!.textContent).toBe('Legendary');
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
    btn('fu-import').click();
    document.querySelector<HTMLButtonElement>('.kit-drawer .btn:not(.btn-primary):not(.kit-x)')!.click();
    setLang('en');
    await flush();
    expect(btn('fu-add').textContent).toBe('Add recipe');
    expect(root.querySelector('h1')!.textContent).toBe('Shard fusion');
    expect(field(0, 'a').getAttribute('aria-label')).toBe('Recipe 1: Input 1');
    expect(stat(0, 'cost').dataset.raw).toBeDefined();
    view.unmount();
    expect(root.childElementCount).toBe(0);
    expect(document.querySelector('.kit-drawer')).toBeNull();
    store.set({ fusion: [] });
    setLang('tr');
    await flush();
    expect(root.childElementCount).toBe(0);
  });

  it('displayOrder: manual keeps order; others descending, nulls last, stable', () => {
    const r = (profit: number | null, margin: number | null = null, pph?: number) =>
      ({ recipe: RECIPE, cost: 1, value: 1, profit, margin, missing: [], profitPerHour: pph }) as FusionRow;
    const rows = [r(1, 0.1, 5), null, r(3, 0.05), r(3, 0.2, 9)];
    expect(displayOrder(rows, 'manual')).toEqual([0, 1, 2, 3]);
    expect(displayOrder(rows, 'profit')).toEqual([2, 3, 0, 1]);
    expect(displayOrder(rows, 'margin')).toEqual([3, 0, 2, 1]);
    expect(displayOrder(rows, 'pph')).toEqual([3, 0, 1, 2]);
  });
});
