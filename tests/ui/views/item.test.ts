// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_VIEWPREFS } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import '../../../src/i18n/common.ts';
import { dictKeys, setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type {
  AppState,
  Catalog,
  HistoryPoint,
  HistoryRange,
  HistoryRepo,
  Route,
  Snapshot,
  Store,
  View,
  ViewContext,
} from '../../../src/types/contracts.ts';
import { bookRows, createItemView, searchProducts } from '../../../src/ui/views/item/itemView.ts';
import { lineChartSvg, nearestIndex, timeTicks } from '../../../src/ui/views/item/lineChart.ts';
import bazaarJson from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';
import { ctxExtras, historyExtras } from '../../helpers/fakes.ts';

const SNAP: Snapshot = toSnapshot(validateRaw(bazaarJson as unknown), 1_700_000_000_000, 'fixture');
const CATALOG: Catalog = catalogFromFile(validateCatalogFile(catalogJson as unknown));

const flush = () => new Promise((r) => setTimeout(r, 30));
const T0 = 1_700_000_000_000;

function pts(n: number): HistoryPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: T0 + i * 60_000,
    bid: 300 + i,
    ask: 320 + i * 2,
    instaBuysWeek: 0,
    instaSellsWeek: 0,
    buyOrders: 1,
    sellOrders: 1,
  }));
}

function fakeHistory() {
  const repo = {
    seriesCalls: [] as [string, HistoryRange][],
    data: new Map<string, HistoryPoint[]>([['ENCHANTED_MELON', pts(6)]]),
    init: async () => {},
    record: async () => {},
    series: async (id: string, range: HistoryRange) => {
      repo.seriesCalls.push([id, range]);
      return repo.data.get(id) ?? [];
    },
    recent: () => [],
    stats: (id: string) => (id === 'ENCHANTED_MELON' ? { n: 30, medianAsk: 325, medianBid: 300, madAsk: 1, madBid: 1, change24h: 0.05 } : null),
    saveLatest: async () => {},
    loadLatest: async () => null,
    ...historyExtras,
  };
  return repo satisfies HistoryRepo;
}

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let history: ReturnType<typeof fakeHistory>;
let ctx: ViewContext;

const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const bookRowCount = () => root.querySelectorAll('[data-testid="order-book"] tbody tr[data-key]').length;

async function mount(id: string, patch: Partial<AppState> = { snapshot: SNAP, catalog: CATALOG }) {
  store.set(patch);
  view = createItemView();
  view.mount(root, ctx, { id: 'item', param: id });
  await flush();
}

beforeEach(() => {
  setLang('tr');
  localStorage.clear();
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  history = fakeHistory();
  ctx = {
    store,
    history,
    navigate: vi.fn((r: Route) => view.update?.(r)),
    t,
    refresh: async () => {},
    ...ctxExtras(store, history),
  };
});

afterEach(() => {
  view?.unmount();
  document.body.innerHTML = '';
  setLang('tr');
});

describe('item view i18n', () => {
  it('TR and EN have identical keys', () => {
    const { tr, en } = dictKeys('item');
    expect(tr.length).toBeGreaterThan(30);
    expect(en).toEqual(tr);
  });
});

describe('item view', () => {
  it('shows a loading message before the snapshot arrives, then renders', async () => {
    await mount('ENCHANTED_MELON', {});
    expect(q('.item-msg').hidden).toBe(false);
    expect(q('.item-msg').textContent).toContain('bekleniyor');
    expect(q('[data-testid="price-chart"] svg')).toBeTruthy();
    store.set({ snapshot: SNAP });
    await flush();
    expect(q('.item-msg').hidden).toBe(true);
    expect(q('[data-testid="item-name"]').textContent).toBe('Enchanted Melon');
  });

  it('renders facts, risk, order book, chart and recipes', async () => {
    await mount('ENCHANTED_MELON');
    const p = SNAP.products.ENCHANTED_MELON!;
    expect(q('.item-head').textContent).toContain('ENCHANTED_MELON');
    // order book: both sides, top levels (fixture has 5 per side)
    expect(bookRowCount()).toBe(Math.min(10, p.bids.length) + Math.min(10, p.asks.length));
    const facts = q('.item-facts').textContent!;
    expect(facts).toContain('quick_status');
    expect(facts).toContain('%5,0'); // 24h change from stats
    // risk flags all listed
    const flags = root.querySelectorAll('.item-flags li').length;
    expect(flags).toBeGreaterThan(0);
    expect(q('[data-testid="item-risk"] .badge')).toBeTruthy();
    // chart with both lines
    expect(history.seriesCalls).toEqual([['ENCHANTED_MELON', '24h']]);
    expect(root.querySelectorAll('[data-testid="price-chart"] path.lc-line')).toHaveLength(2);
    // recipes producing (from MELON) and using (ENCHANTED_MELON_BLOCK)
    const out = q('[data-testid="recipes-out"]');
    expect(out.querySelector('a[href="#/item/MELON"]')).toBeTruthy();
    expect(out.querySelector('a[href="#/craft?q=ENCHANTED_MELON"]')).toBeTruthy();
    const inn = q('[data-testid="recipes-in"]');
    expect(inn.querySelector('a[href="#/item/ENCHANTED_MELON_BLOCK"]')).toBeTruthy();
    expect(inn.querySelector('a[href="#/craft?q=ENCHANTED_MELON_BLOCK"]')).toBeTruthy();
  });

  it('notes the NPC floor on dead-bid raw materials', async () => {
    await mount('GOLD_INGOT');
    expect(q('[data-testid="npc-floor"]')).toBeTruthy();
    view.update!({ id: 'item', param: 'ENCHANTED_GOLD' });
    await flush();
    expect(root.querySelectorAll('[data-testid="npc-floor"]').length).toBe(0);
  });

  it('switches items via update() without remounting and refetches history', async () => {
    await mount('ENCHANTED_MELON');
    const viewEl = q('[data-testid="item-view"]');
    view.update!({ id: 'item', param: 'ENCHANTED_GOLD' });
    await flush();
    expect(q('[data-testid="item-view"]')).toBe(viewEl);
    expect(q('[data-testid="item-name"]').textContent).toBe('Enchanted Gold');
    expect(history.seriesCalls.at(-1)).toEqual(['ENCHANTED_GOLD', '24h']);
    // no history -> empty frame with message, still an svg
    expect(q('[data-testid="price-chart"] svg .lc-empty').textContent).toContain('sayfayı açık tut');
  });

  it('range buttons refetch and persist; historyTick refetches', async () => {
    await mount('ENCHANTED_MELON');
    q<HTMLButtonElement>('[data-range="7d"]').click();
    await flush();
    expect(history.seriesCalls.at(-1)).toEqual(['ENCHANTED_MELON', '7d']);
    expect(q('[data-range="7d"]').getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem(LS_VIEWPREFS + 'item')!)).toEqual({ range: '7d' });
    const n = history.seriesCalls.length;
    store.set((s) => ({ historyTick: s.historyTick + 1 }));
    await flush();
    expect(history.seriesCalls.length).toBe(n + 1);
  });

  it('shows a friendly message for unknown ids', async () => {
    await mount('NOT_A_REAL_ITEM');
    expect(q('.item-msg').hidden).toBe(false);
    expect(q('.item-msg').textContent).toContain('NOT_A_REAL_ITEM');
    expect(q('[data-testid="item-search"]')).toBeTruthy();
  });

  it('search box suggests bazaar items and navigates', async () => {
    await mount('ENCHANTED_MELON');
    const inp = q<HTMLInputElement>('[data-testid="item-search"]');
    inp.value = 'gold ing';
    inp.dispatchEvent(new Event('input'));
    expect(q('.item-sugg').hidden).toBe(false);
    expect(q('.item-sugg a').getAttribute('href')).toBe('#/item/GOLD_INGOT');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(ctx.navigate).toHaveBeenCalledWith({ id: 'item', param: 'GOLD_INGOT' });
    await flush();
    expect(q('[data-testid="item-name"]').textContent).toBe('Gold Ingot');
    expect(inp.value).toBe('');
  });

  it('switches language', async () => {
    await mount('ENCHANTED_MELON');
    setLang('en');
    await flush();
    expect(q('[data-testid="order-book"] h3').textContent).toBe('Order book');
    expect(q('[data-range="3h"]').textContent).toBe('3h');
    expect(q('[data-testid="recipes-out"] h3').textContent).toBe('Recipes producing this');
  });

  it('shows catalog state when recipes are missing', async () => {
    await mount('ENCHANTED_MELON', { snapshot: SNAP, catalogError: 'boom' });
    expect(q('[data-testid="recipes-out"]').textContent).toContain('boom');
    expect(bookRowCount()).toBeGreaterThan(0);
  });

  it('unmount cleans up and stops reacting to the store', async () => {
    await mount('ENCHANTED_MELON');
    view.unmount();
    expect(root.children.length).toBe(0);
    const n = history.seriesCalls.length;
    store.set((s) => ({ historyTick: s.historyTick + 1, snapshot: { ...SNAP } }));
    await flush();
    expect(history.seriesCalls.length).toBe(n);
    expect(root.children.length).toBe(0);
    view = { id: 'item', mount() {}, unmount() {} };
  });
});

describe('item helpers', () => {
  it('bookRows accumulates amount and coins', () => {
    const rows = bookRows(
      [
        { price: 10, amount: 2, orders: 1 },
        { price: 9, amount: 3, orders: 2 },
      ],
      'b',
    );
    expect(rows.map((r) => [r.cumAmount, r.cumCoins])).toEqual([
      [2, 20],
      [5, 47],
    ]);
  });

  it('searchProducts ranks catalog matches and works without a catalog', () => {
    expect(searchProducts(SNAP, CATALOG, 'melon')[0]).toBe('MELON');
    expect(searchProducts(SNAP, null, 'ink sack')).toContain('INK_SACK:4');
    expect(searchProducts(SNAP, CATALOG, '  ')).toEqual([]);
  });

  it('lineChartSvg draws an empty frame for <2 points and lines otherwise', () => {
    const base = { emptyText: 'empty', ariaLabel: 'x', fmtY: String, fmtX: (t: number) => String(t), fmtTip: String };
    const empty = lineChartSvg({ ...base, ts: [1], lines: [{ key: 'bid', label: 'b', cls: 'lc-bid', values: [1] }] }, 400);
    expect(empty.svg).toContain('<svg');
    expect(empty.svg).toContain('empty');
    expect(empty.geo).toBeNull();
    const p = pts(5);
    const full = lineChartSvg(
      {
        ...base,
        ts: p.map((x) => x.ts),
        lines: [
          { key: 'bid', label: 'b', cls: 'lc-bid', values: p.map((x) => x.bid) },
          { key: 'ask', label: 'a', cls: 'lc-ask', values: [NaN, NaN, 1, 2, 3] },
        ],
      },
      400,
    );
    expect(full.svg.match(/class="lc-line/g)).toHaveLength(2);
    expect(full.svg).toContain('>304<'); // y max label
    expect(full.svg).toContain('>1<'); // y min label
  });

  it('breaks lines over long gaps', () => {
    const ts = [0, 60_000, 120_000, 180_000, 10 * 3600_000, 10 * 3600_000 + 60_000];
    const out = lineChartSvg(
      { ts, lines: [{ key: 'bid', label: 'b', cls: 'lc-bid', values: [1, 2, 3, 4, 5, 6] }], emptyText: '', ariaLabel: '', fmtY: String, fmtX: String, fmtTip: String },
      400,
    );
    const d = /d="([^"]+)"/.exec(out.svg)![1]!;
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it('nearestIndex', () => {
    expect(nearestIndex([0, 10, 20], 4)).toBe(0);
    expect(nearestIndex([0, 10, 20], 6)).toBe(1);
    expect(nearestIndex([0, 10, 20], 100)).toBe(2);
    expect(nearestIndex([5], 0)).toBe(0);
  });

  it('timeTicks picks round steps within the tick budget', () => {
    const start = Date.UTC(2026, 0, 1, 10, 7);
    const ticks = timeTicks(start, start + 3 * 3600_000, 4);
    expect(ticks.length).toBeLessThanOrEqual(4);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    const step = ticks[1]! - ticks[0]!;
    expect(step % (5 * 60_000)).toBe(0);
    expect(ticks.every((t) => t >= start && t <= start + 3 * 3600_000)).toBe(true);
    expect(timeTicks(5, 5, 4)).toEqual([5]);
  });
});
