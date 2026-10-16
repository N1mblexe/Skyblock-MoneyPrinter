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
    expect(new Set(keys())).toEqual(new Set(want.map((r) => r.id)));
    expect(keys()).not.toContain('SMALL');
    expect(q('[data-testid="ahflip-count"]').textContent).toBe(t('ahflip.count', { n: want.length, total: all.length, count: all.length }));
  });

  it('a row opens the fee breakdown and copies the /viewauction command', async () => {
    store.set({ catalog, ah: AH });
    mount({ q: 'god' });
    await flush();
    expect(keys()).toEqual(['GOD_POTION_2']);
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
    expect(keys()).toContain('BLACK_CAT;5');
    const cb = q<HTMLInputElement>('.kit-filterbar input[data-filter="pets"]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(keys()).not.toContain('BLACK_CAT;5');
  });

  it('scan v3: max-level pet keys are not separate rows and their listings are counted once', async () => {
    const ah: AhSnapshot = {
      ...AH,
      v: 3,
      lowestBin: { ...AH.lowestBin, 'BLACK_CAT;5@MAX': { price: 90_000_000, next: 120_000_000, count: 4, name: '[Lvl 100] Black Cat', exp: 2.6e7 } },
    };
    expect(computeAhFlips(ah, catalog).map((r) => r.id)).toEqual(computeAhFlips(AH, catalog).map((r) => r.id));
    expect(ahListingCount(ah)).toBe(6 + 8 + 9 + 5);
    store.set({ catalog, ah, settings: { ...store.get().settings, hideSuspicious: false } });
    mount({ minProfit: '0', minMargin: '0' });
    await flush();
    expect(q('.ahf-state').hidden).toBe(true);
    expect(keys()).toContain('BLACK_CAT;5');
    expect(keys()).not.toContain('BLACK_CAT;5@MAX');
    expect(q('.ahf-scan').textContent).toContain(String(6 + 8 + 9 + 5));
  });
});
