// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_SELL } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import { sellOptions } from '../../../src/domain/sell.ts';
import { setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AppState, Catalog, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { fmtCoins } from '../../../src/ui/format.ts';
import { createSellView, loadSellList } from '../../../src/ui/views/sell/sellView.ts';
import bazaarJson from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext;
let snap: Snapshot;
let catalog: Catalog;
const flush = () => new Promise((r) => setTimeout(r, 30));
const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;

function addItem(text: string, qty: string): void {
  q<HTMLInputElement>('[data-sell-item]').value = text;
  q<HTMLInputElement>('[data-sell-newqty]').value = qty;
  q<HTMLFormElement>('.sell-form').dispatchEvent(new Event('submit', { cancelable: true }));
}

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  snap = toSnapshot(validateRaw(structuredClone(bazaarJson) as never), Date.now(), 'fixture');
  catalog = catalogFromFile(validateCatalogFile(structuredClone(catalogJson)));
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  ctx = fakeViewCtx(store, fakeHistory(), { t });
  view = createSellView();
});
afterEach(() => {
  view.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('sell view', () => {
  it('adds items by name, shows every option best first with the total, and saves the list', async () => {
    store.set({ snapshot: snap, catalog });
    view.mount(root, ctx, { id: 'sell' });
    expect(q('h1').textContent).toBe('Sell or craft?');
    expect(q('.sell-list').textContent).toContain(t('sell.empty'));
    addItem('melon', '5000');
    await flush();
    expect(loadSellList()).toEqual([{ id: 'MELON', qty: 5000 }]);
    const card = q('.sell-card[data-id="MELON"]');
    const want = sellOptions(ctx.derived.calcCtx()!, 'MELON', 5000);
    expect(want.options.length).toBeGreaterThan(1);
    const methods = [...card.querySelectorAll<HTMLElement>('tbody tr')].map((r) => r.dataset.method);
    expect(methods).toEqual(want.options.map((o) => o.method));
    expect(card.querySelector('tbody tr')!.classList.contains('sell-best')).toBe(true);
    expect(q('[data-testid="sell-total"]').textContent).toBe(t('sell.total', { value: fmtCoins(want.options[0]!.net) }));
    // a craft option names where the crafted items are sold
    const craft = want.options.find((o) => o.craft)!;
    expect(craft).toBeDefined();
    const tr = card.querySelector<HTMLElement>(`tbody tr[data-method="craft"]`)!;
    expect(tr.textContent).toContain(t(`sell.craftSold_${craft.craft!.venue}`, { price: fmtCoins(craft.craft!.saleNet) }));
  });

  it('unknown names and bad quantities are refused; qty edits and removal persist', async () => {
    store.set({ snapshot: snap, catalog });
    localStorage.setItem(LS_SELL, JSON.stringify([{ id: 'MELON', qty: 100 }]));
    view.mount(root, ctx, { id: 'sell' });
    addItem('no such thing', '5');
    expect(ctx.toast).toHaveBeenCalledWith(t('sell.unknown', { text: 'no such thing' }), 'err');
    addItem('melon', '0');
    expect(ctx.toast).toHaveBeenCalledWith(t('sell.badQty'), 'err');
    const qty = q<HTMLInputElement>('[data-sell-qty="MELON"]');
    qty.value = '320';
    qty.dispatchEvent(new Event('change', { bubbles: true }));
    expect(loadSellList()).toEqual([{ id: 'MELON', qty: 320 }]);
    q<HTMLButtonElement>('[data-sell-remove="MELON"]').click();
    expect(loadSellList()).toEqual([]);
  });
});
