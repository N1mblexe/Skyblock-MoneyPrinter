// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LS_VIEWPREFS } from '../../../src/config.ts';
import { setLang } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AppState, BookRule, Catalog, Product, Route, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { combineSteps, createBooksView } from '../../../src/ui/views/books/booksView.ts';
import { buildCatalog, makeProduct } from '../../domain/helpers.ts';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';

// tests/domain/helpers.ts reads fixtures via import.meta.url, which is root-relative ('/tests/...') under happy-dom's
// web transform. Map those paths onto the project root (no-op once helpers.ts resolves them itself).
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  const fix = (p: unknown) => (typeof p === 'string' && p.startsWith('/tests/') ? process.cwd() + p : p);
  return { ...fs, default: fs, readFileSync: (p: string, ...a: unknown[]) => (fs.readFileSync as (...x: unknown[]) => unknown)(fix(p), ...a) };
});

const UW = 'ENCHANTMENT_ULTIMATE_WISE';
const SH = 'ENCHANTMENT_SHARPNESS';
const PR = 'ENCHANTMENT_PROTECTION';

const lvl = (price: number) => ({ price, amount: 5000, orders: 10 });
const book = (id: string, bid: number, ask: number): Product =>
  makeProduct({ id, bids: [lvl(bid), lvl(bid - 0.1)], asks: [lvl(ask), lvl(ask + 0.1)], quick: { buyPrice: ask, sellPrice: bid } });

const SNAP: Snapshot = {
  lastUpdated: 0,
  fetchedAt: 0,
  source: 'fixture',
  products: Object.fromEntries(
    [
      // Ultimate Wise: only level 2 on sale below 5 -> chain 2 -> 5 (x8), verified (anvil max 5)
      book(`${UW}_2`, 1000, 1100),
      book(`${UW}_5`, 20_000, 21_000),
      // Sharpness 5 -> 6: profitable but above the curated anvil max (5) -> unverified
      book(`${SH}_5`, 140, 150),
      book(`${SH}_6`, 250, 300),
      // Protection 1 -> 2, verified
      book(`${PR}_1`, 10, 11),
      book(`${PR}_2`, 40, 50),
      makeProduct({ id: 'ENCHANTED_MELON' }),
    ].map((p) => [p.id, p]),
  ),
};

const RULES: Record<string, BookRule> = {
  [UW]: { maxLevel: 5, verified: true },
  [SH]: { maxLevel: 5, verified: true },
  [PR]: { maxLevel: 5, verified: true },
};

function catalogWith(rules: Record<string, BookRule>): Catalog {
  const c = buildCatalog({ v: 2, generatedAt: '', items: {}, recipes: [] });
  return { ...c, bookRule: (base) => rules[base] ?? null };
}
const CATALOG = catalogWith(RULES);

const flush = () => new Promise((r) => setTimeout(r, 30));

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext & { setQuery: ReturnType<typeof vi.fn>; toast: ReturnType<typeof vi.fn> };

const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const rowKeys = () => [...root.querySelectorAll<HTMLElement>('tbody tr[data-key]')].map((r) => r.dataset.key!);
const banner = () => q('[data-testid="books-unverified"]');
const panel = () => q('.kit-panel');
function toggle(key: string) {
  const inp = q<HTMLInputElement>(`input[data-filter="${key}"]`);
  inp.checked = !inp.checked;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
}
function mount(route: Route = { id: 'books' }) {
  view.mount(root, ctx, route);
}

beforeEach(() => {
  localStorage.clear();
  setLang('tr');
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  ctx = fakeViewCtx(store, fakeHistory()) as never;
  view = createBooksView();
});
afterEach(() => {
  view.unmount();
  document.body.innerHTML = '';
  setLang('tr');
});

describe('books view', () => {

  it('combineSteps halves down to one', () => {
    expect(combineSteps(8)).toEqual([4, 2, 1]);
    expect(combineSteps(2)).toEqual([1]);
    expect(combineSteps(16).reduce((a, b) => a + b, 0)).toBe(15);
  });

  it('shows loading states, then verified rows only by default', async () => {
    mount();
    expect(q('h1').textContent).toBe('Kitap birleştirme');
    expect(q('[data-testid="books-msg"]').textContent).toBe('Fiyat verisi bekleniyor…');
    store.set({ snapshot: SNAP, catalog: CATALOG });
    await flush();
    expect(q('[data-testid="books-msg"]').hidden).toBe(true);
    expect(rowKeys().sort()).toEqual([`${PR}_2`, `${UW}_5`]);
    expect(q('[data-testid="books-count"]').textContent).toBe('2 kitap');
    expect(q<HTMLInputElement>('input[data-filter="ver"]').checked).toBe(true);
    expect(banner().hidden).toBe(true);
    expect(q('th.sorted').textContent).toContain('Kâr / saat');
  });

  it('chain cell reads "k → L (×count)" with a verified badge', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    const tr = q(`tr[data-key="${UW}_5"]`);
    expect(tr.querySelector('.book-chain')!.textContent).toBe('2 → 5 (×8)');
    expect(tr.textContent).toContain('Ultimate Wise V');
    expect(tr.querySelector('.book-ver')!.textContent).toBe('Doğrulanmış');
  });

  it('unticking "verified only" writes the URL, shows unverified rows and the banner', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    toggle('ver');
    expect(ctx.setQuery).toHaveBeenLastCalledWith({ ver: '0' });
    await flush();
    expect(rowKeys()).toContain(`${SH}_6`);
    expect(q(`tr[data-key="${SH}_6"] .book-ver`).textContent).toBe('Doğrulanmamış');
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('scripts/data/book-rules.json');
    expect(banner().textContent).toMatch(/örs/);
    expect(JSON.parse(localStorage.getItem(LS_VIEWPREFS + 'books')!)).toMatchObject({ ver: '0' });
  });

  it('URL state drives the verified filter on mount and update()', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount({ id: 'books', query: { ver: '0' } });
    expect(banner().hidden).toBe(false);
    expect(rowKeys()).toHaveLength(3);
    view.update!({ id: 'books', query: { ver: '1', minMargin: '0' } });
    await flush();
    expect(banner().hidden).toBe(true);
    expect(rowKeys()).toHaveLength(2);
    expect(q<HTMLInputElement>('input[data-filter="ver"]').checked).toBe(true);
  });

  it('the empty table explains hidden unverified rows', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount({ id: 'books', query: { q: 'sharpness' } });
    await flush();
    expect(rowKeys()).toHaveLength(0);
    expect(q('td.empty').textContent).toContain('1 doğrulanmamış');
  });

  it('opens a detail panel with the chain explainer, rule, plan, order books and links (TR + EN)', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    (q(`tr[data-key="${UW}_5"] td.num`) as HTMLElement).click();
    expect(panel().hidden).toBe(false);
    expect(q('.kit-panel-title').textContent).toBe('Ultimate Wise V');
    const chain = () => q('[data-testid="books-chain"]').textContent;
    expect(chain()).toBe('8 × Ultimate Wise II al → örste 4+2+1 kez birleştir → Ultimate Wise V');
    expect(panel().textContent).toContain('7 birleştirme');
    expect(panel().textContent).toContain('XP');
    expect(panel().textContent).toContain('Örs sınırı 5');
    expect(panel().querySelectorAll('.dp-steps li')).toHaveLength(3);
    expect(panel().querySelectorAll('.dp-book table')).toHaveLength(4);
    expect(panel().querySelector(`a[href="#/item/${UW}_2"]`)).not.toBeNull();
    expect(panel().querySelector(`a[href="#/item/${UW}_5"]`)).not.toBeNull();

    setLang('en');
    expect(chain()).toBe('Buy 8 × Ultimate Wise II → combine on anvil 4+2+1 times → Ultimate Wise V');
    expect(panel().textContent).toContain('Anvil max 5');
  });

  it('explains a zero-size batch instead of planning 0 books', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG, settings: { ...store.get().settings, capital: 1 } });
    mount();
    (q(`tr[data-key="${UW}_5"] td.num`) as HTMLElement).click();
    expect(panel().querySelector('.dp-steps')).toBeNull();
    expect(q('[data-testid="plan-zero"]').textContent).toContain('Sermaye');
  });

  it('★ row action and the panel button toggle the watchlist', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    q<HTMLButtonElement>(`tr[data-key="${PR}_2"] button[data-action="watch"]`).click();
    expect(store.get().watchlist.map((w) => w.id)).toEqual([`${PR}_2`]);
    expect(ctx.toast).toHaveBeenCalledWith(expect.stringContaining('Protection II'), 'ok');
    expect(panel().hidden).toBe(true);
    (q(`tr[data-key="${PR}_2"] td.num`) as HTMLElement).click();
    q<HTMLButtonElement>('.kit-panel [data-panel="watch"]').click();
    expect(store.get().watchlist).toHaveLength(0);
  });

  it('explains when the catalog has no book rules', async () => {
    store.set({ snapshot: SNAP, catalog: catalogWith({}) });
    mount();
    const msg = q('[data-testid="books-msg"]');
    expect(msg.hidden).toBe(false);
    expect(msg.dataset.state).toBe('noRules');
    expect(msg.textContent).toContain('kural');
    toggle('ver');
    await flush();
    expect(msg.hidden).toBe(true);
    expect(rowKeys()).toHaveLength(3);
    expect(banner().hidden).toBe(false);
  });

  it('unmount removes DOM, panel and listeners', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    (q(`tr[data-key="${UW}_5"] td.num`) as HTMLElement).click();
    view.unmount();
    expect(root.children).toHaveLength(0);
    expect(document.querySelector('.kit-panel, .kit-backdrop')).toBeNull();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    expect(store.get().watchlist).toHaveLength(0);
    store.set({ snapshot: { ...SNAP } });
    setLang('en');
    await flush();
    expect(root.children).toHaveLength(0);
  });
});

describe('books view: slots, the ask cap, conservatism and side-aware risk', () => {
  it('shows the order slots a chain takes (input buy order + output sell offer)', async () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    const col = [...root.querySelectorAll('thead th')].findIndex((th) => th.textContent!.includes('Slot'));
    expect(col).toBeGreaterThan(0);
    const cell = q(`tr[data-key="${UW}_5"]`).children[col]!;
    expect(Number(cell.textContent)).toBeGreaterThanOrEqual(2);
    (q(`tr[data-key="${UW}_5"] td.num`) as HTMLElement).click();
    expect(panel().textContent).toContain('çıktı kitabı başına 8 kitap');
    // sell side of the output, ingredient flags of the input
    expect(panel().querySelector('.risk-scope')!.textContent).toMatch(/Çıktı kitabının satış tarafı/);
    expect(panel().querySelector('[data-testid="books-clamp"]')).toBeNull();
  });

  it('an input order capped at the ask is planned as an insta-buy', async () => {
    // Protection I: bid 10, ask 10.1 -> a buy order at 10.1 would reach the ask
    const snap: Snapshot = { ...SNAP, products: { ...SNAP.products, [`${PR}_1`]: book(`${PR}_1`, 10, 10.1) } };
    store.set({ snapshot: snap, catalog: CATALOG });
    mount();
    (q(`tr[data-key="${PR}_2"] td.num`) as HTMLElement).click();
    const steps = [...panel().querySelectorAll('.dp-steps li')].map((li) => li.textContent);
    expect(steps[0]).toMatch(/insta-buy/);
    expect(q('[data-testid="books-clamp"]').textContent).toContain('Ask sınırı');
  });

  it('marks rows adjusted by recent history and lists the changes', async () => {
    view.unmount();
    // recent medians: the output sold lower, the input cost more than the snapshot (wide MADs: no price spike)
    const stats = (id: string) =>
      id === `${UW}_5`
        ? { n: 30, medianAsk: 20_500, medianBid: 20_000, madAsk: 1000, madBid: 1000, change24h: null }
        : id === `${UW}_2`
          ? { n: 30, medianAsk: 1100, medianBid: 1050, madAsk: 100, madBid: 100, change24h: null }
          : null;
    ctx = fakeViewCtx(store, fakeHistory({ stats })) as never;
    view = createBooksView();
    store.set({ snapshot: SNAP, catalog: CATALOG });
    mount();
    expect(q(`tr[data-key="${UW}_5"] .cons-badge`).textContent).toBe('Ayarlı');
    (q(`tr[data-key="${UW}_5"] td.num`) as HTMLElement).click();
    const lines = [...panel().querySelectorAll('[data-testid="cons-list"] li')].map((li) => li.textContent!);
    expect(lines[0]).toMatch(/^Alış fiyatı anlık veride 1[.,]000[.,]1 → 1[.,]050[.,]1/);
    expect(lines[1]).toMatch(/^Satış fiyatı anlık veride 20[.,]999[.,]9 → 20[.,]499[.,]9/);
  });
});
