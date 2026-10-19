// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BITS, LS_BITS } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import { computeBitsRows } from '../../../src/domain/bits.ts';
import { setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AhSnapshot, AppState, Catalog, ItemInfo, ShopOffer, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { fmtCoins, fmtInt } from '../../../src/ui/format.ts';
import { createBitsView, filterBitsRows } from '../../../src/ui/views/bits/bitsView.ts';
import { legacyMultiplier, parseBitsPrefs, rankOf } from '../../../src/ui/views/bits/model.ts';
import catalogJson from '../../fixtures/catalog.json';
import { makeProduct } from '../../domain/helpers.ts';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext;
let catalog: Catalog;
const flush = () => new Promise((r) => setTimeout(r, 30));
const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const keys = () => [...root.querySelectorAll<HTMLElement>('.bits-table tbody tr[data-key]')].map((r) => r.dataset.key!);
const statText = (k: string) => q(`[data-stat="${k}"] .bits-stat-v`).textContent!.trim();

const item = (id: string, name: string, o: Partial<ItemInfo> = {}): ItemInfo => ({ id, name, bazaar: false, ...o });
const bit = (output: string, costQty: number, outQty = 1): ShopOffer => ({ shop: 'Elizabeth', currency: BITS.currency, costQty, output, outQty });

const snap: Snapshot = {
  lastUpdated: 0,
  fetchedAt: Date.now(),
  source: 'fixture',
  products: {
    BOOSTER_COOKIE: makeProduct({ id: 'BOOSTER_COOKIE', bids: [{ price: 2_000_000, amount: 500, orders: 20 }], asks: [{ price: 2_100_000, amount: 500, orders: 20 }] }),
    KISMET_FEATHER: makeProduct({ id: 'KISMET_FEATHER', bids: [{ price: 1_400_000, amount: 50, orders: 10 }], asks: [{ price: 1_500_000, amount: 50, orders: 10 }] }),
    ENCHANTMENT_COMPACT_1: makeProduct({ id: 'ENCHANTMENT_COMPACT_1', bids: [{ price: 2_000_000, amount: 50, orders: 10 }], asks: [{ price: 2_200_000, amount: 50, orders: 10 }] }),
    INFERNO_FUEL_BLOCK: makeProduct({ id: 'INFERNO_FUEL_BLOCK', bids: [{ price: 900, amount: 5000, orders: 10 }], asks: [{ price: 1000, amount: 5000, orders: 10 }] }),
  },
};

const AH: AhSnapshot = {
  v: 3,
  fetchedAt: Date.now() - 60_000,
  lastUpdated: 0,
  lowestBin: {
    GOD_POTION_2: { price: 3_000_000, next: 3_100_000, count: 40 },
    KISMET_FEATHER: { price: 1_600_000, next: 1_650_000, count: 20 },
  },
};

function buildCatalog(): Catalog {
  const base = catalogFromFile(validateCatalogFile(structuredClone(catalogJson)));
  const items: Record<string, ItemInfo> = {
    ...base.items,
    BOOSTER_COOKIE: item('BOOSTER_COOKIE', 'Booster Cookie', { bazaar: true }),
    KISMET_FEATHER: item('KISMET_FEATHER', 'Kismet Feather', { bazaar: true, auctionable: true }),
    ENCHANTMENT_COMPACT_1: item('ENCHANTMENT_COMPACT_1', 'Compact I', { bazaar: true }),
    INFERNO_FUEL_BLOCK: item('INFERNO_FUEL_BLOCK', 'Inferno Fuel Block', { bazaar: true }),
    GOD_POTION_2: item('GOD_POTION_2', 'God Potion', { auctionable: true }),
    HYPER_CATALYST_UPGRADE: item('HYPER_CATALYST_UPGRADE', 'Hyper Catalyst Upgrade', { npcSell: 500, auctionable: true }),
    FLOWER_SACK: item('FLOWER_SACK', 'Flower Sack', { category: 'SACK' }),
  };
  return {
    ...base,
    items,
    name: (id) => items[id]?.name ?? base.name(id),
    shops: [
      bit('KISMET_FEATHER', 1350),
      bit('ENCHANTMENT_COMPACT_1', 4000),
      bit('INFERNO_FUEL_BLOCK', 75, 2),
      bit('GOD_POTION_2', 1500),
      bit('HYPER_CATALYST_UPGRADE', 300),
      bit('FLOWER_SACK', 14_000),
      { shop: 'Adventurer', currency: 'SKYBLOCK_COIN', costQty: 10, output: 'KISMET_FEATHER', outQty: 1 },
    ],
    untradeable: new Set(['FLOWER_SACK']),
  };
}

function mount(query?: Record<string, string>): void {
  view = createBitsView();
  view.mount(root, ctx, { id: 'bits', ...(query ? { query } : {}) });
}

const setCustom = (v: string) => {
  const inp = q<HTMLInputElement>('[data-bits-custom]');
  inp.value = v;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
};
const pickRank = (rank: string) => {
  const sel = q<HTMLSelectElement>('[data-bits-rank]');
  sel.value = rank;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
};

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  catalog = buildCatalog();
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  ctx = fakeViewCtx(store, fakeHistory(), { t });
});
afterEach(() => {
  view?.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('bits prefs', () => {
  it('cleans stored prefs', () => {
    expect(parseBitsPrefs(null)).toEqual({ rank: 'New Player', custom: null });
    expect(parseBitsPrefs({ rank: 'Patron', custom: 2.5 })).toEqual({ rank: 'Patron', custom: 2.5 });
    expect(parseBitsPrefs({ rank: 'Nope', custom: -1 })).toEqual({ rank: 'New Player', custom: null });
    expect(parseBitsPrefs({ rank: 'Senator', custom: 'x' })).toEqual({ rank: 'Senator', custom: null });
  });
});

describe('bits view', () => {
  it('waits for prices and the catalog', () => {
    mount();
    expect(q('h1').textContent).toBe('Bits shop');
    expect(q('h1').getAttribute('tabindex')).toBe('-1');
    expect(q('.bits-state').textContent).toContain(t('bits.waiting'));
    expect(q('.bits-stats').hidden).toBe(true);
  });

  it('rank select and custom multiplier drive the stats through settings.bitsMultiplier', async () => {
    store.set({ snapshot: snap, catalog, ah: AH });
    mount();
    await flush();
    const sel = q<HTMLSelectElement>('[data-bits-rank]');
    expect(sel.options).toHaveLength(BITS.fameRanks.length + 1);
    expect(sel.options[5]!.textContent).toBe('Patron (×1.6)');
    expect(sel.value).toBe('New Player');
    expect(statText('bitsPerCookie')).toBe(fmtInt(4800));
    expect(q('[data-testid="bits-using"]').textContent).toBe(t('bits.usingRank', { mult: '1', rank: 'New Player' }));

    pickRank('Patron');
    await flush();
    expect(store.get().settings.bitsMultiplier).toBe(1.6);
    expect(statText('bitsPerCookie')).toBe(fmtInt(7680));
    expect(statText('costPerBit')).toBe(fmtCoins(2_000_000.1 / 7680));

    setCustom('2.5');
    await flush();
    expect(store.get().settings.bitsMultiplier).toBe(2.5);
    expect(statText('bitsPerCookie')).toBe(fmtInt(12_000));
    expect(q('[data-testid="bits-using"]').textContent).toBe(t('bits.usingCustom', { mult: '2.5' }));
    expect(sel.value).toBe('');

    // invalid input (or out of 1..5) is flagged and ignored; an empty one is left alone
    for (const v of ['abc', '9', '0.5']) {
      setCustom(v);
      expect(q('[data-bits-custom]').getAttribute('aria-invalid'), v).toBe('true');
    }
    setCustom('');
    expect(store.get().settings.bitsMultiplier).toBe(2.5);

    // a remount reads the setting; a custom value equal to a rank shows the rank
    view.unmount();
    mount();
    await flush();
    expect(q<HTMLSelectElement>('[data-bits-rank]').value).toBe('');
    expect(q<HTMLInputElement>('[data-bits-custom]').value).toBe('2.5');
    setCustom('2.2');
    await flush();
    expect(q<HTMLSelectElement>('[data-bits-rank]').value).toBe('Minister');

    // "Custom" keeps the value and moves to the input; a rank replaces a custom value
    const s0 = store.get().settings.bitsMultiplier;
    pickRank('');
    expect(store.get().settings.bitsMultiplier).toBe(s0);
    expect(document.activeElement).toBe(q('[data-bits-custom]'));
    pickRank('Imperator');
    await flush();
    expect(store.get().settings.bitsMultiplier).toBe(2.38);

    // the setting changed elsewhere (another tab, Settings import) shows here
    store.set({ settings: { ...store.get().settings, bitsMultiplier: 1.1 } });
    await flush();
    expect(q<HTMLSelectElement>('[data-bits-rank]').value).toBe('Settler');
  });

  it('moves the old LS_BITS prefs into settings.bitsMultiplier once', async () => {
    localStorage.setItem(LS_BITS, JSON.stringify({ rank: 'Patron', custom: null }));
    store.set({ snapshot: snap, catalog, ah: AH });
    mount();
    await flush();
    expect(store.get().settings.bitsMultiplier).toBe(1.6);
    expect(localStorage.getItem(LS_BITS)).toBeNull();
    // never over a value already set; clamped to 1..5
    view.unmount();
    localStorage.setItem(LS_BITS, JSON.stringify({ rank: 'Patron', custom: 9 }));
    mount();
    expect(store.get().settings.bitsMultiplier).toBe(1.6);
    expect(localStorage.getItem(LS_BITS)).toBeNull();
    expect(legacyMultiplier({ rank: 'Patron', custom: 9 })).toBe(5);
    expect(legacyMultiplier(null)).toBeNull();
    expect(legacyMultiplier({ rank: 'Nope' })).toBe(1);
    expect(rankOf(1.6)).toBe('Patron');
    expect(rankOf(1.65)).toBeNull();
  });

  it('shows the basket one cookie buys', async () => {
    store.set({ snapshot: snap, catalog, ah: AH });
    mount();
    await flush();
    const res = computeBitsRows(ctx.derived.calcCtx()!);
    expect(statText('basket')).toBe(fmtCoins(res.summary.basket.coins));
    const lines = [...root.querySelectorAll<HTMLElement>('.bits-basket [data-basket]')].map((l) => l.dataset.basket);
    expect(lines).toEqual(res.summary.basket.lines.map((l) => l.row.key));
    root.querySelector<HTMLButtonElement>('.bits-basket [data-bits-open]')!.click();
    expect(q('.kit-panel').textContent).toContain(res.summary.basket.lines[0]!.row.name);
    expect(q('.kit-panel').textContent).toContain(t('bits.d_rate'));
    // nothing sells: an empty basket
    store.set({ catalog: { ...catalog, shops: [] } });
    await flush();
    expect(q('.bits-basket').textContent).toContain(t('bits.b_empty'));
  });

  it('lists the valued rows, best coins per bit first, with the summary', async () => {
    store.set({ snapshot: snap, catalog, ah: AH });
    mount();
    await flush();
    const res = computeBitsRows(ctx.derived.calcCtx()!);
    const want = filterBitsRows(res.rows, { q: '', minCpb: null, src: 'all', unsold: false, hideSuspect: true }, catalog).rows;
    expect(keys()).toEqual(want.map((r) => r.key));
    expect(keys()).not.toContain('FLOWER_SACK|14000');
    expect(q('[data-testid="bits-count"]').textContent).toBe(t('bits.count', { n: want.length, total: res.rows.length, count: res.rows.length }));
    expect(statText('best')).toBe(res.summary.best!.name);
    expect(statText('profit')).toBe(fmtCoins(res.summary.profitPerCookie));
    const kismet = q('.bits-table tbody tr[data-key="KISMET_FEATHER|1350"]');
    expect(kismet.textContent).toContain(t('bits.src_ah'));
    expect(q('.bits-table tbody tr[data-key="INFERNO_FUEL_BLOCK|75"]').textContent).toContain('×2');
  });

  it('filters: source, min coins per bit, search, untradeable', async () => {
    store.set({ snapshot: snap, catalog, ah: AH });
    mount({ src: 'ah' });
    await flush();
    expect(keys().sort()).toEqual(['GOD_POTION_2|1500', 'KISMET_FEATHER|1350']);
    view.unmount();
    mount({ src: 'bazaar', minCpb: '500' });
    await flush();
    expect(keys()).toEqual(['ENCHANTMENT_COMPACT_1|4000']);
    view.unmount();
    mount({ q: 'catalyst' });
    await flush();
    expect(keys()).toEqual(['HYPER_CATALYST_UPGRADE|300']);
    view.unmount();
    mount();
    await flush();
    const cb = q<HTMLInputElement>('.kit-filterbar input[data-filter="unsold"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(keys()).toContain('FLOWER_SACK|14000');
    expect(keys().at(-1)).toBe('FLOWER_SACK|14000');
  });

  it('AH scan off: bazaar/NPC rows stay, a hint turns the scan on', async () => {
    store.set({ snapshot: snap, catalog, ah: null, settings: { ...store.get().settings, ahEnabled: false } });
    mount();
    await flush();
    expect(q('.bits-hint').hidden).toBe(false);
    expect(q('.bits-hint').textContent).toContain(t('bits.ahOff'));
    expect(keys()).toContain('ENCHANTMENT_COMPACT_1|4000');
    expect(keys()).toContain('HYPER_CATALYST_UPGRADE|300');
    expect(keys()).not.toContain('GOD_POTION_2|1500');
    q<HTMLButtonElement>('[data-bits-ah-on]').click();
    expect(store.get().settings.ahEnabled).toBe(true);
    await flush();
    expect(q('.bits-hint').textContent).toContain(t('bits.ahWaiting'));
    store.set({ ah: AH });
    await flush();
    expect(q('.bits-hint').hidden).toBe(true);
    expect(keys()).toContain('GOD_POTION_2|1500');
  });

  it('a row opens how its value was computed, with the quotes that lost', async () => {
    store.set({ snapshot: snap, catalog, ah: AH });
    mount();
    await flush();
    q<HTMLElement>('.bits-table tbody tr[data-key="KISMET_FEATHER|1350"]').click();
    const panel = q('.kit-panel');
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain(t('bits.d_how'));
    const srcs = [...panel.querySelectorAll<HTMLElement>('.bits-quotes tbody tr')].map((r) => r.dataset.src);
    expect(srcs).toEqual(['ah', 'bazaar']);
    expect(panel.querySelector('.bits-win')!.textContent).toContain(t('bits.d_best'));
    expect(panel.textContent).toContain(t('bits.d_ahNote'));
    expect(panel.querySelector('a[href="#/item/KISMET_FEATHER"]')).not.toBeNull();

    // the multiplier changes vs cookie in the open panel
    const before = panel.textContent;
    pickRank('Imperator');
    await flush();
    expect(panel.textContent).not.toBe(before);
  });

  it('untradeable rows explain why they have no value; the best-item link opens its row', async () => {
    store.set({ snapshot: snap, catalog, ah: AH });
    mount({ unsold: '1' });
    await flush();
    q<HTMLElement>('.bits-table tbody tr[data-key="FLOWER_SACK|14000"]').click();
    expect(q('.kit-panel').textContent).toContain(t('bits.d_untradeable'));
    q<HTMLButtonElement>('[data-bits-open]').click();
    const best = computeBitsRows(ctx.derived.calcCtx()!, { multiplier: 1 }).summary.best!;
    expect(q('.kit-panel').textContent).toContain(best.name);
    expect(q('.bits-table tr.sel, .bits-table [aria-selected="true"]')?.getAttribute('data-key')).toBe(best.key);
  });

  it('follows a language switch', async () => {
    store.set({ snapshot: snap, catalog, ah: AH });
    mount();
    await flush();
    setLang('tr');
    await flush();
    expect(q('h1').textContent).toBe(t('bits.title'));
    expect(q('.bits-rank-lbl').textContent).toBe(t('bits.rank'));
    setLang('en');
  });
});
