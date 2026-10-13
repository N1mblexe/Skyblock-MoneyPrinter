// NPC flip view: bazaar <-> NPC merchant fixed-price arbitrage in either direction.
import { PRICE_TICK } from '../../../config.ts';
import { round1 } from '../../../domain/pricing.ts';
import { onLangChange, t } from '../../../i18n/index.ts';
import type { AppState, NpcFlipRow, Route, View, ViewContext } from '../../../types/contracts.ts';
import { itemCell, riskBadge, sourceBadge } from '../../cells.ts';
import { esc, h, rafDebounce } from '../../dom.ts';
import { fmtCoins, fmtCompact, fmtInt, fmtPct } from '../../format.ts';
import { createTable, type Column, type TableHandle } from '../../table.ts';
import { createNpcMemo, filterRows, loadPrefs, savePrefs, type NpcDirection, type NpcPrefs } from './npcData.ts';
import './npc.css';
import './i18n.ts';

const DIRS: NpcDirection[] = ['bz2npc', 'npc2bz'];

export function createNpcView(): View {
  let root: HTMLElement | null = null;
  let ctx: ViewContext | null = null;
  let prefs: NpcPrefs = loadPrefs();
  let table: TableHandle<NpcFlipRow> | null = null;
  const cleanups: (() => void)[] = [];
  const memo = createNpcMemo();

  // element refs (set in mount)
  let titleEl: HTMLElement;
  let introEl: HTMLElement;
  let segEl: HTMLElement;
  let dirDescEl: HTMLElement;
  let filtersEl: HTMLElement;
  let noteEl: HTMLElement;
  let stateEl: HTMLElement;
  let toolbarEl: HTMLElement;
  let countEl: HTMLElement;
  let hiddenBtn: HTMLButtonElement;
  let searchInput: HTMLInputElement;
  let marginInput: HTMLInputElement;
  let pphInput: HTMLInputElement;
  const labels: { el: HTMLElement; key: string }[] = [];

  let emptyMsg = '';

  const state = (): AppState => ctx!.store.get();

  const persist = () => savePrefs(prefs);

  // ------------------------------------------------------------------ cells
  function priceCell(price: number, badge: string): string {
    return `<span class="npc-price">${esc(fmtCoins(price))}</span><span class="npc-src">${badge}</span>`;
  }

  function buyCell(r: NpcFlipRow): string {
    if (r.direction === 'npc2bz') return priceCell(r.buyAt, sourceBadge('npc'));
    const s = state().settings;
    if (s.costMode === 'insta') return priceCell(r.buyAt, sourceBadge('insta'));
    const bid = state().snapshot?.products[r.id]?.bid;
    const floored = bid == null || r.buyAt > round1(bid + PRICE_TICK) + 1e-9;
    const hint = floored
      ? ` <span class="npc-floor" title="${esc(t('npc.floorTitle'))}">${esc(t('npc.floorHint'))}</span>`
      : '';
    return priceCell(r.buyAt, sourceBadge('order') + hint);
  }

  function sellCell(r: NpcFlipRow): string {
    if (r.direction === 'bz2npc') return priceCell(r.sellAt, sourceBadge('npc'));
    const insta = state().settings.sellMode === 'insta';
    const badge = `<span class="badge ${insta ? 'src-insta' : 'src-order'}">${esc(t(insta ? 'npc.srcInstaSell' : 'npc.srcSellOffer'))}</span>`;
    return priceCell(r.sellAt, badge);
  }

  const columns: Column<NpcFlipRow>[] = [
    {
      key: 'name',
      label: () => t('npc.col_item'),
      get: (r) => r.name,
      html: (r) => itemCell(r.id, r.name, true),
      cls: 'name-cell',
    },
    {
      key: 'buyAt',
      label: () => t('npc.col_buy'),
      title: () => t('npc.col_buyTitle'),
      get: (r) => r.buyAt,
      html: buyCell,
      align: 'right',
    },
    {
      key: 'sellAt',
      label: () => t('npc.col_sell'),
      title: () => t('npc.col_sellTitle'),
      get: (r) => r.sellAt,
      html: sellCell,
      align: 'right',
    },
    {
      key: 'profit',
      label: () => t('npc.col_profit'),
      get: (r) => r.profit,
      html: (r) => `<span class="${r.profit > 0 ? 'pos' : 'neg'}">${esc(fmtCoins(r.profit))}</span>`,
      align: 'right',
    },
    {
      key: 'margin',
      label: () => t('npc.col_margin'),
      get: (r) => r.margin,
      html: (r) => esc(fmtPct(r.margin)),
      align: 'right',
    },
    {
      key: 'uph',
      label: () => t('npc.col_uph'),
      title: () => t('npc.col_uphTitle'),
      get: (r) => r.tp.unitsPerHour,
      html: (r) =>
        `<span title="${esc(t('npc.limitedBy', { x: t(`npc.lim_${r.tp.limitedBy}`) }))}">${esc(fmtInt(r.tp.unitsPerHour))}</span>`,
      align: 'right',
    },
    {
      key: 'capital',
      label: () => t('npc.col_capital'),
      title: () => t('npc.col_capitalTitle'),
      get: (r) => r.tp.capitalUsed,
      html: (r) => esc(fmtCompact(r.tp.capitalUsed)),
      align: 'right',
    },
    {
      key: 'pph',
      label: () => t('npc.col_pph'),
      title: () => t('npc.col_pphTitle'),
      get: (r) => r.profitPerHour,
      html: (r) => `<strong class="pos">${esc(fmtCoins(r.profitPerHour))}</strong>`,
      align: 'right',
    },
    {
      key: 'risk',
      label: () => t('npc.col_risk'),
      get: (r) => r.risk.score,
      html: (r) => riskBadge(r.risk),
      align: 'center',
    },
  ];

  // ------------------------------------------------------------------ render
  function renderTexts(): void {
    for (const { el, key } of labels) el.textContent = t(key);
    titleEl.textContent = t('npc.title');
    introEl.textContent = t('npc.intro');
    dirDescEl.textContent = t(`npc.dirDesc_${prefs.dir}`);
    searchInput.placeholder = t('npc.searchPh');
    segEl.setAttribute('aria-label', t('npc.dirAria'));
    for (const b of segEl.querySelectorAll<HTMLButtonElement>('button')) {
      b.textContent = t(`npc.dir_${b.dataset.dir}`);
      b.setAttribute('aria-pressed', String(b.dataset.dir === prefs.dir));
    }
    noteEl.innerHTML =
      `<p><strong>${esc(t('npc.noteTitle'))}</strong> ${esc(t('npc.noteLimits'))}</p>` +
      `<p>${esc(t('npc.noteFloor'))}</p><p>${esc(t('npc.notePricing'))}</p>`;
  }

  function setState(msg: string | null, kind: 'info' | 'err' = 'info'): void {
    if (msg == null) {
      stateEl.hidden = true;
      stateEl.textContent = '';
      return;
    }
    stateEl.hidden = false;
    stateEl.className = `banner banner-${kind} npc-state`;
    stateEl.textContent = msg;
  }

  function render(): void {
    if (!root || !ctx || !table) return;
    const s = state();
    const ready = !!(s.snapshot && s.catalog);
    toolbarEl.hidden = !ready;
    table.el.hidden = !ready;
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
    const all = memo({ snap: s.snapshot, catalog: s.catalog, settings: s.settings, stats: (id) => ctx!.history.stats(id) }, s.historyTick);
    const hide = s.settings.hideSuspicious;
    const res = filterRows(all, prefs, s.catalog, hide);
    const hiddenN = hide && !prefs.showHidden ? res.suspect : 0;
    emptyMsg =
      res.total === 0
        ? t('npc.emptyNone')
        : hiddenN > 0
          ? t('npc.emptyHidden', { n: hiddenN })
          : t('npc.emptyFiltered');
    countEl.textContent = t('npc.rowsCount', { n: res.rows.length });
    if (hide && res.suspect > 0) {
      hiddenBtn.hidden = false;
      hiddenBtn.textContent = prefs.showHidden
        ? t('npc.hiddenShowing', { n: res.suspect })
        : t('common.hiddenCount', { n: res.suspect });
      hiddenBtn.title = prefs.showHidden ? t('common.hideHidden') : t('npc.hiddenTitle');
      hiddenBtn.setAttribute('aria-pressed', String(prefs.showHidden));
    } else {
      hiddenBtn.hidden = true;
    }
    table.setRows(res.rows);
  }

  const schedule = rafDebounce(render);

  function setDir(dir: NpcDirection): void {
    if (prefs.dir === dir) return;
    prefs.dir = dir;
    persist();
    renderTexts();
    render();
  }

  function numInput(key: 'minMargin' | 'minPph', step: string): HTMLInputElement {
    const el = h('input', {
      type: 'number',
      inputmode: 'decimal',
      min: '0',
      step,
      'data-filter': key,
      value: String(prefs[key]),
    });
    const onInput = () => {
      const v = Number(el.value);
      prefs[key] = Number.isFinite(v) && v >= 0 ? v : 0;
      persist();
      schedule();
    };
    el.addEventListener('input', onInput);
    el.addEventListener('change', onInput);
    return el;
  }

  function field(labelKey: string, input: HTMLElement): HTMLElement {
    const lab = h('span', { class: 'field-label' });
    labels.push({ el: lab, key: labelKey });
    return h('label', { class: 'field' }, lab, input);
  }

  function applyQuery(route: Route): boolean {
    const q = route.query ?? {};
    let changed = false;
    if (typeof q.q === 'string' && q.q !== prefs.q) {
      prefs.q = q.q;
      changed = true;
    }
    if ((q.dir === 'bz2npc' || q.dir === 'npc2bz') && q.dir !== prefs.dir) {
      prefs.dir = q.dir;
      changed = true;
    }
    if (changed) persist();
    return changed;
  }

  return {
    id: 'npc',
    mount(el, vctx, route) {
      root = el;
      ctx = vctx;
      prefs = loadPrefs();
      labels.length = 0;
      applyQuery(route);

      titleEl = h('h2');
      introEl = h('p', { class: 'muted small npc-intro' });
      segEl = h('div', { class: 'seg npc-seg', role: 'group', 'data-testid': 'npc-dir' });
      for (const d of DIRS) {
        segEl.append(h('button', { type: 'button', 'data-dir': d, onclick: () => setDir(d) }));
      }
      dirDescEl = h('p', { class: 'small npc-dir-desc' });

      searchInput = h('input', { type: 'search', value: prefs.q, autocomplete: 'off', 'data-testid': 'npc-search' });
      searchInput.addEventListener('input', () => {
        prefs.q = searchInput.value;
        persist();
        schedule();
      });
      marginInput = numInput('minMargin', '0.5');
      pphInput = numInput('minPph', '1000');
      filtersEl = h(
        'div',
        { class: 'filters' },
        field('npc.search', searchInput),
        field('npc.minMargin', marginInput),
        field('npc.minPph', pphInput),
      );

      noteEl = h('div', { class: 'note npc-note' });
      stateEl = h('div', { class: 'banner banner-info npc-state', role: 'status' });

      countEl = h('span', { class: 'npc-count' });
      hiddenBtn = h('button', { type: 'button', class: 'hidden-count', 'data-testid': 'npc-hidden' });
      hiddenBtn.addEventListener('click', () => {
        prefs.showHidden = !prefs.showHidden;
        persist();
        render();
      });
      toolbarEl = h('div', { class: 'toolbar' }, h('div', null, countEl), h('div', null, hiddenBtn));

      table = createTable<NpcFlipRow>({
        columns,
        rowKey: (r) => `${r.direction}:${r.id}`,
        sort: prefs.sort ?? { key: 'pph', dir: 'desc' },
        onRowClick: (r) => ctx?.navigate({ id: 'item', param: r.id }),
        rowClass: (r) => (r.risk.level === 'suspect' ? 'npc-suspect' : ''),
        emptyText: () => emptyMsg || t('common.noRows'),
        onSortChange: (s) => {
          prefs.sort = s;
          persist();
        },
      });

      const head = h(
        'div',
        { class: 'card npc-head' },
        h('div', { class: 'npc-titlebar' }, titleEl, segEl),
        introEl,
        dirDescEl,
        filtersEl,
      );
      el.append(h('section', { class: 'npc-view', 'data-testid': 'npc-view' }, head, noteEl, stateEl, toolbarEl, table.el));

      renderTexts();
      render();

      cleanups.push(
        vctx.store.subscribe((s, prev) => {
          if (
            s.snapshot !== prev.snapshot ||
            s.settings !== prev.settings ||
            s.catalog !== prev.catalog ||
            s.catalogError !== prev.catalogError ||
            s.historyTick !== prev.historyTick
          )
            schedule();
        }),
        onLangChange(() => {
          renderTexts();
          table?.refresh();
          schedule();
        }),
      );
    },
    update(route) {
      if (!root || !applyQuery(route)) return;
      searchInput.value = prefs.q;
      renderTexts();
      render();
    },
    unmount() {
      for (const fn of cleanups.splice(0)) fn();
      table?.destroy();
      table = null;
      if (root) root.replaceChildren();
      root = null;
      ctx = null;
    },
  };
}
