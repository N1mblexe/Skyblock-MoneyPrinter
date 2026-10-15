// NPC & Shops view: bazaar <-> NPC fixed-price flips (both directions) and currency shop offers valued in coins.
// Rows come from ctx.derived.npc() / ctx.derived.shops(); filters live in the URL (three query states so a filter
// reset never switches the segment); row details open in the kit detail panel.
import { PRICE_TICK } from '../../../config.ts';
import { round1 } from '../../../domain/pricing.ts';
import { onLangChange, t } from '../../../i18n/index.ts';
import type { AppState, Route, ShopRow, View, ViewContext } from '../../../types/contracts.ts';
import { itemCell, riskBadge, sourceBadge } from '../../cells.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtCompact, fmtInt, fmtPct } from '../../format.ts';
import {
  bindQueryState,
  createDetailPanel,
  createFilterBar,
  createKitTable,
  type DetailPanel,
  type FilterBar,
  type KitColumn,
  type KitTableHandle,
  type QueryState,
  type SortState,
} from '../../kit/index.ts';
import { flipDetailHtml, shopDetailHtml } from './npcDetail.ts';
import {
  currencyLabel,
  currencyOptions,
  filterFlips,
  filterShops,
  FLIP_SCHEMA,
  LS_FLIP,
  LS_SEG,
  LS_SHOPS,
  migrateNpcPrefs,
  SEG_SCHEMA,
  SEGMENTS,
  SHOP_SCHEMA,
  visibleShops,
  type FlipFilters,
  type NpcRow,
  type NpcSegment,
  type ShopFilters,
} from './npcData.ts';
import './npc.css';
import './i18n.ts';

/** Best-rate chips shown above the shops table. */
const RATE_CHIPS = 8;

type SegValues = { dir: string };

const sameSort = (a: SortState | undefined, b: SortState) => !!a && a.key === b.key && a.dir === b.dir;

export function createNpcView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  const cleanups: (() => void)[] = [];

  let segQs: QueryState<SegValues>;
  let flipQs: QueryState<FlipFilters>;
  let shopQs: QueryState<ShopFilters>;
  let flipBar: FilterBar;
  let shopBar: FilterBar;
  let flipTable: KitTableHandle<NpcRow>;
  let shopTable: KitTableHandle<ShopRow>;
  let panel: DetailPanel;

  // element refs (set in mount)
  let titleEl: HTMLElement;
  let introEl: HTMLElement;
  let segEl: HTMLElement;
  let descEl: HTMLElement;
  let stateEl: HTMLElement;
  let flipBox: HTMLElement;
  let shopBox: HTMLElement;
  let flipCount: HTMLElement;
  let flipHidden: HTMLButtonElement;
  let shopCount: HTMLElement;
  let shopHidden: HTMLButtonElement;
  let curLabel: HTMLElement;
  let curSel: HTMLSelectElement;
  let ratesEl: HTMLElement;
  let noteEl: HTMLDetailsElement;
  let noteOpen = false;

  let flipEmpty = '';
  let shopEmpty = '';
  let flipRows: NpcRow[] = [];
  let shopRows: ShopRow[] = [];
  let curSig = '';
  /** row currently shown in the detail panel */
  let openRow: { seg: NpcSegment; key: string } | null = null;

  const state = (): AppState => ctx!.store.get();
  const seg = (): NpcSegment => segQs.get().dir as NpcSegment;
  const isFlipSeg = (s: NpcSegment): s is NpcRow['direction'] => s !== 'shops';

  // ------------------------------------------------------------------ cells
  function priceCell(price: number, badge: string): string {
    return `<span class="npc-price">${esc(fmtCoins(price))}</span> ${badge}`;
  }

  function buyCell(r: NpcRow): string {
    if (r.direction === 'npc2bz') return priceCell(r.buyAt, sourceBadge('npc'));
    const s = state();
    if (s.settings.costMode === 'insta') return priceCell(r.buyAt, sourceBadge('insta'));
    const bid = s.snapshot?.products[r.id]?.bid;
    const floored = bid == null || r.buyAt > round1(bid + PRICE_TICK) + 1e-9;
    const hint = floored ? ` <span class="npc-floor" title="${esc(t('npc.floorTitle'))}">${esc(t('npc.floorHint'))}</span>` : '';
    return priceCell(r.buyAt, sourceBadge('order') + hint);
  }

  function sellCell(r: NpcRow): string {
    if (r.direction === 'bz2npc') return priceCell(r.sellAt, sourceBadge('npc'));
    const insta = state().settings.sellMode === 'insta';
    const badge = `<span class="badge ${insta ? 'src-insta' : 'src-order'}">${esc(t(insta ? 'npc.srcInstaSell' : 'npc.srcSellOffer'))}</span>`;
    return priceCell(r.sellAt, badge);
  }

  function star(id: string, name: string): string {
    const on = ctx!.watch.has(id);
    return `<button type="button" class="btn btn-ghost btn-sm npc-star${on ? ' on' : ''}" data-action="watch" aria-pressed="${on}" aria-label="${esc(
      t(on ? 'npc.unwatchAria' : 'npc.watchAria', { name }),
    )}" title="${esc(t(on ? 'common.unwatch' : 'common.watch'))}">${on ? '★' : '☆'}</button>`;
  }

  const limLabel = (k: string) => t(`npc.lim_${k}`);

  const flipColumns: KitColumn<NpcRow>[] = [
    {
      key: 'name',
      label: () => t('npc.col_item'),
      get: (r) => r.name,
      html: (r) => itemCell(r.id, r.name, true),
      cls: 'name-cell',
      priority: 0,
    },
    { key: 'buyAt', label: () => t('npc.col_buy'), title: () => t('npc.col_buyTitle'), get: (r) => r.buyAt, html: buyCell, align: 'right', priority: 2 },
    { key: 'sellAt', label: () => t('npc.col_sell'), title: () => t('npc.col_sellTitle'), get: (r) => r.sellAt, html: sellCell, align: 'right', priority: 2 },
    {
      key: 'profit',
      label: () => t('npc.col_profit'),
      get: (r) => r.profit,
      html: (r) => `<span class="${r.profit > 0 ? 'pos' : 'neg'}">${esc(fmtCoins(r.profit))}</span>`,
      align: 'right',
      priority: 3,
    },
    { key: 'margin', label: () => t('npc.col_margin'), get: (r) => r.margin, html: (r) => esc(fmtPct(r.margin)), align: 'right', priority: 2 },
    {
      key: 'uph',
      label: () => t('npc.col_uph'),
      title: () => t('npc.col_uphTitle'),
      get: (r) => r.tp.unitsPerHour,
      html: (r) => `<span title="${esc(t('npc.limitedBy', { x: limLabel(r.tp.limitedBy) }))}">${esc(fmtInt(r.tp.unitsPerHour))}</span>`,
      align: 'right',
      priority: 3,
    },
    {
      key: 'capital',
      label: () => t('npc.col_capital'),
      title: () => t('npc.col_capitalTitle'),
      get: (r) => r.tp.capitalUsed,
      html: (r) => esc(fmtCompact(r.tp.capitalUsed)),
      align: 'right',
      priority: 3,
    },
    {
      key: 'pph',
      label: () => t('npc.col_pph'),
      title: () => t('npc.col_pphTitle'),
      get: (r) => r.profitPerHour,
      html: (r) => `<strong class="pos">${esc(fmtCoins(r.profitPerHour))}</strong>`,
      align: 'right',
      priority: 1,
    },
    {
      key: 'vol',
      label: () => t('npc.col_vol'),
      title: () => t('npc.col_volTitle'),
      get: (r) => r.weekVol,
      html: (r) => esc(fmtCompact(r.weekVol)),
      align: 'right',
      priority: 3,
    },
    {
      key: 'lim',
      label: () => t('npc.col_lim'),
      title: () => t('npc.col_limTitle'),
      get: (r) => limLabel(r.tp.limitedBy),
      html: (r) => `<span class="npc-lim npc-lim-${esc(r.tp.limitedBy)}">${esc(limLabel(r.tp.limitedBy))}</span>`,
      priority: 3,
    },
    {
      key: 'slots',
      label: () => t('npc.col_slots'),
      title: () => t('npc.col_slotsTitle'),
      get: (r) => r.tp.slots ?? 0,
      html: (r) => esc(fmtInt(r.tp.slots ?? 0)),
      align: 'right',
      priority: 3,
    },
    {
      key: 'risk',
      label: () => t('npc.col_risk'),
      get: (r) => r.risk.score,
      csv: (r) => r.risk.level,
      html: (r) => riskBadge(r.risk),
      align: 'center',
      priority: 2,
    },
  ];

  function valueCell(r: ShopRow): string {
    if (r.value == null) return '—';
    const badge =
      r.valueSource === 'npc' ? sourceBadge('npc') : `<span class="badge src-bazaar">${esc(t('common.src_bazaar'))}</span>`;
    return `<span class="npc-price">${esc(fmtCoins(r.value))}</span> ${badge}`;
  }

  const cur = (r: ShopRow) => currencyLabel(r.currency, state().catalog);

  const shopColumns: KitColumn<ShopRow>[] = [
    {
      key: 'name',
      label: () => t('npc.col_output'),
      get: (r) => r.name,
      html: (r) => itemCell(r.id, r.name, true),
      cls: 'name-cell',
      priority: 0,
    },
    { key: 'shop', label: () => t('npc.col_shop'), get: (r) => r.shop, html: (r) => esc(r.shop || '—'), priority: 2 },
    { key: 'currency', label: () => t('npc.col_currency'), get: cur, html: (r) => `<span class="npc-cur">${esc(cur(r))}</span>`, priority: 1 },
    {
      key: 'cost',
      label: () => t('npc.col_cost'),
      title: () => t('npc.col_costTitle'),
      get: (r) => r.costQty,
      html: (r) => esc(fmtInt(r.costQty)),
      align: 'right',
      priority: 2,
    },
    { key: 'outQty', label: () => t('npc.col_outQty'), get: (r) => r.outQty, html: (r) => esc(fmtInt(r.outQty)), align: 'right', priority: 3 },
    {
      key: 'value',
      label: () => t('npc.col_value'),
      title: () => t('npc.col_valueTitle'),
      get: (r) => r.value,
      html: valueCell,
      align: 'right',
      priority: 2,
    },
    {
      key: 'cpc',
      label: () => t('npc.col_cpc'),
      title: () => t('npc.col_cpcTitle'),
      get: (r) => r.coinsPerCurrency,
      html: (r) =>
        r.coinsPerCurrency == null
          ? '—'
          : `<strong title="${esc(t('npc.rateLine', { cur: cur(r), n: fmtCoins(r.coinsPerCurrency), item: r.name }))}">${esc(fmtCoins(r.coinsPerCurrency))}</strong>`,
      align: 'right',
      priority: 1,
    },
    {
      key: 'vol',
      label: () => t('npc.col_vol'),
      title: () => t('npc.col_volTitle'),
      get: (r) => r.weekVol,
      html: (r) => esc(fmtCompact(r.weekVol)),
      align: 'right',
      priority: 3,
    },
    {
      key: 'risk',
      label: () => t('npc.col_risk'),
      get: (r) => r.risk?.score ?? null,
      csv: (r) => r.risk?.level ?? '',
      html: (r) => (r.risk ? riskBadge(r.risk) : '—'),
      align: 'center',
      priority: 2,
    },
  ];

  // ------------------------------------------------------------------ texts
  function renderTexts(): void {
    const s = state();
    const limit = fmtInt(s.settings.npcDailyLimit);
    titleEl.textContent = t('npc.title');
    introEl.textContent = t('npc.intro');
    descEl.textContent = t(`npc.dirDesc_${seg()}`, { limit });
    segEl.setAttribute('aria-label', t('npc.segAria'));
    for (const b of segEl.querySelectorAll<HTMLButtonElement>('button')) {
      b.textContent = t(`npc.dir_${b.dataset.seg}`);
      const on = b.dataset.seg === seg();
      b.setAttribute('aria-pressed', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    curLabel.textContent = t('npc.currency');
    ratesEl.setAttribute('aria-label', t('npc.ratesAria'));
    noteEl.innerHTML =
      `<summary>${esc(t('npc.noteTitle'))}</summary>` +
      `<p>${esc(t('npc.noteLimits', { limit }))}</p><p>${esc(t('npc.noteFloor'))}</p>` +
      `<p>${esc(t('npc.notePricing'))}</p><p>${esc(t('npc.noteShops'))}</p>`;
    noteEl.open = noteOpen;
  }

  function setState(msg: string | null, kind: 'info' | 'err' = 'info'): void {
    stateEl.hidden = msg == null;
    stateEl.className = `banner banner-${kind} npc-state`;
    stateEl.textContent = msg ?? '';
  }

  function hiddenButton(btn: HTMLButtonElement, suspect: number, hideOn: boolean, showing: boolean): void {
    if (!hideOn || suspect === 0) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    btn.textContent = showing ? t('npc.hiddenShowing', { n: suspect }) : t('common.hiddenCount', { n: suspect });
    btn.title = showing ? t('common.hideHidden') : t('npc.hiddenTitle');
    btn.setAttribute('aria-pressed', String(showing));
  }

  // ------------------------------------------------------------------ render
  function render(): void {
    if (!root || !ctx) return;
    const s = state();
    const sg = seg();
    flipBox.hidden = !isFlipSeg(sg);
    shopBox.hidden = isFlipSeg(sg);
    const ready = !!(s.snapshot && s.catalog);
    flipTable.el.hidden = !ready;
    shopTable.el.hidden = !ready;
    ratesEl.hidden = !ready;
    if (!s.catalog) {
      if (s.catalogError) setState(t('npc.catalogError', { err: s.catalogError }), 'err');
      else setState(t('npc.loadingCatalog'));
      return;
    }
    if (!s.snapshot) {
      setState(t('common.waitingData'));
      return;
    }
    setState(null);
    if (isFlipSeg(sg)) renderFlips(s, sg);
    else renderShops(s);
    refreshPanel();
  }

  function renderFlips(s: AppState, dir: NpcRow['direction']): void {
    const f = flipQs.get();
    const res = filterFlips(ctx!.derived.npc(), dir, f, { snap: s.snapshot!, catalog: s.catalog, settings: s.settings });
    const hide = s.settings.hideSuspicious;
    const hiddenN = hide && !f.hidden ? res.suspect : 0;
    flipEmpty = res.total === 0 ? t('npc.emptyNone') : hiddenN > 0 ? t('npc.emptyHidden', { n: hiddenN }) : t('npc.emptyFiltered');
    flipCount.textContent = t('npc.rowsCount', { n: res.rows.length });
    hiddenButton(flipHidden, res.suspect, hide, f.hidden);
    if (!sameSort(flipTable.getSort(), f.sort)) flipTable.setSort(f.sort);
    flipRows = res.rows;
    flipTable.setRows(res.rows);
  }

  function renderShops(s: AppState): void {
    const f = shopQs.get();
    const all = ctx!.derived.shops();
    const hide = s.settings.hideSuspicious;
    const base = visibleShops(all, hide, f.shidden);
    const opts = currencyOptions(base.rows, s.catalog);
    renderCurrencies(opts, f.cur);
    renderRates(opts, f.cur);
    const res = filterShops(all, f, s.catalog, hide);
    const hiddenN = hide && !f.shidden ? res.suspect : 0;
    shopEmpty = res.total === 0 ? t('npc.emptyShops') : hiddenN > 0 ? t('npc.emptyHidden', { n: hiddenN }) : t('npc.emptyFiltered');
    shopCount.textContent = t('npc.rowsCount', { n: res.rows.length });
    hiddenButton(shopHidden, res.suspect, hide, f.shidden);
    if (!sameSort(shopTable.getSort(), f.ssort)) shopTable.setSort(f.ssort);
    shopRows = res.rows;
    shopTable.setRows(res.rows);
  }

  function renderCurrencies(opts: ReturnType<typeof currencyOptions>, selected: string): void {
    const sig = `${selected}|${opts.map((o) => `${o.id}:${o.count}:${o.label}`).join(',')}`;
    if (sig === curSig && curSel.value === selected) return;
    if (document.activeElement === curSel && sig === curSig) return;
    curSig = sig;
    const total = opts.reduce((n, o) => n + o.count, 0);
    const list = opts.map((o) => ({ value: o.id, text: `${o.label} (${o.count})` }));
    if (selected && !opts.some((o) => o.id === selected)) list.push({ value: selected, text: currencyLabel(selected, state().catalog) });
    curSel.replaceChildren(
      h('option', { value: '' }, t('npc.currencyAll', { n: total })),
      ...list.map((o) => h('option', { value: o.value }, o.text)),
    );
    curSel.value = selected;
  }

  function renderRates(opts: ReturnType<typeof currencyOptions>, selected: string): void {
    const top = opts.filter((o) => o.best?.coinsPerCurrency != null).slice(0, RATE_CHIPS);
    ratesEl.replaceChildren(
      h('span', { class: 'npc-rates-title' }, t('npc.ratesTitle')),
      ...top.map((o) => {
        const b = o.best!;
        return h(
          'button',
          {
            type: 'button',
            class: 'chip npc-rate',
            'data-cur': o.id,
            'aria-pressed': String(o.id === selected),
            title: t('npc.rateTitle', { shop: b.shop || t('npc.shopUnknown'), cost: fmtInt(b.costQty), cur: o.label, out: fmtInt(b.outQty), item: b.name }),
          },
          t('npc.rateLine', { cur: o.label, n: fmtCoins(b.coinsPerCurrency), item: b.name }),
        );
      }),
    );
  }

  const schedule = rafDebounce(render);

  // ------------------------------------------------------------------ detail panel
  function detailCtx(id: string) {
    const s = state();
    return { snap: s.snapshot!, catalog: s.catalog!, settings: s.settings, watched: ctx!.watch.has(id) };
  }

  function panelBody(html: string, id: string): HTMLElement {
    const body = h('div', { class: 'npc-detail-wrap' });
    body.innerHTML = html;
    body.addEventListener('click', (ev) => {
      const btn = (ev.target as Element).closest('[data-panel-act="watch"]');
      if (!btn) return;
      ctx?.watch.toggle(id);
      refreshPanel(true);
      panel.el.querySelector<HTMLElement>('[data-panel-act="watch"]')?.focus();
    });
    return body;
  }

  function openFlip(r: NpcRow): void {
    openRow = { seg: r.direction, key: `${r.direction}:${r.id}` };
    flipTable.setSelected(openRow.key);
    panel.open(r.name, panelBody(flipDetailHtml(r, detailCtx(r.id)), r.id));
  }

  function openShop(r: ShopRow): void {
    openRow = { seg: 'shops', key: r.key };
    shopTable.setSelected(r.key);
    panel.open(r.name, panelBody(shopDetailHtml(r, detailCtx(r.id)), r.id));
  }

  /** Re-render the open panel with fresh numbers (skipped while focus is inside it, unless forced). */
  function refreshPanel(force = false): void {
    if (!openRow || !panel.isOpen() || !ctx) return;
    if (!force && panel.el.contains(document.activeElement)) return;
    const s = state();
    if (!s.snapshot || !s.catalog) return;
    if (openRow.seg === 'shops') {
      const r = shopRows.find((x) => x.key === openRow!.key) ?? ctx.derived.shops().find((x) => x.key === openRow!.key);
      if (r) panel.open(r.name, panelBody(shopDetailHtml(r, detailCtx(r.id)), r.id));
    } else {
      const key = openRow.key;
      const r = flipRows.find((x) => `${x.direction}:${x.id}` === key);
      if (r) panel.open(r.name, panelBody(flipDetailHtml(r, detailCtx(r.id)), r.id));
    }
  }

  // ------------------------------------------------------------------ segment control
  function buildSeg(): HTMLElement {
    const el = h('div', { class: 'seg npc-seg', role: 'group', 'data-testid': 'npc-seg' });
    for (const sg of SEGMENTS) {
      el.append(h('button', { type: 'button', 'data-seg': sg, onclick: () => segQs.set({ dir: sg }) }));
    }
    el.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft' && ev.key !== 'Home' && ev.key !== 'End') return;
      const i = SEGMENTS.indexOf(seg());
      const n = SEGMENTS.length;
      const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? n - 1 : (i + (ev.key === 'ArrowRight' ? 1 : -1) + n) % n;
      ev.preventDefault();
      segQs.set({ dir: SEGMENTS[next]! });
      el.querySelector<HTMLButtonElement>(`[data-seg="${SEGMENTS[next]}"]`)?.focus();
    });
    return el;
  }

  function onSegChange(): void {
    if (openRow && openRow.seg !== seg()) panel.close();
    renderTexts();
    render();
  }

  return {
    id: 'npc',
    mount(el, vctx, route) {
      root = el;
      ctx = vctx;
      flipRows = [];
      shopRows = [];
      curSig = '';
      openRow = null;
      migrateNpcPrefs();
      segQs = bindQueryState(SEG_SCHEMA, route, vctx.setQuery, LS_SEG);
      flipQs = bindQueryState(FLIP_SCHEMA, route, vctx.setQuery, LS_FLIP);
      shopQs = bindQueryState(SHOP_SCHEMA, route, vctx.setQuery, LS_SHOPS);

      titleEl = h('h1', { class: 'npc-title', tabindex: '-1' });
      introEl = h('p', { class: 'muted small npc-intro' });
      segEl = buildSeg();
      descEl = h('p', { class: 'small npc-dir-desc' });
      stateEl = h('div', { class: 'banner banner-info npc-state', role: 'status', hidden: true });
      noteEl = h('details', { class: 'note npc-note' });
      noteEl.addEventListener('toggle', () => (noteOpen = noteEl.open));

      // --- flips
      flipBar = createFilterBar(
        [
          { kind: 'search', key: 'q', label: () => t('common.search'), placeholder: () => t('npc.searchPh') },
          { kind: 'number', key: 'minMargin', label: () => t('npc.minMargin') },
          { kind: 'number', key: 'minPph', label: () => t('npc.minPph') },
          { kind: 'number', key: 'minVol', label: () => t('npc.minVol'), help: () => t('npc.minVolHelp') },
        ],
        flipQs,
      );
      flipCount = h('span', { class: 'npc-count' });
      flipHidden = h('button', { type: 'button', class: 'hidden-count', 'data-testid': 'npc-hidden', hidden: true });
      flipHidden.addEventListener('click', () => flipQs.set({ hidden: !flipQs.get().hidden }));
      const panelFocus = () => (isFlipSeg(seg()) ? flipTable : shopTable).el.querySelector<HTMLElement>('[tabindex="0"]');
      panel = createDetailPanel({ returnFocus: panelFocus });
      flipTable = createKitTable<NpcRow>({
        columns: flipColumns,
        rowKey: (r) => `${r.direction}:${r.id}`,
        sort: flipQs.get().sort,
        onSortChange: (sort) => flipQs.set({ sort }),
        onActivate: openFlip,
        rowClass: (r) => (r.risk.level === 'suspect' ? 'npc-suspect' : ''),
        emptyText: () => flipEmpty || t('common.noRows'),
        columnsKey: 'npc',
        toolbar: { columns: true, exportName: 'npc-flips', extra: h('div', { class: 'npc-tb' }, flipCount, flipHidden) },
        rowActions: (r) => star(r.id, r.name),
        onRowAction: (a, r) => a === 'watch' && ctx?.watch.toggle(r.id),
      });
      flipBox = h('div', { class: 'npc-box', 'data-testid': 'npc-flips' }, flipBar.el, flipTable.el);

      // --- shops
      shopBar = createFilterBar(
        [
          { kind: 'search', key: 'sq', label: () => t('common.search'), placeholder: () => t('npc.shopSearchPh') },
          { kind: 'number', key: 'svol', label: () => t('npc.minVol'), help: () => t('npc.minVolHelp') },
        ],
        shopQs,
      );
      curLabel = h('span', { class: 'field-label' });
      curSel = h('select', { 'data-filter': 'cur' });
      curSel.addEventListener('change', () => shopQs.set({ cur: curSel.value }));
      shopBar.el.querySelector('.kit-fb-fields')?.append(h('label', { class: 'field npc-cur-field' }, curLabel, curSel));
      ratesEl = h('div', { class: 'npc-rates', role: 'group', 'data-testid': 'npc-rates' });
      ratesEl.addEventListener('click', (ev) => {
        const b = (ev.target as Element).closest<HTMLElement>('[data-cur]');
        if (!b) return;
        const c = b.dataset.cur!;
        shopQs.set({ cur: shopQs.get().cur === c ? '' : c });
      });
      shopCount = h('span', { class: 'npc-count' });
      shopHidden = h('button', { type: 'button', class: 'hidden-count', 'data-testid': 'npc-shop-hidden', hidden: true });
      shopHidden.addEventListener('click', () => shopQs.set({ shidden: !shopQs.get().shidden }));
      shopTable = createKitTable<ShopRow>({
        columns: shopColumns,
        rowKey: (r) => r.key,
        sort: shopQs.get().ssort,
        onSortChange: (ssort) => shopQs.set({ ssort }),
        onActivate: openShop,
        rowClass: (r) => (r.risk?.level === 'suspect' ? 'npc-suspect' : r.value == null ? 'npc-unpriced' : ''),
        emptyText: () => shopEmpty || t('common.noRows'),
        columnsKey: 'npc-shops',
        toolbar: { columns: true, exportName: 'npc-shops', extra: h('div', { class: 'npc-tb' }, shopCount, shopHidden) },
        rowActions: (r) => star(r.id, r.name),
        onRowAction: (a, r) => a === 'watch' && ctx?.watch.toggle(r.id),
      });
      shopBox = h('div', { class: 'npc-box', 'data-testid': 'npc-shops' }, shopBar.el, ratesEl, shopTable.el);

      panel.onClose(() => {
        openRow = null;
        flipTable.setSelected(null);
        shopTable.setSelected(null);
      });

      const head = h(
        'header',
        { class: 'npc-head' },
        h('div', { class: 'npc-titlebar' }, titleEl, segEl),
        introEl,
        descEl,
      );
      el.classList.add('kit-split');
      el.append(h('section', { class: 'npc-view', 'data-testid': 'npc-view' }, head, stateEl, flipBox, shopBox, noteEl), panel.el);

      renderTexts();
      render();

      cleanups.push(
        segQs.onChange(onSegChange),
        flipQs.onChange(() => isFlipSeg(seg()) && schedule()),
        shopQs.onChange(() => seg() === 'shops' && schedule()),
        vctx.store.subscribe((s, prev) => {
          if (s.settings.npcDailyLimit !== prev.settings.npcDailyLimit) renderTexts();
          if (
            s.snapshot !== prev.snapshot ||
            s.settings !== prev.settings ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.historyTick !== prev.historyTick ||
            s.watchlist !== prev.watchlist ||
            s.ah !== prev.ah
          )
            schedule();
        }),
        onLangChange(() => {
          curSig = '';
          renderTexts();
          flipBar.refresh();
          shopBar.refresh();
          flipTable.refresh();
          shopTable.refresh();
          schedule();
        }),
      );
    },
    update(route: Route) {
      if (!root) return;
      segQs.fromRoute(route);
      flipQs.fromRoute(route);
      shopQs.fromRoute(route);
    },
    unmount() {
      for (const fn of cleanups.splice(0)) fn();
      if (!root) return;
      flipBar.destroy();
      shopBar.destroy();
      flipTable.destroy();
      shopTable.destroy();
      panel.destroy();
      root.classList.remove('kit-split', 'kit-split--open');
      root.replaceChildren();
      root = null;
      ctx = null;
      openRow = null;
    },
  };
}
