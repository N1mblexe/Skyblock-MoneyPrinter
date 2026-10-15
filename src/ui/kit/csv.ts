// RFC 4180 CSV export: CRLF line breaks, fields quoted when they contain , " CR or LF, quotes doubled.
// Numbers are locale independent ('.' decimals, no grouping) so spreadsheets in any locale can parse them.

/** A column as the CSV writer sees it (KitColumn is compatible). */
export interface CsvColumn<T> {
  label: () => string;
  get: (row: T) => number | string | null;
  csv?: ((row: T) => string | number | null) | false;
}

/** Number -> plain '.'-decimal text (max 6 decimals, no exponent for normal magnitudes); non-finite -> ''. */
export function csvNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  const r = Math.round(n * 1e6) / 1e6;
  return Math.abs(r) < 1e-6 ? '0' : String(r);
}

/** Leading = + - @ (tab, CR) in a text cell can run as a spreadsheet formula; prefix with ' unless it is a number. */
function guardFormula(s: string): string {
  if (!/^[=+\-@\t\r]/.test(s)) return s;
  if (/^[+-]?\d/.test(s) && Number.isFinite(Number(s))) return s;
  return `'${s}`;
}

/** One RFC 4180 field. null/undefined/NaN -> empty field. */
export function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = typeof v === 'number' ? csvNumber(v) : guardFormula(String(v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text: header row of column labels, then one line per row (column.csv ?? column.get). */
export function toCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const cols = columns.filter((c) => c.csv !== false);
  const lines = [cols.map((c) => csvCell(c.label())).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(c.csv ? c.csv(r) : c.get(r))).join(','));
  return lines.join('\r\n') + '\r\n';
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** `${name}-YYYYMMDD-HHmm.csv` in local time. */
export function csvFileName(name: string, d: Date = new Date()): string {
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  return `${name}-${stamp}.csv`;
}

/** Trigger a browser download of CSV text (UTF-8 with BOM so Excel reads Turkish characters). Returns the file name. */
export function downloadCsv(name: string, csv: string, now: Date = new Date()): string {
  const file = csvFileName(name, now);
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return file;
}
