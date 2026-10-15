// Watchlist: watched items with live prices, an alert-rule editor, notification permission, alert log, import/export.
import { ALERTS, LS_VIEWPREFS } from '../../../config.ts';
import { metricValue } from '../../../domain/alerts.ts';
import { matchesQuery, resolveUserInput, searchItems } from '../../../domain/search.ts';
import { onLangChange, t } from '../../../i18n/index.ts';
import type { AlertEvent, AppState, ItemInfo, MarketStat, Route, View, ViewContext } from '../../../types/contracts.ts';
import { itemCell } from '../../cells.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtCompact, fmtPct, locale } from '../../format.ts';
import {
  bindQueryState,
  createDetailPanel,
  createFilterBar,
  createKitTable,
  type DetailPanel,
  type FilterBar,
  type KitColumn,
  type KitTableHandle,
  type QuerySchema,
  type QueryState,
  type QueryValues,
} from '../../kit/index.ts';
import { sparklineSvg } from '../../sparkline.ts';
import { fmtTime, logMessage, ruleText } from './alertText.ts';
import { exportFileName, exportJson, makeRule, mergeImport, parseImport } from './model.ts';
import { createRulesEditor, type RulesEditor } from './rulesEditor.ts';
import './watch.css';

export interface WatchRow {
  id: string;
  name: string;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  change: number | null;
  margin: number | null;
  profit: number | null;
  weekVol: number | null;
  rules: number;
  rulesOn: number;
}

interface LogRow {
  key: string;
  e: AlertEvent;
  name: string;
  msg: string;
}

const SCHEMA = {
  q: { kind: 'string', def: '' },
  sort: { kind: 'sort', def: { key: 'name', dir: 'asc' } },
} as const satisfies QuerySchema;

const SUGGEST_MAX = 8;

const signCls = (n: number | null | undefined) => (n == null || !Number.isFinite(n) || n === 0 ? '' : n > 0 ? 'pos' : 'neg');
const signed = (n: number | null) => (n != null && n > 0 ? '+' : '') + fmtPct(n);
const span = (cls: string, txt: string) => (cls ? `<span class="${cls}">${esc(txt)}</span>` : esc(txt));

type NotifyPerm = NotificationPermission | 'unsupported';
function notifyPermission(): NotifyPerm {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export function createWatchView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext;
  const cleanups: (() => void)[] = [];
  let qs: QueryState<QueryValues<typeof SCHEMA>>;
  let bar: FilterBar;
  let table: KitTableHandle<WatchRow>;
  let logTable: KitTableHandle<LogRow>;
  let panel: DetailPanel;
  let editor: RulesEditor;
  let panelId: string | null = null;
  let emptyText = '';
  let logKey: unknown[] = [];
  let suggest: ItemInfo[] = [];
  let active = -1;
  const sparkCache = new Map<string, string>();
  let sparkTick = -1;

  let els: {
    banner: HTMLElement;
    wait: HTMLElement;
    count: HTMLElement;
    addIn: HTMLInputElement;
    addList: HTMLUListElement;
    addHint: HTMLElement;
    notifyState: HTMLElement;
    perm: HTMLElement;
    notifyBtn: HTMLButtonElement;
    logClear: HTMLButtonElement;
    logIntro: HTMLElement;
    importText: HTMLTextAreaElement;
    ioStatus: HTMLElement;
  };

  // ---------------------------------------------------------------- data

  const stats = (): ReadonlyMap<string, MarketStat> => ctx.derived.marketStats();

  function spark(id: string): string {
    const tick = ctx.store.get().historyTick;
    if (tick !== sparkTick) {
      sparkTick = tick;
      sparkCache.clear();
    }
    let s = sparkCache.get(id);
    if (s == null) {
      const asks = ctx.history.recent(id).map((p) => p.ask);
      const fin = asks.filter((v) => Number.isFinite(v) && v > 0);
      const trend = fin.length >= 2 ? fin[fin.length - 1]! - fin[0]! : 0;
      s = sparklineSvg(asks, { w: 72, h: 20, cls: trend > 0 ? 'pos' : trend < 0 ? 'neg' : '' });
      sparkCache.set(id, s);
    }
    return s;
  }

  function rowFor(id: string, s: AppState, ms: ReadonlyMap<string, MarketStat>): WatchRow {
    const c = ctx.derived.calcCtx();
    const p = s.snapshot?.products[id];
    const rules = s.alerts.filter((r) => r.id === id);
    const mv = (m: 'spreadPct' | 'flipMargin' | 'flipProfit') => (c ? metricValue(m, id, c) : null);
    const bid = p?.bid ?? null;
    const ask = p?.ask ?? null;
    return {
      id,
      name: s.catalog?.name(id) ?? id,
      bid,
      ask,
      spread: c ? mv('spreadPct') : bid && ask ? (ask - bid) / bid : null,
      change: ms.get(id)?.change24h ?? ctx.history.stats(id)?.change24h ?? null,
      margin: mv('flipMargin'),
      profit: mv('flipProfit'),
      weekVol: p ? p.instaBuysWeek + p.instaSellsWeek : null,
      rules: rules.length,
      rulesOn: rules.filter((r) => r.enabled).length,
    };
  }

  function rows(): WatchRow[] {
    const s = ctx.store.get();
    const ms = stats();
    const q = qs.get().q;
    const out: WatchRow[] = [];
    for (const w of s.watchlist) {
      if (q && !matchesQuery(s.catalog, w.id, q)) continue;
      out.push(rowFor(w.id, s, ms));
    }
    return out;
  }

  // ---------------------------------------------------------------- table

  const columns: KitColumn<WatchRow>[] = [
    { key: 'name', label: () => t('watch.col_item'), get: (r) => r.name, html: (r) => itemCell(r.id, r.name, true), cls: 'name-cell', priority: 0, csv: (r) => r.id },
    { key: 'bid', label: () => t('watch.col_bid'), title: () => t('watch.tip_bid'), get: (r) => r.bid, html: (r) => esc(fmtCoins(r.bid)), align: 'right', priority: 1 },
    { key: 'ask', label: () => t('watch.col_ask'), title: () => t('watch.tip_ask'), get: (r) => r.ask, html: (r) => esc(fmtCoins(r.ask)), align: 'right', priority: 1 },
    { key: 'spread', label: () => t('watch.col_spread'), title: () => t('watch.tip_spread'), get: (r) => r.spread, html: (r) => esc(fmtPct(r.spread)), align: 'right', priority: 2 },
    {
      key: 'change',
      label: () => t('watch.col_change'),
      title: () => t('watch.tip_change'),
      get: (r) => r.change,
      html: (r) => span(signCls(r.change), signed(r.change)),
      align: 'right',
      priority: 2,
    },
    {
      key: 'spark',
      label: () => t('watch.col_spark'),
      title: () => t('watch.tip_spark'),
      get: () => null,
      html: (r) => spark(r.id),
      sortable: false,
      align: 'center',
      cls: 'w-spark',
      csv: false,
      priority: 3,
    },
    {
      key: 'margin',
      label: () => t('watch.col_margin'),
      title: () => t('watch.tip_margin'),
      get: (r) => r.margin,
      html: (r) => span(signCls(r.margin), fmtPct(r.margin)),
      align: 'right',
      priority: 2,
    },
    {
      key: 'profit',
      label: () => t('watch.col_profit'),
      title: () => t('watch.tip_profit'),
      get: (r) => r.profit,
      html: (r) => span(signCls(r.profit), fmtCoins(r.profit)),
      align: 'right',
      priority: 3,
    },
    { key: 'vol', label: () => t('watch.col_vol'), title: () => t('watch.tip_vol'), get: (r) => r.weekVol, html: (r) => esc(fmtCompact(r.weekVol)), align: 'right', priority: 3 },
    {
      key: 'alerts',
      label: () => t('watch.col_alerts'),
      title: () => t('watch.tip_alerts'),
      get: (r) => r.rules,
      html: (r) => (r.rules ? `${esc(String(r.rulesOn))}<span class="muted">/${esc(String(r.rules))}</span>` : '<span class="muted">—</span>'),
      align: 'right',
      priority: 2,
      csv: (r) => r.rules,
    },
  ];

  const logColumns: KitColumn<LogRow>[] = [
    { key: 'at', label: () => t('watch.col_time'), get: (r) => r.e.at, html: (r) => esc(fmtTime(r.e.at, locale())), priority: 1, csv: (r) => new Date(r.e.at).toISOString() },
    { key: 'item', label: () => t('watch.col_item'), get: (r) => r.name, html: (r) => itemCell(r.e.id, r.name, true), cls: 'name-cell', priority: 0, csv: (r) => r.e.id },
    { key: 'msg', label: () => t('watch.col_message'), get: (r) => r.msg, priority: 2, sortable: false },
  ];

  // ---------------------------------------------------------------- actions

  function addRule(id: string): void {
    const s = ctx.store.get();
    const rule = makeRule(id, s.alerts, ctx.derived.calcCtx());
    ctx.store.set((st) => ({ alerts: [...st.alerts, rule] }));
    editor.render();
    editor.focusRule(rule.key);
    ctx.toast(t('watch.ruleAdded', { name: s.catalog?.name(id) ?? id }), 'ok');
  }

  function addItem(id: string): void {
    const name = ctx.store.get().catalog?.name(id) ?? id;
    if (ctx.watch.has(id)) ctx.toast(t('watch.already', { name }), 'info');
    else {
      ctx.watch.toggle(id);
      ctx.toast(t('watch.added', { name }), 'ok');
    }
    els.addIn.value = '';
    closeSuggest();
  }

  function removeItem(id: string): void {
    const s = ctx.store.get();
    const name = s.catalog?.name(id) ?? id;
    const n = s.alerts.filter((r) => r.id === id).length;
    ctx.watch.toggle(id);
    if (panelId === id) panel.close();
    ctx.toast(n ? t('watch.removedKeep', { name, n }) : t('watch.removed', { name }), 'info');
  }

  // ---------------------------------------------------------------- add-item combobox

  function bazaarIds(): Set<string> {
    const s = ctx.store.get();
    const ids = new Set(Object.keys(s.snapshot?.products ?? {}));
    for (const i of Object.values(s.catalog?.items ?? {})) if (i.bazaar) ids.add(i.id);
    return ids;
  }

  function closeSuggest(): void {
    suggest = [];
    active = -1;
    els.addList.hidden = true;
    els.addList.replaceChildren();
    els.addIn.setAttribute('aria-expanded', 'false');
    els.addIn.removeAttribute('aria-activedescendant');
  }

  function renderSuggest(): void {
    const s = ctx.store.get();
    const q = els.addIn.value.trim();
    if (!q || !s.catalog) {
      closeSuggest();
      return;
    }
    const ids = bazaarIds();
    suggest = searchItems(s.catalog, q, SUGGEST_MAX, (i) => ids.has(i.id));
    active = suggest.length ? 0 : -1;
    els.addList.innerHTML = suggest.length
      ? suggest
          .map(
            (it, i) =>
              `<li role="option" id="w-opt-${i}" data-i="${i}" aria-selected="${i === active}">${esc(it.name)}<span class="id-sub">${esc(it.id)}</span>` +
              (ctx.watch.has(it.id) ? ` <span class="badge">${esc(t('common.watched'))}</span>` : '') +
              `</li>`,
          )
          .join('')
      : `<li class="w-opt-none" role="presentation">${esc(t('watch.addNoMatch'))}</li>`;
    els.addList.hidden = false;
    els.addIn.setAttribute('aria-expanded', String(suggest.length > 0));
    syncActive();
  }

  function syncActive(): void {
    els.addList.querySelectorAll<HTMLElement>('[role="option"]').forEach((o, i) => o.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) els.addIn.setAttribute('aria-activedescendant', `w-opt-${active}`);
    else els.addIn.removeAttribute('aria-activedescendant');
  }

  function submitAdd(): void {
    const s = ctx.store.get();
    const text = els.addIn.value.trim();
    if (!text) return;
    if (!s.catalog) {
      const up = text.toUpperCase().replace(/\s+/g, '_');
      if (s.snapshot?.products[up]) addItem(up);
      else ctx.toast(t('watch.addCatalog'), 'info');
      return;
    }
    const pick = active >= 0 ? suggest[active] : undefined;
    const id = pick?.id ?? resolveUserInput(s.catalog, text, bazaarIds());
    if (id) addItem(id);
    else ctx.toast(t('watch.notFound', { q: text }), 'warn');
  }

  function onAddKey(ev: KeyboardEvent): void {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (els.addList.hidden) renderSuggest();
      if (!suggest.length) return;
      ev.preventDefault();
      active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + suggest.length) % suggest.length;
      syncActive();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      submitAdd();
    } else if (ev.key === 'Escape' && !els.addList.hidden) {
      ev.preventDefault();
      ev.stopPropagation();
      closeSuggest();
    }
  }

  // ---------------------------------------------------------------- detail panel

  function detailHtml(r: WatchRow): string {
    const m = stats().get(r.id);
    const kv = (k: string, v: string) => `<dt>${esc(t(k))}</dt><dd>${v}</dd>`;
    const rules = ctx.store.get().alerts.filter((x) => x.id === r.id);
    return (
      `<dl class="kv">` +
      kv('watch.p_bid', esc(fmtCoins(r.bid))) +
      kv('watch.p_ask', esc(fmtCoins(r.ask))) +
      kv('watch.p_spread', esc(fmtPct(r.spread))) +
      kv('watch.p_margin', span(signCls(r.margin), fmtPct(r.margin))) +
      kv('watch.p_profit', span(signCls(r.profit), fmtCoins(r.profit))) +
      kv('watch.p_change1h', span(signCls(m?.change1h), signed(m?.change1h ?? null))) +
      kv('watch.p_change24h', span(signCls(r.change), signed(r.change))) +
      kv('watch.p_volatility', esc(fmtPct(m?.volatility ?? null))) +
      kv('watch.p_consistency', esc(fmtPct(m?.consistency ?? null, 0))) +
      kv('watch.p_vol', esc(fmtCompact(r.weekVol))) +
      `</dl>` +
      `<div class="w-panel-spark">${sparklineSvg(ctx.history.recent(r.id).map((p) => p.ask), { w: 240, h: 48 })}</div>` +
      `<h3 class="w-panel-h">${esc(t('watch.p_rules'))}</h3>` +
      (rules.length
        ? `<ul class="w-panel-rules">${rules.map((x) => `<li class="${x.enabled ? '' : 'muted'}">${esc(ruleText(x))}</li>`).join('')}</ul>`
        : `<p class="muted small">${esc(t('watch.p_noRules'))}</p>`) +
      `<div class="w-actions">` +
      `<button type="button" class="btn btn-sm btn-primary" data-pact="alert">🔔 ${esc(t('watch.p_addAlert'))}</button>` +
      `<a class="btn btn-sm" href="#/item/${encodeURIComponent(r.id)}">${esc(t('watch.p_openItem'))}</a>` +
      `</div>`
    );
  }

  function openPanel(r: WatchRow): void {
    panelId = r.id;
    table.setSelected(r.id);
    panel.open(r.name, detailHtml(r));
  }

  function refreshPanel(): void {
    if (!panelId || !panel.isOpen()) return;
    const s = ctx.store.get();
    if (!s.watchlist.some((w) => w.id === panelId)) {
      panel.close();
      return;
    }
    if (panel.el.contains(document.activeElement) && document.activeElement !== panel.el) return; // don't yank focus
    const r = rowFor(panelId, s, stats());
    panel.open(r.name, detailHtml(r));
  }

  // ---------------------------------------------------------------- notifications

  function renderNotify(): void {
    const s = ctx.store.get();
    const perm = notifyPermission();
    els.notifyState.textContent = t(s.settings.notify ? 'watch.notifyOn' : 'watch.notifyOff');
    els.perm.textContent = t(`watch.perm_${perm}`);
    const on = s.settings.notify && perm === 'granted';
    els.notifyBtn.textContent = t(on ? 'watch.disableBtn' : 'watch.enableBtn');
    els.notifyBtn.disabled = perm === 'unsupported';
    els.notifyBtn.className = on ? 'btn' : 'btn btn-primary';
    els.notifyBtn.dataset.on = String(on);
  }

  const setNotify = (notify: boolean) => ctx.store.set((st) => ({ settings: { ...st.settings, notify } }));

  async function onNotifyClick(): Promise<void> {
    const perm = notifyPermission();
    if (perm === 'unsupported') {
      ctx.toast(t('watch.unsupported'), 'warn');
      return;
    }
    if (ctx.store.get().settings.notify && perm === 'granted') {
      setNotify(false);
      ctx.toast(t('watch.disabledMsg'), 'info');
      return;
    }
    let res: NotificationPermission = perm;
    if (perm !== 'granted') {
      try {
        // must start inside the click handler (user gesture); older Safari only takes a callback
        res = await new Promise<NotificationPermission>((resolve) => {
          const p = Notification.requestPermission(resolve);
          if (p && typeof p.then === 'function') p.then(resolve, () => resolve('denied'));
        });
      } catch {
        res = 'denied';
      }
    }
    if (res === 'granted') {
      setNotify(true);
      ctx.toast(t('watch.enabledMsg'), 'ok');
    } else ctx.toast(t('watch.denied'), 'warn');
    if (root) renderNotify();
  }

  // ---------------------------------------------------------------- import / export

  async function copyExport(): Promise<void> {
    const s = ctx.store.get();
    const json = exportJson(s.watchlist, s.alerts);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(json);
      ctx.toast(t('watch.copied'), 'ok');
    } catch {
      els.importText.value = json; // fallback: put it where it can be selected by hand
      els.importText.select();
      ctx.toast(t('watch.copyFail'), 'warn');
    }
  }

  function downloadExport(): void {
    const s = ctx.store.get();
    const file = exportFileName();
    const blob = new Blob([exportJson(s.watchlist, s.alerts)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: file, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ctx.toast(t('watch.downloaded', { file }), 'ok');
  }

  function importText(text: string): void {
    const res = parseImport(text);
    if (!res.ok) {
      const msg =
        res.error === 'empty' ? t('watch.importEmpty') : res.error === 'nodata' ? t('watch.importNoData') : t('watch.importBad', { err: res.detail ?? '' });
      els.ioStatus.textContent = msg;
      ctx.toast(msg, 'err');
      return;
    }
    const m = mergeImport(ctx.store.get(), res);
    if (!m.items && !m.rules) {
      els.ioStatus.textContent = t('watch.importNothing');
      ctx.toast(els.ioStatus.textContent, 'info');
      return;
    }
    ctx.store.set({ watchlist: m.watchlist, alerts: m.alerts });
    els.ioStatus.textContent = t('watch.imported', { items: m.items, rules: m.rules });
    els.importText.value = '';
    ctx.toast(els.ioStatus.textContent, 'ok');
  }

  async function importFile(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    if (!f) return;
    try {
      importText(await f.text());
    } catch {
      ctx.toast(t('common.readFail'), 'err');
    }
    input.value = '';
  }

  // ---------------------------------------------------------------- render

  function renderLog(force = false): void {
    const s = ctx.store.get();
    const key = [s.alertLog, s.alerts, s.catalog];
    if (!force && key.every((v, i) => v === logKey[i])) return;
    logKey = key;
    const name = (id: string) => s.catalog?.name(id) ?? id;
    logTable.setRows(s.alertLog.map((e, i) => ({ key: `${e.at}:${e.ruleKey}:${i}`, e, name: name(e.id), msg: logMessage(e, s.alerts, name(e.id)) })));
    els.logClear.disabled = !s.alertLog.length;
  }

  function render(): void {
    if (!root) return;
    const s = ctx.store.get();
    if (s.catalogError && !s.catalog) {
      els.banner.textContent = t('common.catalogError', { err: s.catalogError });
      els.banner.hidden = false;
    } else els.banner.hidden = true;
    els.addHint.textContent = s.catalog ? t('watch.addHint') : t('watch.addCatalog');
    els.wait.hidden = !!s.snapshot || !s.watchlist.length;
    if (!els.wait.hidden) els.wait.textContent = t('watch.noSnapshot');

    const list = rows();
    emptyText = !s.watchlist.length ? t('watch.empty') : list.length ? '' : t('watch.emptyFilter');
    els.count.textContent = t('watch.count', { n: s.watchlist.length });
    table.setRows(list);
    editor.render();
    renderNotify();
    renderLog();
    refreshPanel();
  }

  const schedule = rafDebounce(render);

  function applyLabels(): void {
    if (!root) return;
    for (const el of root.querySelectorAll<HTMLElement>('[data-t]')) el.textContent = t(el.dataset.t!);
    for (const el of root.querySelectorAll<HTMLElement>('[data-t-ph]')) el.setAttribute('placeholder', t(el.dataset.tPh!));
    els.addList.setAttribute('aria-label', t('watch.suggestions'));
    els.logIntro.textContent = t('watch.logIntro', { n: ALERTS.logMax });
  }

  // ---------------------------------------------------------------- mount

  function section(cls: string, titleKey: string, ...kids: (Node | null)[]): HTMLElement {
    const hid = `${cls}-h`;
    return h('section', { class: `card w-sec ${cls}`, 'aria-labelledby': hid }, h('h2', { id: hid, 'data-t': titleKey, tabindex: '-1' }), ...kids);
  }

  return {
    id: 'watch',
    mount(el, c, route) {
      root = el;
      ctx = c;
      logKey = [];
      panelId = null;

      qs = bindQueryState(SCHEMA, route, ctx.setQuery, LS_VIEWPREFS + 'watch');
      bar = createFilterBar([{ kind: 'search', key: 'q', label: () => t('watch.filterLabel') }], qs);
      panel = createDetailPanel({ returnFocus: () => table.el.querySelector<HTMLElement>('[tabindex="0"]') });

      const count = h('span', { class: 'muted small', 'data-testid': 'watch-count' });
      table = createKitTable<WatchRow>({
        columns,
        rowKey: (r) => r.id,
        sort: qs.get().sort,
        onSortChange: (sort) => qs.set({ sort }),
        onActivate: (r) => openPanel(r),
        columnsKey: 'watch',
        // no toolbar onReset: the filter bar already has the reset button
        toolbar: { columns: true, exportName: 'watchlist', extra: count },
        emptyText: () => emptyText || t('watch.empty'),
        rowActions: (r) =>
          `<button type="button" class="btn btn-ghost btn-sm" data-action="alert" title="${esc(t('watch.act_alert', { name: r.name }))}" aria-label="${esc(t('watch.act_alert', { name: r.name }))}">🔔</button>` +
          `<button type="button" class="btn btn-ghost btn-sm w-star" data-action="watch" aria-pressed="true" title="${esc(t('watch.act_remove', { name: r.name }))}" aria-label="${esc(t('watch.act_remove', { name: r.name }))}">★</button>`,
        onRowAction: (action, r) => {
          if (action === 'watch') removeItem(r.id);
          else if (action === 'alert') addRule(r.id);
        },
      });
      table.el.dataset.testid = 'watch-table';
      const onPanelClick = (ev: MouseEvent) => {
        const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-pact]');
        if (b?.dataset.pact === 'alert' && panelId) addRule(panelId);
      };
      panel.el.addEventListener('click', onPanelClick);
      cleanups.push(
        panel.onClose(() => {
          panelId = null;
          table.setSelected(null);
        }),
      );

      logTable = createKitTable<LogRow>({
        columns: logColumns,
        rowKey: (r) => r.key,
        sort: { key: 'at', dir: 'desc' },
        emptyText: () => t('watch.logEmpty'),
        toolbar: { exportName: 'alert-log' },
      });
      logTable.el.dataset.testid = 'watch-log';

      editor = createRulesEditor(ctx, { addRule });

      // add-item combobox
      const addIn = h('input', {
        id: 'w-add-in',
        type: 'text',
        role: 'combobox',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-autocomplete': 'list',
        'aria-expanded': 'false',
        'aria-controls': 'w-add-list',
        'aria-describedby': 'w-add-hint',
        'data-t-ph': 'watch.addPh',
        'data-testid': 'watch-add',
      });
      const addList = h('ul', { id: 'w-add-list', role: 'listbox', class: 'w-add-list', hidden: true, 'data-testid': 'watch-suggest' });
      let blurTimer: ReturnType<typeof setTimeout> | undefined;
      addIn.addEventListener('input', renderSuggest);
      addIn.addEventListener('keydown', onAddKey);
      addIn.addEventListener('blur', () => {
        clearTimeout(blurTimer);
        blurTimer = setTimeout(() => root && document.activeElement !== addIn && closeSuggest(), 150);
      });
      cleanups.push(() => clearTimeout(blurTimer));
      addList.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus in the input
      addList.addEventListener('click', (ev) => {
        const li = (ev.target as HTMLElement).closest<HTMLElement>('[data-i]');
        const it = li ? suggest[Number(li.dataset.i)] : undefined;
        if (it) addItem(it.id);
      });
      const addBtn = h('button', { type: 'button', class: 'btn btn-primary', 'data-t': 'watch.addBtn', 'data-testid': 'watch-add-btn' });
      addBtn.addEventListener('click', submitAdd);
      const addHint = h('p', { id: 'w-add-hint', class: 'field-help' });

      // notifications
      const notifyState = h('dd', { 'data-testid': 'watch-notify-state' });
      const perm = h('dd', { 'data-testid': 'watch-perm' });
      const notifyBtn = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'watch-notify' });
      notifyBtn.addEventListener('click', () => void onNotifyClick());

      // log
      const logClear = h('button', { type: 'button', class: 'btn btn-sm btn-danger', 'data-t': 'watch.logClear', 'data-testid': 'watch-log-clear' });
      logClear.addEventListener('click', () => {
        ctx.store.set({ alertLog: [] });
        ctx.toast(t('watch.logCleared'), 'info');
      });
      const logIntro = h('p', { class: 'muted small' });

      // import / export
      const copyBtn = h('button', { type: 'button', class: 'btn btn-sm', 'data-t': 'watch.copy', 'data-testid': 'watch-copy' });
      copyBtn.addEventListener('click', () => void copyExport());
      const dlBtn = h('button', { type: 'button', class: 'btn btn-sm', 'data-t': 'watch.download', 'data-testid': 'watch-download' });
      dlBtn.addEventListener('click', downloadExport);
      const importTa = h('textarea', { id: 'w-import', rows: 4, spellcheck: 'false', class: 'mono', 'data-t-ph': 'watch.importPh', 'data-testid': 'watch-import-text' });
      const importBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-t': 'watch.importBtn', 'data-testid': 'watch-import' });
      importBtn.addEventListener('click', () => importText(importTa.value));
      const fileIn = h('input', { type: 'file', accept: 'application/json,.json', class: 'kit-sr', id: 'w-import-file', 'data-testid': 'watch-import-file' });
      fileIn.addEventListener('change', () => void importFile(fileIn));
      const fileLbl = h('label', { for: 'w-import-file', class: 'btn btn-sm w-file', 'data-t': 'watch.file' });
      const ioStatus = h('p', { class: 'muted small', role: 'status', 'data-testid': 'watch-io-status' });

      els = {
        banner: h('div', { class: 'banner banner-warn', role: 'status', hidden: true }),
        wait: h('p', { class: 'muted small', role: 'status', hidden: true, 'data-testid': 'watch-wait' }),
        count,
        addIn,
        addList,
        addHint,
        notifyState,
        perm,
        notifyBtn,
        logClear,
        logIntro,
        importText: importTa,
        ioStatus,
      };

      const head = h('header', { class: 'w-head' }, h('h1', { 'data-t': 'watch.title', tabindex: '-1' }), h('p', { class: 'muted small', 'data-t': 'watch.intro' }));
      const add = h(
        'div',
        { class: 'card w-add' },
        h('label', { for: 'w-add-in', class: 'field-label', 'data-t': 'watch.addLabel' }),
        h('div', { class: 'w-add-row' }, h('div', { class: 'w-combo' }, addIn, addList), addBtn),
        addHint,
      );
      const rulesSec = section('w-rules', 'watch.rulesTitle', h('p', { class: 'note', 'data-t': 'watch.rulesIntro' }), editor.el);
      const notifySec = section(
        'w-notify',
        'watch.notifyTitle',
        h('p', { class: 'note', 'data-t': 'watch.notifyIntro' }),
        h('dl', { class: 'kv kv-left' }, h('dt', { 'data-t': 'watch.notifyStatus' }), notifyState, h('dt', { 'data-t': 'watch.perm' }), perm),
        h('div', { class: 'w-actions' }, notifyBtn),
      );
      const logSec = section('w-log', 'watch.logTitle', h('div', { class: 'w-sec-bar' }, logIntro, logClear), logTable.el);
      const ioSec = section(
        'w-io',
        'watch.ioTitle',
        h('p', { class: 'note', 'data-t': 'watch.ioIntro' }),
        h('div', { class: 'w-actions' }, copyBtn, dlBtn),
        h('label', { for: 'w-import', class: 'field-label', 'data-t': 'watch.importLabel' }),
        importTa,
        h('div', { class: 'w-actions' }, importBtn, fileIn, fileLbl),
        ioStatus,
      );

      const main = h(
        'div',
        { class: 'w-main' },
        head,
        els.banner,
        add,
        h('div', { class: 'w-list' }, bar.el, els.wait, table.el),
        rulesSec,
        h('div', { class: 'w-side' }, notifySec, ioSec),
        logSec,
      );
      el.classList.add('kit-split', 'watch-view');
      el.append(main, panel.el);
      applyLabels();

      cleanups.push(
        () => panel.el.removeEventListener('click', onPanelClick),
        qs.onChange(() => {
          const sort = qs.get().sort;
          const cur = table.getSort();
          if (!cur || cur.key !== sort.key || cur.dir !== sort.dir) table.setSort(sort);
          render();
        }),
        ctx.store.subscribe((s, prev) => {
          if (
            s.snapshot !== prev.snapshot ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.settings !== prev.settings ||
            s.historyTick !== prev.historyTick ||
            s.watchlist !== prev.watchlist ||
            s.alerts !== prev.alerts ||
            s.alertLog !== prev.alertLog
          ) {
            schedule();
          }
        }),
        onLangChange(() => {
          panel.close();
          applyLabels();
          bar.refresh();
          table.refresh();
          logTable.refresh();
          renderLog(true);
          editor.render(true);
          render();
        }),
      );
      render();
    },
    update(route: Route) {
      if (!root) return;
      qs.fromRoute(route);
    },
    unmount() {
      for (const fn of cleanups.splice(0)) fn();
      bar?.destroy();
      table?.destroy();
      logTable?.destroy();
      panel?.destroy();
      editor?.destroy();
      sparkCache.clear();
      if (root) {
        root.classList.remove('kit-split', 'kit-split--open', 'watch-view');
        root.replaceChildren();
      }
      root = null;
    },
  };
}
