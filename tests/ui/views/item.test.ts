// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_VIEWPREFS } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import { setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type {
  AhSnapshot,
  AppState,
  MarketStat,
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
import { flipPlanFor } from '../../../src/domain/alerts.ts';
import { fmtPct } from '../../../src/ui/format.ts';
import { alertPrefill, alertValueFromInput, fmtPrice, fmtTrend, isBookId } from '../../../src/ui/views/item/helpers.ts';
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
    expect(q('[data-testid="order-book"] h2').textContent).toBe('Order book');
    expect(q('[data-range="3h"]').textContent).toBe('3h');
    expect(q('[data-testid="recipes-out"] h2').textContent).toBe('Recipes producing this');
    expect(q('[data-testid="item-watch"]').textContent).toBe('☆ Watch');
    expect(q('[data-testid="item-flip"] h2').textContent).toBe('Your flip');
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


describe('item view: your flip, stats, AH, shard', () => {
  const dd = (card: string, k: string) => q(`[data-testid="${card}"] dd[data-k="${k}"]`).textContent;

  it('has a single h1 (the item name) and h2 card headings', async () => {
    await mount('ENCHANTED_MELON');
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    expect(q('h1').textContent).toBe('Enchanted Melon');
    expect(root.querySelectorAll('.item-facts h2').length).toBeGreaterThan(3);
  });

  it('"your flip" matches the Flips tab in order mode, with hours and slots', async () => {
    await mount('ENCHANTED_MELON');
    const row = ctx.derived.flips().find((r) => r.id === 'ENCHANTED_MELON');
    const plan = flipPlanFor('ENCHANTED_MELON', ctx.derived.calcCtx()!)!;
    const buy = row?.buyAt ?? plan.buy.price;
    expect(dd('item-flip', 'buy')).toBe(fmtPrice(buy));
    expect(dd('item-flip', 'sell')).toBe(fmtPrice(row?.sellAt ?? plan.sell.price));
    expect(dd('item-flip', 'profit')).toBe(fmtPrice(row?.profit ?? plan.profit));
    if (row) {
      expect(root.querySelector('[data-testid="item-flip"] dd[data-k="buyHours"]')).toBeTruthy();
      expect(dd('item-flip', 'sellHours')).not.toBe('');
      expect(dd('item-flip', 'slots')).toBe(String(row.tp.slots));
    }
    expect(q('[data-testid="flip-mode"]').textContent).toContain('buy order');
  });

  it('"your flip" follows insta cost and sell modes (same numbers as flipPlanFor / the Flips tab)', async () => {
    await mount('ENCHANTED_MELON');
    const orderBuy = dd('item-flip', 'buy');
    store.set((s) => ({ settings: { ...s.settings, costMode: 'insta', sellMode: 'insta' } }));
    await flush();
    const plan = flipPlanFor('ENCHANTED_MELON', ctx.derived.calcCtx()!)!;
    const row = ctx.derived.flips().find((r) => r.id === 'ENCHANTED_MELON');
    expect(plan.buy.price).toBe(row?.buyAt ?? plan.buy.price);
    expect(dd('item-flip', 'buy')).toBe(fmtPrice(plan.buy.price));
    expect(dd('item-flip', 'sell')).toBe(fmtPrice(plan.sell.price));
    expect(dd('item-flip', 'net')).toBe(fmtPrice(plan.sell.net));
    expect(dd('item-flip', 'buy')).not.toBe(orderBuy);
    const p = SNAP.products.ENCHANTED_MELON!;
    expect(plan.buy.price).toBeGreaterThanOrEqual(p.ask!); // insta-buy pays the ask (or more), not bid + tick
    expect(q('[data-testid="flip-mode"]').textContent).toContain('insta-buy');
    expect(q('[data-testid="item-flip"]').textContent).toContain('Insta-buy ile alış');
    // the NPC-floor banner only applies to buy orders
    view.update!({ id: 'item', param: 'GOLD_INGOT' });
    await flush();
    expect(root.querySelectorAll('[data-testid="npc-floor"]').length).toBe(0);
  });

  it('marks unprofitable flips as not on the Flips tab', async () => {
    await mount('ENCHANTED_MELON');
    const losing = Object.keys(SNAP.products).find(
      (id) => !ctx.derived.flips().some((r) => r.id === id) && flipPlanFor(id, ctx.derived.calcCtx()!) != null,
    );
    expect(losing).toBeTruthy();
    if (!losing) return;
    view.update!({ id: 'item', param: losing });
    await flush();
    expect(q('[data-testid="not-on-flip"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="item-flip"] dd[data-k="pph"]')).toBeNull();
  });

  it('market-stats card shows the cross-item stats, volume trend labelled as an estimate', async () => {
    const stat: MarketStat = {
      id: 'ENCHANTED_MELON',
      n: 40,
      change1h: -0.02,
      change24h: 0.05,
      volatility: 0.031,
      spreadMedian: 0.08,
      consistency: 0.75,
      buyVolTrend: 1.25,
      sellVolTrend: 0.8,
    };
    history.marketStats = () => new Map([['ENCHANTED_MELON', stat]]);
    await mount('ENCHANTED_MELON');
    expect(dd('item-stats', 'consistency')).toBe(fmtPct(0.75));
    expect(dd('item-stats', 'spreadMedian')).toBe(fmtPct(0.08));
    expect(dd('item-stats', 'volatility')).toBe(fmtPct(0.031));
    expect(dd('item-stats', 'buyVolTrend')).toBe(fmtTrend(1.25));
    expect(q('[data-testid="item-stats"] dd[data-k="change1h"]').classList.contains('neg')).toBe(true);
    expect(q('[data-testid="item-stats"]').textContent).toContain('tahmin');
    expect(q('[data-testid="item-stats"]').textContent).toContain('40');
  });

  it('market-stats card without history says so', async () => {
    await mount('ENCHANTED_MELON');
    expect(q('[data-testid="item-stats"]').textContent).toContain('Yeterli geçmiş yok');
  });

  it('AH card appears only with a lowest BIN and carries the caveat', async () => {
    await mount('ENCHANTED_MELON');
    expect(root.querySelector('[data-testid="item-ah"]')).toBeNull();
    const ah: AhSnapshot = {
      fetchedAt: Date.now() - 5 * 60_000,
      lastUpdated: 0,
      lowestBin: { ENCHANTED_MELON: { price: 1234, count: 3 } },
      failedPages: [7],
    };
    store.set({ ah });
    await flush();
    expect(dd('item-ah', 'ahPrice')).toBe(fmtPrice(1234));
    expect(dd('item-ah', 'ahCount')).toBe('3');
    expect(dd('item-ah', 'ahNet')).toBe(fmtPrice(1234 * 0.99)); // 1 % listing fee, no claim tax below 1M
    expect(dd('item-ah', 'ahAge')).toContain('5 dk');
    const txt = q('[data-testid="item-ah"]').textContent!;
    expect(txt).toContain('yıldız');
    expect(txt).toContain('1 sayfa');
  });

  it('shows a reduced page for AH-only items (no book, chart or alert button)', async () => {
    store.set({ ah: { fetchedAt: Date.now(), lastUpdated: 0, lowestBin: { HYPERION: { price: 9e8, count: 12 } } } });
    await mount('HYPERION', { snapshot: SNAP, catalog: CATALOG });
    expect(q('.item-msg').hidden).toBe(true);
    expect(q('[data-testid="off-bazaar"]').hidden).toBe(false);
    expect(q('[data-testid="order-book"]').hidden).toBe(true);
    expect(q('[data-testid="item-ah"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="item-flip"]')).toBeNull();
    expect(q('[data-testid="item-alert-btn"]').hidden).toBe(true);
  });

  it('shard card from catalog shard metadata', async () => {
    const file = {
      ...(catalogJson as object),
      v: 2,
      items: { ...(catalogJson as { items: object }).items, SHARD_SALMON: { n: 'Salmon Shard', bz: 1, sh: { r: 'RARE', f: ['Fish', 'Water'], a: 'Ocean' } } },
    };
    const cat = catalogFromFile(validateCatalogFile(file as unknown));
    await mount('SHARD_SALMON', { snapshot: SNAP, catalog: cat });
    expect(dd('item-shard', 'shardRarity')).toBe('RARE');
    expect(dd('item-shard', 'shardFamily')).toBe('Fish, Water');
    expect(dd('item-shard', 'shardAlignment')).toBe('Ocean');
    view.update!({ id: 'item', param: 'ENCHANTED_MELON' });
    await flush();
    expect(root.querySelector('[data-testid="item-shard"]')).toBeNull();
  });
});

describe('item view: header actions', () => {
  it('★ toggles the watchlist and reflects it', async () => {
    await mount('ENCHANTED_MELON');
    const btn = q<HTMLButtonElement>('[data-testid="item-watch"]');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    btn.click();
    expect(store.get().watchlist.map((w) => w.id)).toEqual(['ENCHANTED_MELON']);
    await flush();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.textContent).toContain('★');
    btn.click();
    await flush();
    expect(store.get().watchlist).toEqual([]);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('add-alert form prefills ±5% and appends a rule to store.alerts', async () => {
    await mount('ENCHANTED_MELON');
    const form = q<HTMLFormElement>('[data-testid="item-alert-form"]');
    expect(form.hidden).toBe(true);
    q<HTMLButtonElement>('[data-testid="item-alert-btn"]').click();
    expect(form.hidden).toBe(false);
    expect(q('[data-testid="item-alert-btn"]').getAttribute('aria-expanded')).toBe('true');
    const ask = SNAP.products.ENCHANTED_MELON!.ask!;
    const val = q<HTMLInputElement>('[data-testid="alert-value"]');
    expect(Number(val.value)).toBe(alertPrefill('ask', 'lt', ask));
    expect(Number(val.value)).toBeCloseTo(ask * 0.95, 0);
    const op = q<HTMLSelectElement>('[data-testid="alert-op"]');
    op.value = 'gt';
    op.dispatchEvent(new Event('change'));
    expect(Number(val.value)).toBeCloseTo(ask * 1.05, 0);
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    const rules = store.get().alerts;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: 'ENCHANTED_MELON', metric: 'ask', op: 'gt', value: Number(val.value), enabled: true, cooldownMin: 15 });
    expect(ctx.toast).toHaveBeenCalledWith(expect.stringContaining('Alarm eklendi'), 'ok');
    expect(form.hidden).toBe(true);
    await flush();
    expect(q('.item-alert-count').hidden).toBe(false);
    expect(q('.item-alert-count a').getAttribute('href')).toBe('#/watch');
  });

  it('percent metrics are typed in percent and stored as ratios; bad input is rejected', async () => {
    await mount('ENCHANTED_MELON');
    q<HTMLButtonElement>('[data-testid="item-alert-btn"]').click();
    const metric = q<HTMLSelectElement>('[data-testid="alert-metric"]');
    metric.value = 'flipMargin';
    metric.dispatchEvent(new Event('change'));
    const val = q<HTMLInputElement>('[data-testid="alert-value"]');
    const form = q<HTMLFormElement>('[data-testid="item-alert-form"]');
    val.value = 'abc';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(store.get().alerts).toHaveLength(0);
    expect(val.getAttribute('aria-invalid')).toBe('true');
    val.value = '12,5';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(store.get().alerts[0]).toMatchObject({ metric: 'flipMargin', op: 'lt', value: 0.125 });
  });

  it('copy id writes the id to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount('ENCHANTED_MELON');
    q<HTMLButtonElement>('[data-testid="item-copy"]').click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('ENCHANTED_MELON');
    expect(ctx.toast).toHaveBeenCalledWith('Kopyalandı', 'ok');
  });

  it('links to the Books tab for enchanted books (header and recipe rows)', async () => {
    await mount('ENCHANTMENT_ULTIMATE_WISE_1');
    expect(q('.item-links a[href="#/books?q=ENCHANTMENT_ULTIMATE_WISE_1"]')).toBeTruthy();
    expect(q('.item-links a[href="#/flip?q=ENCHANTMENT_ULTIMATE_WISE_1"]')).toBeTruthy();
    const out = q('[data-testid="recipes-out"]');
    expect(out.querySelector('a[href="#/craft?q=ENCHANTMENT_ULTIMATE_WISE_1"]')).toBeTruthy();
    expect(out.querySelector('a[href="#/books?q=ENCHANTMENT_ULTIMATE_WISE_1"]')).toBeTruthy();
    view.update!({ id: 'item', param: 'ENCHANTED_MELON' });
    await flush();
    expect(root.querySelector('a[href^="#/books"]')).toBeNull();
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

  it('alert prefill and value helpers', () => {
    expect(alertPrefill('ask', 'lt', 100)).toBe(95);
    expect(alertPrefill('bid', 'gt', 100)).toBe(105);
    expect(alertPrefill('flipMargin', 'gt', 0.1)).toBe(10.5);
    expect(alertPrefill('flipProfit', 'gt', -10)).toBe(-9.5);
    expect(alertValueFromInput('spreadPct', 12.5)).toBe(0.125);
    expect(alertValueFromInput('ask', 12.5)).toBe(12.5);
    expect(isBookId('ENCHANTMENT_SHARPNESS_5')).toBe(true);
    expect(isBookId('ENCHANTED_GOLD')).toBe(false);
    expect(fmtTrend(null)).toBe('—');
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
