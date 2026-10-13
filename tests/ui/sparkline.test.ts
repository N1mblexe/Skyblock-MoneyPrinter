import { describe, expect, it } from 'vitest';
import { sparklineSvg } from '../../src/ui/sparkline.ts';

describe('sparklineSvg', () => {
  it('draws a polyline with currentColor and default size', () => {
    const s = sparklineSvg([1, 3, 2, 5]);
    expect(s).toMatch(/^<svg class="spark" width="80" height="20" viewBox="0 0 80 20"/);
    expect(s).toContain('stroke="currentColor"');
    const pts = /points="([^"]+)"/.exec(s)![1]!.split(' ').map((p) => p.split(',').map(Number));
    expect(pts).toHaveLength(4);
    expect(pts[0]![0]).toBe(2);
    expect(pts[3]![0]).toBe(78);
    // max value at top (y = pad), min at bottom (y = h - pad)
    expect(pts[3]![1]).toBe(2);
    expect(pts[0]![1]).toBe(18);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(80);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(20);
    }
  });
  it('handles flat series and custom size/class', () => {
    const s = sparklineSvg([5, 5, 5], { w: 40, h: 10, cls: 'pos' });
    expect(s).toContain('class="spark pos"');
    expect(s).toContain('width="40" height="10"');
    expect(s).toContain('points="2,5 20,5 38,5"');
  });
  it('skips non-finite values', () => {
    const s = sparklineSvg([1, NaN, Infinity, 2]);
    expect(/points="([^"]+)"/.exec(s)![1]!.split(' ')).toHaveLength(2);
  });
  it('returns an empty placeholder for < 2 finite values', () => {
    for (const v of [[], [1], [NaN, 1, Infinity]]) {
      const s = sparklineSvg(v);
      expect(s).toContain('spark-empty');
      expect(s).toContain('width="80" height="20"');
      expect(s).not.toContain('polyline');
    }
  });
});
