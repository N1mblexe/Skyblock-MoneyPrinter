// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_VIEWPREFS } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import { setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AhSnapshot, AppState, Catalog, CatalogFile, CraftRow, Settings, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { createCraftView } from '../../../src/ui/views/craft/craftView.ts';
import { createForgeView } from '../../../src/ui/views/forge/forgeView.ts';
import { filterChains, filterCrafts, migrateLegacyPrefs, ownFlipMargin, slippage } from '../../../src/ui/views/craft/helpers.ts';
import { bestPerLadder } from '../../../src/domain/chains.ts';

import bazaarJson from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';

const PREFS = LS_VIEWPREFS + 'craft';

let snap: Snapshot;
let catalog: Catalog;
let store: Store<AppState>;
let root: HTMLElement;
let view: View | null;
let ctx: ViewContext;

const flush = () => new Promise((r) => setTimeout(r, 30));
const rows = () => [...root.querySelectorAll<HTMLTableRowElement>('.craft-table tbody tr[data-key]')];
const keys = () => rows().map((r) => r.dataset.key!);
const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const setQuery = () => ctx.setQuery as ReturnType<typeof vi.fn>;
/** merged patches passed to setQuery so far */
const urlState = () => Object.assign({}, ...setQuery().mock.calls.map((c) => c[0] as Record<string, string | undefined>));

function catalogWith(extra: (f: CatalogFile) => void): Catalog {
  const f = structuredClone(catalogJson) as unknown as CatalogFile;
  extra(f);
  return catalogFromFile(validateCatalogFile(f));
}

function setSettings(p: Partial<Settings>): void {
  store.set({ settings: { ...store.get().settings, ...p } });
}

function type(sel: string, value: string): void {
  const el = q<HTMLInputElement>(sel);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true })); // flushes the filter bar debounce
}

function segment(key: string, value: string): void {
  q<HTMLButtonElement>(`.kit-filterbar [data-filter="${key}"] button[data-value="${value}"]`).click();
}

function check(key: string, on: boolean): void {
  const cb = q<HTMLInputElement>(`.kit-filterbar input[data-filter="${key}"]`);
  cb.checked = on;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
}

function mount(query?: Record<string, string>): void {
  view = createCraftView();
  view.mount(root, ctx, { id: 'craft', ...(query ? { query } : {}) });
}

function mountForge(query?: Record<string, string>): void {
  view = createForgeView();
  view.mount(root, ctx, { id: 'forge', ...(query ? { query } : {}) });
}

function openRow(key: string): HTMLElement {
  const tr = rows().find((r) => r.dataset.key === key);
  if (!tr) throw new Error(`row ${key} not shown`);
  tr.click();
  const panel = q('.kit-panel');
  expect(panel.hidden).toBe(false);
  return panel;
}

beforeEach(() => {
  localStorage.clear();
  setLang('tr');
  snap = toSnapshot(validateRaw(structuredClone(bazaarJson) as never), Date.now(), 'fixture');
  catalog = catalogFromFile(validateCatalogFile(structuredClone(catalogJson)));
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  ctx = fakeViewCtx(store, fakeHistory(), { t });
  view = null;
});

afterEach(() => {
  view?.unmount();
  document.body.innerHTML = '';
  setLang('tr');
  vi.restoreAllMocks();
});

describe('craft view', () => {

  it('renders an h1 and shows loading states before data and catalog arrive', async () => {
    mount();
    expect(q('h1').textContent).toBe(t('craft.title'));
    expect(q('.craft-state').textContent).toContain(t('common.waitingData'));
    store.set({ snapshot: snap });
    await flush();
    expect(q('.craft-state').textContent).toContain(t('craft.loadingRecipes'));
    store.set({ catalogError: 'boom' });
    await flush();
    expect(q('.craft-state .banner-err').textContent).toContain('boom');
    expect(q('.craft-table .tbl').hidden).toBe(true);
    store.set({ catalog, catalogError: null });
    await flush();
    expect(q('.craft-state').hidden).toBe(true);
    expect(rows().length).toBeGreaterThan(0);
  });

  it('renders rows from the fixture sorted by profit/hour, with item links and a count', async () => {
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    const ks = keys();
    expect(ks.length).toBeGreaterThan(3);
    expect(ks[0]).toBe('ENCHANTED_COAL#4');
    const pph = ctx.derived.crafts().filter((r) => ks.includes(r.recipe.key)).map((r) => r.profitPerHour);
    expect(Math.max(...pph)).toBe(ctx.derived.crafts().find((r) => r.recipe.key === ks[0])!.profitPerHour);
    const total = ctx.derived.crafts().filter((r) => r.recipe.kind === 'craft').length;
    expect(q('.craft-count').textContent).toBe(t('craft.count', { n: ks.length, total }));
    expect(keys().some((k) => k.startsWith('REFINED_MITHRIL'))).toBe(false); // forge recipes live on the Forge page
    expect(rows()[0]!.querySelector('a[href="#/item/ENCHANTED_COAL"]')).not.toBeNull();
    // unpriced hidden by default, with a hint
    expect(root.querySelector('tr.craft-unpriced')).toBeNull();
    expect(q('.craft-unp').textContent).toMatch(/\d/);
    // headers: limitedBy and slots columns exist; virtualization-ready kit table with a toolbar
    const heads = [...root.querySelectorAll('.craft-table thead th')].map((th) => th.textContent);
    expect(heads.some((h) => h?.includes(t('craft.colLimited')))).toBe(true);
    expect(heads.some((h) => h?.includes(t('craft.colSlots')))).toBe(true);
    expect(root.querySelector('.tbl-tools [data-tool="csv"]')).not.toBeNull();
    expect(root.querySelector('.tbl-tools [data-tool="columns"]')).not.toBeNull();
    // one tab stop
    expect(root.querySelectorAll('.craft-table tbody [tabindex="0"]').length).toBe(1);
  });

  it('the Forge page lists forge recipes only, with the forge badge and a forge-time column', async () => {
    store.set({ snapshot: snap, catalog });
    mountForge({ minVol: 'none', minMargin: 'none' });
    await flush();
    expect(q('h1').textContent).toBe('Forge');
    expect(root.querySelector('.craft-tabs')).toBeNull();
    expect(keys().length).toBeGreaterThan(0);
    expect(keys().every((k) => k.startsWith('REFINED_MITHRIL'))).toBe(true);
    const cell = rows()[0]!.querySelector('td')!;
    expect(cell.querySelector('.craft-forge')!.textContent).toBe('Forge · 6 sa');
    const heads = [...root.querySelectorAll('.craft-table thead th')].map((th) => th.textContent);
    expect(heads.some((h) => h?.includes(t('craft.colDuration')))).toBe(true);
    const total = ctx.derived.crafts().filter((r) => r.recipe.kind === 'forge').length;
    expect(q('.craft-count').textContent).toBe(t('craft.count', { n: keys().length, total }));
    // its own saved filters, apart from the Craft page's
    type('input[data-filter="q"]', 'mithril');
    await flush();
    expect(JSON.parse(localStorage.getItem(PREFS.replace(/craft$/, 'forge'))!)).toMatchObject({ q: 'mithril' });
    expect(localStorage.getItem(PREFS)).toBeNull();
  });

  it('market and unpriced filters update rows and write the URL', async () => {
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    type('input[data-filter="minVol"]', '');
    type('input[data-filter="minMargin"]', '');
    await flush();
    expect(urlState()).toMatchObject({ minVol: 'none', minMargin: 'none' });

    segment('market', 'off');
    await flush();
    expect(urlState()).toMatchObject({ market: 'off' });
    expect(keys()).toHaveLength(0); // PAPER etc. are off-bazaar but unpriced
    check('unpriced', true);
    await flush();
    expect(urlState().unpriced).toBe('1');
    expect(keys()).toContain('PAPER#12');
    const paper = rows().find((r) => r.dataset.key === 'PAPER#12')!;
    expect(paper.classList.contains('craft-unpriced')).toBe(true);
    expect(paper.querySelector('.craft-off')).not.toBeNull();

    segment('market', 'bazaar');
    await flush();
    expect(keys()).not.toContain('PAPER#12');

    // header sort goes to the URL too
    const marginBtn = [...root.querySelectorAll<HTMLButtonElement>('.craft-table thead button[data-sort]')].find(
      (b) => b.dataset.sort === 'margin',
    )!;
    marginBtn.click();
    await flush();
    expect(urlState().sort).toBe('margin.desc');
  });

  it('persists search (and the other filters) in the URL and localStorage', async () => {
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    type('input[data-filter="q"]', 'sugar');
    await flush();
    expect(urlState().q).toBe('sugar');
    expect(keys().length).toBeGreaterThan(0);
    expect(keys().every((k) => /SUGAR/.test(k))).toBe(true);
    expect(JSON.parse(localStorage.getItem(PREFS)!)).toMatchObject({ q: 'sugar' });

    // a fresh mount without a query restores the search and pushes it back to the URL
    view!.unmount();
    setQuery().mockClear();
    mount();
    await flush();
    expect(q<HTMLInputElement>('input[data-filter="q"]').value).toBe('sugar');
    expect(keys().every((k) => /SUGAR/.test(k))).toBe(true);
    expect(urlState().q).toBe('sugar');

    // ingredient search: "Enchanted Gold" hits the gold block via its ingredient
    type('input[data-filter="q"]', 'zzzz-nothing');
    await flush();
    expect(keys()).toHaveLength(0);
    expect(q('.craft-table td.empty').textContent).toBe(t('craft.empty'));
  });

  it('follows the URL on update() and is idempotent', async () => {
    store.set({ snapshot: snap, catalog });
    mount({ q: 'melon' });
    await flush();
    expect(q<HTMLInputElement>('input[data-filter="q"]').value).toBe('melon');
    expect(keys().length).toBeGreaterThan(0);
    expect(keys().every((k) => /MELON/.test(k))).toBe(true);

    view!.update!({ id: 'craft', query: { q: 'coal', minVol: 'none' } });
    await flush();
    expect(q<HTMLInputElement>('input[data-filter="q"]').value).toBe('coal');
    expect(keys().every((k) => /COAL/.test(k))).toBe(true);

    const tbody = q('.craft-table tbody');
    const before = tbody.innerHTML;
    const spy = vi.spyOn(ctx.derived, 'crafts');
    view!.update!({ id: 'craft', query: { q: 'coal', minVol: 'none' } });
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(tbody.innerHTML).toBe(before);
  });

  it('opens the detail panel with steps, ingredient + output rows and market columns', async () => {
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    const panel = openRow('ENCHANTED_GOLD_BLOCK#1');
    expect(q('tr[data-key="ENCHANTED_GOLD_BLOCK#1"]').getAttribute('aria-selected')).toBe('true');
    expect(panel.querySelector('.kit-panel-title')!.textContent).toBe('Enchanted Gold Block');
    // steps: buy, craft, sell, profit
    const steps = panel.querySelectorAll('.craft-steps > li');
    expect(steps.length).toBe(4);
    expect(steps[0]!.querySelectorAll('.craft-buys li').length).toBe(1);
    const gold = ctx.derived.crafts().find((r) => r.recipe.key === 'ENCHANTED_GOLD_BLOCK#1')!;
    expect(gold.valueSource).toBe('npc'); // the fixture's NPC price beats the bazaar
    expect(steps[2]!.textContent).toContain(t('craft.stepSellNpc', { value: '' }).split('≈')[0]!.trim());
    // lines table: 10 columns, one ingredient + the output row
    const tbl = panel.querySelector('.craft-ing')!;
    expect(tbl.querySelectorAll('thead th').length).toBe(10);
    const ing = tbl.querySelector<HTMLTableRowElement>('tr.craft-l-in')!;
    const out = tbl.querySelector<HTMLTableRowElement>('tr.craft-l-out')!;
    expect(ing.querySelector('a[href="#/item/ENCHANTED_GOLD"]')).not.toBeNull();
    expect(out.querySelector('a[href="#/item/ENCHANTED_GOLD_BLOCK"]')).not.toBeNull();
    expect(ing.querySelector('.badge.src-craft')).not.toBeNull();
    expect(ing.querySelector('.craft-via')!.textContent).toContain('Gold Ingot');
    expect(out.querySelector('.badge.src-npc')).not.toBeNull();
    // bid / ask pair, weekly volumes and order counts for the output come from the snapshot
    const p = snap.products.ENCHANTED_GOLD_BLOCK!;
    const outCells = [...out.querySelectorAll('td')].map((td) => td.textContent!.trim());
    expect(outCells[2]).toContain(' / ');
    expect(outCells.some((c) => c.includes(new Intl.NumberFormat('tr-TR').format(p.quick.buyOrders)))).toBe(true);
    // own flip margin for the output, formatted as %
    const fm = ownFlipMargin(p, store.get().settings.taxRate, catalog.items.ENCHANTED_GOLD_BLOCK!.npcSell);
    expect(fm).not.toBeNull();
    expect(outCells[7]).toMatch(/%/);
    // bottleneck highlighted somewhere in the crafts/h column
    expect(tbl.querySelector('.bott')).not.toBeNull();
    // throughput notes
    expect(panel.querySelector('.craft-notes')!.textContent).toContain(t(`craft.why_${ctx.derived.crafts().find((r) => r.recipe.key === 'ENCHANTED_GOLD_BLOCK#1')!.tp.limitedBy}`));
    // item page link + watch button in the head
    expect(panel.querySelector('.craft-d-actions a[href="#/item/ENCHANTED_GOLD_BLOCK"]')).not.toBeNull();

    // a bazaar-valued output sells by offer (default sell mode)
    const bz = ctx.derived.crafts().find((r) => keys().includes(r.recipe.key) && r.valueSource === 'bazaar')!;
    openRow(bz.recipe.key);
    expect(panel.querySelector('tr.craft-l-out .badge.src-order')!.textContent).toBe(t('craft.srcSellOffer'));
    expect(panel.querySelectorAll('.craft-steps > li')[2]!.textContent).toContain('sell offer');

    // close: selection clears
    panel.querySelector<HTMLButtonElement>('.kit-x')!.click();
    expect(panel.hidden).toBe(true);
    expect(root.querySelector('tr[aria-selected="true"]')).toBeNull();
  });

  it('shows few-orders chips and forge notes with requirement text', async () => {
    store.set({ snapshot: snap, catalog });
    mountForge({ minVol: 'none', minMargin: 'none' });
    await flush();
    const panel = openRow(keys()[0]!);
    expect(panel.querySelector('.craft-steps')!.textContent).toContain(String(store.get().settings.forgeSlots));
    const notes = panel.querySelector('.craft-notes')!.textContent!;
    expect(notes).toContain('HOTM 2');
    expect(notes).toContain(t('craft.forgeLine', { slots: '', d: '', cap: '' }).split('{')[0]!.slice(0, 5));
  });

  it('notes the NPC daily limit from settings for NPC-sourced ingredients', async () => {
    store.set({ snapshot: snap, catalog });
    setSettings({ npcDailyLimit: 1234 });
    mount({ minVol: 'none', minMargin: 'none' });
    await flush();
    const npcRow = ctx.derived.crafts().find((r) => r.unpriced.length === 0 && r.lines.some((l) => l.source === 'npc'));
    if (!npcRow) throw new Error('no npc row in fixture');
    const panel = openRow(npcRow.recipe.key);
    const note = panel.querySelector('.craft-npc-limit')!.textContent!;
    expect(note).toContain('1.234');
    expect(q('.craft-note-body').textContent).toContain('1.234');
  });

  it('shows slippage notes in insta modes', async () => {
    store.set({ snapshot: snap, catalog });
    setSettings({ costMode: 'insta', sellMode: 'insta' });
    mount({ minVol: 'none', minMargin: 'none' });
    await flush();
    const r = ctx.derived.crafts().find((x) => x.unpriced.length === 0 && x.valueSource === 'bazaar' && x.lines.some((l) => l.source === 'insta'));
    if (!r) throw new Error('no insta row');
    const panel = openRow(r.recipe.key);
    const slip = panel.querySelector('.craft-slip')!;
    expect(slip.textContent).toContain(t('craft.slipMode'));
    expect(slip.querySelectorAll('li').length).toBeGreaterThan(0);
    // helper: batch average never beats the first unit on the ask side
    const p = snap.products[r.lines.find((l) => l.source === 'insta')!.id]!;
    const s = slippage(p.asks, 1e6)!;
    expect(s.batch).toBeGreaterThanOrEqual(s.one);
  });

  it('values off-bazaar forge outputs from the AH (with badges, warning and AH_THIN) and NPC', async () => {
    const cat = catalogWith((f) => {
      f.items.TEST_DRILL = { n: 'Test Drill', ah: 1 };
      f.items.TEST_TRINKET = { n: 'Test Trinket', ns: 50_000_000 };
      f.recipes.push({ o: 'TEST_DRILL', c: 1, i: [['ENCHANTED_GOLD', 10]], k: 'forge', d: 3600 });
      f.recipes.push({ o: 'TEST_TRINKET', c: 1, i: [['ENCHANTED_GOLD', 10]], k: 'forge', d: 7200 });
    });
    const ah: AhSnapshot = { fetchedAt: Date.now(), lastUpdated: Date.now(), lowestBin: { TEST_DRILL: { price: 90_000_000, count: 1 } } };
    store.set({ snapshot: snap, catalog: cat, ah });
    setSettings({ ahEnabled: true });
    mountForge({ market: 'off' });
    await flush();
    const drillKey = cat.recipes.find((r) => r.output === 'TEST_DRILL')!.key;
    const trinketKey = cat.recipes.find((r) => r.output === 'TEST_TRINKET')!.key;
    expect(keys()).toEqual(expect.arrayContaining([drillKey, trinketKey]));
    const drill = ctx.derived.crafts().find((r) => r.recipe.key === drillKey)!;
    expect(drill.valueSource).toBe('ah');
    expect(drill.risk.flags).toContain('AH_THIN');
    const tr = rows().find((r) => r.dataset.key === drillKey)!;
    expect(tr.querySelector('.craft-src-ah')).not.toBeNull();
    expect(tr.querySelector('.craft-off')).not.toBeNull();
    expect(tr.querySelector('.craft-forge')).not.toBeNull();
    expect(tr.querySelector('.badge.risk-caution, .badge.risk-suspect')!.getAttribute('title')).toContain(t('risk.AH_THIN'));
    const trinket = rows().find((r) => r.dataset.key === trinketKey)!;
    expect(trinket.querySelector('.badge.src-npc')).not.toBeNull();

    const panel = openRow(drillKey);
    expect(panel.querySelector('.craft-ah-warn')!.textContent).toBe(t('craft.ahWarn'));
    expect(panel.querySelector('.craft-steps')!.textContent).toContain('BIN');
    const out = panel.querySelector('tr.craft-l-out')!;
    expect(out.querySelector('.craft-src-ah')).not.toBeNull();
    expect(out.textContent).toContain(t('craft.ahListings', { price: '', count: '' }).slice(0, 4));

    openRow(trinketKey);
    expect(panel.querySelector('.craft-ah-warn')).toBeNull();
    expect(panel.querySelector('.craft-steps')!.textContent).toContain('NPC');

    // market=bazaar hides both
    segment('market', 'bazaar');
    await flush();
    expect(keys()).not.toContain(drillKey);
    expect(keys()).not.toContain(trinketKey);

    // AH scan off: the drill becomes unpriced and its panel says why
    segment('market', 'off');
    setSettings({ ahEnabled: false });
    check('unpriced', true);
    await flush();
    const after = ctx.derived.crafts().find((r) => r.recipe.key === drillKey)!;
    expect(after.unpriced).toContain('TEST_DRILL');
    openRow(drillKey);
    expect(panel.querySelector('.craft-unpriced-msg')!.textContent).toContain(t('craft.offUnpricedAhOff'));
  });

  it('toggles the watchlist from the row action and from the panel', async () => {
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    const star = () => q<HTMLButtonElement>('tr[data-key="ENCHANTED_GOLD_BLOCK#1"] button[data-action="watch"]');
    expect(star().getAttribute('aria-pressed')).toBe('false');
    star().click();
    expect(store.get().watchlist.map((w) => w.id)).toEqual(['ENCHANTED_GOLD_BLOCK']);
    expect(ctx.toast).toHaveBeenCalled();
    expect(star().getAttribute('aria-pressed')).toBe('true');
    expect(q('.kit-panel').hidden).toBe(true); // action clicks never activate the row

    const panel = openRow('ENCHANTED_GOLD_BLOCK#1');
    const btn = () => panel.querySelector<HTMLButtonElement>('[data-craft-watch]')!;
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    btn().click();
    expect(store.get().watchlist).toHaveLength(0);
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    expect(star().getAttribute('aria-pressed')).toBe('false');
  });

  it('hides suspect rows behind a toggle that lives in the URL', async () => {
    store.set({ snapshot: snap, catalog });
    const real = ctx.derived.crafts();
    const target = 'ENCHANTED_GOLD_BLOCK#1';
    const fake: CraftRow[] = real.map((r) => (r.recipe.key === target ? { ...r, risk: { level: 'suspect', score: 5, flags: [] } } : r));
    ctx.derived = { ...ctx.derived, crafts: () => fake };

    const res = filterCrafts(
      fake,
      { q: '', minVol: 1000, minMargin: 1, minPph: null, kind: 'all', market: 'all', showUnpriced: false, hideSuspect: true },
      catalog,
    );
    expect(res.hidden).toBe(1);

    mount();
    await flush();
    const btn = q<HTMLButtonElement>('.craft-hidden');
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe(t('common.hiddenCount', { n: 1 }));
    expect(keys()).not.toContain(target);
    btn.click();
    await flush();
    expect(keys()).toContain(target);
    expect(urlState().suspect).toBe('1');
    expect(q<HTMLInputElement>('input[data-filter="suspect"]').checked).toBe(true);
    setSettings({ hideSuspicious: false });
    await flush();
    expect(btn.hidden).toBe(true);
  });

  it('migrates round-1 prefs from localStorage', async () => {
    localStorage.setItem(PREFS, JSON.stringify({ minVol: 0, minMargin: null, kind: 'forge', showUnpriced: true, sort: { key: 'margin', dir: 'asc' } }));
    migrateLegacyPrefs();
    // the old kind filter is gone (forge recipes have their own page), the rest carries over
    expect(JSON.parse(localStorage.getItem(PREFS)!)).toEqual({ minVol: '0', minMargin: 'none', unpriced: '1', sort: 'margin.asc' });
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    expect(keys().length).toBeGreaterThan(0);
    expect(urlState()).toMatchObject({ unpriced: '1', sort: 'margin.asc' });
  });

  it('switches language, refreshes an open panel, and cleans up on unmount', async () => {
    store.set({ snapshot: snap, catalog });
    mount();
    await flush();
    expect(q('.craft-table thead th').textContent).toContain('Çıktı');
    const panel = openRow('ENCHANTED_GOLD_BLOCK#1');
    expect(panel.querySelector('.craft-sec h3')!.textContent).toBe('Adımlar');
    setLang('en');
    await flush();
    expect(q('.craft-table thead th').textContent).toContain('Output');
    expect(q('h1').textContent).toBe('Craft');
    expect(q('.craft-note-body').textContent).toContain('How it works');
    expect(panel.querySelector('.craft-sec h3')!.textContent).toBe('Steps');
    expect(q('.kit-filterbar').textContent).toContain('Output market');

    view!.unmount();
    view = null;
    expect(root.innerHTML).toBe('');
    expect(document.querySelector('.kit-panel')).toBeNull();
    store.set({ snapshot: { ...snap } });
    setLang('tr');
    await flush();
    expect(root.innerHTML).toBe('');
  });
});

describe('craft view: chains tab', () => {
  const chainRows = () => [...root.querySelectorAll<HTMLTableRowElement>('.chains-view tbody tr[data-key]')];

  beforeEach(() => {
    setLang('en');
    store.set({ snapshot: snap, catalog });
  });

  it('?view=chains shows the chains pane with the filtered domain rows (best per ladder by default)', async () => {
    mount({ view: 'chains' });
    await flush();
    expect(q('[data-testid="craft-tab-chains"]').getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    const all = ctx.derived.chains();
    const best = bestPerLadder(all);
    const want = filterChains(
      all,
      { q: '', only: best, minSteps: 2, minMargin: 1, minPph: null, showUnpriced: false, hideSuspect: store.get().settings.hideSuspicious },
      catalog,
    ).rows;
    expect(want.length).toBeGreaterThan(0);
    expect(new Set(chainRows().map((r) => r.dataset.key))).toEqual(new Set(want.map((r) => r.key)));
    expect(q('[data-testid="chain-count"]').textContent).toBe(t('craft.chCount', { n: want.length, total: all.length, count: all.length }));
  });

  it('turning off "best move per ladder" lists every priced move', async () => {
    mount({ view: 'chains' });
    await flush();
    const before = chainRows().length;
    check('best', false);
    await flush();
    expect(chainRows().length).toBeGreaterThanOrEqual(before);
    expect(urlState()).toMatchObject({ best: '0' });
  });

  it('a row opens the ladder: tiers, start and sell rows, one craft step per tier', async () => {
    mount({ view: 'chains' });
    await flush();
    const tr = chainRows()[0]!;
    const row = ctx.derived.chains().find((r) => r.key === tr.dataset.key)!;
    tr.click();
    const panel = q('.kit-panel');
    expect(panel.hidden).toBe(false);
    const tiers = [...panel.querySelectorAll<HTMLElement>('.chain-ladder tbody tr')].map((r) => r.dataset.tier);
    expect(tiers).toEqual(expect.arrayContaining(row.path));
    expect(panel.querySelector('.chain-ladder tr.chain-start')!.getAttribute('data-tier')).toBe(row.fromId);
    expect(panel.querySelector('.chain-ladder tr.chain-target')!.getAttribute('data-tier')).toBe(row.toId);
    // buy + one craft per step + sell + profit
    expect(panel.querySelectorAll('.craft-steps > li')).toHaveLength(1 + row.steps + 2);
  });

  it('tab buttons navigate between the tabs, dropping the other tab’s query', async () => {
    mount({ view: 'chains', q: 'gem' });
    await flush();
    q<HTMLButtonElement>('[data-testid="craft-tab-recipes"]').click();
    expect(ctx.navigate).toHaveBeenCalledWith({ id: 'craft', query: {} });
    view!.update!({ id: 'craft', query: {} });
    await flush();
    expect(root.querySelector('.chains-view')).toBeNull();
    expect(q('[data-testid="craft-tab-recipes"]').getAttribute('aria-pressed')).toBe('true');
    expect(rows().length).toBeGreaterThan(0);
    q<HTMLButtonElement>('[data-testid="craft-tab-chains"]').click();
    expect(ctx.navigate).toHaveBeenLastCalledWith({ id: 'craft', query: { view: 'chains' } });
  });

  it('switches language in place', async () => {
    mount({ view: 'chains' });
    await flush();
    setLang('tr');
    await flush();
    expect(q('[data-testid="craft-tab-chains"]').textContent).toBe('Zincirler');
    expect(q('.craft-tabs').getAttribute('aria-label')).toBe('Craft & Forge görünümü');
  });
});
