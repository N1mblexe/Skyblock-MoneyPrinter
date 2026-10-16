// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { KAT } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import { computeKatFlips, type KatRow } from '../../../src/domain/kat.ts';
import { setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AhSnapshot, AppState, Catalog, PetLeveling, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { esc } from '../../../src/ui/dom.ts';
import { createKatView, filterKat, katDetail, rarityName } from '../../../src/ui/views/kat/katView.ts';
import { KAT_MAX_TAMING, type KatFilters } from '../../../src/ui/views/kat/model.ts';
import bazaarJson from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext;
let catalog: Catalog;
let snap: Snapshot;
const flush = () => new Promise((r) => setTimeout(r, 30));
const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const keys = () => [...root.querySelectorAll<HTMLElement>('.kat-table tbody tr[data-key]')].map((r) => r.dataset.key!);

const LEVELING: PetLeveling = {
  offsets: { COMMON: 0, UNCOMMON: 6, RARE: 11, EPIC: 16, LEGENDARY: 20, MYTHIC: 20 },
  levels: Array.from({ length: 119 }, (_, i) => (i + 1) * 100),
  custom: {},
};

const AH: AhSnapshot = {
  v: 3,
  fetchedAt: Date.now() - 60_000,
  lastUpdated: 0,
  lowestBin: {
    'OCELOT;3@MAX': { price: 3_000_000, count: 5, exp: 653_400, uuid: 'abc', name: '[Lvl 100] Ocelot' },
    'OCELOT;4': { price: 6_000_000, count: 10, name: '[Lvl 1] Ocelot' },
    'OCELOT;4@MAX': { price: 9_000_000, count: 10 },
    'OCELOT;5': { price: 12_000_000, count: 10 },
    'OCELOT;5@MAX': { price: 20_000_000, count: 10 },
    'BEE;0': { price: 1_000, count: 10 },
    'BEE;1': { price: 900_000, count: 10 },
    PET_ITEM_X: { price: 100_000, count: 4 },
    [KAT.flowerId]: { price: 1_000, count: 9 },
  },
};

function mount(query?: Record<string, string>): void {
  view = createKatView();
  view.mount(root, ctx, { id: 'kat', ...(query ? { query } : {}) });
}

const ready = (over: Partial<AppState> = {}) => store.set({ catalog, snapshot: snap, ah: AH, ...over });

function openRow(key: string): HTMLElement {
  const tr = root.querySelector<HTMLElement>(`.kat-table tbody tr[data-key="${CSS.escape(key)}"]`);
  if (!tr) throw new Error(`row ${key} not shown: ${keys().join(', ')}`);
  tr.click();
  const panel = q('.kit-panel');
  expect(panel.hidden).toBe(false);
  return panel;
}

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  snap = toSnapshot(validateRaw(structuredClone(bazaarJson) as never), Date.now(), 'fixture');
  const base = catalogFromFile(validateCatalogFile(structuredClone(catalogJson)));
  catalog = {
    ...base,
    kat: [
      { pet: 'OCELOT', from: 3, to: 4, coins: 1_000_000, hours: 130, items: [] },
      { pet: 'OCELOT', from: 4, to: 5, coins: 2_000_000, hours: 10, items: [{ id: 'PET_ITEM_X', qty: 1 }] },
      { pet: 'BEE', from: 0, to: 1, coins: 1_000, hours: 1, items: [{ id: 'NOWHERE_ITEM', qty: 3 }] },
    ],
    petLeveling: LEVELING,
    petNames: { OCELOT: 'Ocelot', BEE: 'Bee' },
  };
  store = createStore(initialState({ ...defaultSettings, ahEnabled: true, hideSuspicious: true }));
  root = document.createElement('div');
  document.body.append(root);
  ctx = fakeViewCtx(store, fakeHistory(), { t });
});
afterEach(() => {
  view.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('Kat view', () => {
  it('explains the off / waiting / old-scan / no-data states and can turn the scan on', async () => {
    store.set({ settings: { ...store.get().settings, ahEnabled: false }, catalog, snapshot: snap });
    mount();
    expect(q('h1').textContent).toBe('Kat upgrades');
    expect(q('h1').getAttribute('tabindex')).toBe('-1');
    expect(q('.kat-state').textContent).toContain(t('kat.off'));
    q<HTMLButtonElement>('[data-kat-on]').click();
    expect(store.get().settings.ahEnabled).toBe(true);
    await flush();
    expect(q('.kat-state').textContent).toContain(t('kat.waiting'));
    store.set({ ah: { ...AH, v: 2 } });
    await flush();
    expect(q('.kat-state').textContent).toContain(t('kat.oldScan'));
    store.set({ ah: AH, snapshot: null });
    await flush();
    expect(q('.kat-state').textContent).toContain(t('kat.waitingData'));
    store.set({ snapshot: snap, catalog: { ...catalog, kat: [] } });
    await flush();
    expect(q('.kat-state').textContent).toContain(t('kat.noData'));
    expect(q('.kat-tools').hidden).toBe(true);
    store.set({ catalog });
    await flush();
    expect(q('.kat-state').hidden).toBe(true);
    expect(keys().length).toBeGreaterThan(0);
  });

  it('lists the domain rows that pass the default filters, with the count', async () => {
    ready();
    mount();
    await flush();
    const c = ctx.derived.calcCtx()!;
    const all = computeKatFlips(c);
    const filters: KatFilters = {
      q: '',
      minProfit: 100_000,
      maxCapital: null,
      maxHours: null,
      band: 'both',
      showUnpriced: false,
      hideSuspect: true,
    };
    const want = filterKat(all, filters, catalog).rows;
    expect(new Set(keys())).toEqual(new Set(want.map((r) => r.key)));
    expect(keys()).toEqual(expect.arrayContaining(['OCELOT;3>4:max', 'OCELOT;3>5:max', 'OCELOT;4>5:any', 'OCELOT;4>5:max']));
    // the Bee upgrade needs an item nobody sells: hidden until unpriced rows are shown
    expect(keys()).not.toContain('BEE;0>1:any');
    expect(q('[data-testid="kat-count"]').textContent).toBe(t('kat.count', { n: want.length, total: all.length, count: all.length }));
    // default sort: coins per hour, best first
    const pph = want.map((r) => r.profitPerHour).sort((a, b) => b - a);
    expect(keys()[0]).toBe(want.find((r) => r.profitPerHour === pph[0])!.key);
    expect(root.textContent).toContain('Epic → Legendary');
    expect(root.textContent).toContain('Lvl 100 → 96');
  });

  it('filters: band, max hours, max capital, search, unpriced', async () => {
    ready();
    mount({ band: 'max' });
    await flush();
    expect(keys().every((k) => k.endsWith(':max'))).toBe(true);
    view.update!({ id: 'kat', query: { maxHours: '50' } });
    await flush();
    expect(new Set(keys())).toEqual(new Set(['OCELOT;4>5:any', 'OCELOT;4>5:max']));
    view.update!({ id: 'kat', query: { maxCapital: '5000000' } });
    await flush();
    expect(keys()).toEqual(['OCELOT;3>4:max']);
    view.update!({ id: 'kat', query: { q: 'bee', unpriced: '1' } });
    await flush();
    expect(keys()).toEqual(['BEE;0>1:any']);
    expect(root.textContent).toContain(t('kat.noPrice'));
  });

  it('the Taming field reads and writes settings.taming, shared with derived.kat()', async () => {
    store.set({ settings: { ...store.get().settings, taming: 20 } });
    ready();
    mount({ band: 'max', taming: '60' });
    await flush();
    const inp = q<HTMLInputElement>('.kit-filterbar input[data-setting="taming"]');
    expect(inp.value).toBe('20');
    // Mythic needs Taming 25; the old URL param is ignored
    expect(keys()).toEqual(['OCELOT;3>4:max']);
    expect(ctx.derived.kat().every((r) => r.to < 5)).toBe(true);
    inp.value = String(KAT_MAX_TAMING);
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().settings.taming).toBe(KAT_MAX_TAMING);
    await flush();
    expect(keys()).toContain('OCELOT;3>5:max');
    // with the skip option the page computes its own rows, for the same Taming level
    const cb = q<HTMLInputElement>('.kit-filterbar input[data-filter="skip"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(keys()).toContain('OCELOT;3>5:max');
    store.set({ settings: { ...store.get().settings, taming: 20 } });
    await flush();
    expect(keys()).toEqual(['OCELOT;3>4:max']);
    expect(inp.value).toBe('20');
    // invalid: flagged, not written
    inp.value = '61';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    expect(inp.getAttribute('aria-invalid')).toBe('true');
    expect(store.get().settings.taming).toBe(20);
  });

  it('the rows without skip items are derived.kat(), kept across display-only setting changes', async () => {
    ready();
    mount();
    await flush();
    const rows = ctx.derived.kat();
    const spy = vi.spyOn(ctx.derived, 'kat');
    store.set({ settings: { ...store.get().settings, theme: 'light', density: 'compact' } });
    await flush();
    expect(spy).toHaveBeenCalled();
    expect(ctx.derived.kat()).toBe(rows);
  });

  it('the skip toggle buys Kat Flowers and shortens the wait', async () => {
    ready();
    mount({ maxHours: '20' });
    await flush();
    expect(keys()).not.toContain('OCELOT;3>4:max');
    const cb = q<HTMLInputElement>('.kit-filterbar input[data-filter="skip"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(keys()).toContain('OCELOT;3>4:max');
    const panel = openRow('OCELOT;3>4:max');
    expect(panel.textContent).toContain(t('kat.d_skip'));
    expect(panel.textContent).toContain('5× Kat Flower');
  });

  it('a row opens the per-step breakdown and copies the /viewauction command', async () => {
    ready();
    mount();
    await flush();
    const panel = openRow('OCELOT;3>5:max');
    expect(panel.textContent).toContain('Ocelot: Epic → Mythic');
    expect(panel.querySelectorAll('.kat-step')).toHaveLength(2);
    const first = panel.querySelector('.kat-step')!.textContent!;
    expect(first).toContain('Lvl 100 → 96');
    expect(first).toContain('list price');
    expect(panel.querySelectorAll('.kat-step')[1]!.textContent).toContain('Pet Item X');
    expect(panel.textContent).toContain(t('kat.sellVariant', { rarity: 'Mythic', level: 96 }));
    const write = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } });
    panel.querySelector<HTMLButtonElement>('[data-kat-copy]')!.click();
    await flush();
    expect(write).toHaveBeenCalledWith('/viewauction abc');
    expect(ctx.toast).toHaveBeenCalledWith(t('kat.copied', { cmd: '/viewauction abc' }), 'ok');
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    panel.querySelector<HTMLButtonElement>('[data-kat-copy]')!.click();
    await flush();
    expect(ctx.toast).toHaveBeenCalledWith(t('kat.copyFail'), 'err');
    vi.unstubAllGlobals();
    // the panel follows a re-render (new scan) while open
    store.set({ ah: { ...AH, fetchedAt: AH.fetchedAt + 1 } });
    await flush();
    expect(q('.kit-panel').hidden).toBe(false);
  });

  it('re-labels on a language switch', async () => {
    ready();
    mount();
    await flush();
    setLang('tr');
    await flush();
    expect(q('h1').textContent).toBe(t('kat.title'));
    expect(q('.kat-intro').textContent).toBe(t('kat.intro'));
    setLang('en');
  });
});

describe('katDetail', () => {
  const row = (over: Partial<KatRow> = {}): KatRow => {
    const c = { ...ctx.derived.calcCtx()! };
    const r = computeKatFlips(c).find((x) => x.key === 'BEE;0>1:any')!;
    return { ...r, ...over };
  };

  it('notes unknown levels, unpriced items and Derpy; no copy button without a listing id', () => {
    ready();
    const html = katDetail(row({ levelKnown: false }), true);
    expect(html).toContain(esc(t('kat.levelGuess')));
    expect(html).toContain(t('kat.derpy'));
    expect(html).toContain('NOWHERE_ITEM');
    expect(html).not.toContain('data-kat-copy');
  });

  it('rarity names', () => {
    expect(rarityName(0)).toBe('Common');
    expect(rarityName(5)).toBe('Mythic');
    expect(rarityName(9)).toBe('9');
  });
});
