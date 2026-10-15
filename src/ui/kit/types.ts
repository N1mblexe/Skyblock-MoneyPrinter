// UI kit API (frozen in Wave 0, implemented by the kit package in Wave 1).
// Views import implementations from './index.ts' once it exists; these types are the contract.
import type { Route, ToastKind } from '../../types/contracts.ts';
import type { Column as BaseColumn, SortState, TableHandle as BaseHandle, TableOptions as BaseOptions } from '../table.ts';

export type { SortState };

export interface KitColumn<T> extends BaseColumn<T> {
  /** CSV cell value; defaults to get(row). `false` leaves the column out of the export (e.g. action buttons). */
  csv?: ((row: T) => string | number | null) | false;
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
  /** Download toCsv() as `${toolbar.exportName ?? 'export'}-YYYYMMDD-HHmm.csv` (the toolbar button calls this). */
  exportCsv(): void;
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
  /** content container: append your form/controls here */
  body: HTMLElement;
  isOpen(): boolean;
  /** re-apply the title (e.g. after a language change) */
  setTitle(title: string): void;
}

export interface DrawerOptions {
  /** heading text; a function is re-read on every open() */
  title: string | (() => string);
  /** slide-in edge (default 'right'); 'bottom' = mobile sheet */
  side?: 'left' | 'right' | 'bottom';
  onClose?: () => void;
}

export interface DetailPanelOptions {
  /** where focus goes on close when the opener is gone (e.g. a re-rendered table row) */
  returnFocus?: () => HTMLElement | null;
}

export interface PaletteOptions {
  providers: PaletteProvider[];
  placeholder?: string;
  onClose?: () => void;
  /** prefill the input */
  query?: string;
  /** max results across all providers (default 50) */
  limit?: number;
}

export interface PaletteHandle {
  el: HTMLElement;
  close(): void;
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
  | { kind: 'number'; def: number | null; min?: number; max?: number }
  | { kind: 'bool'; def: boolean }
  | { kind: 'enum'; def: string; values: readonly string[] }
  | { kind: 'sort'; def: SortState; keys?: readonly string[] };

export type QuerySchema = Record<string, QueryField>;

/** Value type of one schema field. */
export type QueryValue<F extends QueryField> = F extends { kind: 'string' }
  ? string
  : F extends { kind: 'number' }
    ? number | null
    : F extends { kind: 'bool' }
      ? boolean
      : F extends { kind: 'enum' }
        ? string
        : SortState;

/** Values object for a schema, e.g. {q: string; minVol: number | null; sort: SortState}. */
export type QueryValues<S extends QuerySchema> = { [K in keyof S]: QueryValue<S[K]> };

/** Patch the URL query (ViewContext.setQuery); undefined removes a key. */
export type SetQueryFn = (patch: Record<string, string | undefined>) => void;

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
