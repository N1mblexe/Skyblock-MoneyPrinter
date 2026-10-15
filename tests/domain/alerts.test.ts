import { describe, expect, it } from 'vitest';
import { evaluateAlerts, flipPlanFor, metricValue } from '../../src/domain/alerts.ts';
import { computeFlips } from '../../src/domain/flip.ts';
import type { AlertRule, CalcCtx, Product } from '../../src/types/contracts.ts';
import { ctx, makeProduct, snap } from './helpers.ts';

const NOW = Date.UTC(2026, 9, 1);
const MIN = 60_000;

/** ctx over a synthetic snapshot (catalog from the fixture). */
function synth(products: Record<string, Product>, over: Parameters<typeof ctx>[0] = {}): CalcCtx {
  return ctx(over, { snap: { ...snap, products } });
}

const rule = (o: Partial<AlertRule> = {}): AlertRule => ({
  key: 'r1',
  id: 'X',
  metric: 'ask',
  op: 'lt',
  value: 200,
  enabled: true,
  cooldownMin: 15,
  ...o,
});

describe('metricValue', () => {
  const c = synth({
    X: makeProduct({ id: 'X' }), // bid 100, ask 105
    ONE: makeProduct({ id: 'ONE', bids: [], bid: null }),
    ZERO: makeProduct({ id: 'ZERO', bid: 0 }),
    LOSS: makeProduct({
      id: 'LOSS',
      bids: [{ price: 100, amount: 5000, orders: 10 }],
      asks: [{ price: 100.5, amount: 5000, orders: 10 }],
    }),
  });

  it('ask, bid, spreadPct from the top of book', () => {
    expect(metricValue('ask', 'X', c)).toBe(105);
    expect(metricValue('bid', 'X', c)).toBe(100);
    expect(metricValue('spreadPct', 'X', c)).toBeCloseTo(0.05, 12);
    expect(metricValue('bid', 'ONE', c)).toBeNull();
    expect(metricValue('ask', 'ONE', c)).toBe(105);
    expect(metricValue('spreadPct', 'ONE', c)).toBeNull();
    expect(metricValue('spreadPct', 'ZERO', c)).toBeNull();
    expect(metricValue('ask', 'MISSING', c)).toBeNull();
    expect(metricValue('flipProfit', 'MISSING', c)).toBeNull();
  });

  it('flipProfit / flipMargin: order -> offer pricing after tax', () => {
    const profit = 104.9 * (1 - 0.0125) - 100.1;
    expect(metricValue('flipProfit', 'X', c)).toBeCloseTo(profit, 9);
    expect(metricValue('flipMargin', 'X', c)).toBeCloseTo(profit / 100.1, 9);
    // unprofitable flips still report (negative) values so "lt" rules can fire
    expect(metricValue('flipProfit', 'LOSS', c)!).toBeLessThan(0);
    expect(metricValue('flipMargin', 'LOSS', c)!).toBeLessThan(0);
    expect(metricValue('flipProfit', 'ONE', c)).toBeNull(); // no bid -> no order price
    expect(flipPlanFor('MISSING', c)).toBeNull();
  });

  it('matches computeFlips on every fixture flip, in every cost/sell mode', () => {
    let checked = 0;
    for (const over of [{}, { costMode: 'insta' as const }, { sellMode: 'insta' as const }, { costMode: 'insta' as const, sellMode: 'insta' as const }]) {
      const cx = ctx(over);
      for (const r of computeFlips(cx)) {
        checked++;
        expect(metricValue('flipProfit', r.id, cx)).toBeCloseTo(r.profit, 9);
        expect(metricValue('flipMargin', r.id, cx)).toBeCloseTo(r.margin, 9);
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('flipMargin is null when the buy price is not positive', () => {
    const free = synth(
      { F: makeProduct({ id: 'F', bids: [{ price: -5, amount: 10, orders: 1 }] }) },
      { costMode: 'order' },
    );
    expect(metricValue('flipMargin', 'F', free)).toBeNull();
  });
});

describe('evaluateAlerts', () => {
  const c = synth({ X: makeProduct({ id: 'X' }), Y: makeProduct({ id: 'Y', asks: [{ price: 300, amount: 10, orders: 1 }] }) });

  it('fires lt/gt rules whose condition holds, keeping other rule objects', () => {
    const rules = [
      rule({ key: 'a', op: 'lt', value: 106 }), // 105 < 106 -> fires
      rule({ key: 'b', op: 'lt', value: 105 }), // strict
      rule({ key: 'c', op: 'gt', value: 104 }), // fires
      rule({ key: 'd', op: 'gt', value: 105 }),
      rule({ key: 'e', id: 'Y', op: 'gt', value: 250 }), // fires
      rule({ key: 'f', enabled: false, value: 1e9 }),
      rule({ key: 'g', id: 'MISSING', value: 1e9 }),
    ];
    const res = evaluateAlerts(rules, c, NOW);
    expect(res.fired).toEqual([
      { ruleKey: 'a', id: 'X', metric: 'ask', value: 105, at: NOW },
      { ruleKey: 'c', id: 'X', metric: 'ask', value: 105, at: NOW },
      { ruleKey: 'e', id: 'Y', metric: 'ask', value: 300, at: NOW },
    ]);
    expect(res.rules).not.toBe(rules);
    expect(res.rules.length).toBe(rules.length);
    for (const [i, r] of res.rules.entries()) {
      if (['a', 'c', 'e'].includes(r.key)) {
        expect(r).not.toBe(rules[i]);
        expect(r).toEqual({ ...rules[i], lastFiredAt: NOW });
      } else expect(r).toBe(rules[i]);
    }
    expect(rules[0]!.lastFiredAt).toBeUndefined(); // input not mutated
  });

  it('respects the cooldown', () => {
    const r = rule({ value: 1e9, cooldownMin: 15 });
    expect(evaluateAlerts([{ ...r, lastFiredAt: NOW - 14 * MIN }], c, NOW).fired).toEqual([]);
    expect(evaluateAlerts([{ ...r, lastFiredAt: NOW - 15 * MIN }], c, NOW).fired.length).toBe(1);
    expect(evaluateAlerts([{ ...r, cooldownMin: 0, lastFiredAt: NOW }], c, NOW).fired.length).toBe(1);
    // a firing run followed by an immediate re-run: suppressed
    const first = evaluateAlerts([r], c, NOW);
    expect(first.fired.length).toBe(1);
    expect(evaluateAlerts(first.rules, c, NOW + MIN).fired).toEqual([]);
    expect(evaluateAlerts(first.rules, c, NOW + 15 * MIN).fired.length).toBe(1);
  });

  it('evaluates other metrics, sharing values between rules', () => {
    const res = evaluateAlerts(
      [
        rule({ key: 'm1', metric: 'flipMargin', op: 'gt', value: 0.01 }),
        rule({ key: 'm2', metric: 'flipMargin', op: 'lt', value: 0.01 }),
        rule({ key: 's', metric: 'spreadPct', op: 'gt', value: 0.04 }),
        rule({ key: 'b', metric: 'bid', op: 'lt', value: 100 }),
      ],
      c,
      NOW,
    );
    expect(res.fired.map((e) => e.ruleKey)).toEqual(['m1', 's']);
    expect(evaluateAlerts([], c, NOW)).toEqual({ fired: [], rules: [] });
  });
});
