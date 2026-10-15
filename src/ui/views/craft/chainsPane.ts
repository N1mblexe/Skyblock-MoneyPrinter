// Craft & Forge, Chains tab: multi-step moves along crafting ladders (src/domain/chains.ts). Rows come from
// ctx.derived.chains(); filters live in the URL (#/craft?view=chains&…); the side panel shows the whole ladder.
import { bestPerLadder, ladderDetail, type LadderTier } from '../../../domain/chains.ts';
import { msgText, onLangChange, t } from '../../../i18n/index.ts';
import type { AppState, ChainRow, CraftRow, Recipe, View, ViewContext } from '../../../types/contracts.ts';
import { itemCell, riskBadge } from '../../cells.ts';
import { esc, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtInt } from '../../format.ts';
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
import { CHAIN_PREFS_KEY, CHAIN_SCHEMA, filterChains, fmtQty, relabel, tabsHtml, type ChainQuery } from './helpers.ts';
import {
  buyStepHtml,
  craftColumns,
  linesTable,
  notesHtml,
  outputBadges,
  sellStepsHtml,
  signCls,
  slippageHtml,
  watchButton,
  type RenderEnv,
} from './render.ts';

const NOTES = ['chNote1', 'chNote2', 'chNote3'] as const;
const dash = '—';
const isUnpriced = (r: ChainRow) => r.row.unpriced.length > 0;
/** Cost of everything but the first tier, per crafted item. */
const sideCost = (r: ChainRow) => r.row.lines.reduce((s, l) => (l.id === r.fromId ? s : s + l.total), 0);

function skeleton(): string {
  return `
  <div class="craft-view chains-view kit-split">
    <header class="craft-head">
      <h1 class="craft-title" tabindex="-1" data-i18n="craft.title"></h1>
      <p class="craft-intro muted small" data-i18n="craft.chainsIntro"></p>
      ${tabsHtml('chains')}
    </header>
    <div class="craft-bar"></div>
    <div class="craft-state" hidden></div>
    <div class="craft-table"></div>
    <details class="note craft-note"><summary data-i18n="craft.chainsHowTitle"></summary><div class="craft-note-body"></div></details>
  </div>`;
}

/** Path as names: "Wheat → Enchanted Wheat → Enchanted Hay Bale". */
const pathText = (env: RenderEnv, path: readonly string[]) => path.map((id) => env.catalog()?.name(id) ?? id).join(' → ');

export function chainColumns(env: RenderEnv): KitColumn<ChainRow>[] {
  const craft = new Map(craftColumns(env).map((c) => [c.key, c]));
  /** a Recipes-tab column reading the move's priced row */
  const wrap = (key: string): KitColumn<ChainRow> => {
    const c = craft.get(key)!;
    const csv = c.csv;
    return {
      ...c,
      get: (r) => c.get(r.row),
      html: (r) => c.html!(r.row),
      ...(csv === false ? { csv: false } : csv ? { csv: (r: ChainRow) => csv(r.row) } : {}),
    } as KitColumn<ChainRow>;
  };
  return [
    {
      key: 'name',
      label: () => t('craft.colChain'),
      get: (r) => r.row.name,
      cls: 'name-cell craft-name',
      priority: 0,
      csv: (r) => r.path.join(' > '),
      html: (r) => {
        const path = pathText(env, r.path);
        return (
          `<span class="craft-line1"><a href="#/item/${encodeURIComponent(r.toId)}">${esc(r.row.name)}</a>${outputBadges(r.row)}</span>` +
          `<span class="id-sub craft-sub chain-path" title="${esc(path)}">${esc(path)}</span>`
        );
      },
    },
    {
      key: 'steps',
      label: () => t('craft.colSteps'),
      get: (r) => r.steps,
      align: 'right',
      priority: 3,
      html: (r) => esc(fmtInt(r.steps)),
    },
    {
      key: 'need',
      label: () => t('craft.colNeed'),
      title: () => t('craft.colNeedTitle'),
      get: (r) => r.needFrom,
      csv: (r) => r.needFrom,
      priority: 2,
      html: (r) => esc(t('craft.chNeedCell', { n: fmtQty(r.needFrom), name: env.catalog()?.name(r.fromId) ?? r.fromId })),
    },
    {
      key: 'sides',
      label: () => t('craft.colSides'),
      title: () => t('craft.colSidesTitle'),
      get: (r) => (isUnpriced(r) ? null : sideCost(r)),
      align: 'right',
      priority: 3,
      html: (r) => (isUnpriced(r) || sideCost(r) === 0 ? dash : esc(fmtCoins(sideCost(r)))),
    },
    ...['cost', 'value', 'profit', 'margin', 'limited', 'slots', 'pph', 'risk'].map(wrap),
  ];
}

function ladderTable(env: RenderEnv, r: ChainRow, tiers: readonly LadderTier[]): string {
  const start = env.catalog()?.name(r.fromId) ?? r.fromId;
  const th = (k: string, cls = '', title?: string) =>
    `<th scope="col"${cls ? ` class="${cls}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${esc(t(k))}</th>`;
  const fromIdx = tiers.findIndex((x) => x.id === r.fromId);
  const body = tiers
    .map((x, i) => {
      const role = x.id === r.fromId ? 'chain-start' : x.id === r.toId ? 'chain-target' : i < fromIdx ? 'chain-below' : '';
      const tag =
        x.id === r.fromId ? ` <span class="badge src-order">${esc(t('craft.ladStart'))}</span>` : x.id === r.toId ? ` <span class="badge craft-forge">${esc(t('craft.ladTarget'))}</span>` : '';
      const perStart = i >= fromIdx && x.sellNet != null && x.need > 0 ? x.sellNet / x.need : null;
      const pph = x.move && x.move.unpriced.length === 0 ? x.move.profitPerHour : null;
      return `<tr class="${role}" data-tier="${esc(x.id)}">
        <th scope="row" class="name-cell">${itemCell(x.id, x.name, true)}${tag}</th>
        <td class="num">${i >= fromIdx ? esc(fmtQty(x.need)) : dash}</td>
        <td class="num">${x.buyUnit == null ? dash : esc(fmtCoins(x.buyUnit))}</td>
        <td class="num">${x.sellNet == null ? dash : esc(fmtCoins(x.sellNet))}</td>
        <td class="num">${perStart == null ? dash : esc(fmtCoins(perStart))}</td>
        <td class="num">${pph == null ? dash : `<span class="${signCls(pph)}">${esc(fmtCoins(pph))}</span>`}</td>
      </tr>`;
    })
    .join('');
  return `<div class="craft-ing-wrap" tabindex="0" role="region" aria-label="${esc(t('craft.ladderTitle'))}"><table class="tbl-plain craft-ing chain-ladder">
    <thead><tr>
      ${th('craft.ladTier')}${th('craft.ladNeed', 'num', t('craft.ladNeedTitle', { name: start }))}${th('craft.ladBuy', 'num')}
      ${th('craft.ladSell', 'num', t('craft.ladSellTitle'))}${th('craft.ladPerStart', 'num', t('craft.ladPerStartTitle', { name: start }))}
      ${th('craft.ladPph', 'num', t('craft.ladPphTitle', { name: start }))}
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

/** Buy, one craft step per tier above the start, sell, profit. */
function chainSteps(env: RenderEnv, r: ChainRow, tiers: readonly LadderTier[]): string {
  const li: string[] = [buyStepHtml(env, r.row)];
  for (const id of r.path.slice(1)) {
    const tier = tiers.find((x) => x.id === id);
    // units of this tier made per crafted end item = start units in the end item / start units in this tier
    const made = tier && tier.need > 0 ? r.needFrom / tier.need : 1;
    li.push(t('craft.stepCraft', { n: esc(fmtQty(made)), name: esc(tier?.name ?? id) }));
  }
  li.push(...sellStepsHtml(env, r.row));
  return `<ol class="craft-steps">${li.map((x) => `<li>${x}</li>`).join('')}</ol>`;
}

/** Detail panel body for one chain move. */
export function chainDetail(env: RenderEnv, r: ChainRow, tiers: readonly LadderTier[]): string {
  const row: CraftRow = r.row;
  const on = env.watched(r.toId);
  const unpriced = isUnpriced(r);
  const kv = (k: string, v: string) => `<div><dt>${esc(t(k))}</dt><dd>${v}</dd></div>`;
  const summary = unpriced
    ? ''
    : `<dl class="kv craft-sum">
        ${kv('craft.dCost', esc(fmtCoins(row.cost)))}
        ${kv('craft.dValue', esc(fmtCoins(row.value)))}
        ${kv('craft.dProfit', `<span class="${signCls(row.profit)}">${esc(fmtCoins(row.profit))}</span>`)}
        ${kv('craft.dPph', `<strong class="${signCls(row.profitPerHour)}">${esc(fmtCoins(row.profitPerHour))}</strong>`)}
      </dl>`;
  const others = r.ladders.length - 1;
  const head = `<div class="craft-d-head">
      <span class="craft-d-badges">${outputBadges(row)} ${riskBadge(row.risk)}</span>
      <span class="craft-d-actions">
        <button type="button" class="btn btn-sm craft-watch${on ? ' on' : ''}" data-craft-watch aria-pressed="${on}">${esc(t(on ? 'craft.watching' : 'craft.watch'))}</button>
        <a class="btn btn-sm" href="#/item/${encodeURIComponent(r.toId)}">${esc(t('craft.openItem'))}</a>
      </span>
    </div>
    <p class="small muted chain-d-path">${esc(pathText(env, r.path))}${others > 0 ? ` · ${esc(t('craft.chOtherLadders', { n: others }))}` : ''}</p>`;
  const warn = unpriced ? `<div class="banner banner-warn craft-unpriced-msg">${esc(t('craft.cannotPrice', { ids: row.unpriced.join(', ') }))}</div>` : '';
  return `<div class="craft-detail chain-detail">
    ${head}
    ${summary}
    ${warn}
    <section class="craft-sec"><h3>${esc(t('craft.ladderTitle'))}</h3>${ladderTable(env, r, tiers)}</section>
    ${unpriced ? '' : `<section class="craft-sec"><h3>${esc(t('craft.stepsTitle'))}</h3>${chainSteps(env, r, tiers)}</section>`}
    <section class="craft-sec"><h3>${esc(t('craft.linesTitle'))}</h3>${linesTable(env, row)}</section>
    ${unpriced ? '' : slippageHtml(env, row)}
    ${notesHtml(env, row)}
  </div>`;
}

/** The Chains tab, mounted by the craft view when the route has view=chains. */
export function createChainsPane(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  let qs: QueryState<ChainQuery> | null = null;
  let bar: FilterBar | null = null;
  let table: KitTableHandle<ChainRow> | null = null;
  let panel: DetailPanel | null = null;
  let detailEl: HTMLElement | null = null;
  let openKey: string | null = null;
  const subs: (() => void)[] = [];
  let recipeIdx: { catalog: AppState['catalog']; map: Map<string, Recipe> } | null = null;
  let rowIdx: { rows: ChainRow[]; map: Map<string, ChainRow>; best: Set<string> } | null = null;

  const $ = <E extends Element = HTMLElement>(sel: string) => root!.querySelector<E>(sel)!;

  const env: RenderEnv = {
    catalog: () => ctx?.store.get().catalog ?? null,
    settings: () => ctx!.store.get().settings,
    product: (id) => ctx?.store.get().snapshot?.products[id],
    ah: (id) => ctx?.derived.calcCtx()?.ah?.(id) ?? null,
    recipe(key) {
      const cat = ctx?.store.get().catalog;
      if (!cat) return undefined;
      if (recipeIdx?.catalog !== cat) recipeIdx = { catalog: cat, map: new Map(cat.recipes.map((r) => [r.key, r])) };
      return recipeIdx.map.get(key);
    },
    watched: (id) => ctx?.watch.has(id) ?? false,
  };

  function index(): NonNullable<typeof rowIdx> {
    const rows = ctx!.derived.chains();
    if (rowIdx?.rows !== rows) rowIdx = { rows, map: new Map(rows.map((r) => [r.key, r])), best: bestPerLadder(rows) };
    return rowIdx;
  }

  function applyLabels(): void {
    if (!root) return;
    relabel(root);
    $('.craft-note-body').innerHTML = NOTES.map((k) => `<p>${t(`craft.${k}`)}</p>`).join('');
  }

  function setState(html: string): void {
    const st = $('.craft-state');
    st.innerHTML = html;
    st.hidden = !html;
  }

  function showDetail(r: ChainRow, reopen: boolean): void {
    const c = ctx?.derived.calcCtx();
    if (!panel || !detailEl || !c) return;
    const ladder = (r.ladders[0] ?? r.key).split('>');
    detailEl.innerHTML = chainDetail(env, r, ladderDetail(c, ladder, ladder.indexOf(r.fromId)));
    if (reopen || !panel.isOpen()) panel.open(r.row.name, detailEl);
  }

  function refreshDetail(): void {
    if (!openKey || !panel?.isOpen() || !ctx) return;
    const r = index().map.get(openKey);
    if (r) showDetail(r, false);
  }

  function render(): void {
    if (!root || !ctx || !table || !qs) return;
    const s = ctx.store.get();
    const tools = $('.craft-tools');
    if (!s.catalog || !s.snapshot) {
      if (!s.catalog && s.catalogError) setState(`<div class="banner banner-err">${esc(t('common.catalogError', { err: msgText(s.catalogError) }))}</div>`);
      else setState(`<div class="empty card">${esc(!s.snapshot ? t('common.waitingData') : t('craft.loadingRecipes'))}</div>`);
      table.el.hidden = true;
      tools.hidden = true;
      return;
    }
    setState('');
    table.el.hidden = false;
    tools.hidden = false;

    const v = qs.get();
    const idx = index();
    const res = filterChains(
      idx.rows,
      {
        q: v.q,
        only: v.best ? idx.best : null,
        minSteps: v.minSteps,
        minMargin: v.minMargin,
        minPph: v.minPph,
        showUnpriced: v.unpriced,
        hideSuspect: s.settings.hideSuspicious && !v.suspect,
      },
      s.catalog,
    );
    const cur = table.getSort();
    if (!cur || cur.key !== v.sort.key || cur.dir !== v.sort.dir) table.setSort(v.sort);
    table.setRows(res.rows);

    const count = t('craft.chCount', { n: res.rows.length, total: idx.rows.length, count: idx.rows.length });
    const countEl = $('.craft-count');
    if (countEl.textContent !== count) countEl.textContent = count;
    $('.craft-unp').textContent = !v.unpriced && res.unpricedHidden > 0 ? t('craft.unpricedHidden', { n: res.unpricedHidden }) : '';
    const hiddenBtn = $<HTMLButtonElement>('.craft-hidden');
    const canHide = s.settings.hideSuspicious && res.suspect > 0;
    hiddenBtn.hidden = !canHide;
    if (canHide) {
      hiddenBtn.textContent = v.suspect ? t('common.hideHiddenN', { n: res.suspect }) : t('common.hiddenCount', { n: res.hidden });
      hiddenBtn.title = v.suspect ? '' : t('common.showHidden');
      hiddenBtn.setAttribute('aria-pressed', String(v.suspect));
    }
    refreshDetail();
  }

  const schedule = rafDebounce(render);

  function toggleWatch(r: ChainRow): void {
    if (!ctx) return;
    ctx.watch.toggle(r.toId);
    ctx.toast(t(ctx.watch.has(r.toId) ? 'craft.watchOn' : 'craft.watchOff', { name: r.row.name }), 'ok');
  }

  return {
    id: 'craft',
    mount(el, c, route) {
      root = el;
      ctx = c;
      el.innerHTML = skeleton();
      const view = $('.craft-view');
      const state = bindQueryState(CHAIN_SCHEMA, route, c.setQuery, CHAIN_PREFS_KEY);
      qs = state;

      bar = createFilterBar(
        [
          { kind: 'search', key: 'q', label: () => t('craft.search'), placeholder: () => t('craft.chSearchPh') },
          { kind: 'toggle', key: 'best', label: () => t('craft.chBest') },
          { kind: 'number', key: 'minSteps', label: () => t('craft.chMinSteps') },
          { kind: 'number', key: 'minMargin', label: () => t('craft.minMargin'), suffix: '%' },
          { kind: 'number', key: 'minPph', label: () => t('craft.minPph') },
          { kind: 'toggle', key: 'unpriced', label: () => t('craft.showUnpriced') },
          { kind: 'toggle', key: 'suspect', label: () => t('craft.showSuspect') },
        ],
        state,
      );
      $('.craft-bar').append(bar.el);

      const extra = document.createElement('div');
      extra.className = 'craft-tools';
      extra.innerHTML =
        '<span class="craft-count" role="status" data-testid="chain-count"></span><button type="button" class="hidden-count craft-hidden" hidden></button><span class="craft-unp muted small"></span>';

      panel = createDetailPanel({ returnFocus: () => table?.el.querySelector<HTMLElement>('[data-key][tabindex="0"]') ?? null });
      detailEl = document.createElement('div');
      detailEl.className = 'craft-detail-host';

      table = createKitTable<ChainRow>({
        columns: chainColumns(env),
        rowKey: (r) => r.key,
        sort: state.get().sort,
        onSortChange: (s) => qs?.set({ sort: s }),
        rowClass: (r) => (isUnpriced(r) ? 'craft-unpriced' : ''),
        emptyText: () => t('craft.chEmpty'),
        onActivate: (r) => {
          openKey = r.key;
          table?.setSelected(openKey);
          showDetail(r, true);
        },
        selectedKey: null,
        columnsKey: 'craft.chains',
        toolbar: { columns: true, exportName: 'craft-chains', extra },
        rowActions: (r) => watchButton(env, r.row),
        onRowAction: (action, r) => {
          if (action === 'watch') toggleWatch(r);
        },
      });
      $('.craft-table').append(table.el);
      view.append(panel.el);

      subs.push(
        panel.onClose(() => {
          openKey = null;
          table?.setSelected(null);
        }),
      );
      const onDetailClick = (ev: MouseEvent) => {
        if (!(ev.target instanceof Element) || !ev.target.closest('[data-craft-watch]') || !openKey) return;
        const r = index().map.get(openKey);
        if (r) toggleWatch(r);
      };
      detailEl.addEventListener('click', onDetailClick);
      const onToolsClick = (ev: MouseEvent) => {
        if (ev.target instanceof Element && ev.target.closest('.craft-hidden')) qs?.set({ suspect: !qs.get().suspect });
      };
      extra.addEventListener('click', onToolsClick);
      subs.push(() => {
        detailEl?.removeEventListener('click', onDetailClick);
        extra.removeEventListener('click', onToolsClick);
      });

      subs.push(state.onChange(() => schedule()));
      subs.push(
        c.store.subscribe((s, prev) => {
          if (s.watchlist !== prev.watchlist) {
            table?.refresh();
            refreshDetail();
          }
          if (
            s.snapshot !== prev.snapshot ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.settings !== prev.settings ||
            s.historyTick !== prev.historyTick ||
            s.ah !== prev.ah
          ) {
            schedule();
          }
        }),
      );
      subs.push(
        onLangChange(() => {
          applyLabels();
          bar?.refresh();
          table?.refresh();
          if (openKey && panel?.isOpen()) {
            const r = index().map.get(openKey);
            if (r) showDetail(r, true);
          }
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
      if (root) root.textContent = '';
      root = null;
      ctx = null;
      recipeIdx = null;
      rowIdx = null;
    },
  };
}
