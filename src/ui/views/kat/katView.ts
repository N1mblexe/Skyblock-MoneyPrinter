// Kat upgrades (#/kat): buy a pet on the AH, upgrade its rarity at Kat, sell it on the AH (src/domain/kat.ts).
// Rows are recomputed when the AH scan, the catalog, the bazaar snapshot, the settings or the mayor change (and per
// skip option); the other filters live in the URL.
import { LS_VIEWPREFS } from '../../../config.ts';
import { computeKatFlips, KAT_RARITIES, type KatItemLine, type KatRow, type KatSkip } from '../../../domain/kat.ts';
import { onLangChange, t } from '../../../i18n/index.ts';
import { isDerpy } from '../../../state/derived.ts';
import type { AppState, View, ViewContext } from '../../../types/contracts.ts';
import { riskBadge, sourceBadge } from '../../cells.ts';
import { esc, rafDebounce } from '../../dom.ts';
import { fmtAge, fmtCoins, fmtHours, fmtInt, fmtList, fmtPct } from '../../format.ts';
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
import { ahListingCount } from '../ahflip/model.ts';
import './kat.css';
import { filterKat, KAT_SCHEMA, type KatQuery } from './model.ts';

export { filterKat, KAT_SCHEMA };

/** "EPIC" -> "Epic" (rarities are game data: not translated). */
export const rarityName = (i: number): string => {
  const r = KAT_RARITIES[i] ?? String(i);
  return r.charAt(0) + r.slice(1).toLowerCase();
};

const priced = (r: KatRow) => r.unpriced.length === 0;
/** every step item and skip item has a price (the upgrade cost is known even when the sale is not) */
const itemsPriced = (r: KatRow) => r.steps.every((s) => s.items.every((l) => l.source) && s.skip.every((l) => l.source));
const dash = '—';

function columns(): KitColumn<KatRow>[] {
  const coins = (f: (r: KatRow) => number) => (r: KatRow) => esc(fmtCoins(f(r)));
  return [
    {
      key: 'name',
      label: () => t('kat.col_pet'),
      get: (r) => r.name,
      cls: 'name-cell',
      priority: 0,
      csv: (r) => r.id,
      html: (r) => `<span>${esc(r.name)}</span><span class="id-sub">${esc(r.listingName ?? r.id)}</span>`,
    },
    {
      key: 'tiers',
      label: () => t('kat.col_tiers'),
      get: (r) => r.from * 10 + r.to,
      csv: (r) => `${rarityName(r.from)} > ${rarityName(r.to)}`,
      priority: 1,
      html: (r) =>
        `<span>${esc(t('kat.tiers', { from: rarityName(r.from), to: rarityName(r.to) }))}</span><span class="id-sub">${esc(t('kat.levels', { a: r.levelStart, b: r.levelEnd }))}</span>`,
    },
    {
      key: 'band',
      label: () => t('kat.col_band'),
      title: () => t('kat.tip_band'),
      get: (r) => r.band,
      csv: (r) => r.band,
      priority: 2,
      html: (r) => esc(t(`kat.band_${r.band}`)),
    },
    { key: 'buy', label: () => t('kat.col_buy'), get: (r) => r.buy, align: 'right', priority: 2, html: coins((r) => r.buy) },
    {
      key: 'upgrade',
      label: () => t('kat.col_upgrade'),
      title: () => t('kat.tip_upgrade'),
      get: (r) => r.upgradeCost,
      align: 'right',
      priority: 2,
      html: (r) => (itemsPriced(r) ? coins((x) => x.upgradeCost)(r) : `<span class="muted">${esc(t('kat.noPrice'))}</span>`),
    },
    {
      key: 'sell',
      label: () => t('kat.col_sell'),
      title: () => t('kat.tip_sell'),
      get: (r) => r.sell,
      align: 'right',
      priority: 2,
      html: (r) => (r.sell > 0 ? coins((x) => x.sell)(r) : `<span class="muted">${esc(t('kat.noPrice'))}</span>`),
    },
    {
      key: 'profit',
      label: () => t('kat.col_profit'),
      get: (r) => r.profit,
      align: 'right',
      priority: 1,
      html: (r) => (priced(r) ? `<strong class="${r.profit >= 0 ? 'pos' : 'neg'}">${esc(fmtCoins(r.profit))}</strong>` : dash),
    },
    { key: 'margin', label: () => t('kat.col_margin'), get: (r) => r.margin, align: 'right', priority: 2, html: (r) => (priced(r) ? esc(fmtPct(r.margin)) : dash) },
    { key: 'hours', label: () => t('kat.col_hours'), title: () => t('kat.tip_hours'), get: (r) => r.hours, align: 'right', priority: 2, html: (r) => esc(fmtHours(r.hours)) },
    {
      key: 'pph',
      label: () => t('kat.col_pph'),
      get: (r) => r.profitPerHour,
      align: 'right',
      priority: 1,
      html: (r) => (priced(r) ? esc(fmtCoins(r.profitPerHour)) : dash),
    },
    {
      key: 'risk',
      label: () => t('kat.col_risk'),
      get: (r) => r.risk.score,
      csv: (r) => t(`risk.${r.risk.level}`),
      align: 'center',
      priority: 1,
      html: (r) => riskBadge(r.risk),
    },
  ];
}

function srcBadge(l: KatItemLine): string {
  if (l.source === 'ah') return `<span class="badge">${esc(t('common.src_ah'))}</span>`;
  return l.source ? sourceBadge(l.source) : `<span class="badge risk-suspect">${esc(t('kat.noPrice'))}</span>`;
}

function itemList(lines: readonly KatItemLine[]): string {
  return `<ul class="kat-items">${lines
    .map(
      (l) =>
        `<li><span>${esc(t('kat.itemQty', { qty: fmtInt(l.qty), name: l.name }))}</span> ${srcBadge(l)} <span class="num">${l.source ? esc(fmtCoins(l.total)) : dash}</span></li>`,
    )
    .join('')}</ul>`;
}

/** Detail panel body: buy, each Kat step (levels, discounted coins, items, wait, skip), sell, totals, notes. */
export function katDetail(r: KatRow, derpy: boolean): string {
  const kv = (k: string, v: string) => `<div><dt>${esc(t(k))}</dt><dd>${v}</dd></div>`;
  const money = (n: number) => esc(fmtCoins(n));
  const steps = r.steps
    .map((s) => {
      const wait = s.hours < s.baseHours ? t('kat.waitSkipped', { h: fmtHours(s.hours), base: fmtHours(s.baseHours) }) : fmtHours(s.hours);
      const coins = s.coins < s.baseCoins ? t('kat.coinsDiscount', { coins: fmtCoins(s.coins), base: fmtCoins(s.baseCoins) }) : fmtCoins(s.coins);
      return `<li class="kat-step">
        <h3>${esc(t('kat.tiers', { from: rarityName(s.from), to: rarityName(s.to) }))} <span class="muted small">${esc(t('kat.levels', { a: s.levelBefore, b: s.levelAfter }))}</span></h3>
        <dl class="kv">
          ${kv('kat.d_coins', esc(coins))}
          ${s.items.length ? kv('kat.d_items', s.items.every((l) => l.source) ? money(s.itemsCost) : dash) : ''}
          ${kv('kat.d_wait', esc(wait))}
          ${s.skip.length ? kv('kat.d_skip', money(s.skipCost)) : ''}
        </dl>
        ${s.items.length ? itemList(s.items) : ''}
        ${s.skip.length ? itemList(s.skip) : ''}
      </li>`;
    })
    .join('');
  const notes: string[] = [];
  if (!r.levelKnown) notes.push(t('kat.levelGuess'));
  if (!r.sellKey.endsWith('@MAX')) notes.push(t('kat.sellVariant', { rarity: rarityName(r.to), level: r.levelEnd }));
  if (r.unpriced.length) notes.push(t('kat.unpricedNote', { items: fmtList(r.unpriced) }));
  if (derpy) notes.push(t('kat.derpy'));
  return `<div class="kat-detail">
    <p class="kat-badges">${riskBadge(r.risk)} <span class="id-sub">${esc(r.id)}</span></p>
    <dl class="kv">
      ${kv('kat.d_buy', money(r.buy))}
      ${r.listingName ? kv('kat.d_listing', esc(r.listingName)) : ''}
      ${kv('kat.d_level', esc(t('kat.levels', { a: r.levelStart, b: r.levelEnd })))}
    </dl>
    <h3 class="kat-sub">${esc(t('kat.d_steps'))}</h3>
    <ol class="kat-steps">${steps}</ol>
    <dl class="kv">
      ${kv('kat.d_upgrade', itemsPriced(r) ? money(r.upgradeCost) : dash)}
      ${kv('kat.d_capital', itemsPriced(r) ? money(r.capital) : dash)}
      ${r.sell > 0 ? kv('kat.d_sell', `${money(r.sell)} <span class="id-sub">${esc(r.sellKey)}</span>`) : kv('kat.d_sell', esc(t('kat.noPrice')))}
      ${r.sell > 0 ? kv('kat.d_sellNet', money(r.sellNet)) : ''}
      ${priced(r) ? kv('kat.d_profit', `<strong class="${r.profit >= 0 ? 'pos' : 'neg'}">${money(r.profit)}</strong>`) : ''}
      ${priced(r) ? kv('kat.d_margin', esc(fmtPct(r.margin))) : ''}
      ${kv('kat.d_hours', esc(fmtHours(r.hours)))}
      ${priced(r) ? kv('kat.d_pph', money(r.profitPerHour)) : ''}
    </dl>
    ${notes.map((n) => `<p class="note small">${esc(n)}</p>`).join('')}
    <p class="kat-actions">
      ${r.uuid ? `<button type="button" class="btn btn-sm" data-kat-copy title="${esc(t('kat.copyCmdTitle'))}">${esc(t('kat.copyCmd'))}</button>` : ''}
    </p>
    <p class="note small">${esc(t('kat.caveat'))}</p>
  </div>`;
}

export function createKatView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  let qs: QueryState<KatQuery> | null = null;
  let bar: FilterBar | null = null;
  let table: KitTableHandle<KatRow> | null = null;
  let panel: DetailPanel | null = null;
  let detailEl: HTMLElement | null = null;
  let openKey: string | null = null;
  let lastRows: KatRow[] = [];
  const subs: (() => void)[] = [];
  /** rows per skip option, for one (AH scan, catalog, snapshot, settings, mayor) */
  let memo: {
    ah: AppState['ah'];
    catalog: AppState['catalog'];
    snapshot: AppState['snapshot'];
    settings: AppState['settings'];
    derpy: boolean;
    bySkip: Map<KatSkip, KatRow[]>;
  } | null = null;

  const $ = <E extends Element = HTMLElement>(sel: string) => root!.querySelector<E>(sel)!;

  function rows(s: AppState, skip: KatSkip): KatRow[] {
    const derpy = isDerpy(s.election);
    if (memo?.ah !== s.ah || memo.catalog !== s.catalog || memo.snapshot !== s.snapshot || memo.settings !== s.settings || memo.derpy !== derpy)
      memo = { ah: s.ah, catalog: s.catalog, snapshot: s.snapshot, settings: s.settings, derpy, bySkip: new Map() };
    let out = memo.bySkip.get(skip);
    if (!out) {
      const c = ctx!.derived.calcCtx();
      out = c ? computeKatFlips(c, { skip }) : [];
      memo.bySkip.set(skip, out);
    }
    return out;
  }

  function applyLabels(): void {
    if (!root) return;
    $('h1').textContent = t('kat.title');
    $('.kat-intro').textContent = t('kat.intro');
  }

  function setState(html: string): void {
    const st = $('.kat-state');
    st.innerHTML = html;
    st.hidden = !html;
  }

  function showDetail(r: KatRow, reopen: boolean): void {
    if (!panel || !detailEl || !ctx) return;
    detailEl.innerHTML = katDetail(r, isDerpy(ctx.store.get().election));
    if (reopen || !panel.isOpen()) panel.open(t('kat.panelTitle', { name: r.name, from: rarityName(r.from), to: rarityName(r.to) }), detailEl);
  }

  function blockedState(s: AppState): string | null {
    if (!s.settings.ahEnabled) return 'off';
    if (!s.ah) return 'waiting';
    if (s.ah.v == null || s.ah.v < 3) return 'oldScan';
    if (!s.catalog || !s.snapshot) return 'waitingData';
    if (!s.catalog.kat.length) return 'noData';
    return null;
  }

  function render(): void {
    if (!root || !ctx || !table || !qs) return;
    const s = ctx.store.get();
    const tools = $('.kat-tools');
    const blocked = blockedState(s);
    if (blocked) {
      const btn = blocked === 'off' ? ` <button type="button" class="btn btn-sm" data-kat-on>${esc(t('kat.turnOn'))}</button>` : '';
      setState(`<div class="empty card">${esc(t(`kat.${blocked}`))}${btn}</div>`);
      table.el.hidden = true;
      tools.hidden = true;
      return;
    }
    setState('');
    table.el.hidden = false;
    tools.hidden = false;
    const v = qs.get();
    const all = rows(s, v.skip ? 'flowers' : 'none');
    lastRows = all;
    const res = filterKat(
      all,
      {
        q: v.q,
        minProfit: v.minProfit,
        maxCapital: v.maxCapital,
        maxHours: v.maxHours,
        taming: v.taming,
        band: v.band === 'any' || v.band === 'max' ? v.band : 'both',
        showUnpriced: v.unpriced,
        hideSuspect: s.settings.hideSuspicious && !v.suspect,
      },
      s.catalog,
    );
    const cur = table.getSort();
    if (!cur || cur.key !== v.sort.key || cur.dir !== v.sort.dir) table.setSort(v.sort);
    table.setRows(res.rows);
    $('.kat-count').textContent = t('kat.count', { n: res.rows.length, total: all.length, count: all.length });
    $('.kat-scan').textContent = t('kat.scanned', { age: fmtAge(Date.now() - s.ah!.fetchedAt), n: fmtInt(ahListingCount(s.ah!)) });
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
      ctx.toast(t('kat.copied', { cmd }), 'ok');
    } catch {
      ctx.toast(t('kat.copyFail'), 'err');
    }
  }

  return {
    id: 'kat',
    mount(el, c, route) {
      root = el;
      ctx = c;
      el.innerHTML = `<div class="kat-view kit-split">
        <header class="kat-head"><h1 tabindex="-1"></h1><p class="kat-intro muted small"></p></header>
        <div class="kat-bar"></div>
        <div class="kat-state" hidden></div>
        <div class="kat-table"></div>
      </div>`;
      const state = bindQueryState(KAT_SCHEMA, route, c.setQuery, LS_VIEWPREFS + 'kat');
      qs = state;
      bar = createFilterBar(
        [
          { kind: 'search', key: 'q', label: () => t('kat.search'), placeholder: () => t('kat.searchPh') },
          { kind: 'number', key: 'minProfit', label: () => t('kat.minProfit') },
          { kind: 'number', key: 'maxCapital', label: () => t('kat.maxCapital') },
          { kind: 'number', key: 'maxHours', label: () => t('kat.maxHours') },
          { kind: 'number', key: 'taming', label: () => t('kat.taming'), help: () => t('kat.tamingHelp') },
          {
            kind: 'segment',
            key: 'band',
            label: () => t('kat.band'),
            options: [
              { value: 'both', label: () => t('kat.band_both') },
              { value: 'any', label: () => t('kat.band_any') },
              { value: 'max', label: () => t('kat.band_max') },
            ],
          },
          { kind: 'toggle', key: 'skip', label: () => t('kat.skip') },
          { kind: 'toggle', key: 'unpriced', label: () => t('kat.showUnpriced') },
          { kind: 'toggle', key: 'suspect', label: () => t('kat.showSuspect') },
        ],
        state,
      );
      $('.kat-bar').append(bar.el);
      const extra = document.createElement('div');
      extra.className = 'kat-tools';
      extra.innerHTML = '<span class="kat-count" role="status" data-testid="kat-count"></span><span class="kat-scan muted small"></span>';
      panel = createDetailPanel({ returnFocus: () => table?.el.querySelector<HTMLElement>('[data-key][tabindex="0"]') ?? null });
      detailEl = document.createElement('div');
      table = createKitTable<KatRow>({
        columns: columns(),
        rowKey: (r) => r.key,
        sort: state.get().sort,
        onSortChange: (s) => qs?.set({ sort: s }),
        emptyText: () => t('kat.empty'),
        onActivate: (r) => {
          openKey = r.key;
          table?.setSelected(openKey);
          showDetail(r, true);
        },
        selectedKey: null,
        columnsKey: 'kat',
        toolbar: { columns: true, exportName: 'kat-upgrades', extra },
      });
      $('.kat-table').append(table.el);
      $('.kat-view').append(panel.el);
      subs.push(
        panel.onClose(() => {
          openKey = null;
          table?.setSelected(null);
        }),
      );
      const onClick = (ev: MouseEvent) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (target?.closest('[data-kat-copy]')) void copyCmd();
        if (target?.closest('[data-kat-on]')) c.store.set((s) => ({ settings: { ...s.settings, ahEnabled: true } }));
      };
      el.addEventListener('click', onClick);
      subs.push(() => el.removeEventListener('click', onClick));
      subs.push(state.onChange(() => schedule()));
      subs.push(
        c.store.subscribe((s, prev) => {
          if (
            s.ah !== prev.ah ||
            s.catalog !== prev.catalog ||
            s.snapshot !== prev.snapshot ||
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
      if (root) root.textContent = '';
      root = null;
      ctx = null;
    },
  };
}
