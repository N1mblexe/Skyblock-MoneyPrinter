// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_VIEWPREFS } from '../../../src/config.ts';
import { catalogFromFile } from '../../../src/data/catalog.ts';
import { computeNpcFlips } from '../../../src/domain/npc.ts';
import { computeShopRows } from '../../../src/domain/shops.ts';
import { setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AppState, Catalog, CatalogFile, Route, ShopOffer, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { fmtCoins } from '../../../src/ui/format.ts';
import {
  currencyOptions,
  filterFlips,
  filterShops,
  FLIP_SCHEMA,
  migrateNpcPrefs,
  SHOP_SCHEMA,
  visibleShops,
} from '../../../src/ui/views/npc/npcData.ts';
import { createNpcView } from '../../../src/ui/views/npc/npcView.ts';
import rawBazaar from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';

const snapshot: Snapshot = toSnapshot(validateRaw(rawBazaar as unknown), Date.now(), 'fixture');
const catalog: Catalog = catalogFromFile(catalogJson as unknown as CatalogFile);

const SHOPS: ShopOffer[] = [
  { shop: 'SkyMart', currency: 'SKYBLOCK_COPPER', costQty: 10, output: 'ENCHANTED_GOLD', outQty: 1 },
  { shop: 'SkyMart', currency: 'SKYBLOCK_COPPER', costQty: 200, output: 'ENCHANTED_GOLD_BLOCK', outQty: 1 },
  { shop: 'Elizabeth', currency: 'SKYBLOCK_BIT', costQty: 50, output: 'ENCHANTED_DIAMOND', outQty: 2 },
  { shop: 'Elizabeth', currency: 'SKYBLOCK_BIT', costQty: 500, output: 'NOT_A_REAL_ITEM', outQty: 1 },
];

/**
 * Synthetic catalog: the fixture catalog rebuilt + overridden shops and two currency names.
 * (tests/domain/helpers.ts buildCatalog reads fixtures via import.meta.url, which happy-dom can't resolve.)
 */
function shopCatalog(): Catalog {
  const c = catalogFromFile(catalogJson as unknown as CatalogFile);
  c.items.SKYBLOCK_COPPER = { id: 'SKYBLOCK_COPPER', name: 'Copper', bazaar: false };
  c.items.SKYBLOCK_BIT = { id: 'SKYBLOCK_BIT', name: 'Bit', bazaar: false };
  return { ...c, shops: SHOPS };
}

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext;

const flush = () => new Promise((r) => setTimeout(r, 30));
const debounce = () => new Promise((r) => setTimeout(r, 320));
const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const box = (seg: 'flips' | 'shops') => q(`[data-testid="npc-${seg}"]`);
const rowKeys = (seg: 'flips' | 'shops' = 'flips') =>
  [...box(seg).querySelectorAll<HTMLTableRowElement>('tbody tr[data-key]')].map((tr) => tr.dataset.key!);
const rowIds = () => rowKeys('flips').map((k) => k.split(':')[1]!);
const segBtn = (d: string) => q<HTMLButtonElement>(`[data-seg="${d}"]`);
const setInput = (el: HTMLInputElement, v: string) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const setQueryCalls = () => (ctx.setQuery as unknown as { mock: { calls: [Record<string, string | undefined>][] } }).mock.calls.map((c) => c[0]);

function mount(state: Partial<AppState> = { snapshot, catalog }, route: Route = { id: 'npc' }): void {
  store = createStore<AppState>({ ...initialState({ ...defaultSettings }), ...state });
  ctx = fakeViewCtx(store, fakeHistory());
  view = createNpcView();
  view.mount(root, ctx, route);
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

describe('npc view: flips', () => {
  it('renders three segments, bz2npc rows sorted by profit/hour, suspects hidden', async () => {
    mount();
    await flush();
    expect(q('h1').textContent).toBe('NPC & Dükkanlar');
    expect([...root.querySelectorAll('[data-seg]')].map((b) => b.getAttribute('data-seg'))).toEqual(['bz2npc', 'npc2bz', 'shops']);
    expect(segBtn('bz2npc').getAttribute('aria-pressed')).toBe('true');
    expect(box('shops').hidden).toBe(true);
    const ids = rowIds();
    expect(ids).toContain('ENCHANTED_GOLD');
    expect(ids[0]).toBe('ENCHANTED_GOLD_BLOCK');
    // side-aware risk: GOLD_INGOT's dead 0.1 bid only matters when selling on the bazaar, so no bz2npc row is suspect
    expect(ids).toContain('GOLD_INGOT');
    expect(q('tr[data-key="bz2npc:GOLD_INGOT"]').querySelector('.npc-floor')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="npc-hidden"]').hidden).toBe(true);
    const tr = q(`tr[data-key="bz2npc:ENCHANTED_GOLD"]`);
    expect(tr.textContent).toContain('456');
    expect(tr.textContent).toContain('480');
    expect(tr.querySelector('.src-order')).not.toBeNull();
    expect(tr.querySelector('.src-npc')).not.toBeNull();
    // the derived rows are used (no local memo)
    expect(ids.length).toBe(ctx.derived.npc().filter((r) => r.direction === 'bz2npc' && r.risk.level !== 'suspect' && r.margin >= 0.01).length);
  });

  it('shows weekly volume, limited-by and slots columns', async () => {
    mount({ snapshot, catalog, settings: { ...defaultSettings, hideSuspicious: false } });
    await flush();
    const heads = [...box('flips').querySelectorAll('th')].map((th) => th.textContent);
    expect(heads.join('|')).toContain('Hacim / hafta');
    expect(heads.join('|')).toContain('Sınırlayan');
    expect(heads.join('|')).toContain('Slot');
    const row = ctx.derived.npc().find((r) => r.id === 'ENCHANTED_GOLD' && r.direction === 'bz2npc')!;
    const tr = q(`tr[data-key="bz2npc:ENCHANTED_GOLD"]`);
    expect(tr.querySelector('.npc-lim')!.textContent).toBe(t(`npc.lim_${row.tp.limitedBy}`));
    segBtn('npc2bz').click();
    await flush();
    // NPC buying is capped by settings.npcDailyLimit (640/day)
    const melon = ctx.derived.npc().find((r) => r.id === 'MELON' && r.direction === 'npc2bz')!;
    expect(melon.tp.limitedBy).toBe('npcLimit');
    expect(q('tr[data-key="npc2bz:MELON"] .npc-lim').textContent).toBe('NPC günlük limiti');
  });

  it('hidden-count toggle reveals suspects and writes the URL', async () => {
    mount();
    await flush();
    segBtn('npc2bz').click(); // MELON npc2bz sells into a 0.7 / 4.9 book: suspect
    await flush();
    const btn = q<HTMLButtonElement>('[data-testid="npc-hidden"]');
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toMatch(/gizli/);
    expect(rowIds()).not.toContain('MELON');
    btn.click();
    await flush();
    expect(setQueryCalls()).toContainEqual({ hidden: '1' });
    expect(rowIds()).toContain('MELON');
    expect(q('tr[data-key="npc2bz:MELON"]').classList.contains('npc-suspect')).toBe(true);
  });

  it('segment switch writes setQuery and persists across remounts', async () => {
    mount({ snapshot, catalog, settings: { ...defaultSettings, hideSuspicious: false } });
    await flush();
    segBtn('npc2bz').click();
    await flush();
    expect(setQueryCalls()).toContainEqual({ dir: 'npc2bz' });
    expect(segBtn('npc2bz').getAttribute('aria-pressed')).toBe('true');
    expect(rowIds().sort()).toEqual(['MELON', 'WHEAT']);
    expect(q('tr[data-key="npc2bz:MELON"]').textContent).toMatch(/Sell offer/);
    expect(q('.npc-dir-desc').textContent).toContain('640');
    // arrow keys move between segments
    segBtn('npc2bz').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flush();
    expect(segBtn('shops').getAttribute('aria-pressed')).toBe('true');
    segBtn('shops').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await flush();
    view.unmount();
    view = createNpcView();
    view.mount(root, ctx, { id: 'npc' });
    await flush();
    expect(segBtn('npc2bz').getAttribute('aria-pressed')).toBe('true');
    expect(rowIds().sort()).toEqual(['MELON', 'WHEAT']);
  });

  it('filters by search, min margin, min profit/hour and min volume (URL written)', async () => {
    mount();
    await flush();
    const search = q<HTMLInputElement>('[data-testid="npc-flips"] input[data-filter="q"]');
    setInput(search, 'gold');
    await debounce();
    expect(setQueryCalls()).toContainEqual({ q: 'gold' });
    expect(rowIds().length).toBeGreaterThan(0);
    expect(rowIds().every((id) => id.includes('GOLD'))).toBe(true);
    setInput(search, '');
    await debounce(); // kit number fields resync on any state change, so let each debounce settle
    const margin = q<HTMLInputElement>('input[data-filter="minMargin"]');
    setInput(margin, '5');
    await debounce();
    expect(rowIds()).toContain('ENCHANTED_GOLD'); // 5.3%
    expect(rowIds()).not.toContain('ENCHANTED_DIAMOND'); // 2.9%
    setInput(margin, '0');
    await debounce();
    const pph = q<HTMLInputElement>('input[data-filter="minPph"]');
    setInput(pph, '200000');
    await debounce();
    expect(rowIds()).toContain('ENCHANTED_GOLD_BLOCK');
    expect(rowIds()).not.toContain('ENCHANTED_SUGAR');
    setInput(pph, '');
    await debounce();
    const vol = q<HTMLInputElement>('[data-testid="npc-flips"] input[data-filter="minVol"]');
    const before = rowIds().length;
    setInput(vol, '1e15');
    await debounce();
    expect(setQueryCalls()).toContainEqual({ minVol: '1000000000000000' });
    expect(rowIds()).toEqual([]);
    expect(before).toBeGreaterThan(0);
    expect(q('[data-testid="npc-flips"] td.empty').textContent).toBe('Filtrelere uyan satır yok.');
  });

  it('URL-driven state: update(route) switches segment and filters', async () => {
    mount();
    await flush();
    view.update!({ id: 'npc', query: { dir: 'bz2npc', q: 'block' } });
    await flush();
    expect(rowIds()).toEqual(['ENCHANTED_GOLD_BLOCK']);
    expect(q<HTMLInputElement>('input[data-filter="q"]').value).toBe('block');
    // idempotent
    view.update!({ id: 'npc', query: { dir: 'bz2npc', q: 'block' } });
    await flush();
    expect(rowIds()).toEqual(['ENCHANTED_GOLD_BLOCK']);
    view.update!({ id: 'npc', query: { dir: 'shops' } });
    await flush();
    expect(segBtn('shops').getAttribute('aria-pressed')).toBe('true');
    expect(box('flips').hidden).toBe(true);
    expect(box('shops').hidden).toBe(false);
  });

  it('a shared link wins over localStorage on mount', async () => {
    localStorage.setItem(LS_VIEWPREFS + 'npc', JSON.stringify({ q: 'diamond' }));
    mount({ snapshot, catalog }, { id: 'npc', query: { q: 'gold', sort: 'margin.asc' } });
    await flush();
    expect(rowIds().every((id) => id.includes('GOLD'))).toBe(true);
    const th = [...box('flips').querySelectorAll('th')].find((x) => x.textContent?.startsWith('Marj'))!;
    expect(th.getAttribute('aria-sort')).toBe('ascending');
  });

  it('opens the detail panel with steps, risk and links', async () => {
    mount();
    await flush();
    q<HTMLElement>('tr[data-key="bz2npc:ENCHANTED_GOLD"] td.num').click();
    const panel = q('.kit-panel');
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector('.kit-panel-title')!.textContent).toBe(catalog.name('ENCHANTED_GOLD'));
    expect(panel.querySelectorAll('.npc-steps li').length).toBe(3);
    expect(panel.querySelector('.npc-steps')!.textContent).toContain('buy order');
    expect(panel.querySelector('.badge[class*="risk-"]')).not.toBeNull();
    expect(panel.querySelector('a[href="#/item/ENCHANTED_GOLD"]')).not.toBeNull();
    expect(q('tr[data-key="bz2npc:ENCHANTED_GOLD"]').classList.contains('sel')).toBe(true);
    // watch from the panel
    panel.querySelector<HTMLButtonElement>('[data-panel-act="watch"]')!.click();
    expect(store.get().watchlist.map((w) => w.id)).toEqual(['ENCHANTED_GOLD']);
    expect(panel.querySelector('[data-panel-act="watch"]')!.getAttribute('aria-pressed')).toBe('true');
    // switching segment closes it
    segBtn('shops').click();
    await flush();
    expect(panel.hidden).toBe(true);
  });

  it('★ row action toggles the watchlist', async () => {
    mount();
    await flush();
    const starBtn = () => q<HTMLButtonElement>('tr[data-key="bz2npc:ENCHANTED_GOLD"] [data-action="watch"]');
    expect(starBtn().getAttribute('aria-pressed')).toBe('false');
    starBtn().click();
    expect(store.get().watchlist.map((w) => w.id)).toEqual(['ENCHANTED_GOLD']);
    await flush();
    expect(starBtn().getAttribute('aria-pressed')).toBe('true');
    expect(starBtn().textContent).toBe('★');
    expect(q('.kit-panel').hidden).toBe(true); // action clicks never activate the row
    starBtn().click();
    expect(store.get().watchlist).toEqual([]);
  });

  it('reacts to the NPC daily limit setting', async () => {
    mount({ snapshot, catalog, settings: { ...defaultSettings, hideSuspicious: false } });
    await flush();
    segBtn('npc2bz').click();
    await flush();
    const uph = () => ctx.derived.npc().find((r) => r.id === 'MELON' && r.direction === 'npc2bz')!.tp.unitsPerHour;
    const before = uph();
    store.set({ settings: { ...store.get().settings, npcDailyLimit: 64 } });
    await flush();
    expect(uph()).toBeLessThan(before);
    expect(q('.npc-dir-desc').textContent).toContain('64');
    expect(q('.npc-note').textContent).toContain('64 adet/gün');
  });

  it('shows loading / catalog error / waiting states', async () => {
    mount({ snapshot, catalog: null });
    await flush();
    expect(q('.npc-state').hidden).toBe(false);
    expect(q('.npc-state').textContent).toMatch(/katalog/i);
    expect(box('flips').querySelector('.tbl')!.hasAttribute('hidden')).toBe(true);
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
});

describe('npc view: shops', () => {
  it('lists shop offers with coins per currency (best first) and a rate explainer', async () => {
    const cat = shopCatalog();
    mount({ snapshot, catalog: cat, settings: { ...defaultSettings, hideSuspicious: false } }, { id: 'npc', query: { dir: 'shops' } });
    await flush();
    const rows = computeShopRows({ snap: snapshot, catalog: cat, settings: { ...defaultSettings } });
    const priced = rows.filter((r) => r.coinsPerCurrency != null).sort((a, b) => b.coinsPerCurrency! - a.coinsPerCurrency!);
    expect(rowKeys('shops')).toEqual([...priced.map((r) => r.key), ...rows.filter((r) => r.coinsPerCurrency == null).map((r) => r.key)]);
    const best = priced[0]!;
    const tr = q(`[data-testid="npc-shops"] tr[data-key="${best.key}"]`);
    expect(tr.textContent).toContain(fmtCoins(best.coinsPerCurrency));
    expect(tr.querySelector('.npc-cur')!.textContent).toMatch(/Copper|Bit/);
    expect(tr.querySelector('.src-bazaar, .src-npc')).not.toBeNull();
    // unpriced offer shows dashes and sorts last
    const unpriced = rows.find((r) => r.id === 'NOT_A_REAL_ITEM')!;
    expect(rowKeys('shops').at(-1)).toBe(unpriced.key);
    // explainer chips: "1 Copper ≈ N coin · Enchanted Gold"
    const copperBest = priced.find((r) => r.currency === 'SKYBLOCK_COPPER')!;
    const chip = q<HTMLButtonElement>('[data-testid="npc-rates"] [data-cur="SKYBLOCK_COPPER"]');
    expect(chip.textContent).toBe(`1 Copper ≈ ${fmtCoins(copperBest.coinsPerCurrency)} coin · ${copperBest.name}`);
  });

  it('filters by currency (select + chip) and search, writing the URL', async () => {
    mount({ snapshot, catalog: shopCatalog(), settings: { ...defaultSettings, hideSuspicious: false } }, { id: 'npc', query: { dir: 'shops' } });
    await flush();
    const sel = q<HTMLSelectElement>('select[data-filter="cur"]');
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'SKYBLOCK_BIT', 'SKYBLOCK_COPPER']);
    expect(sel.options[0]!.textContent).toBe('Tümü (4)');
    sel.value = 'SKYBLOCK_BIT';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(setQueryCalls()).toContainEqual({ cur: 'SKYBLOCK_BIT' });
    expect(rowKeys('shops').every((k) => k.includes('SKYBLOCK_BIT'))).toBe(true);
    expect(rowKeys('shops')).toHaveLength(2);
    // chip toggles the same filter
    q<HTMLButtonElement>('[data-testid="npc-rates"] [data-cur="SKYBLOCK_COPPER"]').click();
    await flush();
    expect(sel.value).toBe('SKYBLOCK_COPPER');
    expect(rowKeys('shops')).toHaveLength(2);
    expect(q('[data-testid="npc-rates"] [data-cur="SKYBLOCK_COPPER"]').getAttribute('aria-pressed')).toBe('true');
    q<HTMLButtonElement>('[data-testid="npc-rates"] [data-cur="SKYBLOCK_COPPER"]').click();
    await flush();
    expect(rowKeys('shops')).toHaveLength(4);
    // search matches the shop name too
    setInput(q<HTMLInputElement>('input[data-filter="sq"]'), 'elizabeth');
    await debounce();
    expect(setQueryCalls()).toContainEqual({ sq: 'elizabeth' });
    expect(rowKeys('shops')).toHaveLength(2);
    // URL-driven currency
    view.update!({ id: 'npc', query: { dir: 'shops', cur: 'SKYBLOCK_COPPER' } });
    await flush();
    expect(sel.value).toBe('SKYBLOCK_COPPER');
    expect(rowKeys('shops').every((k) => k.includes('SKYBLOCK_COPPER'))).toBe(true);
  });

  it('opens a shop detail with steps and the coins/currency line', async () => {
    const cat = shopCatalog();
    mount({ snapshot, catalog: cat, settings: { ...defaultSettings, hideSuspicious: false } }, { id: 'npc', query: { dir: 'shops' } });
    await flush();
    const r = computeShopRows({ snap: snapshot, catalog: cat, settings: { ...defaultSettings } }).find((x) => x.id === 'ENCHANTED_GOLD')!;
    q<HTMLElement>(`tr[data-key="${r.key}"] td.num`).click();
    const panel = q('.kit-panel');
    expect(panel.hidden).toBe(false);
    const steps = panel.querySelector('.npc-steps')!.textContent!;
    expect(steps).toContain('SkyMart dükkanında 10 Copper öde');
    expect(steps).toContain(`1 Copper ≈ ${fmtCoins(r.coinsPerCurrency)} coin`);
    // watch from row star on shops too
    q<HTMLButtonElement>(`tr[data-key="${r.key}"] [data-action="watch"]`).click();
    expect(store.get().watchlist.map((w) => w.id)).toEqual(['ENCHANTED_GOLD']);
  });

  it('shows an empty message when the catalog has no shops', async () => {
    mount({ snapshot, catalog }, { id: 'npc', query: { dir: 'shops' } });
    await flush();
    expect(q('[data-testid="npc-shops"] td.empty').textContent).toBe(t('npc.emptyShops'));
  });
});

describe('npc view: language and lifecycle', () => {
  it('switches language live and keeps TR/EN parity', async () => {
    mount();
    await flush();
    expect(box('flips').querySelector('th')!.textContent).toContain('Ürün');
    setLang('en');
    await flush();
    expect(q('h1').textContent).toBe('NPC & Shops');
    expect(box('flips').querySelector('th')!.textContent).toContain('Item');
    expect(segBtn('shops').textContent).toBe('Shops');
    expect(q('.npc-note').textContent).toContain('640/day');
  });

  it('unmount releases everything', async () => {
    mount();
    await flush();
    q<HTMLElement>('tr[data-key="bz2npc:ENCHANTED_GOLD"] td.num').click();
    view.unmount();
    expect(root.childElementCount).toBe(0);
    expect(root.classList.contains('kit-split')).toBe(false);
    expect(document.querySelector('.kit-panel')).toBeNull();
    store.set({ snapshot: { ...snapshot } });
    setLang('en');
    await flush();
    expect(root.childElementCount).toBe(0);
  });
});

describe('npc view: instant NPC leg, side-aware risk, ask cap and conservatism', () => {
  const panel = () => q('.kit-panel');

  it('NPC -> bazaar: the NPC purchase is instant and capped; only the sell side is risk-checked', async () => {
    mount({ snapshot, catalog }, { id: 'npc', query: { dir: 'npc2bz', hidden: '1' } });
    await flush();
    q<HTMLElement>('tr[data-key="npc2bz:MELON"] td.num').click();
    const steps = panel().querySelector('.npc-steps')!.textContent!;
    expect(steps).toMatch(/hemen al/);
    expect(steps).toMatch(/sipariş slotu yok/);
    const kv = panel().querySelector('dl.kv')!.textContent!;
    expect(kv).toContain('Alış süresianında');
    // npcDailyLimit / 24 per hour, x cycleHours per cycle
    const perHour = defaultSettings.npcDailyLimit / 24;
    expect(kv).toContain(`NPC alımı≈ saatte ${perHour.toLocaleString('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`);
    expect(panel().querySelector('.risk-scope')!.textContent).toMatch(/Yalnızca bazaar satış tarafı/);
  });

  it('bazaar -> NPC: only the buy side is risk-checked; the NPC sale is instant', async () => {
    mount();
    await flush();
    q<HTMLElement>('tr[data-key="bz2npc:ENCHANTED_GOLD"] td.num').click();
    expect(panel().querySelector('.risk-scope')!.textContent).toMatch(/Yalnızca bazaar alış tarafı/);
    expect(panel().querySelector('dl.kv')!.textContent).toContain('Satış süresianında');
    expect(panel().querySelector('[data-testid="npc-clamp"]')).toBeNull();
  });

  it('a buy order that would reach the ask is shown and planned as an insta-buy', async () => {
    const p = snapshot.products.ENCHANTED_GOLD!;
    const ask = p.bid! + 0.1;
    const snap: Snapshot = {
      ...snapshot,
      products: { ...snapshot.products, ENCHANTED_GOLD: { ...p, ask, asks: [{ price: ask, amount: 100_000, orders: 5 }] } },
    };
    mount({ snapshot: snap, catalog });
    await flush();
    const tr = q('tr[data-key="bz2npc:ENCHANTED_GOLD"]');
    expect(tr.querySelector('.src-insta')).not.toBeNull();
    expect(tr.querySelector('.flip-clamp')!.textContent).toBe('Ask sınırı');
    expect(tr.querySelector('.npc-floor')).toBeNull();
    q<HTMLElement>('tr[data-key="bz2npc:ENCHANTED_GOLD"] td.num').click();
    expect(panel().querySelector('.npc-steps li')!.textContent).toMatch(/insta-buy/i);
    expect(q('[data-testid="npc-clamp"]').textContent).toMatch(/sipariş slotu kullanmaz/);
  });

  it('marks rows adjusted by recent history and lists the changes', async () => {
    const p = snapshot.products.ENCHANTED_GOLD!;
    store = createStore<AppState>({ ...initialState({ ...defaultSettings }), snapshot, catalog });
    const stats = (id: string) =>
      id === 'ENCHANTED_GOLD' ? { n: 30, medianAsk: p.ask!, medianBid: p.bid! + 5, madAsk: 50, madBid: 50, change24h: null } : null;
    ctx = fakeViewCtx(store, fakeHistory({ stats }));
    view = createNpcView();
    view.mount(root, ctx, { id: 'npc' });
    await flush();
    expect(q('tr[data-key="bz2npc:ENCHANTED_GOLD"] .cons-badge')).not.toBeNull();
    q<HTMLElement>('tr[data-key="bz2npc:ENCHANTED_GOLD"] td.num').click();
    const line = panel().querySelector('[data-testid="cons-list"] li')!.textContent!;
    expect(line).toMatch(/^Alış fiyatı anlık veride/);
    expect(line).toContain(fmtCoins(p.bid! + 0.1).replace(/\D.*$/, ''));
  });
});

describe('npc helpers', () => {
  const settings = { ...defaultSettings };
  const flipDefaults = { q: '', minMargin: 1, minPph: null, minVol: null, hidden: false, sort: FLIP_SCHEMA.sort.def };

  it('filters flips by direction and counts suspects', () => {
    const rows = computeNpcFlips({ snap: snapshot, catalog, settings });
    const hidden = filterFlips(rows, 'npc2bz', flipDefaults, { snap: snapshot, catalog, settings });
    expect(hidden.rows).toEqual([]);
    expect(hidden.total).toBe(2);
    expect(hidden.suspect).toBe(2);
    const shown = filterFlips(rows, 'npc2bz', { ...flipDefaults, hidden: true }, { snap: snapshot, catalog, settings });
    expect(shown.rows.map((r) => r.id).sort()).toEqual(['MELON', 'WHEAT']);
    expect(shown.rows.every((r) => r.weekVol > 0)).toBe(true);
  });

  it('builds currency options and filters shops', () => {
    const cat = shopCatalog();
    const rows = computeShopRows({ snap: snapshot, catalog: cat, settings });
    const opts = currencyOptions(visibleShops(rows, false, false).rows, cat);
    expect(opts.map((o) => [o.id, o.count])).toEqual([
      ['SKYBLOCK_BIT', 2],
      ['SKYBLOCK_COPPER', 2],
    ]);
    expect(opts.find((o) => o.id === 'SKYBLOCK_BIT')!.best!.id).toBe('ENCHANTED_DIAMOND');
    const defaults = { sq: '', cur: '', svol: null, shidden: false, ssort: SHOP_SCHEMA.ssort.def };
    expect(filterShops(rows, { ...defaults, cur: 'SKYBLOCK_COPPER' }, cat, false).rows).toHaveLength(2);
    expect(filterShops(rows, { ...defaults, sq: 'copper' }, cat, false).rows).toHaveLength(2);
    expect(filterShops(rows, { ...defaults, svol: 1 }, cat, false).rows.every((r) => r.weekVol >= 1)).toBe(true);
  });

  it('migrates round-1 typed prefs to the query-state format', () => {
    localStorage.setItem(
      LS_VIEWPREFS + 'npc',
      JSON.stringify({ dir: 'npc2bz', q: 'gold', minMargin: 2, minPph: 0, showHidden: true, sort: { key: 'margin', dir: 'asc' } }),
    );
    migrateNpcPrefs();
    expect(JSON.parse(localStorage.getItem(LS_VIEWPREFS + 'npc')!)).toEqual({ q: 'gold', minMargin: '2', hidden: '1', sort: 'margin.asc' });
    expect(JSON.parse(localStorage.getItem(LS_VIEWPREFS + 'npc.seg')!)).toEqual({ dir: 'npc2bz' });
    migrateNpcPrefs(); // idempotent
    expect(JSON.parse(localStorage.getItem(LS_VIEWPREFS + 'npc')!).q).toBe('gold');
  });
});
