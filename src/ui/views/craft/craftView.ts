// Craft flip view: buy ingredients -> craft/forge -> sell. Rows come from computeCrafts (memoized), filtered here.
import { computeCrafts } from '../../../domain/craft.ts';
import { onLangChange, t } from '../../../i18n/index.ts';
import type { AppState, Catalog, CraftRow, Recipe, Route, View, ViewContext } from '../../../types/contracts.ts';
import { esc, rafDebounce } from '../../dom.ts';
import { createTable, type TableHandle } from '../../table.ts';
import './craft.css';
import { filterCrafts, loadPrefs, savePrefs, type CraftPrefs, type KindFilter } from './helpers.ts';
import './i18n.ts';
import { craftColumns, craftDetail, type RenderEnv } from './render.ts';

const KINDS: KindFilter[] = ['all', 'craft', 'forge'];
const KIND_KEY: Record<KindFilter, string> = { all: 'craft.kindAll', craft: 'craft.kindCraft', forge: 'craft.kindForge' };

function skeleton(): string {
  return `
  <div class="craft-view">
    <div class="card craft-filters">
      <p class="craft-intro muted small" data-i18n="craft.intro"></p>
      <div class="filters">
        <label class="field craft-search">
          <span class="field-label" data-i18n="craft.search"></span>
          <input type="search" name="q" autocomplete="off" spellcheck="false" data-i18n-ph="craft.searchPh">
        </label>
        <label class="field">
          <span class="field-label" data-i18n="craft.minVol"></span>
          <input type="number" name="minVol" min="0" step="100" inputmode="numeric" data-filter="minVol">
          <span class="field-help" data-i18n="craft.minVolHelp"></span>
        </label>
        <label class="field">
          <span class="field-label" data-i18n="craft.minMargin"></span>
          <input type="number" name="minMargin" step="0.5" inputmode="decimal" data-filter="minMargin">
        </label>
        <div class="field">
          <span class="field-label" data-i18n="craft.kind"></span>
          <div class="seg craft-kind" role="group">
            ${KINDS.map((k) => `<button type="button" data-kind="${k}" data-i18n="${KIND_KEY[k]}" aria-pressed="false"></button>`).join('')}
          </div>
        </div>
        <label class="field field-check">
          <span class="check-row"><input type="checkbox" name="showUnpriced"><span class="field-label craft-unpriced-label"></span></span>
          <span class="field-help" data-i18n="craft.showUnpricedHelp"></span>
        </label>
      </div>
    </div>
    <div class="toolbar craft-toolbar">
      <span class="craft-count" role="status"></span>
      <span><button type="button" class="hidden-count craft-hidden" hidden></button><span data-i18n="craft.clickHint"></span></span>
    </div>
    <div class="craft-state"></div>
    <div class="craft-table"></div>
    <div class="note craft-note"></div>
  </div>`;
}

export function createCraftView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  let table: TableHandle<CraftRow> | null = null;
  const subs: (() => void)[] = [];
  const prefs: CraftPrefs = loadPrefs();
  let q = '';
  let showHidden = false;

  // memo: computeCrafts only when inputs change
  let memoKey: [AppState['snapshot'], AppState['catalog'], AppState['settings'], number] | null = null;
  let memoRows: CraftRow[] = [];
  let recipeIdx: { catalog: Catalog; map: Map<string, Recipe> } | null = null;

  const $ = <E extends Element = HTMLElement>(sel: string) => root!.querySelector<E>(sel)!;

  function computed(s: AppState): CraftRow[] {
    if (!s.snapshot || !s.catalog) return [];
    const k = memoKey;
    if (k && k[0] === s.snapshot && k[1] === s.catalog && k[2] === s.settings && k[3] === s.historyTick) return memoRows;
    const history = ctx!.history;
    memoRows = computeCrafts({ snap: s.snapshot, catalog: s.catalog, settings: s.settings, stats: (id) => history.stats(id) });
    memoKey = [s.snapshot, s.catalog, s.settings, s.historyTick];
    return memoRows;
  }

  const env: RenderEnv = {
    catalog: () => ctx?.store.get().catalog ?? null,
    settings: () => ctx!.store.get().settings,
    recipe(key) {
      const cat = ctx?.store.get().catalog;
      if (!cat) return undefined;
      if (recipeIdx?.catalog !== cat) recipeIdx = { catalog: cat, map: new Map(cat.recipes.map((r) => [r.key, r])) };
      return recipeIdx.map.get(key);
    },
  };

  function applyLabels(): void {
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n!)));
    root.querySelectorAll<HTMLInputElement>('[data-i18n-ph]').forEach((el) => (el.placeholder = t(el.dataset.i18nPh!)));
    $('.craft-kind').setAttribute('aria-label', t('craft.kind'));
    const slots = ctx!.store.get().settings.forgeSlots;
    $('.craft-note').innerHTML = ['note1', 'note2', 'note3', 'note4']
      .map((k) => `<p>${t(`craft.${k}`, { slots: esc(slots) })}</p>`)
      .join('');
  }

  function syncControls(): void {
    $<HTMLInputElement>('input[name=q]').value = q;
    $<HTMLInputElement>('input[name=minVol]').value = String(prefs.minVol);
    $<HTMLInputElement>('input[name=minMargin]').value = prefs.minMargin == null ? '' : String(prefs.minMargin);
    $<HTMLInputElement>('input[name=showUnpriced]').checked = prefs.showUnpriced;
    root!.querySelectorAll<HTMLButtonElement>('.craft-kind button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.kind === prefs.kind));
    });
  }

  function setState(html: string): void {
    const st = $('.craft-state');
    st.innerHTML = html;
    st.hidden = !html;
  }

  function render(): void {
    if (!root || !ctx || !table) return;
    const s = ctx.store.get();
    const tableEl = $('.craft-table');
    const unpricedLabel = $('.craft-unpriced-label');
    const countEl = $('.craft-count');
    const hiddenBtn = $<HTMLButtonElement>('.craft-hidden');

    if (!s.catalog || !s.snapshot) {
      if (!s.catalog && s.catalogError) {
        setState(`<div class="banner banner-err">${esc(t('common.catalogError', { err: s.catalogError }))}</div>`);
      } else {
        const msg = !s.snapshot ? t('common.waitingData') : t('craft.loadingRecipes');
        setState(`<div class="empty card">${esc(msg)}</div>`);
      }
      tableEl.hidden = true;
      countEl.textContent = '';
      hiddenBtn.hidden = true;
      unpricedLabel.textContent = t('craft.showUnpriced', { n: 0 });
      return;
    }
    setState('');
    tableEl.hidden = false;

    const all = computed(s);
    const unpricedN = all.reduce((n, r) => n + (r.unpriced.length > 0 ? 1 : 0), 0);
    unpricedLabel.textContent = t('craft.showUnpriced', { n: unpricedN });

    const res = filterCrafts(
      all,
      {
        q,
        minVol: prefs.minVol,
        minMargin: prefs.minMargin,
        kind: prefs.kind,
        showUnpriced: prefs.showUnpriced,
        hideSuspect: s.settings.hideSuspicious && !showHidden,
      },
      s.catalog,
    );
    table.setRows(res.rows);
    countEl.textContent = t('craft.count', { n: res.rows.length, total: all.length });

    const canHide = s.settings.hideSuspicious && res.suspect > 0;
    hiddenBtn.hidden = !canHide;
    if (canHide) {
      hiddenBtn.textContent = showHidden ? `${t('common.hideHidden')} (${res.suspect})` : t('common.hiddenCount', { n: res.hidden });
      hiddenBtn.title = showHidden ? '' : t('common.showHidden');
      hiddenBtn.setAttribute('aria-pressed', String(showHidden));
    }
  }

  const schedule = rafDebounce(render);

  function readNum(el: HTMLInputElement, fallback: number): number {
    const v = el.value.trim() === '' ? NaN : Number(el.value);
    return Number.isFinite(v) ? v : fallback;
  }

  function onInput(ev: Event): void {
    const el = ev.target as HTMLInputElement;
    switch (el.name) {
      case 'q':
        q = el.value;
        break;
      case 'minVol':
        prefs.minVol = Math.max(0, readNum(el, 0));
        savePrefs(prefs);
        break;
      case 'minMargin':
        prefs.minMargin = el.value.trim() === '' ? null : readNum(el, prefs.minMargin ?? 0);
        savePrefs(prefs);
        break;
      case 'showUnpriced':
        prefs.showUnpriced = el.checked;
        savePrefs(prefs);
        break;
      default:
        return;
    }
    schedule();
  }

  function onClick(ev: MouseEvent): void {
    const target = ev.target as Element | null;
    if (!(target instanceof Element)) return;
    const kindBtn = target.closest<HTMLButtonElement>('.craft-kind button[data-kind]');
    if (kindBtn) {
      prefs.kind = kindBtn.dataset.kind as KindFilter;
      savePrefs(prefs);
      syncControls();
      schedule();
      return;
    }
    if (target.closest('.craft-hidden')) {
      showHidden = !showHidden;
      schedule();
    }
  }

  function setQueryFromRoute(route: Route): void {
    q = route.query?.q ?? '';
  }

  return {
    id: 'craft',
    mount(el, c, route) {
      root = el;
      ctx = c;
      setQueryFromRoute(route);
      el.innerHTML = skeleton();
      table = createTable<CraftRow>({
        columns: craftColumns(env),
        rowKey: (r) => r.recipe.key,
        sort: prefs.sort,
        expand: (r) => craftDetail(env, r),
        rowClass: (r) => (r.unpriced.length > 0 ? 'craft-unpriced' : ''),
        emptyText: () => t('craft.empty'),
        onSortChange: (s) => {
          prefs.sort = s;
          savePrefs(prefs);
        },
      });
      $('.craft-table').append(table.el);
      applyLabels();
      syncControls();

      const view = $('.craft-view');
      view.addEventListener('input', onInput);
      view.addEventListener('change', onInput);
      view.addEventListener('click', onClick);
      subs.push(() => {
        view.removeEventListener('input', onInput);
        view.removeEventListener('change', onInput);
        view.removeEventListener('click', onClick);
      });
      subs.push(
        c.store.subscribe((s, prev) => {
          if (s.settings.forgeSlots !== prev.settings.forgeSlots) applyLabels();
          if (
            s.snapshot !== prev.snapshot ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.settings !== prev.settings ||
            s.historyTick !== prev.historyTick
          ) {
            schedule();
          }
        }),
      );
      subs.push(
        onLangChange(() => {
          applyLabels();
          table?.refresh();
          schedule();
        }),
      );
      render();
    },
    update(route) {
      if (!root) return;
      const before = q;
      setQueryFromRoute(route);
      if (q === before) return;
      $<HTMLInputElement>('input[name=q]').value = q;
      schedule();
    },
    unmount() {
      for (const off of subs.splice(0)) off();
      table?.destroy();
      table = null;
      if (root) root.textContent = '';
      root = null;
      ctx = null;
      memoKey = null;
      memoRows = [];
      recipeIdx = null;
    },
  };
}
