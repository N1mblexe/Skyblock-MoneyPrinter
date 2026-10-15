// Flip finder: buy low (buy order), sell high (sell offer) on the same bazaar product.
// Rows come from ctx.derived.flips(); filters live in the URL (bindQueryState); a row opens the detail panel.
import { HOTKEYS, LS_VIEWPREFS } from '../../../config.ts';
import { matchesQuery } from '../../../domain/search.ts';
import { msgText, onLangChange, t } from '../../../i18n/index.ts';
import type { AppState, FlipRow, MarketStat, Route, View, ViewContext } from '../../../types/contracts.ts';
import { riskBadge } from '../../cells.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtCompact, fmtHours, fmtInt, fmtPct } from '../../format.ts';
import {
  bindQueryState,
  createDetailPanel,
  createFilterBar,
  createKitTable,
  registerHotkeys,
  type DetailPanel,
  type FilterBar,
  type KitColumn,
  type KitTableHandle,
  type QuerySchema,
  type QueryState,
  type QueryValues,
} from '../../kit/index.ts';
import { sparklineSvg } from '../../sparkline.ts';
import './flip.css';
import {
  changeHtml,
  fillText,
  focusedRowKey,
  kv,
  limitedHelp,
  limitedText,
  migrateLegacyPrefs,
  orderBookHtml,
  riskListHtml,
  section,
  signCls,
  span,
  statsHtml,
  tpPairs,
  watchButton,
} from './parts.ts';

export const FLIP_PREFS_KEY = LS_VIEWPREFS + 'flip';

/** FlipRow plus the buy-quote clamp, once the domain exposes it (contract request). */
type Row = FlipRow & { buyClamped?: 'npcFloor' | 'ask' };

const SORT_KEYS = ['name', 'buyAt', 'sellAt', 'profit', 'margin', 'change', 'change1h', 'cons', 'vol', 'comp', 'uph', 'capital', 'slots', 'fill', 'limited', 'pph', 'risk'] as const;

export const FLIP_SCHEMA = {
  q: { kind: 'string', def: '' },
  minVol: { kind: 'number', def: 10_000, min: 0 },
  /** percent, e.g. 1 = 1% */
  minMargin: { kind: 'number', def: 1, min: 0 },
  minPph: { kind: 'number', def: null, min: 0 },
  /** max risk level shown: all / caution (no suspect) / ok */
  risk: { kind: 'enum', def: 'all', values: ['all', 'caution', 'ok'] },
  /** show suspect rows even when settings.hideSuspicious is on */
  sus: { kind: 'bool', def: false },
  sort: { kind: 'sort', def: { key: 'pph', dir: 'desc' }, keys: SORT_KEYS },
} as const satisfies QuerySchema;

type Prefs = QueryValues<typeof FLIP_SCHEMA>;

const RISK_RANK = { ok: 0, caution: 1, suspect: 2 } as const;

export function createFlipView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext;
  let qs: QueryState<Prefs>;
  let bar: FilterBar | null = null;
  let table: KitTableHandle<Row> | null = null;
  let panel: DetailPanel | null = null;
  const cleanups: (() => void)[] = [];

  /** all derived rows (unfiltered) and the market stats map of the current render */
  let all: Row[] = [];
  let stats: ReadonlyMap<string, MarketStat> = new Map();
  let selectedId: string | null = null;
  let emptyText = '';
  /** data (not filters) changed since the last render: refresh the open panel too */
  let dataDirty = true;

  let sparkTick = -1;
  const sparkCache = new Map<string, string>();

  let els: {
    title: HTMLElement;
    intro: HTMLElement;
    banner: HTMLElement;
    msg: HTMLElement;
    body: HTMLElement;
    count: HTMLElement;
    hiddenBtn: HTMLButtonElement;
    hint: HTMLElement;
    note: HTMLElement;
  };

  const st = (id: string): MarketStat | undefined => stats.get(id);

  function spark(id: string): string {
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

  function clampBadge(r: Row): string {
    if (!r.buyClamped) return '';
    const npc = r.buyClamped === 'npcFloor';
    return ` <span class="badge src-npc flip-clamp" title="${esc(t(npc ? 'flip.clampedNpcTip' : 'flip.clampedAskTip'))}">${esc(t(npc ? 'flip.clampedNpc' : 'flip.clampedAsk'))}</span>`;
  }

  const num = (key: string, get: (r: Row) => number | null, html: (r: Row) => string, extra: Partial<KitColumn<Row>> = {}): KitColumn<Row> => ({
    key,
    label: () => t(`flip.col_${key}`),
    title: () => t(`flip.tip_${key}`),
    get,
    html,
    align: 'right',
    ...extra,
  });

  const columns: KitColumn<Row>[] = [
    {
      key: 'name',
      label: () => t('flip.col_item'),
      title: () => t('flip.tip_item'),
      get: (r) => r.name,
      html: (r) => `<a href="#/item/${encodeURIComponent(r.id)}">${esc(r.name)}</a>${clampBadge(r)}<span class="id-sub">${esc(r.id)}</span>`,
      csv: (r) => `${r.name} (${r.id})`,
      cls: 'name-cell',
      priority: 0,
    },
    {
      key: 'spark',
      label: () => t('flip.col_spark'),
      title: () => t('flip.tip_spark'),
      get: () => null,
      html: (r) => spark(r.id),
      sortable: false,
      csv: false,
      align: 'center',
      cls: 'flip-spark',
      priority: 3,
    },
    num('buyAt', (r) => r.buyAt, (r) => esc(fmtCoins(r.buyAt)), { priority: 2 }),
    num('sellAt', (r) => r.sellAt, (r) => esc(fmtCoins(r.sellAt)), { priority: 2 }),
    num('profit', (r) => r.profit, (r) => span(signCls(r.profit), fmtCoins(r.profit)), { priority: 3 }),
    num('margin', (r) => r.margin, (r) => span(signCls(r.margin), fmtPct(r.margin)), { priority: 1 }),
    num('change', (r) => st(r.id)?.change24h ?? null, (r) => changeHtml(st(r.id)?.change24h), { priority: 3 }),
    num('change1h', (r) => st(r.id)?.change1h ?? null, (r) => changeHtml(st(r.id)?.change1h), { priority: 3 }),
    num('cons', (r) => st(r.id)?.consistency ?? null, (r) => esc(fmtPct(st(r.id)?.consistency, 0)), { priority: 2 }),
    num('vol', (r) => r.weekVol, (r) => esc(fmtCompact(r.weekVol)), { priority: 2 }),
    num(
      'comp',
      (r) => r.compBuy + r.compSell,
      (r) => `${esc(fmtInt(r.compBuy))}<span class="muted"> / </span>${esc(fmtInt(r.compSell))}`,
      { priority: 3, defaultHidden: true, csv: (r) => `${r.compBuy}/${r.compSell}` },
    ),
    num('uph', (r) => r.tp.unitsPerHour, (r) => esc(fmtCompact(r.tp.unitsPerHour)), { priority: 3, defaultHidden: true }),
    num('capital', (r) => r.tp.capitalUsed, (r) => esc(fmtCompact(r.tp.capitalUsed)), { priority: 3 }),
    num('slots', (r) => r.tp.slots ?? null, (r) => esc(fmtInt(r.tp.slots)), { priority: 3 }),
    num('fill', (r) => r.tp.fillHours, (r) => esc(fillText(r.tp)), {
      priority: 3,
      csv: (r) => r.tp.fillHours,
    }),
    {
      key: 'limited',
      label: () => t('flip.col_limited'),
      title: () => t('flip.tip_limited'),
      get: (r) => limitedText(r.tp.limitedBy),
      html: (r) => `<span title="${esc(limitedHelp(r.tp.limitedBy))}">${esc(limitedText(r.tp.limitedBy))}</span>`,
      priority: 3,
    },
    num('pph', (r) => r.profitPerHour, (r) => `<strong>${span(signCls(r.profitPerHour), fmtCoins(r.profitPerHour))}</strong>`, { priority: 1 }),
    {
      key: 'risk',
      label: () => t('flip.col_risk'),
      title: () => t('flip.tip_risk'),
      get: (r) => r.risk.score,
      html: (r) => riskBadge(r.risk),
      csv: (r) => t(`risk.${r.risk.level}`),
      align: 'center',
      priority: 1,
    },
  ];

  // ---------------------------------------------------------------- detail panel
  function detailHtml(r: Row): string {
    const s = ctx.store.get();
    const { costMode, sellMode, orderSlots } = s.settings;
    const tp = r.tp;
    const n = fmtInt(Math.round(tp.batchQty));
    const steps = [
      costMode === 'order'
        ? t('flip.stepBuyOrder', { n, price: esc(fmtCoins(r.buyAt)), h: esc(fmtHours(tp.buyHours ?? tp.fillHours)) })
        : t('flip.stepBuyInsta', { n, price: esc(fmtCoins(r.buyAt)) }),
      sellMode === 'offer'
        ? t('flip.stepSellOffer', { price: esc(fmtCoins(r.sellAt)), h: esc(fmtHours(tp.sellHours ?? tp.fillHours)) })
        : t('flip.stepSellInsta', { price: esc(fmtCoins(r.sellAt)) }),
      t('flip.stepProfit', { batch: esc(fmtCoins(r.profit * tp.batchQty)), pph: esc(fmtCoins(r.profitPerHour)) }),
    ];
    const clamp = r.buyClamped
      ? `<p class="small">${clampBadge(r)} ${esc(t(r.buyClamped === 'npcFloor' ? 'flip.clampedNpcTip' : 'flip.clampedAskTip'))}</p>`
      : '';
    const watched = ctx.watch.has(r.id);
    return (
      `<div class="dp flip-dp" data-id="${esc(r.id)}">` +
      section(
        t('flip.planTitle'),
        (tp.batchQty >= 0.5
          ? `<ol class="dp-steps">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>`
          : `<p class="small" data-testid="plan-zero">${esc(t('flip.planZero', { why: limitedText(tp.limitedBy) }))}</p>`) +
          clamp +
          kv([[t('flip.profitUnit'), span(signCls(r.profit), fmtCoins(r.profit))], ...tpPairs(tp, orderSlots, r.profitPerHour)]),
      ) +
      section(t('flip.riskTitle'), riskListHtml(r.risk)) +
      section(t('flip.statsTitle'), statsHtml(st(r.id))) +
      section(t('flip.bookTitle'), orderBookHtml(s.snapshot?.products[r.id])) +
      section(
        t('flip.linksTitle'),
        `<div class="dp-links"><a class="btn btn-sm" href="#/item/${encodeURIComponent(r.id)}">${esc(t('flip.openItem'))}</a>` +
          `<a class="btn btn-sm" data-testid="flip-track" href="#/trades?${new URLSearchParams({ add: r.id, side: 'buy', price: String(r.buyAt), qty: String(Math.max(1, Math.ceil(r.tp.batchQty))) })}">${esc(t('flip.trackOrder'))}</a>` +
          `<button type="button" class="btn btn-sm" data-panel="watch" aria-pressed="${watched}">${esc(t(watched ? 'flip.watchRemove' : 'flip.watchAdd'))}</button></div>`,
      ) +
      '</div>'
    );
  }

  function openDetail(r: Row): void {
    selectedId = r.id;
    table?.setSelected(r.id);
    panel?.open(r.name, detailHtml(r));
  }

  /** Re-render the open panel with fresh data (keeps focus on the same panel control). */
  function refreshPanel(): void {
    if (!panel?.isOpen() || !selectedId) return;
    const r = all.find((x) => x.id === selectedId);
    if (!r) return;
    const active = document.activeElement as HTMLElement | null;
    const focusSel = active && panel.el.contains(active) ? active.dataset.panel : undefined;
    panel.open(r.name, detailHtml(r));
    if (focusSel) panel.el.querySelector<HTMLElement>(`[data-panel="${focusSel}"]`)?.focus();
  }

  function toggleWatch(id: string): void {
    const r = all.find((x) => x.id === id);
    const name = r?.name ?? id;
    const was = ctx.watch.has(id);
    ctx.watch.toggle(id);
    ctx.toast(t(was ? 'flip.unstarred' : 'flip.starred', { name }), 'ok');
  }

  // ---------------------------------------------------------------- render
  function filtered(s: AppState): { shown: Row[]; hidden: number } {
    const p = qs.get();
    const minM = p.minMargin != null ? p.minMargin / 100 : -Infinity;
    const minV = p.minVol ?? -Infinity;
    const minP = p.minPph ?? -Infinity;
    const maxRisk = p.risk === 'ok' ? 0 : p.risk === 'caution' ? 1 : 2;
    const hideSusp = s.settings.hideSuspicious && !p.sus;
    const shown: Row[] = [];
    let hidden = 0;
    for (const r of all) {
      if (r.weekVol < minV || r.margin < minM || r.profitPerHour < minP) continue;
      if (RISK_RANK[r.risk.level] > maxRisk) continue;
      if (p.q && !matchesQuery(s.catalog, r.id, p.q)) continue;
      if (r.risk.level === 'suspect' && s.settings.hideSuspicious) {
        hidden++;
        if (hideSusp) continue;
      }
      shown.push(r);
    }
    return { shown, hidden };
  }

  function render(): void {
    if (!root || !table) return;
    const s = ctx.store.get();
    if (s.historyTick !== sparkTick) {
      sparkTick = s.historyTick;
      sparkCache.clear();
    }

    const failed = !!s.catalogError && !s.catalog;
    els.banner.hidden = !failed;
    if (failed) els.banner.textContent = t('common.catalogError', { err: msgText(s.catalogError!) });

    all = ctx.derived.flips();
    if (!s.snapshot || (!s.catalog && (!failed || !all.length))) {
      els.msg.textContent = !s.snapshot ? t('common.waitingData') : failed ? t('flip.catalogFailed') : t('flip.loadingNames');
      els.msg.hidden = false;
      els.body.hidden = true;
      return;
    }
    els.msg.hidden = true;
    els.body.hidden = false;
    stats = ctx.derived.marketStats(); // once per render, read by the column getters

    const { shown, hidden } = filtered(s);
    const p = qs.get();
    els.count.textContent = t('flip.count', { n: fmtInt(shown.length) });
    if (hidden > 0) {
      els.hiddenBtn.hidden = false;
      els.hiddenBtn.textContent = p.sus ? t('common.hideHidden') : t('common.hiddenCount', { n: hidden });
      els.hiddenBtn.title = p.sus ? t('common.hideHidden') : t('common.showHidden');
      els.hiddenBtn.setAttribute('aria-pressed', String(p.sus));
    } else els.hiddenBtn.hidden = true;
    emptyText = hidden > 0 && !p.sus ? t('flip.emptyHidden', { n: hidden }) : t('flip.empty');
    table.setRows(shown);
    if (dataDirty) {
      dataDirty = false;
      refreshPanel();
    }
  }

  const schedule = rafDebounce(render);

  function applyLabels(): void {
    els.title.textContent = t('flip.title');
    els.intro.textContent = t('flip.intro');
    els.hint.textContent = t('flip.hotkeys');
    els.note.innerHTML = ['noteHow', 'notePph', 'noteSettings'].map((k) => `<p>${t('flip.' + k)}</p>`).join('');
  }

  function starCurrent(): void {
    if (!table) return;
    const id = (panel?.isOpen() ? selectedId : null) ?? focusedRowKey(table.el) ?? selectedId;
    if (!id) {
      ctx.toast(t('flip.starNone'), 'info');
      return;
    }
    toggleWatch(id);
  }

  return {
    id: 'flip',
    mount(el, c, route) {
      root = el;
      ctx = c;
      selectedId = null;
      dataDirty = true;
      migrateLegacyPrefs(FLIP_PREFS_KEY);
      qs = bindQueryState(FLIP_SCHEMA, route, ctx.setQuery, FLIP_PREFS_KEY);

      els = {
        title: h('h1', { class: 'view-title' }),
        intro: h('p', { class: 'muted small view-intro' }),
        banner: h('div', { class: 'banner banner-warn', role: 'status', hidden: true }),
        msg: h('div', { class: 'empty', role: 'status', 'data-testid': 'flip-msg' }),
        body: h('div', { class: 'flip-body' }),
        count: h('span', { 'data-testid': 'flip-count' }),
        hiddenBtn: h('button', { type: 'button', class: 'hidden-count', 'data-testid': 'flip-hidden', hidden: true }),
        hint: h('span', { class: 'muted small flip-hint' }),
        note: h('div', { class: 'note' }),
      };
      els.hiddenBtn.addEventListener('click', () => qs.set({ sus: !qs.get().sus }));

      bar = createFilterBar(
        [
          { kind: 'search', key: 'q', label: () => t('flip.search'), placeholder: () => t('flip.searchPh') },
          { kind: 'number', key: 'minVol', label: () => t('flip.minVol') },
          { kind: 'number', key: 'minMargin', label: () => t('flip.minMargin'), suffix: '%' },
          { kind: 'number', key: 'minPph', label: () => t('flip.minPph') },
          {
            kind: 'segment',
            key: 'risk',
            label: () => t('flip.risk'),
            options: [
              { value: 'all', label: () => t('flip.riskAll') },
              { value: 'caution', label: () => t('flip.riskCaution') },
              { value: 'ok', label: () => t('flip.riskOk') },
            ],
          },
          { kind: 'toggle', key: 'sus', label: () => t('flip.showSuspect') },
        ],
        qs,
      );

      panel = createDetailPanel({ returnFocus: () => table?.el.querySelector<HTMLElement>('[data-key][tabindex="0"]') ?? null });
      panel.onClose(() => {
        selectedId = null;
        table?.setSelected(null);
      });
      panel.el.addEventListener('click', (ev) => {
        const btn = (ev.target as Element | null)?.closest<HTMLElement>('[data-panel="watch"]');
        if (btn && selectedId) toggleWatch(selectedId);
      });

      const extra = h('div', { class: 'flip-tools' }, els.count, els.hiddenBtn);
      table = createKitTable<Row>({
        columns,
        rowKey: (r) => r.id,
        sort: qs.get().sort,
        onSortChange: (sort) => qs.set({ sort }),
        onActivate: openDetail,
        rowClass: (r) => (r.risk.level === 'ok' ? '' : `risk-row-${r.risk.level}`),
        emptyText: () => emptyText || t('flip.empty'),
        columnsKey: 'flip',
        toolbar: { columns: true, exportName: 'flips', extra },
        rowActions: (r) => watchButton(ctx.watch.has(r.id), r.name),
        onRowAction: (action, r) => {
          if (action === 'watch') toggleWatch(r.id);
        },
      });
      els.body.append(table.el, els.hint);

      const main = h(
        'div',
        { class: 'flip-main' },
        h('header', { class: 'view-head' }, els.title, els.intro),
        bar.el,
        els.banner,
        els.msg,
        els.body,
        els.note,
      );
      const sec = h('section', { class: 'flip-view kit-split', 'data-testid': 'flip-view' }, main, panel.el);
      applyLabels();
      el.append(sec);

      cleanups.push(
        qs.onChange((v) => {
          const cur = table?.getSort();
          if (cur && (cur.key !== v.sort.key || cur.dir !== v.sort.dir)) table!.setSort(v.sort);
          schedule();
        }),
        ctx.store.subscribe((s, prev) => {
          if (
            s.snapshot !== prev.snapshot ||
            s.settings !== prev.settings ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.historyTick !== prev.historyTick ||
            s.ah !== prev.ah ||
            s.watchlist !== prev.watchlist
          ) {
            dataDirty = true;
            schedule();
          }
        }),
        onLangChange(() => {
          applyLabels();
          bar?.refresh();
          table?.refresh();
          dataDirty = true;
          render();
        }),
        registerHotkeys(
          Object.fromEntries([...HOTKEYS.star.map((k) => [k, starCurrent]), ...HOTKEYS.export.map((k) => [k, () => table?.exportCsv()])]),
        ),
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
      panel?.destroy();
      bar = null;
      table = null;
      panel = null;
      all = [];
      stats = new Map();
      sparkCache.clear();
      if (root) root.replaceChildren();
      root = null;
    },
  };
}
