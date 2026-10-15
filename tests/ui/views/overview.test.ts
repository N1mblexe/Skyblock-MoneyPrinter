// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseElection } from '../../../src/api/election.ts';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_VIEWPREFS, OPTIMIZER, STATS } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import { allocate } from '../../../src/domain/optimizer.ts';
import { setLang } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AppState, BookRow, Catalog, HistoryPoint, MarketStat, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { fmtCoins } from '../../../src/ui/format.ts';
import { createOverviewView, MOVERS_N, TOP_N } from '../../../src/ui/views/overview/overviewView.ts';
import { mostConsistent, movers, planOptions, topBooks, topCrafts, topFlips } from '../../../src/ui/views/overview/select.ts';
import bazaarJson from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';
import electionJson from '../../fixtures/election.json';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';

const SNAP: Snapshot = toSnapshot(validateRaw(bazaarJson as unknown), 1_700_000_000_000, 'fixture');
const CATALOG: Catalog = catalogFromFile(validateCatalogFile(catalogJson as unknown));
const flush = () => new Promise((r) => setTimeout(r, 30));

const vol = (id: string) => SNAP.products[id]!.instaBuysWeek + SNAP.products[id]!.instaSellsWeek;
const BY_VOL = Object.keys(SNAP.products).sort((a, b) => vol(b) - vol(a));
const LOW_VOL = BY_VOL.filter((id) => vol(id) < STATS.moversMinWeekVol);

const stat = (id: string, o: Partial<MarketStat>): MarketStat => ({
  id,
  n: 20,
  change1h: null,
  change24h: null,
  volatility: null,
  spreadMedian: null,
  consistency: null,
  buyVolTrend: null,
  sellVolTrend: null,
  ...o,
});

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext;
let stats: Map<string, MarketStat>;

const card = (k: string) => root.querySelector<HTMLElement>(`[data-card="${k}"]`)!;
const body = (k: string) => card(k).querySelector<HTMLElement>('.ov-body')!;
const rows = (k: string) => [...body(k).querySelectorAll('tbody tr')];

function mount(state: Partial<AppState> = {}, route = { id: 'overview' as const, query: {} as Record<string, string> }) {
  store.set(state);
  view.mount(root, ctx, route);
}

beforeEach(() => {
  localStorage.clear();
  setLang('tr');
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  stats = new Map();
  const pts = (id: string): HistoryPoint[] =>
    [0, 1, 2, 3].map((i) => ({ ts: i, bid: 100, ask: 110 + (id.length % 3) * i, instaBuysWeek: 0, instaSellsWeek: 0, buyOrders: 1, sellOrders: 1 }));
  const history = fakeHistory({ marketStats: () => stats, recent: pts });
  ctx = fakeViewCtx(store, history);
  view = createOverviewView();
});
afterEach(() => {
  view.unmount();
  document.body.innerHTML = '';
  setLang('tr');
  vi.restoreAllMocks();
});

describe('overview view', () => {

  it('renders an h1 and every card with a heading; titles link to their full views', () => {
    mount();
    expect(root.querySelector('h1')!.textContent).toBe('Genel bakış');
    const keys = [...root.querySelectorAll<HTMLElement>('[data-card]')].map((c) => c.dataset.card);
    expect(keys).toEqual(['flips', 'crafts', 'books', 'movers', 'consistent', 'plan', 'watch', 'alerts', 'election', 'market']);
    expect(card('flips').querySelector('h2 a')!.getAttribute('href')).toBe('#/flip');
    expect(card('crafts').querySelector('h2 a')!.getAttribute('href')).toBe('#/craft');
    expect(card('books').querySelector('h2 a')!.getAttribute('href')).toBe('#/books');
    expect(card('plan').querySelector('h2 a')!.getAttribute('href')).toBe('#/plan');
    expect(card('watch').querySelector('h2 a')!.getAttribute('href')).toBe('#/watch');
    for (const c of root.querySelectorAll('[data-card]')) {
      const id = c.getAttribute('aria-labelledby')!;
      expect(c.querySelector(`h2#${id}`)!.textContent).not.toBe('');
      expect(c.querySelector('.ov-desc')!.textContent).not.toBe('');
    }
  });

  it('explains every empty state before data arrives', async () => {
    mount();
    for (const k of ['flips', 'crafts', 'books', 'movers', 'consistent', 'plan']) expect(body(k).textContent).toBe('Fiyat verisi bekleniyor…');
    expect(body('watch').textContent).toContain('Henüz izlenen ürün yok');
    expect(body('alerts').textContent).toContain('Hiç alarm kuralın yok');
    expect(body('election').textContent).toBe('Seçim bilgisi henüz yüklenmedi.');
    expect(body('market').textContent).toContain('veri yok');

    store.set({ snapshot: SNAP });
    await flush();
    expect(body('flips').textContent).toBe('Tarif kataloğu yükleniyor…');
    expect(body('movers').textContent).toContain('yaklaşık 1 saatlik fiyat geçmişi');
    store.set({ catalogError: 'boom' });
    await flush();
    expect(body('flips').textContent).toBe('Katalog yüklenemediği için hesaplanamadı.');
    expect(root.querySelector<HTMLElement>('.banner')!.hidden).toBe(false);

    store.set({ catalog: CATALOG, catalogError: null, alerts: [{ key: 'k', id: 'X', metric: 'ask', op: 'lt', value: 1, enabled: true, cooldownMin: 1 }] });
    await flush();
    // the fixture has no book combines and no history: those cards explain why
    expect(body('books').textContent).toContain('doğrulanmış bir kitap birleştirmesi yok');
    expect(body('consistent').textContent).toContain(`en az ${STATS.consistencyMinPoints} geçmiş ölçümü`);
    expect(body('alerts').textContent).toContain('Henüz alarm tetiklenmedi');
  });

  it('renders top flips and crafts from the fixture, excluding suspect rows', () => {
    mount({ snapshot: SNAP, catalog: CATALOG });
    const top = topFlips(ctx.derived.flips(), TOP_N);
    expect(top.length).toBeGreaterThan(0);
    expect(top.every((r) => r.risk.level !== 'suspect')).toBe(true);
    const r = rows('flips');
    expect(r).toHaveLength(top.length);
    expect(r[0]!.querySelector('a')!.getAttribute('href')).toBe(`#/item/${encodeURIComponent(top[0]!.id)}`);
    expect(r[0]!.textContent).toContain(fmtCoins(top[0]!.profitPerHour));
    const crafts = topCrafts(ctx.derived.crafts(), TOP_N);
    expect(rows('crafts')).toHaveLength(crafts.length);
    expect(new Set(crafts.map((c) => c.id)).size).toBe(crafts.length); // one row per output
    expect(body('market').querySelector('[data-k="products"]')!.textContent).toBe(String(Object.keys(SNAP.products).length));
  });

  it('shows verified, non-suspect book combines only', () => {
    const base = ctx.derived.books;
    const mk = (id: string, pph: number, verified: boolean, level: 'ok' | 'suspect' = 'ok'): BookRow =>
      ({ id, name: id, base: 'B', fromLevel: 5, toLevel: 6, inputId: id + '_5', count: 2, buyAt: 1, sellAt: 3, cost: 2, netSell: 3, profit: 1, margin: 0.5, tp: {} as never, profitPerHour: pph, risk: { level, score: 0, flags: [] }, verified }) as BookRow;
    const books = [mk('A_6', 100, true), mk('B_6', 500, false), mk('C_6', 900, true, 'suspect'), mk('D_6', 300, true)];
    ctx.derived.books = () => books;
    mount({ snapshot: SNAP, catalog: CATALOG });
    expect(rows('books').map((r) => r.querySelector('a')!.textContent)).toEqual(['D_6', 'A_6']);
    expect(topBooks(books, 5).map((b) => b.id)).toEqual(['D_6', 'A_6']);
    ctx.derived.books = base;
  });

  it('movers: up and down by the chosen window, filtered by weekly volume; window lives in the URL', async () => {
    const [a, b, c, d] = BY_VOL;
    stats.set(a!, stat(a!, { change1h: 0.2, change24h: -0.1 }));
    stats.set(b!, stat(b!, { change1h: 0.05 }));
    stats.set(c!, stat(c!, { change1h: -0.3 }));
    stats.set(d!, stat(d!, { change1h: null }));
    if (LOW_VOL[0]) stats.set(LOW_VOL[0], stat(LOW_VOL[0], { change1h: 5 }));
    mount({ snapshot: SNAP, catalog: CATALOG });
    const sides = body('movers').querySelectorAll('.ov-side');
    const ids = (s: Element) => [...s.querySelectorAll('tbody a')].map((x) => decodeURIComponent(x.getAttribute('href')!.slice(7)));
    expect(ids(sides[0]!)).toEqual([a, b]);
    expect(ids(sides[1]!)).toEqual([c]);
    expect(sides[0]!.textContent).toContain('+');
    const m = movers(stats, SNAP, '1h', MOVERS_N);
    expect(m.known).toBe(3);

    // 24h window: button writes the URL; only `a` has a 24h change (a faller)
    const btn24 = root.querySelector<HTMLButtonElement>('[data-testid="ov-mw-24h"]')!;
    btn24.click();
    expect(ctx.setQuery).toHaveBeenCalledWith(expect.objectContaining({ mw: '24h' }));
    expect(btn24.getAttribute('aria-pressed')).toBe('true');
    const s24 = body('movers').querySelectorAll('.ov-side');
    expect(ids(s24[0]!)).toEqual([]);
    expect(s24[0]!.textContent).toContain('Bu yönde hareket yok.');
    expect(ids(s24[1]!)).toEqual([a]);
    expect(localStorage.getItem(LS_VIEWPREFS + 'overview')).toContain('24h');

    // URL-driven: update() with a window in the query applies it
    view.update!({ id: 'overview', query: { mw: '1h' } });
    await flush();
    expect(root.querySelector('[data-testid="ov-mw-1h"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(ids(body('movers').querySelectorAll('.ov-side')[0]!)).toEqual([a, b]);
  });

  it('mount reads the movers window from the route', () => {
    mount({ snapshot: SNAP }, { id: 'overview', query: { mw: '24h' } });
    expect(root.querySelector('[data-testid="ov-mw-24h"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(body('movers').textContent).toContain('24 saatlik değişim');
  });

  it('most consistent flips rank by consistency × profit/hour and show consistency as a percent', () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    const flips = topFlips(ctx.derived.flips(), 3);
    expect(flips.length).toBe(3);
    stats.set(flips[0]!.id, stat(flips[0]!.id, { consistency: 0.1 }));
    stats.set(flips[1]!.id, stat(flips[1]!.id, { consistency: 1 }));
    stats.set(flips[2]!.id, stat(flips[2]!.id, { consistency: 0.5 }));
    view.mount(root, ctx, { id: 'overview' });
    const expected = mostConsistent(ctx.derived.flips(), stats, TOP_N);
    const r = rows('consistent');
    expect(r.map((x) => x.querySelector('a')!.textContent)).toEqual(expected.map((e) => e.row.name));
    expect(expected[0]!.score).toBeGreaterThanOrEqual(expected[1]!.score);
    expect(r.find((x) => x.textContent!.includes(flips[1]!.name))!.textContent).toContain('%100');
  });

  it('planner summary numbers match allocate()', () => {
    mount({ snapshot: SNAP, catalog: CATALOG });
    const s = store.get().settings;
    const plan = allocate(ctx.derived.opportunities(), {
      capital: s.capital,
      slots: s.orderSlots,
      maxShare: OPTIMIZER.maxShareOfCapitalPerItem,
      excludeSuspect: OPTIMIZER.excludeSuspect,
    });
    expect(planOptions(s)).toEqual({ capital: s.capital, slots: s.orderSlots, maxShare: OPTIMIZER.maxShareOfCapitalPerItem, excludeSuspect: OPTIMIZER.excludeSuspect });
    expect(plan.allocations.length).toBeGreaterThan(0);
    const v = (k: string) => Number(body('plan').querySelector(`[data-k="${k}"] [data-v]`)!.getAttribute('data-v'));
    expect(v('pph')).toBeCloseTo(plan.profitPerHour, 6);
    expect(v('capital')).toBeCloseTo(plan.capitalUsed, 6);
    expect(v('slots')).toBe(plan.slotsUsed);
    expect(v('picks')).toBe(plan.allocations.length);
    expect(body('plan').querySelector('[data-k="pph"]')!.textContent).toBe(fmtCoins(plan.profitPerHour));
    expect(body('plan').querySelector('a[href="#/plan"]')).not.toBeNull();
  });

  it('planner summary follows capital and slot settings', async () => {
    mount({ snapshot: SNAP, catalog: CATALOG });
    store.set((s) => ({ settings: { ...s.settings, orderSlots: 1 } }));
    await flush();
    const v = Number(body('plan').querySelector('[data-k="slots"] [data-v]')!.getAttribute('data-v'));
    expect(v).toBeLessThanOrEqual(1);
  });

  it('watchlist mini table: price, sparkline and change; alert log uses the message formatter', () => {
    const id = BY_VOL[0]!;
    stats.set(id, stat(id, { change24h: 0.12 }));
    mount({
      snapshot: SNAP,
      catalog: CATALOG,
      watchlist: [{ id, addedAt: 0 }],
      alerts: [{ key: 'r1', id, metric: 'ask', op: 'gt', value: 10, enabled: true, cooldownMin: 5 }],
      alertLog: [{ ruleKey: 'r1', id, metric: 'ask', value: 12, at: Date.now() - 120_000 }],
    });
    const r = rows('watch');
    expect(r).toHaveLength(1);
    expect(r[0]!.textContent).toContain(CATALOG.name(id));
    expect(r[0]!.textContent).toContain(fmtCoins(SNAP.products[id]!.ask));
    expect(r[0]!.querySelector('svg polyline')).not.toBeNull();
    expect(r[0]!.textContent).toContain('+%12,0');
    const li = body('alerts').querySelector('li')!;
    expect(li.textContent).toContain(`${CATALOG.name(id)}: satış fiyatı (ask) 12 (> 10)`);
    expect(li.textContent).toContain('2 dk önce');
  });

  it('election card shows mayor and minister perks', () => {
    mount({ election: parseElection(electionJson, 0) });
    const t = body('election').textContent!;
    expect(t).toContain('Belediye başkanı: Paul');
    expect(t).toContain('Marauder');
    expect(t).toContain('Bakan: Cole');
    expect(t).toContain('Mining Fiesta');
  });

  it('market card reports AH state', async () => {
    mount({ snapshot: SNAP });
    expect(body('market').querySelector('[data-k="ah"]')!.textContent).toBe('henüz taranmadı');
    store.set({ ah: { fetchedAt: Date.now() - 60_000, lastUpdated: 0, lowestBin: { A: { price: 1, count: 3 } } } });
    await flush();
    expect(body('market').querySelector('[data-k="ah"]')!.textContent).toBe('1 dk önce');
    store.set((s) => ({ settings: { ...s.settings, ahEnabled: false } }));
    await flush();
    expect(body('market').querySelector('[data-k="ah"]')!.textContent).toBe('kapalı');
  });

  it('switches language', () => {
    mount({ snapshot: SNAP, catalog: CATALOG });
    setLang('en');
    expect(root.querySelector('h1')!.textContent).toBe('Overview');
    expect(card('flips').querySelector('h2')!.textContent).toBe('Top flips');
    expect(card('movers').querySelector('.seg')!.getAttribute('aria-label')).toBe('Time window');
  });

  it('unmount releases subscriptions, timers and DOM', async () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    mount({ snapshot: SNAP, catalog: CATALOG });
    view.unmount();
    expect(root.childElementCount).toBe(0);
    expect(clear).toHaveBeenCalled();
    store.set({ watchlist: [{ id: 'X', addedAt: 0 }] });
    setLang('en');
    await flush();
    expect(root.childElementCount).toBe(0);
    // remount works
    view.mount(root, ctx, { id: 'overview' });
    expect(root.querySelectorAll('[data-card]')).toHaveLength(10);
  });
});
