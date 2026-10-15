/**
 * UI kit for the trading-terminal views. Import everything from here: `import { createKitTable, … } from '../../kit/index.ts'`.
 * Styles live in src/styles/components.css (theme tokens only); see the reference comment at its top.
 *
 * ## Typical view
 * ```ts
 * const SCHEMA = {
 *   q: { kind: 'string', def: '' },
 *   minVol: { kind: 'number', def: null, min: 0 },
 *   risk: { kind: 'enum', def: 'all', values: ['all', 'ok'] },
 *   verified: { kind: 'bool', def: true },
 *   sort: { kind: 'sort', def: { key: 'pph', dir: 'desc' } },
 * } as const satisfies QuerySchema;
 *
 * mount(root, ctx, route) {
 *   const qs = bindQueryState(SCHEMA, route, ctx.setQuery, LS_VIEWPREFS + 'flip'); // URL beats localStorage
 *   const bar = createFilterBar([
 *     { kind: 'search', key: 'q', label: () => t('common.search') },
 *     { kind: 'number', key: 'minVol', label: () => t('flip.minVol') },
 *     { kind: 'segment', key: 'risk', label: () => t('flip.risk'), options: [{ value: 'all', label: () => '…' }, …] },
 *     { kind: 'toggle', key: 'verified', label: () => t('common.verified') },
 *   ], qs);
 *   const panel = createDetailPanel({ returnFocus: () => table.el.querySelector('[tabindex="0"]') });
 *   const table = createKitTable<FlipRow>({
 *     columns,                      // KitColumn: priority 0 = card title, 1–2 shown on cards, 3 hidden on cards
 *     rowKey: (r) => r.id,
 *     sort: qs.get().sort,
 *     onSortChange: (sort) => qs.set({ sort }),
 *     onActivate: (r) => { table.setSelected(r.id); panel.open(r.name, detailHtml(r)); },
 *     columnsKey: 'flip',           // hidden columns persist at LS_COLUMNS + 'flip'
 *     toolbar: { columns: true, exportName: 'flips', onReset: () => qs.reset() },
 *     rowActions: (r) => `<button type="button" class="btn btn-ghost btn-sm" data-action="watch">★</button>`,
 *     onRowAction: (action, r) => action === 'watch' && ctx.watch.toggle(r.id),
 *   });
 *   panel.onClose(() => table.setSelected(null));
 *   qs.onChange(() => render());           // filter rows from qs.get(), then table.setRows(rows)
 *   root.classList.add('kit-split');       // panel docks as a 2nd grid column at >= UI.dockBp
 *   root.append(bar.el, table.el, panel.el);
 * }
 * update(route) { qs.fromRoute(route); }
 * // on language change: bar.refresh(); table.refresh();   unmount: destroy() everything
 * ```
 *
 * ## Rules
 * - Tables: use `createKitTable` (not the legacy `createTable`). Column `html` must escape its own output (`esc`).
 *   Rows virtualize above UI.virtualizeAbove unless `expand` is set; virtual rows have a fixed height
 *   (--row-h), so keep cells single-line (an `.id-sub` line fits). Only one row is tabbable (roving tabindex):
 *   ArrowUp/Down or j/k move, Home/End jump, Enter = onActivate, Space toggles `expand`.
 *   Below UI.mobileBp (`layout: 'auto'`) rows render as cards with "show more" paging.
 *   In a fixed-height grid area add `table.el.classList.add('tbl-fill')` so the table scrolls inside its row;
 *   otherwise the wrap scrolls at `max-height: var(--tbl-max-h)` (72vh).
 * - Row action buttons need `data-action="…"`; their clicks never activate the row.
 * - CSV: `column.csv` overrides `get` for export; `csv: false` drops the column. Only visible columns export.
 * - `toast(msg, kind)` is what `ctx.toast` calls; prefer ctx.toast in views.
 * - Global shortcuts are the shell's job (`registerHotkeys(map)`); views register only view-local keys and
 *   must call the returned unregister on unmount.
 * - Strings: everything user-visible goes through t(); kit strings live in 'common' and 'kit' namespaces.
 */

export type * from './types.ts';
export { createKitTable, cssRowHeight } from './table.ts';
export { sortRows, isNullish } from './sort.ts';
export { toCsv, csvCell, csvNumber, csvFileName, downloadCsv } from './csv.ts';
export { downloadBlob, downloadJson } from './download.ts';
export { createDetailPanel } from './panel.ts';
export { createDrawer } from './drawer.ts';
export { openPalette, collectPalette, currentPalette, PALETTE_LIMIT } from './palette.ts';
export { toast, clearToasts, TOAST_MS, TOAST_MAX } from './toast.ts';
export { registerHotkeys, parseHotkey, hotkeyLabel, SEQ_TIMEOUT_MS } from './hotkeys.ts';
export { bindQueryState, encodeField, decodeField } from './queryState.ts';
export { createFilterBar, parseNumberInput, FILTER_DEBOUNCE_MS } from './filterBar.ts';
export { debounce, trapTab, focusables, isTypingTarget } from './util.ts';
