import { describe, expect, it } from 'vitest';
import { bookUnits, walkBook } from '../../src/domain/book.ts';
import { P } from './helpers.ts';

describe('walkBook', () => {
  const asks = P('ENCHANTED_MELON').asks; // 324.7x294, 324.8x238, 325x45917, ...

  it('fills within the top level', () => {
    expect(walkBook(asks, 100)).toEqual({ avgPrice: 324.7, filled: 100, worstPrice: 324.7 });
  });

  it('computes VWAP across levels', () => {
    const w = walkBook(asks, 500)!;
    expect(w.filled).toBe(500);
    expect(w.avgPrice).toBeCloseTo((294 * 324.7 + 206 * 324.8) / 500, 9);
    expect(w.worstPrice).toBe(324.8);
  });

  it('stops when depth runs out', () => {
    const total = bookUnits(asks);
    const w = walkBook(asks, total * 2)!;
    expect(w.filled).toBe(total);
    expect(w.worstPrice).toBe(asks.at(-1)!.price);
  });

  it('returns null for empty book / non-positive qty / zero-amount levels', () => {
    expect(walkBook([], 10)).toBeNull();
    expect(walkBook(asks, 0)).toBeNull();
    expect(walkBook(asks, -1)).toBeNull();
    expect(walkBook([{ price: 1, amount: 0, orders: 1 }], 5)).toBeNull();
  });

  it('skips empty levels', () => {
    const w = walkBook(
      [
        { price: 1, amount: 0, orders: 0 },
        { price: 2, amount: 3, orders: 1 },
      ],
      2,
    )!;
    expect(w).toEqual({ avgPrice: 2, filled: 2, worstPrice: 2 });
  });
});
