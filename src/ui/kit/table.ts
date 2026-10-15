// Kit table: sortable, virtualized (fixed row height), card layout on mobile, roving tabindex,
// column chooser, CSV export. The legacy createTable() in ../table.ts is a thin wrapper around this.
//
// Scrolling model: `.tbl-wrap` is the scroll container (max-height: var(--tbl-max-h), default 72vh).
// The sticky header lives inside it, so the window of rendered rows is computed from
// wrap.scrollTop / rowHeight. In a CSS-grid shell give the table a definite height with the
// `.tbl-fill` modifier (el.classList.add('tbl-fill')) and a grid row of `minmax(0, 1fr)`; the
// wrap then fills that row instead of using --tbl-max-h.
import { LS_COLUMNS, TABLE_MAX_ROWS, UI } from '../../config.ts';
import { t } from '../../i18n/index.ts';
import { lsGet, lsSet } from '../../storage/local.ts';
import { esc } from '../dom.ts';
import { downloadCsv, toCsv as buildCsv } from './csv.ts';
import { isNullish, sortRows } from './sort.ts';
import type { KitColumn, KitTableHandle, KitTableOptions, SortState } from './types.ts';
import { focusEl, media, onMedia, uid } from './util.ts';

type Layout = 'table' | 'cards';

const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[contenteditable]';
const INNER_TABBABLE = 'a,button,input,select,textarea,[tabindex]';

/** Current row height in px: --row-h on <html>, else UI.rowH / UI.rowHCompact by [data-density]. */
export function cssRowHeight(): number {
  if (typeof document === 'undefined') return UI.rowH;
  const root = document.documentElement;
  try {
    const v = parseFloat(getComputedStyle(root).getPropertyValue('--row-h'));
    if (Number.isFinite(v) && v > 0) return v;
  } catch {
    /* no computed style */
  }
  return root.dataset.density === 'compact' ? UI.rowHCompact : UI.rowH;
}

/** Card priority of a column (default 2 = shown on cards). */
const prio = <T>(c: KitColumn<T>): number => c.priority ?? 2;
const isHideable = <T>(c: KitColumn<T>): boolean => c.hideable ?? c.priority !== 0;

/**
 * Create a kit table. See src/ui/kit/index.ts for the usage guide.
 * Virtualizes above UI.virtualizeAbove rows (unless `expand` is used), switches to cards below UI.mobileBp
 * (layout 'auto'), keeps exactly one row tabbable, and renders only the visible window on scroll/setRows.
 */
export function createKitTable<T>(opts: KitTableOptions<T>): KitTableHandle<T> {
  const { columns, rowKey } = opts;
  const maxRows = opts.maxRows ?? TABLE_MAX_ROWS;
  const clickable = !!(opts.expand || opts.onRowClick || opts.onActivate);
  const focusable = clickable || !!opts.rowActions;
  const colByKey = new Map(columns.map((c) => [c.key, c]));
  const lsKey = opts.columnsKey ? LS_COLUMNS + opts.columnsKey : null;

  let sort: SortState | undefined = opts.sort ? { ...opts.sort } : undefined;
  let rows: readonly T[] = [];
  let sorted: T[] = [];
  let view: T[] = [];
  let keys: string[] = [];
  const index = new Map<string, number>();
  const expanded = new Set<string>();
  let selected: string | null = opts.selectedKey ?? null;
  let focusKey: string | null = null;
  let virtual = false;
  let range: [number, number] = [0, 0];
  let rowH = opts.rowHeight ?? cssRowHeight();
  let measured = false;
  let widthsLocked = false;
  let cardLimit: number = UI.cardPage;
  let hidden = initHidden();

  function initHidden(): Set<string> {
    const stored = lsKey ? lsGet<unknown>(lsKey, null) : null;
    const ok = (k: unknown): k is string => typeof k === 'string' && !!colByKey.get(k) && isHideable(colByKey.get(k)!);
    if (Array.isArray(stored)) return new Set(stored.filter(ok));
    return new Set(columns.filter((c) => c.defaultHidden && isHideable(c)).map((c) => c.key));
  }

  // ---------------------------------------------------------------- DOM skeleton
  const el = document.createElement('div');
  el.className = 'tbl tbl-kit';
  const wrap = document.createElement('div');
  wrap.className = 'tbl-wrap';
  const table = document.createElement('table');
  if (clickable) table.className = 'tbl-clickable';
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  const cardsBar = document.createElement('div');
  cardsBar.className = 'kcards-bar';
  const list = document.createElement('ul');
  list.className = 'kcards';
  list.setAttribute('role', 'list');
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'btn btn-sm kcards-more';
  moreBtn.hidden = true;
  const foot = document.createElement('div');
  foot.className = 'tbl-foot';
  foot.setAttribute('role', 'status');

  // toolbar
  const tb = opts.toolbar;
  let tools: HTMLElement | null = null;
  let colBtn: HTMLButtonElement | null = null;
  let pop: HTMLElement | null = null;
  let csvBtn: HTMLButtonElement | null = null;
  let resetBtn: HTMLButtonElement | null = null;
  if (tb) {
    tools = document.createElement('div');
    tools.className = 'tbl-tools';
    const left = document.createElement('div');
    left.className = 'tbl-tools-extra';
    if (tb.extra) left.append(tb.extra);
    const right = document.createElement('div');
    right.className = 'tbl-tools-actions';
    if (tb.columns && columns.some(isHideable)) {
      const popId = uid('tbl-cols');
      const holder = document.createElement('div');
      holder.className = 'kit-pop-anchor';
      colBtn = document.createElement('button');
      colBtn.type = 'button';
      colBtn.className = 'btn btn-sm';
      colBtn.dataset.tool = 'columns';
      colBtn.setAttribute('aria-expanded', 'false');
      colBtn.setAttribute('aria-controls', popId);
      pop = document.createElement('div');
      pop.className = 'kit-pop';
      pop.id = popId;
      pop.hidden = true;
      pop.setAttribute('role', 'group');
      holder.append(colBtn, pop);
      right.append(holder);
    }
    if (tb.exportName) {
      csvBtn = document.createElement('button');
      csvBtn.type = 'button';
      csvBtn.className = 'btn btn-sm';
      csvBtn.dataset.tool = 'csv';
      right.append(csvBtn);
    }
    if (tb.onReset) {
      resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'btn btn-sm btn-ghost';
      resetBtn.dataset.tool = 'reset';
      right.append(resetBtn);
    }
    tools.append(left, right);
    el.append(tools);
  }
  el.append(wrap, moreBtn, foot);

  // ---------------------------------------------------------------- layout
  const mql = !opts.layout || opts.layout === 'auto' ? media(`(max-width: ${UI.mobileBp - 0.02}px)`) : null;
  const pickLayout = (): Layout => (opts.layout === 'cards' ? 'cards' : opts.layout === 'table' ? 'table' : mql?.matches ? 'cards' : 'table');
  let layout: Layout = pickLayout();

  function mountLayout(): void {
    el.dataset.layout = layout;
    if (layout === 'cards') wrap.replaceChildren(cardsBar, list);
    else wrap.replaceChildren(table);
    // non-interactive tables: make the scroll region itself focusable for keyboard scrolling
    if (!focusable && layout === 'table') wrap.tabIndex = 0;
    else wrap.removeAttribute('tabindex');
  }

  // ---------------------------------------------------------------- helpers
  const visibleCols = (): KitColumn<T>[] => columns.filter((c) => !hidden.has(c.key));
  const span = (): number => visibleCols().length + (opts.rowActions ? 1 : 0);
  const alignCls = (c: KitColumn<T>) => (c.align === 'right' ? 'num' : c.align === 'center' ? 'ctr' : '');
  const cellCls = (c: KitColumn<T>) => [alignCls(c), c.cls].filter(Boolean).join(' ');
  const bodyEl = (): HTMLElement => (layout === 'cards' ? list : tbody);

  function cellInner(c: KitColumn<T>, row: T): string {
    if (c.html) return c.html(row);
    const v = c.get(row);
    return esc(isNullish(v) ? '—' : String(v));
  }

  function rowElByKey(key: string): HTMLElement | null {
    for (const c of bodyEl().children) if ((c as HTMLElement).dataset.key === key) return c as HTMLElement;
    return null;
  }

  function rowFromTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const r = target.closest<HTMLElement>('[data-key]');
    return r && r.parentElement === bodyEl() ? r : null;
  }

  // ---------------------------------------------------------------- compute
  function compute(): void {
    const col = sort ? colByKey.get(sort.key) : undefined;
    sorted = sort && col ? sortRows(rows, col.get, sort.dir) : rows.slice();
    virtual = layout === 'table' && !opts.expand && (opts.virtualize ?? sorted.length > UI.virtualizeAbove);
    view = layout === 'table' && !virtual && sorted.length > maxRows ? sorted.slice(0, maxRows) : sorted;
    keys = view.map(rowKey);
    index.clear();
    keys.forEach((k, i) => index.set(k, i));
    el.classList.toggle('tbl-virtual', virtual);
    if (virtual) {
      table.setAttribute('aria-rowcount', String(view.length + 1));
      el.style.setProperty('--kit-row-h', `${rowH}px`);
    } else table.removeAttribute('aria-rowcount');
  }

  // ---------------------------------------------------------------- header
  function headHtml(): string {
    let s = '<tr' + (virtual ? ' aria-rowindex="1"' : '') + '>';
    for (const c of visibleCols()) {
      const sortable = c.sortable !== false;
      const active = sort?.key === c.key;
      const aria = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      const cls = [cellCls(c), active ? 'sorted' : ''].filter(Boolean).join(' ');
      const title = c.title ? ` title="${esc(c.title())}"` : '';
      const width = c.width ? ` style="width:${esc(c.width)}"` : '';
      const label = esc(c.label());
      if (sortable) {
        const ind = active ? (sort!.dir === 'asc' ? '▲' : '▼') : '';
        s += `<th scope="col"${cls ? ` class="${cls}"` : ''} aria-sort="${aria}"${title}${width}><button type="button" class="th-btn" data-sort="${esc(c.key)}">${label}<span class="sort-ind" aria-hidden="true">${ind}</span></button></th>`;
      } else {
        s += `<th scope="col"${cls ? ` class="${cls}"` : ''}${title}${width}>${label}</th>`;
      }
    }
    if (opts.rowActions) s += `<th scope="col" class="row-actions"><span class="kit-sr">${esc(t('kit.actions'))}</span></th>`;
    return s + '</tr>';
  }

  let lastBar = '';
  function renderCardsBar(): void {
    const sortable = visibleCols().filter((c) => c.sortable !== false);
    if (!sortable.length) {
      cardsBar.hidden = true;
      return;
    }
    cardsBar.hidden = false;
    const cur = sort ? `${sort.key}.${sort.dir}` : '';
    let o = cur ? '' : '<option value="" selected>—</option>';
    for (const c of sortable) {
      for (const dir of ['desc', 'asc'] as const) {
        const v = `${c.key}.${dir}`;
        o += `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(c.label())} ${dir === 'asc' ? '▲' : '▼'}</option>`;
      }
    }
    const html = `<label class="kcards-sort"><span class="field-label">${esc(t('kit.sortBy'))}</span><select data-cards-sort>${o}</select></label>`;
    if (html === lastBar) return;
    lastBar = html;
    cardsBar.innerHTML = html;
  }

  let lastHead = '';
  /** Header (or the cards sort bar). Skips the DOM write when nothing changed, so setRows stays cheap. */
  function renderHead(force = false): void {
    if (layout === 'cards') {
      renderCardsBar();
      return;
    }
    const html = headHtml();
    if (html === lastHead && !force) return;
    lastHead = html;
    thead.innerHTML = html;
    widthsLocked = false;
    table.classList.remove('tbl-fixed');
  }

  /** Virtual mode: freeze measured column widths so they don't jump while scrolling. */
  function lockWidths(): void {
    if (widthsLocked || !virtual) return;
    const ths = [...thead.querySelectorAll<HTMLElement>('th')];
    if (!ths.length || !ths[0]!.offsetWidth) return;
    const cols = visibleCols();
    const w = ths.map((th) => th.offsetWidth);
    ths.forEach((th, i) => {
      if (!cols[i]?.width) th.style.width = `${w[i]}px`;
    });
    table.classList.add('tbl-fixed');
    widthsLocked = true;
  }

  // ---------------------------------------------------------------- body
  function rowAttrs(key: string, tabKey: string | null, extraCls: string, idx: number): string {
    const open = opts.expand ? expanded.has(key) : false;
    const cls = [extraCls, open ? 'open' : '', key === selected ? 'sel' : ''].filter(Boolean).join(' ');
    let s = ` data-key="${esc(key)}"${cls ? ` class="${esc(cls)}"` : ''}`;
    if (focusable) s += ` tabindex="${key === tabKey ? 0 : -1}"`;
    if (opts.expand) s += ` aria-expanded="${open}"`;
    if (key === selected) s += ' aria-selected="true"';
    if (virtual) s += ` aria-rowindex="${idx + 2}"`;
    return s;
  }

  function detailHtml(row: T): string {
    return `<tr class="detail"><td colspan="${span()}">${opts.expand!(row)}</td></tr>`;
  }

  function rowHtml(row: T, idx: number, tabKey: string | null): string {
    const key = keys[idx]!;
    let s = `<tr${rowAttrs(key, tabKey, opts.rowClass?.(row) ?? '', idx)}>`;
    for (const c of visibleCols()) {
      const cc = cellCls(c);
      s += `<td${cc ? ` class="${cc}"` : ''}>${cellInner(c, row)}</td>`;
    }
    if (opts.rowActions) s += `<td class="row-actions">${opts.rowActions(row)}</td>`;
    s += '</tr>';
    if (opts.expand && expanded.has(key)) s += detailHtml(row);
    return s;
  }

  function cardHtml(row: T, idx: number, tabKey: string | null): string {
    const key = keys[idx]!;
    const cols = visibleCols();
    const titleCol = cols.find((c) => c.priority === 0) ?? cols[0];
    let s = `<li${rowAttrs(key, tabKey, ['kcard', opts.rowClass?.(row) ?? ''].filter(Boolean).join(' '), idx)}>`;
    if (titleCol) s += `<div class="kcard-title">${cellInner(titleCol, row)}</div>`;
    let kv = '';
    for (const c of cols) {
      if (c === titleCol || prio(c) === 0 || prio(c) >= 3) continue;
      const cc = cellCls(c);
      kv += `<div${cc ? ` class="${cc}"` : ''}><dt>${esc(c.label())}</dt><dd>${cellInner(c, row)}</dd></div>`;
    }
    if (kv) s += `<dl class="kcard-kv">${kv}</dl>`;
    if (opts.rowActions) s += `<div class="row-actions kcard-actions">${opts.rowActions(row)}</div>`;
    if (opts.expand && expanded.has(key)) s += `<div class="detail kcard-detail">${opts.expand(row)}</div>`;
    return s + '</li>';
  }

  function viewportH(): number {
    return wrap.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0) || 600;
  }

  function windowRange(): [number, number] {
    const n = view.length;
    const vis = Math.max(1, Math.ceil(viewportH() / rowH));
    const first = Math.min(Math.floor(Math.max(0, wrap.scrollTop) / rowH), Math.max(0, n - vis));
    return [Math.max(0, first - UI.overscan), Math.min(n, first + vis + UI.overscan)];
  }

  /** Tabbable row: focusKey when rendered, else the first rendered row. */
  function pickTabKey(start: number, end: number): string | null {
    if (!focusable || start >= end) return null;
    const i = focusKey != null ? index.get(focusKey) : undefined;
    return i != null && i >= start && i < end ? focusKey : keys[start]!;
  }

  /** Inner links/buttons follow their row: tabbable only in the tabbable row. */
  function syncInner(rowEl: HTMLElement, on: boolean): void {
    for (const n of rowEl.querySelectorAll<HTMLElement>(INNER_TABBABLE)) {
      if (on) {
        if (n.dataset.kitTab != null) {
          n.removeAttribute('tabindex');
          delete n.dataset.kitTab;
        }
      } else if (n.getAttribute('tabindex') !== '-1') {
        n.dataset.kitTab = '1';
        n.tabIndex = -1;
      }
    }
  }

  function setTabRow(next: HTMLElement): void {
    for (const c of bodyEl().children) {
      const r = c as HTMLElement;
      if (r.dataset.key == null) continue;
      if (r === next) {
        r.tabIndex = 0;
        syncInner(r, true);
      } else if (r.getAttribute('tabindex') === '0') {
        r.tabIndex = -1;
        syncInner(r, false);
      }
    }
  }

  function renderBody(): void {
    const body = bodyEl();
    const hadFocus = typeof document !== 'undefined' && !!document.activeElement && body.contains(document.activeElement);
    const n = view.length;
    let html = '';
    let start = 0;
    let end = n;
    if (layout === 'cards') end = Math.min(n, cardLimit);
    else if (virtual) [start, end] = windowRange();
    range = [start, end];
    const tabKey = pickTabKey(start, end);

    if (layout === 'cards') {
      for (let i = start; i < end; i++) html += cardHtml(view[i]!, i, tabKey);
      if (!n) html = `<li class="empty">${esc(opts.emptyText ? opts.emptyText() : t('common.noRows'))}</li>`;
    } else {
      const pad = (h: number) => `<tr class="vpad" aria-hidden="true"><td colspan="${span()}" style="height:${h}px"></td></tr>`;
      if (virtual && start > 0) html += pad(start * rowH);
      for (let i = start; i < end; i++) html += rowHtml(view[i]!, i, tabKey);
      if (virtual && end < n) html += pad((n - end) * rowH);
      if (!n) html = `<tr class="empty-row"><td class="empty" colspan="${span()}">${esc(opts.emptyText ? opts.emptyText() : t('common.noRows'))}</td></tr>`;
    }
    body.innerHTML = html;
    if (focusable) {
      for (const c of body.children) if (c.getAttribute('tabindex') === '-1') syncInner(c as HTMLElement, false);
    }
    if (hadFocus && focusKey != null) {
      const r = rowElByKey(focusKey);
      if (r) focusEl(r, true);
    }
    if (virtual) {
      lockWidths();
      measureRow();
    }
    updateFoot();
  }

  /** Adopt the real row height once (CSS may make rows taller than --row-h). */
  function measureRow(): void {
    if (measured || opts.rowHeight) return;
    const r = tbody.querySelector<HTMLElement>('tr[data-key]');
    const hgt = r?.offsetHeight ?? 0;
    if (!hgt) return;
    measured = true;
    if (Math.abs(hgt - rowH) > 1) {
      rowH = hgt;
      el.style.setProperty('--kit-row-h', `${rowH}px`);
      renderBody();
    }
  }

  function updateFoot(): void {
    const shown = layout === 'cards' ? Math.min(view.length, cardLimit) : view.length;
    const total = layout === 'cards' ? view.length : rows.length;
    if (total > shown) {
      foot.textContent = t('common.tableShowing', { n: shown, m: total, count: total });
      foot.hidden = false;
    } else {
      foot.textContent = '';
      foot.hidden = true;
    }
    const left = view.length - shown;
    moreBtn.hidden = layout !== 'cards' || left <= 0;
    if (!moreBtn.hidden) moreBtn.textContent = t('kit.loadMore', { n: Math.min(UI.cardPage, left) });
  }

  function renderToolbar(): void {
    if (colBtn) colBtn.textContent = t('common.columns');
    if (pop) {
      pop.setAttribute('aria-label', t('common.columns'));
      let s = '';
      for (const c of columns) {
        if (!isHideable(c)) continue;
        s += `<label class="kit-pop-item"><input type="checkbox" data-col="${esc(c.key)}"${hidden.has(c.key) ? '' : ' checked'}> ${esc(c.label())}</label>`;
      }
      s += `<button type="button" class="link kit-pop-all" data-cols-all>${esc(t('kit.showAllColumns'))}</button>`;
      pop.innerHTML = s;
    }
    if (csvBtn) csvBtn.textContent = t('common.exportCsv');
    if (resetBtn) resetBtn.textContent = t('common.resetFilters');
  }

  function renderAll(): void {
    compute();
    renderHead();
    renderBody();
  }

  // ---------------------------------------------------------------- behaviour
  function firstClickDir(col: KitColumn<T>): 'asc' | 'desc' {
    for (const r of rows) {
      const v = col.get(r);
      if (isNullish(v)) continue;
      return typeof v === 'number' ? 'desc' : 'asc';
    }
    return col.align === 'right' ? 'desc' : 'asc';
  }

  function applySort(next: SortState, notify: boolean): void {
    sort = { ...next };
    if (virtual) wrap.scrollTop = 0;
    renderAll();
    if (notify) opts.onSortChange?.({ ...sort });
  }

  function onSortClick(key: string): void {
    const col = colByKey.get(key);
    if (!col) return;
    applySort(sort?.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstClickDir(col) }, true);
  }

  function toggleExpand(rowEl: HTMLElement): void {
    const key = rowEl.dataset.key!;
    const i = index.get(key);
    if (i == null || !opts.expand) return;
    const row = view[i]!;
    const open = !expanded.has(key);
    if (open) expanded.add(key);
    else expanded.delete(key);
    if (layout === 'cards') {
      renderBody();
      return;
    }
    const next = rowEl.nextElementSibling;
    if (!open) {
      if (next?.classList.contains('detail')) next.remove();
    } else {
      const det = document.createElement('tr');
      det.className = 'detail';
      const td = document.createElement('td');
      td.colSpan = span();
      td.innerHTML = opts.expand(row);
      det.append(td);
      rowEl.after(det);
    }
    rowEl.classList.toggle('open', open);
    rowEl.setAttribute('aria-expanded', String(open));
  }

  function activate(rowEl: HTMLElement, ev: Event): void {
    const i = index.get(rowEl.dataset.key!);
    if (i == null) return;
    const row = view[i]!;
    if (opts.onActivate) opts.onActivate(row);
    else if (opts.expand) toggleExpand(rowEl);
    else opts.onRowClick?.(row, ev as MouseEvent);
  }

  /** Make row `i` rendered + tabbable + focused (scrolls the virtual window / loads more cards as needed). */
  function moveTo(i: number, focus = true): void {
    const n = view.length;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    focusKey = keys[i]!;
    if (layout === 'cards') {
      if (i >= cardLimit) {
        cardLimit = Math.ceil((i + 1) / UI.cardPage) * UI.cardPage;
        renderBody();
      }
    } else if (virtual) {
      const headH = thead.offsetHeight || 0;
      const vh = viewportH();
      const top = i * rowH;
      if (top < wrap.scrollTop) wrap.scrollTop = top;
      else if (headH + top + rowH > wrap.scrollTop + vh) wrap.scrollTop = headH + top + rowH - vh;
      if (i < range[0] || i >= range[1] || windowRange()[0] !== range[0]) renderBody();
    }
    const r = rowElByKey(focusKey);
    if (!r) return;
    if (focusable) setTabRow(r);
    if (focus) focusEl(r, virtual);
    if (!virtual && typeof r.scrollIntoView === 'function') r.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- events
  function closePop(refocus: boolean): void {
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    colBtn!.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick, true);
    if (refocus) colBtn!.focus();
  }

  function onDocClick(ev: MouseEvent): void {
    const target = ev.target as Node | null;
    if (target && pop && (pop.contains(target) || colBtn!.contains(target))) return;
    closePop(false);
  }

  function setHidden(next: Set<string>): void {
    if (!columns.some((c) => !next.has(c.key))) return; // keep at least one column
    hidden = next;
    if (lsKey) lsSet(lsKey, [...hidden]);
    renderAll();
    if (pop) for (const cb of pop.querySelectorAll<HTMLInputElement>('input[data-col]')) cb.checked = !hidden.has(cb.dataset.col!);
  }

  const onClick = (ev: MouseEvent) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const tool = target.closest<HTMLElement>('[data-tool]');
    if (tool && tools?.contains(tool)) {
      if (tool.dataset.tool === 'columns') {
        if (pop!.hidden) {
          pop!.hidden = false;
          colBtn!.setAttribute('aria-expanded', 'true');
          document.addEventListener('click', onDocClick, true);
          pop!.querySelector<HTMLElement>('input')?.focus();
        } else closePop(false);
      } else if (tool.dataset.tool === 'csv') handle.exportCsv();
      else if (tool.dataset.tool === 'reset') tb?.onReset?.();
      return;
    }
    if (target.closest('[data-cols-all]') && pop?.contains(target)) {
      setHidden(new Set());
      return;
    }
    if (target === moreBtn) {
      const firstNew = cardLimit;
      cardLimit += UI.cardPage;
      renderBody();
      if (firstNew < view.length) moveTo(firstNew);
      return;
    }
    const sortBtn = target.closest<HTMLElement>('button[data-sort]');
    if (sortBtn && thead.contains(sortBtn)) {
      onSortClick(sortBtn.dataset.sort!);
      return;
    }
    const rowEl = rowFromTarget(target);
    if (!rowEl) return;
    const actBtn = target.closest<HTMLElement>('[data-action]');
    if (actBtn && rowEl.contains(actBtn)) {
      const i = index.get(rowEl.dataset.key!);
      if (i != null) opts.onRowAction?.(actBtn.dataset.action!, view[i]!);
      return;
    }
    if (!clickable || target.closest('.kcard-detail')) return;
    const inter = target.closest(INTERACTIVE);
    if (inter && rowEl.contains(inter)) return;
    focusKey = rowEl.dataset.key!;
    activate(rowEl, ev);
  };

  const onChange = (ev: Event) => {
    const target = ev.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.dataset.col && pop?.contains(target)) {
      const next = new Set(hidden);
      if (target.checked) next.delete(target.dataset.col);
      else next.add(target.dataset.col);
      setHidden(next);
      target.checked = !hidden.has(target.dataset.col);
    } else if (target instanceof HTMLSelectElement && target.dataset.cardsSort != null) {
      const m = /^(.+)\.(asc|desc)$/.exec(target.value);
      if (m) applySort({ key: m[1]!, dir: m[2] as 'asc' | 'desc' }, true);
    }
  };

  const onKey = (ev: KeyboardEvent) => {
    if (pop && !pop.hidden && ev.key === 'Escape' && pop.contains(ev.target as Node)) {
      ev.preventDefault();
      closePop(true);
      return;
    }
    const rowEl = rowFromTarget(ev.target);
    if (!rowEl || ev.target !== rowEl || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const i = index.get(rowEl.dataset.key!);
    if (i == null) return;
    const page = Math.max(1, Math.floor(viewportH() / rowH) - 1);
    let to: number | null = null;
    switch (ev.key) {
      case 'ArrowDown':
      case 'j':
        to = i + 1;
        break;
      case 'ArrowUp':
      case 'k':
        to = i - 1;
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = view.length - 1;
        break;
      case 'PageDown':
        to = i + page;
        break;
      case 'PageUp':
        to = i - page;
        break;
      case 'Enter':
        if (!clickable) return;
        ev.preventDefault();
        focusKey = rowEl.dataset.key!;
        activate(rowEl, ev);
        return;
      case ' ':
        if (!clickable) return;
        ev.preventDefault();
        if (opts.expand) toggleExpand(rowEl);
        else activate(rowEl, ev);
        return;
      default:
        return;
    }
    ev.preventDefault();
    moveTo(to);
  };

  const onFocusIn = (ev: FocusEvent) => {
    const rowEl = rowFromTarget(ev.target);
    if (!rowEl || !focusable) return;
    if (rowEl.dataset.key !== focusKey || rowEl.tabIndex !== 0) {
      focusKey = rowEl.dataset.key!;
      setTabRow(rowEl);
    }
  };

  const onScroll = () => {
    if (!virtual || layout !== 'table') return;
    const [s, e] = windowRange();
    if (s !== range[0] || e !== range[1]) renderBody();
  };

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('keydown', onKey);
  el.addEventListener('focusin', onFocusIn);
  wrap.addEventListener('scroll', onScroll, { passive: true });

  let lastW = 0;
  let lastH = 0;
  const ro =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          const w = wrap.clientWidth;
          const hh = wrap.clientHeight;
          if (w !== lastW && virtual) renderHead(true);
          if (w !== lastW || hh !== lastH) {
            lastW = w;
            lastH = hh;
            if (virtual) renderBody();
          }
        })
      : null;
  ro?.observe(wrap);

  const offMedia = onMedia(mql, () => {
    const next = pickLayout();
    if (next === layout) return;
    layout = next;
    mountLayout();
    renderAll();
  });

  mountLayout();
  renderToolbar();
  renderAll();

  const handle: KitTableHandle<T> = {
    el,
    setRows(next) {
      rows = next;
      compute();
      renderHead();
      renderBody();
    },
    refresh() {
      if (!opts.rowHeight) {
        rowH = cssRowHeight();
        measured = false;
      }
      renderToolbar();
      renderAll();
    },
    getSort: () => (sort ? { ...sort } : undefined),
    setSort(s) {
      applySort(s, false);
    },
    getHiddenColumns: () => columns.filter((c) => hidden.has(c.key)).map((c) => c.key),
    setHiddenColumns(ks) {
      setHidden(new Set(ks.filter((k) => colByKey.has(k) && isHideable(colByKey.get(k)!))));
    },
    toCsv: () => buildCsv(visibleCols(), sorted),
    exportCsv() {
      downloadCsv(tb?.exportName ?? 'export', buildCsv(visibleCols(), sorted));
    },
    setSelected(key) {
      if (key === selected) return;
      const prev = selected != null ? rowElByKey(selected) : null;
      if (prev) {
        prev.classList.remove('sel');
        prev.removeAttribute('aria-selected');
      }
      selected = key;
      const cur = key != null ? rowElByKey(key) : null;
      if (cur) {
        cur.classList.add('sel');
        cur.setAttribute('aria-selected', 'true');
      }
    },
    scrollToKey(key) {
      const i = index.get(key);
      if (i != null) moveTo(i, false);
    },
    destroy() {
      el.removeEventListener('click', onClick);
      el.removeEventListener('change', onChange);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('focusin', onFocusIn);
      wrap.removeEventListener('scroll', onScroll);
      document.removeEventListener('click', onDocClick, true);
      ro?.disconnect();
      offMedia();
      el.remove();
    },
  };
  return handle;
}
