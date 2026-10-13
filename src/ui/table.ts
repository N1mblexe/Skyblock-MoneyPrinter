import { TABLE_MAX_ROWS } from '../config.ts';
import { t } from '../i18n/index.ts';
import { esc } from './dom.ts';
import { locale } from './format.ts';

export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDir;
}

export interface Column<T> {
  key: string;
  /** header label (called on every render so language switches apply) */
  label: () => string;
  /** sort value; null sorts last */
  get: (row: T) => number | string | null;
  /** cell HTML (must escape itself); defaults to esc(String(get(row) ?? '—')) */
  html?: (row: T) => string;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  /** header tooltip */
  title?: () => string;
  cls?: string;
}

export interface TableOptions<T> {
  columns: Column<T>[];
  rowKey: (row: T) => string;
  sort?: SortState;
  /** default TABLE_MAX_ROWS */
  maxRows?: number;
  onRowClick?: (row: T, ev: MouseEvent) => void;
  /** if set, rows toggle an expanded detail row (HTML) on click instead of onRowClick; key kept across setRows */
  expand?: (row: T) => string;
  rowClass?: (row: T) => string;
  emptyText?: () => string;
  onSortChange?: (s: SortState) => void;
}

export interface TableHandle<T> {
  el: HTMLElement;
  setRows(rows: readonly T[]): void;
  /** re-render headers/footer (e.g. after language change) */
  refresh(): void;
  getSort(): SortState | undefined;
  destroy(): void;
}

type SortVal = number | string | null;

function isNullish(v: SortVal): boolean {
  return v == null || (typeof v === 'number' && Number.isNaN(v));
}

/** Sort a copy of rows by column; null/NaN values last in both directions. Stable. */
export function sortRows<T>(rows: readonly T[], get: (row: T) => SortVal, dir: SortDir): T[] {
  const coll = new Intl.Collator(locale(), { numeric: true, sensitivity: 'base' });
  const sign = dir === 'asc' ? 1 : -1;
  const dec = rows.map((row, i) => ({ row, i, v: get(row) }));
  dec.sort((a, b) => {
    const an = isNullish(a.v);
    const bn = isNullish(b.v);
    if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1;
    let c: number;
    if (typeof a.v === 'number' && typeof b.v === 'number') c = a.v - b.v;
    else c = coll.compare(String(a.v), String(b.v));
    return c !== 0 ? c * sign : a.i - b.i;
  });
  return dec.map((d) => d.row);
}

/** Sortable, capped table: renders footer "showing N of M" when capped. Click on header toggles sort. */
export function createTable<T>(opts: TableOptions<T>): TableHandle<T> {
  const { columns, rowKey } = opts;
  const maxRows = opts.maxRows ?? TABLE_MAX_ROWS;
  const clickable = !!(opts.expand || opts.onRowClick);
  let sort: SortState | undefined = opts.sort ? { ...opts.sort } : undefined;
  let rows: readonly T[] = [];
  let shown: T[] = [];
  const byKey = new Map<string, T>();
  const expanded = new Set<string>();

  const el = document.createElement('div');
  el.className = 'tbl';
  const wrap = document.createElement('div');
  wrap.className = 'tbl-wrap';
  const table = document.createElement('table');
  if (clickable) table.className = 'tbl-clickable';
  const foot = document.createElement('div');
  foot.className = 'tbl-foot';
  foot.setAttribute('role', 'status');
  wrap.append(table);
  el.append(wrap, foot);

  const colByKey = new Map(columns.map((c) => [c.key, c]));
  const alignCls = (c: Column<T>) => (c.align === 'right' ? 'num' : c.align === 'center' ? 'ctr' : '');
  const cellCls = (c: Column<T>) => [alignCls(c), c.cls].filter(Boolean).join(' ');

  function headHtml(): string {
    let s = '<thead><tr>';
    for (const c of columns) {
      const sortable = c.sortable !== false;
      const active = sort?.key === c.key;
      const aria = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      const cls = [cellCls(c), active ? 'sorted' : ''].filter(Boolean).join(' ');
      const title = c.title ? ` title="${esc(c.title())}"` : '';
      const label = esc(c.label());
      if (sortable) {
        const ind = active ? (sort!.dir === 'asc' ? '▲' : '▼') : '';
        s += `<th scope="col"${cls ? ` class="${cls}"` : ''} aria-sort="${aria}"${title}><button type="button" class="th-btn" data-sort="${esc(c.key)}">${label}<span class="sort-ind" aria-hidden="true">${ind}</span></button></th>`;
      } else {
        s += `<th scope="col"${cls ? ` class="${cls}"` : ''}${title}>${label}</th>`;
      }
    }
    return s + '</tr></thead>';
  }

  function detailHtml(row: T): string {
    return `<tr class="detail"><td colspan="${columns.length}">${opts.expand!(row)}</td></tr>`;
  }

  function rowHtml(row: T): string {
    const key = rowKey(row);
    const open = opts.expand ? expanded.has(key) : false;
    const extra = opts.rowClass?.(row) ?? '';
    const cls = [extra, open ? 'open' : ''].filter(Boolean).join(' ');
    let s = `<tr data-key="${esc(key)}"${cls ? ` class="${esc(cls)}"` : ''}`;
    if (clickable) s += ' tabindex="0"';
    if (opts.expand) s += ` aria-expanded="${open}"`;
    s += '>';
    for (const c of columns) {
      const cc = cellCls(c);
      let inner: string;
      if (c.html) inner = c.html(row);
      else {
        const v = c.get(row);
        inner = esc(isNullish(v) ? '—' : String(v));
      }
      s += `<td${cc ? ` class="${cc}"` : ''}>${inner}</td>`;
    }
    s += '</tr>';
    if (open) s += detailHtml(row);
    return s;
  }

  function render(): void {
    byKey.clear();
    let body = '';
    for (const r of shown) {
      byKey.set(rowKey(r), r);
      body += rowHtml(r);
    }
    if (!shown.length) {
      const txt = opts.emptyText ? opts.emptyText() : t('common.noRows');
      body = `<tr class="empty-row"><td class="empty" colspan="${columns.length}">${esc(txt)}</td></tr>`;
    }
    table.innerHTML = headHtml() + '<tbody>' + body + '</tbody>';
    if (rows.length > shown.length) {
      foot.textContent = t('common.tableShowing', { n: shown.length, m: rows.length });
      foot.hidden = false;
    } else {
      foot.textContent = '';
      foot.hidden = true;
    }
  }

  function compute(): void {
    let sorted: readonly T[] = rows;
    const col = sort ? colByKey.get(sort.key) : undefined;
    if (sort && col) sorted = sortRows(rows, col.get, sort.dir);
    shown = sorted.length > maxRows ? sorted.slice(0, maxRows) : sorted.slice();
  }

  function onSortClick(key: string): void {
    const col = colByKey.get(key);
    if (!col) return;
    if (sort?.key === key) sort = { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
    else {
      // first click: numbers default to desc, text to asc
      let numeric = false;
      for (const r of rows) {
        const v = col.get(r);
        if (isNullish(v)) continue;
        numeric = typeof v === 'number';
        break;
      }
      if (!rows.length) numeric = col.align === 'right';
      sort = { key, dir: numeric ? 'desc' : 'asc' };
    }
    compute();
    render();
    opts.onSortChange?.({ ...sort });
  }

  function toggleRow(tr: HTMLTableRowElement, ev: Event): void {
    const key = tr.dataset.key;
    if (key == null) return;
    const row = byKey.get(key);
    if (row === undefined) return;
    if (opts.expand) {
      const next = tr.nextElementSibling;
      if (expanded.has(key)) {
        expanded.delete(key);
        if (next?.classList.contains('detail')) next.remove();
        tr.classList.remove('open');
        tr.setAttribute('aria-expanded', 'false');
      } else {
        expanded.add(key);
        const det = document.createElement('tr');
        det.className = 'detail';
        const td = document.createElement('td');
        td.colSpan = columns.length;
        td.innerHTML = opts.expand(row);
        det.append(td);
        tr.after(det);
        tr.classList.add('open');
        tr.setAttribute('aria-expanded', 'true');
      }
    } else if (opts.onRowClick) {
      opts.onRowClick(row, ev as MouseEvent);
    }
  }

  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[contenteditable]';

  function rowFromEvent(ev: Event): HTMLTableRowElement | null {
    const target = ev.target as Element | null;
    if (!target || !(target instanceof Element)) return null;
    const tr = target.closest('tr');
    if (!tr || !table.contains(tr) || tr.dataset.key == null) return null;
    const inter = target.closest(INTERACTIVE);
    if (inter && tr.contains(inter)) return null;
    return tr as HTMLTableRowElement;
  }

  const onClick = (ev: MouseEvent) => {
    const target = ev.target as Element | null;
    const btn = target instanceof Element ? target.closest<HTMLElement>('button[data-sort]') : null;
    if (btn && table.contains(btn)) {
      onSortClick(btn.dataset.sort!);
      return;
    }
    if (!clickable) return;
    const tr = rowFromEvent(ev);
    if (tr) toggleRow(tr, ev);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (!clickable || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    const target = ev.target as Element | null;
    if (!(target instanceof HTMLTableRowElement) || target.dataset.key == null) return;
    ev.preventDefault();
    toggleRow(target, ev);
  };
  table.addEventListener('click', onClick);
  table.addEventListener('keydown', onKey);

  compute();
  render();

  return {
    el,
    setRows(next) {
      rows = next;
      compute();
      render();
    },
    refresh() {
      // re-sort too: string collation can depend on locale
      compute();
      render();
    },
    getSort: () => (sort ? { ...sort } : undefined),
    destroy() {
      table.removeEventListener('click', onClick);
      table.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
}
