// UI kit API (frozen in Wave 0, implemented by the kit package in Wave 1).
// Views import implementations from './index.ts' once it exists; these types are the contract.
import type { Route, ToastKind } from '../../types/contracts.ts';
import type { Column as BaseColumn, SortState, TableHandle as BaseHandle, TableOptions as BaseOptions } from '../table.ts';

export type { SortState };

export interface KitColumn<T> extends BaseColumn<T> {
  /** CSV cell value; defaults to get(row) */
  csv?: (row: T) => string | number | null;
  /** card layout: 0 = title, 1 = always shown, 2 = shown, 3 = hidden on cards */
  priority?: 0 | 1 | 2 | 3;
  /** user may hide via the column chooser (default true except priority 0) */
  hideable?: boolean;
  defaultHidden?: boolean;
  /** CSS width, e.g. '8ch' */
  width?: string;
}

export interface KitTableOptions<T> extends Omit<BaseOptions<T>, 'columns'> {
  columns: KitColumn<T>[];
  /** default: true when rows > UI.virtualizeAbove and no `expand` */
  virtualize?: boolean;
  rowHeight?: number;
  /** Enter / click on a row (preferred over onRowClick/expand for new code) */
  onActivate?: (row: T) => void;
  selectedKey?: string | null;
  /** persist hidden columns under LS_COLUMNS + columnsKey */
  columnsKey?: string;
  toolbar?: { columns?: boolean; exportName?: string; onReset?: () => void; extra?: HTMLElement };
  /** HTML for per-row action buttons (each with data-action="..."); clicks go to onRowAction */
  rowActions?: (row: T) => string;
  onRowAction?: (action: string, row: T) => void;
  /** 'auto' = cards below UI.mobileBp */
  layout?: 'auto' | 'table' | 'cards';
}

export interface KitTableHandle<T> extends BaseHandle<T> {
  setSort(s: SortState): void;
  getHiddenColumns(): string[];
  setHiddenColumns(keys: string[]): void;
  /** CSV of the current filtered+sorted rows (all of them, not just rendered) */
  toCsv(): string;
  setSelected(key: string | null): void;
  scrollToKey(key: string): void;
}

export interface DetailPanel {
  el: HTMLElement;
  /** show content (HTML string or element) with a title; docks at >= UI.dockBp, overlays below */
  open(title: string, body: string | HTMLElement): void;
  close(): void;
  isOpen(): boolean;
  onClose(fn: () => void): () => void;
  destroy(): void;
}

export interface Drawer {
  el: HTMLElement;
  open(): void;
  close(): void;
  destroy(): void;
}

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run(): void;
}

/** A provider returns matches for the query (sync), most relevant first. */
export type PaletteProvider = (query: string) => PaletteItem[];

export type HotkeyMap = Record<string, (ev: KeyboardEvent) => void>;

/** Query-state schema: key -> kind + default. URL query wins over localStorage on mount. */
export type QueryField =
  | { kind: 'string'; def: string }
  | { kind: 'number'; def: number | null }
  | { kind: 'bool'; def: boolean }
  | { kind: 'enum'; def: string; values: readonly string[] }
  | { kind: 'sort'; def: SortState };

export type QuerySchema = Record<string, QueryField>;

export interface QueryState<V> {
  get(): V;
  set(patch: Partial<V>): void;
  /** re-read from a new route (view.update) */
  fromRoute(r: Route): void;
  reset(): void;
  /** number of fields differing from defaults (for the "Filters (n)" badge) */
  activeCount(): number;
  onChange(fn: (v: V) => void): () => void;
}

export type FilterSpec =
  | { kind: 'search'; key: string; label: () => string; placeholder?: () => string }
  | { kind: 'number'; key: string; label: () => string; help?: () => string; suffix?: string }
  | { kind: 'segment'; key: string; label: () => string; options: { value: string; label: () => string }[] }
  | { kind: 'toggle'; key: string; label: () => string };

export interface FilterBar {
  el: HTMLElement;
  /** re-apply labels (language change) and values */
  refresh(): void;
  destroy(): void;
}

export type ToastFn = (msg: string, kind?: ToastKind) => void;
