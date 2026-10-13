// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_VIEWPREFS } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import * as craftDomain from '../../../src/domain/craft.ts';
import '../../../src/i18n/common.ts';
import { dictKeys, setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AppState, Catalog, HistoryRepo, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { createCraftView } from '../../../src/ui/views/craft/craftView.ts';
import { filterCrafts } from '../../../src/ui/views/craft/helpers.ts';

import bazaarJson from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';

const fixture = (name: 'bazaar.json' | 'catalog.json'): unknown =>
  structuredClone(name === 'bazaar.json' ? bazaarJson : catalogJson);

let snap: Snapshot;
let catalog: Catalog;
let store: Store<AppState>;
let root: HTMLElement;
let view: View | null;
let ctx: ViewContext;

const fakeHistory: HistoryRepo = {
  init: async () => {},
  record: async () => {},
  series: async () => [],
  recent: () => [],
  stats: () => null,
  saveLatest: async () => {},
  loadLatest: async () => null,
};

const flush = () => new Promise((r) => setTimeout(r, 30));
const rows = () => [...root.querySelectorAll<HTMLTableRowElement>('.craft-table tbody tr[data-key]')];
const keys = () => rows().map((r) => r.dataset.key!);
const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;

function setInput(sel: string, value: string, type = 'input'): void {
  const el = q<HTMLInputElement>(sel);
  el.value = value;
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function mount(query?: Record<string, string>): void {
  view = createCraftView();
  view.mount(root, ctx, { id: 'craft', ...(query ? { query } : {}) });
}

beforeEach(() => {
  localStorage.clear();
  setLang('tr');
  snap = toSnapshot(validateRaw(fixture('bazaar.json') as never), Date.now(), 'fixture');
  catalog = catalogFromFile(validateCatalogFile(fixture('catalog.json')));
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  ctx = { store, history: fakeHistory, navigate: vi.fn(), t, refresh: vi.fn(async () => {}) };
  view = null;
});

afterEach(() => {
  view?.unmount();
  document.body.innerHTML = '';
  setLang('tr');
  vi.restoreAllMocks();
});

describe('craft view', () => {
  it('has identical TR/EN keys', () => {
    const k = dictKeys('craft');
    expect(k.tr.length).toBeGreaterThan(20);
    expect(k.en).toEqual(k.tr);
  });

  it('shows loading states before data and catalog arrive', async () => {
    mount();
    expect(q('.craft-state').textContent).toContain(t('common.waitingData'));
    store.set({ snapshot: snap });
    await flush();
    expect(q('.craft-state').textContent).toContain(t('craft.loadingRecipes'));
    store.set({ catalogError: 'boom' });
    await flush();
    expect(q('.craft-state .banner-err').textContent).toContain('boom');
    expect(q('.craft-table').hidden).toBe(true);
    store.set({ catalog, catalogError: null });
    await flush();
    expect(q('.craft-state').hidden).toBe(true);
    expect(rows().length).toBeGreaterThan(0);
  });

  it('renders rows sorted by profit/hour with defaults, and filters', async () => {
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    const ks = keys();
    expect(ks.length).toBeGreaterThan(3);
    expect(ks[0]).toBe('ENCHANTED_COAL#4'); // gold block's sub-crafted ingredient is now rate-limited by its own inputs
    expect(q('.craft-count').textContent).toContain(String(ks.length));
    // forge badge + requirement on REFINED_MITHRIL (if visible), unpriced hidden by default
    expect(root.querySelector('tr.craft-unpriced')).toBeNull();

    // numeric filters carry data-filter; 0 shows more rows
    const filters = root.querySelectorAll<HTMLInputElement>('input[data-filter]');
    expect(filters.length).toBe(2);
    for (const f of filters) setInput(`input[name=${f.name}]`, '0');
    await flush();
    expect(keys().length).toBeGreaterThanOrEqual(ks.length);

    // search matches output or ingredient
    setInput('input[name=q]', 'sugar');
    await flush();
    expect(keys().length).toBeGreaterThan(0);
    expect(keys().every((k) => /SUGAR/.test(k))).toBe(true);
    setInput('input[name=q]', 'Enchanted Gold');
    await flush();
    expect(keys()).toContain('ENCHANTED_GOLD_BLOCK#1');
    setInput('input[name=q]', 'zzzz-nothing');
    await flush();
    expect(keys()).toHaveLength(0);
    expect(q('.craft-table td.empty').textContent).toBe(t('craft.empty'));
  });

  it('does not recompute crafts on search keystrokes', async () => {
    const spy = vi.spyOn(craftDomain, 'computeCrafts');
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    const n = spy.mock.calls.length;
    setInput('input[name=q]', 'gold');
    await flush();
    setInput('input[name=q]', 'gol');
    await flush();
    expect(spy.mock.calls.length).toBe(n);
    store.set({ settings: { ...store.get().settings, capital: 1e9 } });
    await flush();
    expect(spy.mock.calls.length).toBe(n + 1);
  });

  it('kind toggle, unpriced toggle and forge badge', async () => {
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    setInput('input[name=minVol]', '0');
    setInput('input[name=minMargin]', '');
    q<HTMLButtonElement>('.craft-kind button[data-kind="forge"]').click();
    await flush();
    expect(keys().length).toBeGreaterThan(0);
    expect(keys().every((k) => k.startsWith('REFINED_MITHRIL'))).toBe(true);
    const cell = rows()[0]!.querySelector('td')!;
    expect(cell.querySelector('.craft-forge')!.textContent).toBe('Forge · 6 sa');
    expect(cell.querySelector('.craft-req')!.textContent).toBe('HOTM 2');

    q<HTMLButtonElement>('.craft-kind button[data-kind="all"]').click();
    await flush();
    const unpricedLabel = q('.craft-unpriced-label').textContent!;
    expect(unpricedLabel).toMatch(/\(\d+\)/);
    const before = keys().length;
    const cb = q<HTMLInputElement>('input[name=showUnpriced]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    const greyed = root.querySelectorAll('tr.craft-unpriced');
    expect(greyed.length).toBeGreaterThan(0);
    expect(keys().length).toBe(before + greyed.length);
    expect(greyed[0]!.querySelector('.craft-unpriced-ids')!.textContent).toContain(t('craft.unpricedList', { ids: '' }).trim());

    // prefs persisted
    const saved = JSON.parse(localStorage.getItem(LS_VIEWPREFS + 'craft')!);
    expect(saved).toMatchObject({ minVol: 0, minMargin: null, kind: 'all', showUnpriced: true });
  });

  it('expands a detail panel with steps, sub-craft and item links', async () => {
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    const tr = rows().find((r) => r.dataset.key === 'ENCHANTED_GOLD_BLOCK#1')!;
    tr.click();
    const det = tr.nextElementSibling as HTMLElement;
    expect(det.classList.contains('detail')).toBe(true);
    expect(det.querySelectorAll('.craft-steps li').length).toBeGreaterThanOrEqual(4);
    expect(det.querySelector('.craft-ing a[href="#/item/ENCHANTED_GOLD"]')).not.toBeNull();
    expect(det.querySelector('.craft-via')!.textContent).toContain('Gold Ingot');
    expect(det.querySelector('.badge.src-craft')).not.toBeNull();
    tr.click();
    expect(tr.nextElementSibling?.classList.contains('detail') ?? false).toBe(false);
  });

  it('notes NPC buy limits for NPC-sourced ingredients', async () => {
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    setInput('input[name=minVol]', '0');
    setInput('input[name=minMargin]', '');
    await flush();
    const all = craftDomain.computeCrafts({ snap, catalog, settings: store.get().settings });
    const npcRow = all.find((r) => r.unpriced.length === 0 && r.lines.some((l) => l.source === 'npc'));
    if (!npcRow) throw new Error('no npc row in fixture');
    const tr = rows().find((r) => r.dataset.key === npcRow.recipe.key);
    if (!tr) throw new Error('npc row not shown');
    tr.click();
    expect(tr.nextElementSibling!.querySelector('.craft-npc-limit')).not.toBeNull();
  });

  it('pre-fills search from the route query and updates on route change', async () => {
    store.set({ snapshot: snap, catalog });
    mount({ q: 'melon' });
    await flush();
    expect(q<HTMLInputElement>('input[name=q]').value).toBe('melon');
    expect(keys().length).toBeGreaterThan(0);
    expect(keys().every((k) => /MELON/.test(k))).toBe(true);
    view!.update!({ id: 'craft', query: { q: 'coal' } });
    await flush();
    expect(q<HTMLInputElement>('input[name=q]').value).toBe('coal');
    expect(keys().every((k) => /COAL/.test(k))).toBe(true);
  });

  it('hides suspect rows behind a hidden-count toggle', async () => {
    store.set({ snapshot: snap, catalog });
    const real = craftDomain.computeCrafts({ snap, catalog, settings: store.get().settings });
    const target = real.find((r) => r.recipe.key === 'ENCHANTED_GOLD_BLOCK#1')!;
    const res = filterCrafts(
      real.map((r) => (r === target ? { ...r, risk: { level: 'suspect' as const, score: 5, flags: [] } } : r)),
      { q: '', minVol: 1000, minMargin: 1, kind: 'all', showUnpriced: false, hideSuspect: true },
      catalog,
    );
    expect(res.hidden).toBe(1);
    expect(res.rows.some((r) => r.recipe.key === 'ENCHANTED_GOLD_BLOCK#1')).toBe(false);

    vi.spyOn(craftDomain, 'computeCrafts').mockImplementation((c) =>
      real.map((r) => (r.recipe.key === target.recipe.key ? { ...r, risk: { level: 'suspect', score: 5, flags: [] } } : r)),
    );
    mount();
    await flush();
    const btn = q<HTMLButtonElement>('.craft-hidden');
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe(t('common.hiddenCount', { n: 1 }));
    expect(keys()).not.toContain('ENCHANTED_GOLD_BLOCK#1');
    btn.click();
    await flush();
    expect(keys()).toContain('ENCHANTED_GOLD_BLOCK#1');
    store.set({ settings: { ...store.get().settings, hideSuspicious: false } });
    await flush();
    expect(btn.hidden).toBe(true);
  });

  it('switches language and cleans up on unmount', async () => {
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    expect(q('th').textContent).toContain('Çıktı');
    setLang('en');
    await flush();
    expect(q('th').textContent).toContain('Output');
    expect(q('.craft-note').textContent).toContain('How it works');
    view!.unmount();
    view = null;
    expect(root.innerHTML).toBe('');
    // further store changes must not throw or re-render
    store.set({ snapshot: { ...snap } });
    await flush();
    expect(root.innerHTML).toBe('');
  });
});
