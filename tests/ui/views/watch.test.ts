// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { ALERTS, LS_VIEWPREFS } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import { metricValue } from '../../../src/domain/alerts.ts';
import { setLang, t } from '../../../src/i18n/index.ts';
import { fmtMetric } from '../../../src/state/alertsRunner.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AlertRule, AppState, Catalog, HistoryPoint, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { exportJson, makeRule, mergeImport, newRuleKey, parseImport, suggestRule } from '../../../src/ui/views/watch/model.ts';
import { displayValue, parseValue } from '../../../src/ui/views/watch/rulesEditor.ts';
import { createWatchView } from '../../../src/ui/views/watch/watchView.ts';
import bazaarJson from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';

const SNAP: Snapshot = toSnapshot(validateRaw(bazaarJson as unknown), 1_700_000_000_000, 'fixture');
const CATALOG: Catalog = catalogFromFile(validateCatalogFile(catalogJson as unknown));
const flush = () => new Promise((r) => setTimeout(r, 30));
const MELON = 'ENCHANTED_MELON';
const GOLD = 'ENCHANTED_GOLD';

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext;

const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const tid = <E extends Element = HTMLElement>(id: string) => q<E>(`[data-testid="${id}"]`);
const tableKeys = () => [...tid('watch-table').querySelectorAll<HTMLElement>('tbody tr[data-key]')].map((r) => r.dataset.key!);
const ruleRow = (key: string) => q(`[data-rule="${key}"]`);
function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function type(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

function mount(state: Partial<AppState> = {}, route: { id: 'watch'; query?: Record<string, string> } = { id: 'watch', query: {} }) {
  store.set(state);
  view.mount(root, ctx, route);
}

beforeEach(() => {
  localStorage.clear();
  setLang('tr');
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  const pts = (): HistoryPoint[] =>
    [0, 1, 2].map((i) => ({ ts: i, bid: 100, ask: 110 + i, instaBuysWeek: 0, instaSellsWeek: 0, buyOrders: 1, sellOrders: 1 }));
  ctx = fakeViewCtx(store, fakeHistory({ recent: pts }));
  view = createWatchView();
});
afterEach(() => {
  view.unmount();
  document.body.innerHTML = '';
  setLang('tr');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('watch view', () => {

  it('renders the h1, empty states and an empty log', () => {
    mount();
    expect(q('h1').textContent).toBe('İzleme listesi');
    expect(tid('watch-table').textContent).toContain('Henüz izlenen ürün yok');
    expect(tid('watch-rules').textContent).toContain('Henüz kural yok');
    expect(tid('watch-log').textContent).toContain('Henüz alarm tetiklenmedi.');
    expect(tid<HTMLButtonElement>('watch-log-clear').disabled).toBe(true);
  });

  it('rows from the fixture: prices, spread, flip metrics via metricValue, alert count', () => {
    const rule: AlertRule = { key: 'r1', id: MELON, metric: 'ask', op: 'lt', value: 1, enabled: true, cooldownMin: 5 };
    mount({ snapshot: SNAP, catalog: CATALOG, watchlist: [{ id: MELON, addedAt: 0 }, { id: GOLD, addedAt: 0 }], alerts: [rule] });
    expect(tableKeys().sort()).toEqual([GOLD, MELON]);
    const row = q(`tbody tr[data-key="${MELON}"]`);
    const c = ctx.derived.calcCtx()!;
    expect(row.textContent).toContain(fmtMetric('flipMargin', metricValue('flipMargin', MELON, c)!));
    expect(row.textContent).toContain(fmtMetric('spreadPct', metricValue('spreadPct', MELON, c)!));
    expect(row.textContent).toContain('1/1');
    expect(row.querySelector('svg polyline')).not.toBeNull();
    expect(tid('watch-count').textContent).toBe('2 ürün izleniyor');
  });

  it('adds items via the search box (suggestions + Enter) and removes them with the ★ action', async () => {
    mount({ snapshot: SNAP, catalog: CATALOG });
    const inp = tid<HTMLInputElement>('watch-add');
    type(inp, 'enchanted mel');
    const opts = [...tid('watch-suggest').querySelectorAll('[role="option"]')];
    expect(opts.length).toBeGreaterThan(0);
    expect(inp.getAttribute('aria-expanded')).toBe('true');
    expect(opts[0]!.textContent).toContain('Enchanted Melon');
    key(inp, 'Enter');
    expect(store.get().watchlist.map((w) => w.id)).toEqual([MELON]);
    expect(inp.value).toBe('');
    expect(ctx.toast).toHaveBeenCalledWith(expect.stringContaining('eklendi'), 'ok');

    // exact id via the Add button; duplicates are refused
    type(inp, GOLD);
    tid<HTMLButtonElement>('watch-add-btn').click();
    type(inp, GOLD);
    tid<HTMLButtonElement>('watch-add-btn').click();
    expect(store.get().watchlist.map((w) => w.id)).toEqual([MELON, GOLD]);
    expect(ctx.toast).toHaveBeenCalledWith(expect.stringContaining('zaten izleniyor'), 'info');

    // unknown text
    type(inp, 'zzz-not-an-item');
    key(inp, 'Enter');
    expect(ctx.toast).toHaveBeenCalledWith(expect.stringContaining('bulunamadı'), 'warn');

    await flush();
    expect(tableKeys().sort()).toEqual([GOLD, MELON]);
    q(`tbody tr[data-key="${MELON}"] [data-action="watch"]`).click();
    expect(store.get().watchlist.map((w) => w.id)).toEqual([GOLD]);
    await flush();
    expect(tableKeys()).toEqual([GOLD]);
  });

  it('creates, edits and deletes an alert rule; shows the current metric value', async () => {
    mount({ snapshot: SNAP, catalog: CATALOG, watchlist: [{ id: MELON, addedAt: 0 }] });
    await flush();
    q(`tbody tr[data-key="${MELON}"] [data-action="alert"]`).click();
    const [rule] = store.get().alerts;
    expect(rule).toMatchObject({ id: MELON, metric: 'ask', op: 'lt', enabled: true, cooldownMin: ALERTS.defaultCooldownMin });
    expect(rule!.value).toBe(suggestRule('ask', SNAP.products[MELON]!.ask).value);
    const row = ruleRow(rule!.key);
    expect(document.activeElement).toBe(row.querySelector('[data-f="value"]'));
    expect(row.querySelector('[data-now]')!.textContent).toContain(fmtMetric('ask', SNAP.products[MELON]!.ask!));

    // threshold (Turkish decimal comma) and condition
    change(row.querySelector<HTMLInputElement>('[data-f="value"]')!, '1234,5');
    change(row.querySelector<HTMLSelectElement>('[data-f="op"]')!, 'gt');
    change(row.querySelector<HTMLInputElement>('[data-f="cooldown"]')!, '30');
    expect(store.get().alerts[0]).toMatchObject({ value: 1234.5, op: 'gt', cooldownMin: 30 });

    // invalid threshold is refused
    const v = row.querySelector<HTMLInputElement>('[data-f="value"]')!;
    change(v, 'abc');
    expect(v.getAttribute('aria-invalid')).toBe('true');
    expect(store.get().alerts[0]!.value).toBe(1234.5);

    // switching to a percent metric re-derives the threshold; the input is in percent
    change(row.querySelector<HTMLSelectElement>('[data-f="metric"]')!, 'spreadPct');
    const r2 = store.get().alerts[0]!;
    expect(r2.metric).toBe('spreadPct');
    expect(r2.op).toBe('gt');
    await flush();
    const v2 = ruleRow(r2.key).querySelector<HTMLInputElement>('[data-f="value"]')!;
    change(v2, '12,5');
    expect(store.get().alerts[0]!.value).toBeCloseTo(0.125, 10);
    expect(ruleRow(r2.key).querySelector('[data-unit]')!.textContent).toBe('%');

    // enable toggle
    const en = ruleRow(r2.key).querySelector<HTMLInputElement>('[data-f="enabled"]')!;
    en.checked = false;
    en.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().alerts[0]!.enabled).toBe(false);
    await flush();
    expect(ruleRow(r2.key).classList.contains('wr-off')).toBe(true);
    expect(q(`tbody tr[data-key="${MELON}"]`).textContent).toContain('0/1');

    // second rule from the group button gets a distinct key; delete the first
    q(`section[data-id="${MELON}"] [data-act="add"]`).click();
    const keys = store.get().alerts.map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
    ruleRow(keys[0]!).querySelector<HTMLButtonElement>('[data-act="del"]')!.click();
    expect(store.get().alerts.map((r) => r.key)).toEqual([keys[1]]);
    expect(root.querySelector(`[data-rule="${keys[0]}"]`)).toBeNull();
  });

  it('rule helpers: unique keys, percent display and parsing', () => {
    const fixed = () => 0.5;
    const k1 = newRuleKey(new Set(), 1000, fixed);
    const k2 = newRuleKey(new Set([k1]), 1000, fixed);
    expect(k2).not.toBe(k1);
    const rules: AlertRule[] = [];
    for (let i = 0; i < 50; i++) rules.push(makeRule('X', rules, null));
    expect(new Set(rules.map((r) => r.key)).size).toBe(50);
    expect(parseValue('flipMargin', '5')).toBe(0.05);
    expect(parseValue('ask', '1.234,5')).toBe(1234.5);
    expect(parseValue('ask', 'x')).toBeNull();
    expect(displayValue('spreadPct', 0.125)).toBe('12,5');
    expect(suggestRule('ask', null)).toEqual({ op: 'lt', value: 0 });
    expect(suggestRule('flipProfit', 100).op).toBe('gt');
  });

  it('renders the alert log with formatted messages and clears it', async () => {
    const at = Date.UTC(2026, 0, 2, 3, 4);
    mount({
      snapshot: SNAP,
      catalog: CATALOG,
      alerts: [{ key: 'r1', id: MELON, metric: 'ask', op: 'gt', value: 100, enabled: true, cooldownMin: 5 }],
      alertLog: [
        { ruleKey: 'r1', id: MELON, metric: 'ask', value: 150, at },
        { ruleKey: 'gone', id: GOLD, metric: 'flipMargin', value: 0.2, at: at - 1000 },
      ],
    });
    const log = tid('watch-log');
    const trs = [...log.querySelectorAll('tbody tr[data-key]')];
    expect(trs).toHaveLength(2);
    expect(trs[0]!.textContent).toContain('Enchanted Melon: satış fiyatı (ask) 150 (> 100)');
    expect(trs[1]!.textContent).toContain('flip marjı %20,0 (kural silinmiş)');
    expect(trs[0]!.querySelector('a')!.getAttribute('href')).toBe(`#/item/${MELON}`);
    const clear = tid<HTMLButtonElement>('watch-log-clear');
    expect(clear.disabled).toBe(false);
    clear.click();
    expect(store.get().alertLog).toEqual([]);
    await flush();
    expect(log.querySelectorAll('tbody tr[data-key]')).toHaveLength(0);
    expect(clear.disabled).toBe(true);
  });

  it('notification button requests permission on click and sets settings.notify', async () => {
    const requestPermission = vi.fn(() => Promise.resolve('granted' as NotificationPermission));
    const N = { permission: 'default' as NotificationPermission, requestPermission };
    vi.stubGlobal('Notification', N);
    mount();
    expect(requestPermission).not.toHaveBeenCalled(); // never without a click
    expect(tid('watch-perm').textContent).toBe('henüz sorulmadı');
    expect(tid('watch-notify-state').textContent).toBe('kapalı');
    const btn = tid<HTMLButtonElement>('watch-notify');
    expect(btn.textContent).toBe('Tarayıcı bildirimlerini aç');
    btn.click();
    N.permission = 'granted';
    await flush();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(store.get().settings.notify).toBe(true);
    expect(tid('watch-notify-state').textContent).toBe('açık');
    expect(btn.textContent).toBe('Bildirimleri kapat');
    // turning off does not ask again
    btn.click();
    await flush();
    expect(store.get().settings.notify).toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('a denied permission leaves notify off and warns; no Notification API disables the button', async () => {
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: vi.fn(() => Promise.resolve('denied')) });
    mount();
    tid<HTMLButtonElement>('watch-notify').click();
    await flush();
    expect(store.get().settings.notify).toBe(false);
    expect(ctx.toast).toHaveBeenCalledWith(expect.stringContaining('izni verilmedi'), 'warn');
    view.unmount();
    vi.stubGlobal('Notification', undefined);
    view.mount(root, ctx, { id: 'watch' });
    expect(tid<HTMLButtonElement>('watch-notify').disabled).toBe(true);
    expect(tid('watch-perm').textContent).toBe('desteklenmiyor');
  });

  it('import/export round trip (model and UI)', async () => {
    const watchlist = [{ id: MELON, addedAt: 5 }, { id: GOLD, addedAt: 6, note: 'n' }];
    const alerts: AlertRule[] = [
      { key: 'a', id: MELON, metric: 'ask', op: 'lt', value: 10, enabled: true, cooldownMin: 15 },
      { key: 'b', id: GOLD, metric: 'flipMargin', op: 'gt', value: 0.1, enabled: false, cooldownMin: 0, lastFiredAt: 9 },
    ];
    const json = exportJson(watchlist, alerts, 1);
    const parsed = parseImport(json);
    expect(parsed).toEqual({ ok: true, watchlist, alerts });
    const merged = mergeImport({ watchlist: [], alerts: [] }, parsed as { watchlist: typeof watchlist; alerts: AlertRule[] });
    expect(merged).toMatchObject({ watchlist, alerts, items: 2, rules: 2 });
    expect(mergeImport({ watchlist, alerts }, { watchlist, alerts })).toMatchObject({ items: 0, rules: 0 });
    expect(parseImport('')).toMatchObject({ ok: false, error: 'empty' });
    expect(parseImport('{')).toMatchObject({ ok: false, error: 'json' });
    expect(parseImport('{"x":1}')).toMatchObject({ ok: false, error: 'nodata' });
    expect(parseImport('["A","A",""]')).toEqual({ ok: true, watchlist: [{ id: 'A', addedAt: 0 }], alerts: [] });

    // UI: copy what is in the store, clear it, paste it back
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount({ watchlist, alerts });
    tid<HTMLButtonElement>('watch-copy').click();
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = (writeText.mock.calls[0] as unknown as [string])[0];
    store.set({ watchlist: [], alerts: [] });
    tid<HTMLTextAreaElement>('watch-import-text').value = copied;
    tid<HTMLButtonElement>('watch-import').click();
    expect(store.get().watchlist).toEqual(watchlist);
    expect(store.get().alerts).toEqual(alerts);
    expect(tid('watch-io-status').textContent).toBe('2 ürün ve 2 kural içe aktarıldı.');
    tid<HTMLTextAreaElement>('watch-import-text').value = 'not json';
    tid<HTMLButtonElement>('watch-import').click();
    expect(tid('watch-io-status').textContent).toContain('JSON okunamadı');
  });

  it('download builds a JSON file', () => {
    const create = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mount({ watchlist: [{ id: MELON, addedAt: 0 }] });
    tid<HTMLButtonElement>('watch-download').click();
    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(ctx.toast).toHaveBeenCalledWith(expect.stringMatching(/bazaar-watchlist-\d{8}-\d{4}\.json/), 'ok');
  });

  it('search filter writes setQuery; update() applies the URL filter', async () => {
    mount({ snapshot: SNAP, catalog: CATALOG, watchlist: [{ id: MELON, addedAt: 0 }, { id: GOLD, addedAt: 0 }] });
    const inp = q<HTMLInputElement>('.kit-filterbar input[type="search"]');
    type(inp, 'gold');
    await new Promise((r) => setTimeout(r, 320));
    expect(ctx.setQuery).toHaveBeenCalledWith(expect.objectContaining({ q: 'gold' }));
    await flush();
    expect(tableKeys()).toEqual([GOLD]);
    view.update!({ id: 'watch', query: { q: 'melon' } });
    await flush();
    expect(tableKeys()).toEqual([MELON]);
    expect(localStorage.getItem(LS_VIEWPREFS + 'watch')).toContain('melon');
    view.update!({ id: 'watch', query: { q: 'nothing-matches' } });
    await flush();
    expect(tid('watch-table').textContent).toContain('Aramayla eşleşen izlenen ürün yok.');
  });

  it('opens the detail panel on row activation; the panel can add an alert', async () => {
    mount({ snapshot: SNAP, catalog: CATALOG, watchlist: [{ id: MELON, addedAt: 0 }] });
    await flush();
    q(`tbody tr[data-key="${MELON}"] td`).click();
    const panel = q('.kit-panel');
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain('Enchanted Melon');
    expect(panel.textContent).toContain('Bu ürün için alarm kuralı yok.');
    expect(q(`tbody tr[data-key="${MELON}"]`).getAttribute('aria-selected')).toBe('true');
    panel.querySelector<HTMLButtonElement>('[data-pact="alert"]')!.click();
    expect(store.get().alerts).toHaveLength(1);
    // removing the item closes its panel
    ctx.watch.toggle(MELON);
    await flush();
    expect(panel.hidden).toBe(true);
  });

  it('switches language and releases everything on unmount', async () => {
    mount({ snapshot: SNAP, catalog: CATALOG, alerts: [{ key: 'r', id: MELON, metric: 'bid', op: 'lt', value: 1, enabled: true, cooldownMin: 1 }] });
    setLang('en');
    expect(q('h1').textContent).toBe('Watchlist');
    expect(q('.w-rules h2').textContent).toBe('Alert rules');
    expect(ruleRow('r').querySelector('[data-f="metric"] option[value="bid"]')!.textContent).toBe('bid');
    view.unmount();
    expect(root.childElementCount).toBe(0);
    expect(root.classList.contains('kit-split')).toBe(false);
    expect(document.querySelector('.kit-panel')).toBeNull();
    store.set({ watchlist: [{ id: MELON, addedAt: 0 }] });
    setLang('tr');
    await flush();
    expect(root.childElementCount).toBe(0);
  });
});

describe('watch view: market alerts', () => {
  it('adds, edits and deletes market alert rules', async () => {
    mount();
    const sec = q('.w-opp');
    expect(sec.querySelector('h2')!.textContent).toBe(t('watch.oppTitle'));
    q<HTMLButtonElement>('[data-testid="opp-add"]').click();
    expect(store.get().oppAlerts).toHaveLength(1);
    const r0 = store.get().oppAlerts[0]!;
    expect(r0).toMatchObject({ scope: ['flip'], metric: 'profitPerHour', value: 1_000_000, maxRisk: 'ok', enabled: true });
    const box = () => q(`[data-opp="${r0.key}"]`);
    const craft = box().querySelector<HTMLInputElement>('[data-opp-kind="craft"]')!;
    craft.checked = true;
    craft.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().oppAlerts[0]!.scope).toEqual(['flip', 'craft']);
    const metric = box().querySelector<HTMLSelectElement>('[data-opp-metric]')!;
    metric.value = 'margin';
    metric.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().oppAlerts[0]).toMatchObject({ metric: 'margin', value: 0.2 });
    const value = box().querySelector<HTMLInputElement>('[data-opp-value]')!;
    expect(value.value).toBe('20'); // shown in percent
    value.value = '35';
    value.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().oppAlerts[0]!.value).toBeCloseTo(0.35, 9);
    box().querySelector<HTMLButtonElement>('[data-opp-delete]')!.click();
    expect(store.get().oppAlerts).toEqual([]);
  });
});
