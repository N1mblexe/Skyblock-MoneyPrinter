import { describe, expect, it } from 'vitest';
import { computeFusion } from '../../src/domain/fusion.ts';
import { ctx } from './helpers.ts';

describe('computeFusion', () => {
  it('prices a recipe by id and by display name', () => {
    const [r] = computeFusion(ctx(), [{ a: 'SHARD_SALMON', qa: 2, b: 'Wiki Tiki Shard', qb: 1, out: 'shard_beeheemoth', qo: 1 }]);
    const cost = 2 * 1440.3 + 16247;
    const value = 94782.2 * 0.9875;
    expect(r!.missing).toEqual([]);
    expect(r!.cost).toBeCloseTo(cost, 6);
    expect(r!.value).toBeCloseTo(value, 6);
    expect(r!.profit).toBeCloseTo(value - cost, 6);
    expect(r!.margin).toBeCloseTo((value - cost) / cost, 9);
  });

  it('missing input -> cost/profit/margin null, listed in missing', () => {
    const [r] = computeFusion(ctx(), [{ a: 'NOT_A_THING', qa: 1, b: 'SHARD_SALMON', qb: 1, out: 'SHARD_BEEHEEMOTH', qo: 1 }]);
    expect(r!.missing).toEqual(['NOT_A_THING']);
    expect(r!.cost).toBeNull();
    expect(r!.value).not.toBeNull();
    expect(r!.profit).toBeNull();
    expect(r!.margin).toBeNull();
  });

  it('unpriced output (empty book) -> value null', () => {
    const [r] = computeFusion(ctx(), [{ a: 'SHARD_SALMON', qa: 1, b: 'SHARD_SALMON', qb: 1, out: 'ENCHANTMENT_LIFE_STEAL_2', qo: 1 }]);
    expect(r!.missing).toEqual(['ENCHANTMENT_LIFE_STEAL_2']);
    expect(r!.value).toBeNull();
    expect(r!.margin).toBeNull();
  });

  it('zero cost -> margin null (never Infinity/NaN)', () => {
    const rows = computeFusion(ctx(), [
      { a: 'SHARD_SALMON', qa: 0, b: 'SHARD_SALMON', qb: 0, out: 'SHARD_BEEHEEMOTH', qo: 1 },
      { a: 'SHARD_SALMON', qa: NaN, b: '', qb: 1, out: 'SHARD_BEEHEEMOTH', qo: 1 },
    ]);
    expect(rows[0]!.cost).toBe(0);
    expect(rows[0]!.margin).toBeNull();
    expect(rows[0]!.profit).toBeGreaterThan(0);
    expect(rows[1]!.missing).toEqual(['']);
    expect(rows[1]!.margin).toBeNull();
  });

  it('respects insta modes and keeps order', () => {
    const rows = computeFusion(ctx({ costMode: 'insta', sellMode: 'insta' }), [
      { a: 'SHARD_SALMON', qa: 1, b: 'SHARD_SALMON', qb: 1, out: 'SHARD_WIKI_TIKI', qo: 1 },
      { a: 'SHARD_WIKI_TIKI', qa: 1, b: 'SHARD_WIKI_TIKI', qb: 1, out: 'SHARD_SALMON', qo: 1 },
    ]);
    expect(rows[0]!.cost).toBeCloseTo(2 * 2952, 6);
    expect(rows[0]!.value).toBeCloseTo(16246.9 * 0.9875, 6);
    expect(rows[1]!.recipe.out).toBe('SHARD_SALMON');
    expect(computeFusion(ctx(), [])).toEqual([]);
  });
});
