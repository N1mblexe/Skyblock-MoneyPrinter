// Row sorting shared by the kit table and the legacy createTable wrapper.
import { locale } from '../format.ts';
import type { SortDir } from '../table.ts';

type SortVal = number | string | null;

/** true for null/undefined/NaN (these sort last in both directions). */
export function isNullish(v: SortVal | undefined): boolean {
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
