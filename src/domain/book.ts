import type { OrderLevel } from '../types/contracts.ts';

export interface BookWalk {
  /** volume-weighted average price of the filled units */
  avgPrice: number;
  /** units filled (<= qty; less when book depth runs out) */
  filled: number;
  /** price of the last level touched */
  worstPrice: number;
}

/** Walk `levels` (already ordered best-first) filling up to qty units. null if levels is empty or qty <= 0. */
export function walkBook(levels: readonly OrderLevel[], qty: number): BookWalk | null {
  if (levels.length === 0 || !(qty > 0)) return null;
  let left = qty;
  let filled = 0;
  let cost = 0;
  let worstPrice = levels[0]!.price;
  for (const l of levels) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, l.amount));
    if (take <= 0) continue;
    filled += take;
    cost += take * l.price;
    left -= take;
    worstPrice = l.price;
  }
  if (filled <= 0) return null;
  return { avgPrice: cost / filled, filled, worstPrice };
}

/** Total units resting on the given levels. */
export function bookUnits(levels: readonly OrderLevel[]): number {
  let s = 0;
  for (const l of levels) s += Math.max(0, l.amount);
  return s;
}
