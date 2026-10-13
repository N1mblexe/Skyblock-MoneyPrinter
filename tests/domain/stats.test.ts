import { describe, expect, it } from 'vitest';
import { mad, median, pctChange, robustZ } from '../../src/domain/stats.ts';

describe('stats helpers', () => {
  it('median / mad', () => {
    expect(median([])).toBeNaN();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    expect(mad([2, 2, 2])).toBe(0);
  });

  it('robustZ', () => {
    expect(robustZ(5, 2, 0)).toBeNaN();
    expect(robustZ(5, 2, Infinity)).toBeNaN();
    expect(robustZ(3, 2, 0.6745)).toBeCloseTo(1, 12);
  });

  it('pctChange', () => {
    expect(pctChange(100, 110)).toBeCloseTo(0.1);
    expect(pctChange(0, 1)).toBeNull();
    expect(pctChange(1, NaN)).toBeNull();
  });
});
