// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import { computeAhFlips } from '../../../src/domain/ahFlips.ts';
import { setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AhSnapshot, AppState, Catalog, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { createAhFlipView, filterAhFlips } from '../../../src/ui/views/ahflip/ahflipView.ts';
import { ahListingCount } from '../../../src/ui/views/ahflip/model.ts';
import catalogJson from '../../fixtures/catalog.json';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';
import { fmtCoins, fmtHours, fmtNum } from '../../../src/ui/format.ts';

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext;
let catalog: Catalog;
const flush = () => new Promise((r) => setTimeout(r, 30));
const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const keys = () => [...root.querySelectorAll<HTMLElement>('.ahf-table tbody tr[data-key]')].map((r) => r.dataset.key!);

const AH: AhSnapshot = {
  v: 2,
  fetchedAt: Date.now() - 60_000,
  lastUpdated: 0,
  lowestBin: {
    HYPERION: { price: 500_000_000, next: 560_000_000, count: 6, uuid: 'abc', name: 'Hyperion' },
    GOD_POTION_2: { price: 1_000_000, next: 1_400_000, count: 8, uuid: 'def', name: 'God Potion' },
    SMALL: { price: 1_000, next: 1_200, count: 9 }, // under the default min profit
    'BLACK_CAT;5': { price: 50_000_000, next: 80_000_000, count: 5, name: '[Lvl 1] Black Cat' },
  },
};

function mount(query?: Record<string, string>): void {
  view = createAhFlipView();
  view.mount(root, ctx, { id: 'ahflip', ...(query ? { query } : {}) });
}

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  catalog = catalogFromFile(validateCatalogFile(structuredClone(catalogJson)));
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  ctx = fakeViewCtx(store, fakeHistory(), { t });
});
afterEach(() => {
  view.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('AH flips view', () => {
  it('explains the off / waiting / old-scan states and can turn the scan on', async () => {
    store.set({ settings: { ...store.get().settings, ahEnabled: false }, catalog });
    mount();
    expect(q('h1').textContent).toBe('AH flips');
    expect(q('.ahf-state').textContent).toContain(t('ahflip.off'));
    q<HTMLButtonElement>('[data-ahf-on]').click();
    expect(store.get().settings.ahEnabled).toBe(true);
    await flush();
    expect(q('.ahf-state').textContent).toContain(t('ahflip.waiting'));
    store.set({ ah: { ...AH, v: undefined } });
    await flush();
    expect(q('.ahf-state').textContent).toContain(t('ahflip.oldScan'));
  });

  it('lists the domain rows that pass the default filters', async () => {
    store.set({ catalog, ah: AH });
    mount();
    await flush();
    const all = computeAhFlips(AH, catalog);
    const want = filterAhFlips(
      all,
      { q: '', minProfit: 100_000, minMargin: 5, minCount: 5, pets: true, hideSuspect: store.get().settings.hideSuspicious },
      catalog,
    ).rows;
    expect(new Set(keys())).toEqual(new Set(want.map((r) => r.key)));
    expect(keys()).not.toContain('ah:SMALL');
    expect(q('[data-testid="ahflip-count"]').textContent).toBe(t('ahflip.count', { n: want.length, total: all.length, count: all.length }));
  });

  it('a row opens the fee breakdown and copies the /viewauction command', async () => {
    store.set({ catalog, ah: AH });
    mount({ q: 'god' });
    await flush();
    expect(keys()).toEqual(['ah:GOD_POTION_2']);
    root.querySelector<HTMLElement>('.ahf-table tbody tr[data-key]')!.click();
    const panel = q('.kit-panel');
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain(t('ahflip.d_fee'));
    const write = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } });
    panel.querySelector<HTMLButtonElement>('[data-ahf-copy]')!.click();
    await flush();
    expect(write).toHaveBeenCalledWith('/viewauction def');
    vi.unstubAllGlobals();
  });

  it('hiding pets drops pet rows', async () => {
    store.set({ catalog, ah: AH, settings: { ...store.get().settings, hideSuspicious: false } });
    mount({ minProfit: '0', minMargin: '0' });
    await flush();
    expect(keys()).toContain('ah:BLACK_CAT;5');
    const cb = q<HTMLInputElement>('.kit-filterbar input[data-filter="pets"]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(keys()).not.toContain('ah:BLACK_CAT;5');
  });

  it('max-level pet keys are rows of their own, marked; level keys are counted once', async () => {
    const ah: AhSnapshot = {
      ...AH,
      v: 4,
      lowestBin: {
        ...AH.lowestBin,
        'BLACK_CAT;5@MAX': { price: 90_000_000, next: 120_000_000, count: 4, name: '[Lvl 100] Black Cat', exp: 2.6e7 },
        'BLACK_CAT;5@L49': { price: 50_000_000, next: 80_000_000, count: 1, name: '[Lvl 1] Black Cat' },
      },
    };
    expect(computeAhFlips(ah, catalog).map((r) => r.id).sort()).toEqual([...computeAhFlips(AH, catalog).map((r) => r.id), 'BLACK_CAT;5@MAX'].sort());
    expect(ahListingCount(ah)).toBe(6 + 8 + 9 + 5);
    store.set({ catalog, ah, settings: { ...store.get().settings, hideSuspicious: false } });
    mount({ minProfit: '0', minMargin: '0', minCount: '3' });
    await flush();
    expect(q('.ahf-state').hidden).toBe(true);
    expect(keys()).toContain('ah:BLACK_CAT;5');
    expect(keys()).toContain('ah:BLACK_CAT;5@MAX');
    expect(keys()).not.toContain('ah:BLACK_CAT;5@L49');
    expect(q('.ahf-table tbody tr[data-key="ah:BLACK_CAT;5@MAX"] [data-ahf-max]')).not.toBeNull();
    expect(q('.ahf-scan').textContent).toContain(String(6 + 8 + 9 + 5));
  });

  it('sell time: measured AH sales, else a marked guess; the detail explains a stack and the median cap', async () => {
    const ah: AhSnapshot = { ...AH, v: 4, lowestBin: { GOD_POTION_2: { price: 1_000_000, next: 1_400_000, count: 8, stack: 2, uuid: 'def' }, HYPERION: AH.lowestBin.HYPERION! } };
    const stat = { n: 9, items: 9, median: 1_300_000, perHour: 4, coverageHours: 6, last: 0 };
    store.set({
      catalog,
      ah,
      ahSales: { v: 1, updatedAt: 0, coverageHours: 6, byId: { GOD_POTION_2: stat } },
      settings: { ...store.get().settings, conservative: true },
    });
    mount();
    await flush();
    const god = q('.ahf-table tbody tr[data-key="ah:GOD_POTION_2"]');
    expect(god.textContent).toContain(fmtHours(0.5));
    expect(god.querySelector('[data-ahf-stack]')).not.toBeNull();
    expect(q('.ahf-table tbody tr[data-key="ah:HYPERION"]').textContent).toContain(`~${fmtHours(4)}`);
    god.click();
    const panel = q('.kit-panel');
    expect(panel.textContent).toContain(t('ahflip.d_stackNote', { n: '2', total: fmtCoins(2_000_000) }));
    expect(panel.textContent).toContain(t('ahflip.d_medianCap', { ref: fmtCoins(1_399_999) }));
    expect(panel.textContent).toContain(t('ahflip.perHour', { n: fmtNum(4, 2) }));
    q<HTMLElement>('.ahf-table tbody tr[data-key="ah:HYPERION"]').click();
    expect(panel.textContent).toContain(t('ahflip.d_noSales'));
  });

  it('George mode: pets below his price, sold at once; the listing filter does not apply', async () => {
    const george = { ...catalog, george: { 'BLACK_CAT;5': 60_000_000, 'BEE;1': 500 } };
    const ah: AhSnapshot = { ...AH, v: 4, lowestBin: { ...AH.lowestBin, 'BEE;1': { price: 200, count: 1, prices: [200] } } };
    store.set({ catalog: george, ah, settings: { ...store.get().settings, hideSuspicious: false } });
    mount({ mode: 'george', minProfit: '0' });
    await flush();
    expect(keys().sort()).toEqual(['george:BEE;1', 'george:BLACK_CAT;5']);
    expect(q('.ahf-table thead').textContent).toContain(t('ahflip.col_george'));
    expect(q('.ahf-table tbody tr[data-key="george:BEE;1"]').textContent).toContain(t('ahflip.instant'));
    q<HTMLElement>('.ahf-table tbody tr[data-key="george:BLACK_CAT;5"]').click();
    const panel = q('.kit-panel');
    expect(panel.textContent).toContain(t('ahflip.d_george'));
    expect(panel.textContent).toContain(t('ahflip.georgeCaveat'));
    expect(panel.textContent).not.toContain(t('ahflip.d_fee'));
    // back to relisting
    const seg = root.querySelector<HTMLElement>('.kit-filterbar [data-filter="mode"] [data-value="relist"]');
    expect(seg).not.toBeNull();
    seg!.click();
    await flush();
    expect(keys().every((k) => k.startsWith('ah:'))).toBe(true);
    expect(q('.ahf-table thead').textContent).toContain(t('ahflip.col_next'));
  });
});
