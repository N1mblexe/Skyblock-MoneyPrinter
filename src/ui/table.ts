// Legacy table API. New code should use createKitTable from './kit/index.ts' (virtualization, cards,
// toolbar, roving focus); createTable is a thin wrapper that keeps the old behaviour: no virtualization,
// always a <table>, rows capped at maxRows (default TABLE_MAX_ROWS) with a "showing N of M" footer.
import { createKitTable } from './kit/table.ts';

export { sortRows } from './kit/sort.ts';

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

/** Sortable, capped table: renders footer "showing N of M" when capped. Click on header toggles sort. */
export function createTable<T>(opts: TableOptions<T>): TableHandle<T> {
  return createKitTable<T>({ ...opts, virtualize: false, layout: 'table' });
}
