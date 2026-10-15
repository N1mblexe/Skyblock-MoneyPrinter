// Craft & Forge view with two tabs: Recipes (buy ingredients -> craft/forge -> sell; rows from ctx.derived.crafts())
// and Chains (multi-step moves, ./chainsPane.ts). `#/craft?view=chains` picks the tab; each tab keeps its own
// filters in the URL (bindQueryState) and localStorage; details open in the side panel.
import { msgText, onLangChange, t } from '../../../i18n/index.ts';
import type { AppState, CraftRow, Recipe, Route, View, ViewContext } from '../../../types/contracts.ts';
import { esc, rafDebounce } from '../../dom.ts';
import { fmtInt } from '../../format.ts';
import {
  bindQueryState,
  createDetailPanel,
  createFilterBar,
  createKitTable,
  type DetailPanel,
  type FilterBar,
  type KitTableHandle,
  type QueryState,
} from '../../kit/index.ts';
import './craft.css';
import { createChainsPane } from './chainsPane.ts';
import { filterCrafts, migrateLegacyPrefs, PREFS_KEY, relabel, SCHEMA, tabOf, tabsHtml, type CraftQuery, type CraftTab, type KindFilter, type MarketFilter } from './helpers.ts';
import { craftColumns, craftDetail, watchButton, type RenderEnv } from './render.ts';

const NOTES = ['note1', 'note2', 'note3', 'note4'] as const;

function skeleton(): string {
  return `
  <div class="craft-view kit-split">
    <header class="craft-head">
      <h1 class="craft-title" tabindex="-1" data-i18n="craft.title"></h1>
      <p class="craft-intro muted small" data-i18n="craft.intro"></p>
      ${tabsHtml('recipes')}
    </header>
    <div class="craft-bar"></div>
    <div class="craft-state" hidden></div>
    <div class="craft-table"></div>
    <details class="note craft-note"><summary data-i18n="craft.howTitle"></summary><div class="craft-note-body"></div></details>
  </div>`;
}

export function createCraftView(): View {
  let host: HTMLElement | null = null;
  let c: ViewContext | null = null;
  let tab: CraftTab = 'recipes';
  let pane: View | null = null;
  const make = (t: CraftTab) => (t === 'chains' ? createChainsPane() : createRecipesPane());
  const onClick = (ev: MouseEvent) => {
    const b = ev.target instanceof Element ? ev.target.closest<HTMLElement>('[data-craft-tab]') : null;
    if (!b || !c || b.dataset.craftTab === tab) return;
    // each tab restores its own filters, so the other tab's query is dropped
    c.navigate({ id: 'craft', query: b.dataset.craftTab === 'chains' ? { view: 'chains' } : {} });
  };
  const open = (route: Route) => {
    tab = tabOf(route.query);
    pane = make(tab);
    pane.mount(host!, c!, route);
  };
  return {
    id: 'craft',
    mount(el, ctx, route) {
      host = el;
      c = ctx;
      el.addEventListener('click', onClick);
      open(route);
    },
    update(route) {
      if (tabOf(route.query) === tab) return pane?.update?.(route);
      pane?.unmount();
      open(route);
    },
    unmount() {
      host?.removeEventListener('click', onClick);
      pane?.unmount();
      pane = null;
      host = null;
      c = null;
    },
  };
}

function createRecipesPane(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  let qs: QueryState<CraftQuery> | null = null;
  let bar: FilterBar | null = null;
  let table: KitTableHandle<CraftRow> | null = null;
  let panel: DetailPanel | null = null;
  let detailEl: HTMLElement | null = null;
  /** recipe key of the row shown in the panel */
  let openKey: string | null = null;
  const subs: (() => void)[] = [];

  let recipeIdx: { catalog: AppState['catalog']; map: Map<string, Recipe> } | null = null;
  let rowIdx: { rows: CraftRow[]; map: Map<string, CraftRow> } | null = null;

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

  function rowByKey(key: string): CraftRow | undefined {
    const rows = ctx!.derived.crafts();
    if (rowIdx?.rows !== rows) rowIdx = { rows, map: new Map(rows.map((r) => [r.recipe.key, r])) };
    return rowIdx.map.get(key);
  }

  function applyLabels(): void {
    if (!root || !ctx) return;
    relabel(root);
    const s = ctx.store.get().settings;
    const params = { slots: esc(fmtInt(s.forgeSlots)), orderSlots: esc(fmtInt(s.orderSlots)), limit: esc(fmtInt(s.npcDailyLimit)) };
    $('.craft-note-body').innerHTML = NOTES.map((k) => `<p>${t(`craft.${k}`, params)}</p>`).join('');
  }

  function setState(html: string): void {
    const st = $('.craft-state');
    st.innerHTML = html;
    st.hidden = !html;
  }

  function showDetail(r: CraftRow, reopen: boolean): void {
    if (!panel || !detailEl) return;
    detailEl.innerHTML = craftDetail(env, r);
    if (reopen || !panel.isOpen()) panel.open(r.name, detailEl);
  }

  function refreshDetail(): void {
    if (!openKey || !panel?.isOpen() || !ctx) return;
    const r = rowByKey(openKey);
    if (r) showDetail(r, false);
  }

  function render(): void {
    if (!root || !ctx || !table || !qs) return;
    const s = ctx.store.get();
    const tools = $('.craft-tools');
    const countEl = $('.craft-count');
    const hiddenBtn = $<HTMLButtonElement>('.craft-hidden');
    const unpEl = $('.craft-unp');

    if (!s.catalog || !s.snapshot) {
      if (!s.catalog && s.catalogError) {
        setState(`<div class="banner banner-err">${esc(t('common.catalogError', { err: msgText(s.catalogError) }))}</div>`);
      } else {
        const msg = !s.snapshot ? t('common.waitingData') : t('craft.loadingRecipes');
        setState(`<div class="empty card">${esc(msg)}</div>`);
      }
      table.el.hidden = true;
      tools.hidden = true;
      return;
    }
    setState('');
    table.el.hidden = false;
    tools.hidden = false;

    const v = qs.get();
    const all = ctx.derived.crafts();
    const res = filterCrafts(
      all,
      {
        q: v.q,
        minVol: v.minVol,
        minMargin: v.minMargin,
        minPph: v.minPph,
        kind: v.kind as KindFilter,
        market: v.market as MarketFilter,
        showUnpriced: v.unpriced,
        hideSuspect: s.settings.hideSuspicious && !v.suspect,
      },
      s.catalog,
    );
    const cur = table.getSort();
    if (!cur || cur.key !== v.sort.key || cur.dir !== v.sort.dir) table.setSort(v.sort);
    table.setRows(res.rows);

    const count = t('craft.count', { n: res.rows.length, total: all.length });
    if (countEl.textContent !== count) countEl.textContent = count;
    unpEl.textContent = !v.unpriced && res.unpricedHidden > 0 ? t('craft.unpricedHidden', { n: res.unpricedHidden }) : '';

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

  function toggleWatch(r: Pick<CraftRow, 'id' | 'name'>): void {
    if (!ctx) return;
    ctx.watch.toggle(r.id);
    ctx.toast(t(ctx.watch.has(r.id) ? 'craft.watchOn' : 'craft.watchOff', { name: r.name }), 'ok');
  }

  return {
    id: 'craft',
    mount(el, c, route) {
      root = el;
      ctx = c;
      migrateLegacyPrefs();
      el.innerHTML = skeleton();
      const view = $('.craft-view');
      const state = bindQueryState(SCHEMA, route, c.setQuery, PREFS_KEY);
      qs = state;

      bar = createFilterBar(
        [
          { kind: 'search', key: 'q', label: () => t('craft.search'), placeholder: () => t('craft.searchPh') },
          {
            kind: 'segment',
            key: 'kind',
            label: () => t('craft.kind'),
            options: [
              { value: 'all', label: () => t('craft.kindAll') },
              { value: 'craft', label: () => t('craft.kindCraft') },
              { value: 'forge', label: () => t('craft.kindForge') },
            ],
          },
          {
            kind: 'segment',
            key: 'market',
            label: () => t('craft.market'),
            options: [
              { value: 'all', label: () => t('craft.marketAll') },
              { value: 'bazaar', label: () => t('craft.marketBazaar') },
              { value: 'off', label: () => t('craft.marketOff') },
            ],
          },
          { kind: 'number', key: 'minVol', label: () => t('craft.minVol') },
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
        '<span class="craft-count" role="status"></span><button type="button" class="hidden-count craft-hidden" hidden></button><span class="craft-unp muted small"></span>';

      panel = createDetailPanel({ returnFocus: () => table?.el.querySelector<HTMLElement>('[data-key][tabindex="0"]') ?? null });
      detailEl = document.createElement('div');
      detailEl.className = 'craft-detail-host';

      table = createKitTable<CraftRow>({
        columns: craftColumns(env),
        rowKey: (r) => r.recipe.key,
        sort: state.get().sort,
        onSortChange: (s) => qs?.set({ sort: s }),
        rowClass: (r) => (r.unpriced.length > 0 ? 'craft-unpriced' : ''),
        emptyText: () => t('craft.empty'),
        onActivate: (r) => {
          openKey = r.recipe.key;
          table?.setSelected(openKey);
          showDetail(r, true);
        },
        selectedKey: null,
        columnsKey: 'craft',
        toolbar: { columns: true, exportName: 'crafts', extra },
        rowActions: (r) => watchButton(env, r),
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
        const target = ev.target;
        if (!(target instanceof Element) || !target.closest('[data-craft-watch]') || !openKey) return;
        const r = rowByKey(openKey);
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
          if (s.settings !== prev.settings) applyLabels();
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
            const r = rowByKey(openKey);
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
