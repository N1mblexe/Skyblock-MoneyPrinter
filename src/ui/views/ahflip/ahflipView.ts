// AH flip finder (#/ahflip): lowest BIN -> relist under the second-lowest BIN, after AH fees, or pets bought below
// George's price (src/domain/ahFlips.ts). Rows are recomputed when the AH scan, the sales feed, the catalog, the mayor
// or a setting they read changes; filters (and the mode) live in the URL.
import { LS_VIEWPREFS } from '../../../config.ts';
import { computeAhFlips, computeGeorgeFlips, type AhFlipRow } from '../../../domain/ahFlips.ts';
import { salesLookup } from '../../../domain/market.ts';
import { onLangChange, t } from '../../../i18n/index.ts';
import { isDerpy } from '../../../state/derived.ts';
import type { AppState, View, ViewContext } from '../../../types/contracts.ts';
import { riskBadge } from '../../cells.ts';
import { esc, rafDebounce } from '../../dom.ts';
import { fmtAge, fmtCoins, fmtHours, fmtInt, fmtNum, fmtPct } from '../../format.ts';
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
} from '../../kit/index.ts';
import './ahflip.css';
import { AHFLIP_SCHEMA, ahListingCount, filterAhFlips, type AhFlipMode, type AhFlipQuery } from './model.ts';

export { AHFLIP_SCHEMA, filterAhFlips };

/** Name-cell markers: a max-level key, a stack bought whole. */
function markers(r: AhFlipRow): string {
  const out: string[] = [];
  if (r.maxLevel) out.push(`<span class="badge" data-ahf-max>${esc(t('ahflip.maxLevel'))}</span>`);
  if (r.stack > 1) out.push(`<span class="badge" data-ahf-stack>${esc(t('ahflip.stack', { n: fmtInt(r.stack) }))}</span>`);
  return out.length ? ` ${out.join(' ')}` : '';
}

/** Sell time: hours to sell the bought stack on the AH (marked when no sales are measured), instant for George. */
function hoursHtml(r: AhFlipRow): string {
  if (r.venue === 'george') return esc(t('ahflip.instant'));
  const h = esc(fmtHours(r.sellHours));
  return r.salesPerHour == null ? `<span class="muted" title="${esc(t('ahflip.tip_hoursGuess'))}">~${h}</span>` : h;
}

function columns(mode: () => AhFlipMode): KitColumn<AhFlipRow>[] {
  const coins = (k: 'buy' | 'next' | 'profit') => (r: AhFlipRow) => esc(fmtCoins(r[k]));
  const george = () => mode() === 'george';
  return [
    {
      key: 'name',
      label: () => t('ahflip.col_item'),
      get: (r) => r.name,
      cls: 'name-cell',
      priority: 0,
      csv: (r) => r.id,
      html: (r) =>
        `<span>${esc(r.name)}${markers(r)}</span><span class="id-sub">${esc(r.listingName && r.listingName !== r.name ? r.listingName : r.id)}</span>`,
    },
    { key: 'buy', label: () => t('ahflip.col_buy'), get: (r) => r.buy, align: 'right', priority: 2, html: coins('buy') },
    {
      key: 'next',
      label: () => t(george() ? 'ahflip.col_george' : 'ahflip.col_next'),
      title: () => t(george() ? 'ahflip.tip_george' : 'ahflip.tip_next'),
      get: (r) => r.next,
      align: 'right',
      priority: 2,
      html: coins('next'),
    },
    {
      key: 'profit',
      label: () => t('ahflip.col_profit'),
      get: (r) => r.profit,
      align: 'right',
      priority: 1,
      html: (r) => `<strong class="pos">${esc(fmtCoins(r.profit))}</strong>`,
    },
    { key: 'margin', label: () => t('ahflip.col_margin'), get: (r) => r.margin, align: 'right', priority: 1, html: (r) => esc(fmtPct(r.margin)) },
    { key: 'gap', label: () => t('ahflip.col_gap'), title: () => t('ahflip.tip_gap'), get: (r) => r.gap, align: 'right', priority: 3, html: (r) => esc(fmtPct(r.gap)) },
    {
      key: 'count',
      label: () => t(george() ? 'ahflip.col_units' : 'ahflip.col_count'),
      title: () => (george() ? t('ahflip.tip_units') : ''),
      get: (r) => (r.venue === 'george' ? r.units : r.count),
      align: 'right',
      priority: 3,
      html: (r) => esc(fmtInt(r.venue === 'george' ? r.units : r.count)),
    },
    { key: 'hours', label: () => t('ahflip.col_hours'), title: () => t('ahflip.tip_hours'), get: (r) => r.sellHours, align: 'right', priority: 2, html: hoursHtml },
    {
      key: 'pph',
      label: () => t('ahflip.col_pph'),
      title: () => t(george() ? 'ahflip.tip_pphGeorge' : 'ahflip.tip_pph'),
      get: (r) => r.profitPerHour,
      align: 'right',
      priority: 3,
      html: (r) => esc(fmtCoins(r.profitPerHour)),
    },
    {
      key: 'risk',
      label: () => t('ahflip.col_risk'),
      get: (r) => r.risk.score,
      csv: (r) => t(`risk.${r.risk.level}`),
      align: 'center',
      priority: 1,
      html: (r) => riskBadge(r.risk),
    },
  ];
}

/** Detail panel body: the trade with its fees (or George's price), the sell time, the in-game command, the caveat. */
export function ahFlipDetail(r: AhFlipRow, derpy: boolean, hasItemPage: boolean): string {
  const kv = (k: string, v: string) => `<div><dt>${esc(t(k))}</dt><dd>${v}</dd></div>`;
  const money = (n: number) => esc(fmtCoins(n));
  const george = r.venue === 'george';
  const notes: string[] = [];
  if (r.stack > 1) notes.push(t('ahflip.d_stackNote', { n: fmtInt(r.stack), total: fmtCoins(r.buy * r.stack) }));
  if (r.sellRef != null) notes.push(t('ahflip.d_medianCap', { ref: fmtCoins(r.sellRef) }));
  if (!george && r.salesPerHour == null) notes.push(t('ahflip.d_noSales'));
  if (derpy && !george) notes.push(t('ahflip.derpy'));
  const body = george
    ? `${kv('ahflip.d_buy', money(r.buy))}
      ${kv('ahflip.d_george', money(r.sellAt))}
      ${kv('ahflip.d_profit', `<strong class="pos">${money(r.profit)}</strong>`)}
      ${kv('ahflip.d_margin', esc(fmtPct(r.margin)))}
      ${kv('ahflip.d_units', esc(fmtInt(r.units)))}
      ${kv('ahflip.d_unitsProfit', money(r.plan.profitPerUnit * r.units))}`
    : `${kv('ahflip.d_buy', money(r.buy))}
      ${kv('ahflip.d_sellAt', money(r.sellAt))}
      ${kv('ahflip.d_fee', `−${money(r.listingFee)}`)}
      ${kv('ahflip.d_tax', `−${money(r.claimTax)}`)}
      ${kv('ahflip.d_profit', `<strong class="pos">${money(r.profit)}</strong>`)}
      ${kv('ahflip.d_margin', esc(fmtPct(r.margin)))}
      ${kv('ahflip.d_count', esc(fmtInt(r.count)))}
      ${kv('ahflip.d_hours', hoursHtml(r))}
      ${r.salesPerHour != null ? kv('ahflip.d_sales', esc(t('ahflip.perHour', { n: fmtNum(r.salesPerHour, 2) }))) : ''}`;
  return `<div class="ahf-detail">
    <p class="ahf-badges">${riskBadge(r.risk)}${markers(r)} <span class="id-sub">${esc(r.id)}</span></p>
    <dl class="kv">
      ${body}
      ${r.listingName ? kv('ahflip.d_listing', esc(r.listingName)) : ''}
    </dl>
    ${notes.map((n) => `<p class="note small">${esc(n)}</p>`).join('')}
    <p class="ahf-actions">
      ${r.uuid ? `<button type="button" class="btn btn-sm" data-ahf-copy title="${esc(t('ahflip.copyCmdTitle'))}">${esc(t('ahflip.copyCmd'))}</button>` : ''}
      ${hasItemPage ? `<a class="btn btn-sm btn-ghost" href="#/item/${encodeURIComponent(r.id)}">${esc(t('ahflip.openItem'))} →</a>` : ''}
    </p>
    <p class="note small">${esc(t(george ? 'ahflip.georgeCaveat' : 'ahflip.caveat'))}</p>
  </div>`;
}

export function createAhFlipView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  let qs: QueryState<AhFlipQuery> | null = null;
  let bar: FilterBar | null = null;
  let table: KitTableHandle<AhFlipRow> | null = null;
  let panel: DetailPanel | null = null;
  let detailEl: HTMLElement | null = null;
  let openKey: string | null = null;
  const subs: (() => void)[] = [];
  /** rows per mode, for the inputs they were computed from */
  let memo: { deps: readonly unknown[]; rows: AhFlipRow[] } | null = null;
  let lastRows: AhFlipRow[] = [];
  let mode: AhFlipMode = 'relist';

  const $ = <E extends Element = HTMLElement>(sel: string) => root!.querySelector<E>(sel)!;

  function rows(s: AppState, m: AhFlipMode): AhFlipRow[] {
    const derpy = isDerpy(s.election);
    if (!s.ah || !s.catalog) return [];
    const { ah, catalog, ahSales: sales } = s;
    const { conservative, cycleHours, share } = s.settings;
    const deps = [m, ah, catalog, derpy, sales, conservative, cycleHours, share];
    if (!memo || memo.deps.length !== deps.length || memo.deps.some((d, i) => d !== deps[i])) {
      const out =
        m === 'george'
          ? computeGeorgeFlips(ah, catalog, { cycleHours })
          : computeAhFlips(ah, catalog, { derpy, conservative, share, ...(sales ? { sales: salesLookup(sales) } : {}) });
      memo = { deps, rows: out };
    }
    return memo.rows;
  }

  function applyLabels(): void {
    if (!root) return;
    $('h1').textContent = t('ahflip.title');
    $('.ahf-intro').textContent = t('ahflip.intro');
  }

  function setState(html: string): void {
    const st = $('.ahf-state');
    st.innerHTML = html;
    st.hidden = !html;
  }

  function showDetail(r: AhFlipRow, reopen: boolean): void {
    if (!panel || !detailEl || !ctx) return;
    const s = ctx.store.get();
    detailEl.innerHTML = ahFlipDetail(r, isDerpy(s.election), !!s.catalog?.items[r.id] || !!s.snapshot?.products[r.id]);
    if (reopen || !panel.isOpen()) panel.open(r.name, detailEl);
  }

  function render(): void {
    if (!root || !ctx || !table || !qs) return;
    const s = ctx.store.get();
    const tools = $('.ahf-tools');
    const blocked = !s.settings.ahEnabled ? 'off' : !s.ah ? 'waiting' : s.ah.v == null || s.ah.v < 2 ? 'oldScan' : !s.catalog ? 'waiting' : null;
    if (blocked) {
      const btn = blocked === 'off' ? ` <button type="button" class="btn btn-sm" data-ahf-on>${esc(t('ahflip.turnOn'))}</button>` : '';
      setState(`<div class="empty card">${esc(t(`ahflip.${blocked}`))}${btn}</div>`);
      table.el.hidden = true;
      tools.hidden = true;
      return;
    }
    setState('');
    table.el.hidden = false;
    tools.hidden = false;
    const v = qs.get();
    const m: AhFlipMode = v.mode === 'george' ? 'george' : 'relist';
    if (m !== mode) {
      mode = m;
      table.refresh();
    }
    const all = rows(s, m);
    lastRows = all;
    const res = filterAhFlips(
      all,
      { q: v.q, minProfit: v.minProfit, minMargin: v.minMargin, minCount: v.minCount, pets: v.pets, hideSuspect: s.settings.hideSuspicious && !v.suspect },
      s.catalog,
    );
    const cur = table.getSort();
    if (!cur || cur.key !== v.sort.key || cur.dir !== v.sort.dir) table.setSort(v.sort);
    table.setRows(res.rows);
    $('.ahf-count').textContent = t('ahflip.count', { n: res.rows.length, total: all.length, count: all.length });
    $('.ahf-scan').textContent = t('ahflip.scanned', {
      age: fmtAge(Date.now() - s.ah!.fetchedAt),
      n: fmtInt(ahListingCount(s.ah!)),
    });
    if (openKey && panel?.isOpen()) {
      const r = all.find((x) => x.key === openKey);
      if (r) showDetail(r, false);
    }
  }

  const schedule = rafDebounce(render);

  async function copyCmd(): Promise<void> {
    const r = openKey ? lastRows.find((x) => x.key === openKey) : null;
    if (!r?.uuid || !ctx) return;
    const cmd = `/viewauction ${r.uuid}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(cmd);
      ctx.toast(t('ahflip.copied', { cmd }), 'ok');
    } catch {
      ctx.toast(t('ahflip.copyFail'), 'err');
    }
  }

  return {
    id: 'ahflip',
    mount(el, c, route) {
      root = el;
      ctx = c;
      el.innerHTML = `<div class="ahf-view kit-split">
        <header class="ahf-head"><h1 tabindex="-1"></h1><p class="ahf-intro muted small"></p></header>
        <div class="ahf-bar"></div>
        <div class="ahf-state" hidden></div>
        <div class="ahf-table"></div>
      </div>`;
      const state = bindQueryState(AHFLIP_SCHEMA, route, c.setQuery, LS_VIEWPREFS + 'ahflip');
      qs = state;
      bar = createFilterBar(
        [
          {
            kind: 'segment',
            key: 'mode',
            label: () => t('ahflip.mode'),
            options: [
              { value: 'relist', label: () => t('ahflip.mode_relist') },
              { value: 'george', label: () => t('ahflip.mode_george') },
            ],
          },
          { kind: 'search', key: 'q', label: () => t('ahflip.search'), placeholder: () => t('ahflip.searchPh') },
          { kind: 'number', key: 'minProfit', label: () => t('ahflip.minProfit') },
          { kind: 'number', key: 'minMargin', label: () => t('ahflip.minMargin'), suffix: '%' },
          { kind: 'number', key: 'minCount', label: () => t('ahflip.minCount') },
          { kind: 'toggle', key: 'pets', label: () => t('ahflip.pets') },
          { kind: 'toggle', key: 'suspect', label: () => t('ahflip.showSuspect') },
        ],
        state,
      );
      $('.ahf-bar').append(bar.el);
      const extra = document.createElement('div');
      extra.className = 'ahf-tools';
      extra.innerHTML = '<span class="ahf-count" role="status" data-testid="ahflip-count"></span><span class="ahf-scan muted small"></span>';
      panel = createDetailPanel({ returnFocus: () => table?.el.querySelector<HTMLElement>('[data-key][tabindex="0"]') ?? null });
      detailEl = document.createElement('div');
      table = createKitTable<AhFlipRow>({
        columns: columns(() => mode),
        rowKey: (r) => r.key,
        sort: state.get().sort,
        onSortChange: (s) => qs?.set({ sort: s }),
        emptyText: () => t('ahflip.empty'),
        onActivate: (r) => {
          openKey = r.key;
          table?.setSelected(openKey);
          showDetail(r, true);
        },
        selectedKey: null,
        columnsKey: 'ahflip',
        toolbar: { columns: true, exportName: 'ah-flips', extra },
      });
      $('.ahf-table').append(table.el);
      $('.ahf-view').append(panel.el);
      subs.push(
        panel.onClose(() => {
          openKey = null;
          table?.setSelected(null);
        }),
      );
      const onClick = (ev: MouseEvent) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (target?.closest('[data-ahf-copy]')) void copyCmd();
        if (target?.closest('[data-ahf-on]')) c.store.set((s) => ({ settings: { ...s.settings, ahEnabled: true } }));
      };
      el.addEventListener('click', onClick);
      subs.push(() => el.removeEventListener('click', onClick));
      subs.push(state.onChange(() => schedule()));
      subs.push(
        c.store.subscribe((s, prev) => {
          if (
            s.ah !== prev.ah ||
            s.ahSales !== prev.ahSales ||
            s.catalog !== prev.catalog ||
            s.settings !== prev.settings ||
            s.election !== prev.election ||
            s.ahProgress !== prev.ahProgress
          )
            schedule();
        }),
      );
      subs.push(
        onLangChange(() => {
          applyLabels();
          bar?.refresh();
          table?.refresh();
          schedule();
        }),
      );
      applyLabels();
      render();
    },
    update(route) {
      qs?.fromRoute(route);
    },
    unmount() {
      for (const off of subs.splice(0)) off();
      bar?.destroy();
      table?.destroy();
      panel?.destroy();
      bar = null;
      table = null;
      panel = null;
      detailEl = null;
      qs = null;
      openKey = null;
      memo = null;
      lastRows = [];
      mode = 'relist';
      if (root) root.textContent = '';
      root = null;
      ctx = null;
    },
  };
}
