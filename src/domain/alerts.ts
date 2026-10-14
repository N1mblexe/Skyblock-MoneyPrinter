// Alert rule evaluation (pure). Owner: history package.
import type { AlertEvent, AlertMetric, AlertRule, CalcCtx } from '../types/contracts.ts';
import { afterTax, buySide, planTrade, sellSide, type Leg, type TradePlan } from './pricing.ts';

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * The flip for one product, priced exactly like computeFlips (same legs, same planTrade), but without its
 * profit > 0 filter, so falling margins can trigger "lt" alerts. null when a side can't be quoted.
 */
export function flipPlanFor(id: string, ctx: CalcCtx): TradePlan | null {
  const p = ctx.snap.products[id];
  if (!p) return null;
  const { costMode, sellMode, share, taxRate } = ctx.settings;
  const npcSell = ctx.catalog.items[id]?.npcSell;
  const buy = (q: number): Leg | null => {
    const s = buySide(p, costMode, share, q, npcSell);
    return s && { price: s.quote.price, net: s.quote.price, rate: s.rate, depth: s.depth, comp: s.comp };
  };
  const sell = (q: number): Leg | null => {
    const s = sellSide(p, sellMode, share, q);
    return s && { price: s.quote.price, net: afterTax(s.quote.price, taxRate), rate: s.rate, depth: s.depth, comp: s.comp };
  };
  return planTrade(buy, sell, ctx.settings, costMode === 'insta' || sellMode === 'insta');
}

/**
 * Current value of a metric for an item, or null when it can't be computed.
 *  ask / bid: top of book; spreadPct: (ask - bid) / bid;
 *  flipProfit / flipMargin: per-unit profit and profit / buy price of the item's flip (current settings).
 */
export function metricValue(metric: AlertMetric, id: string, ctx: CalcCtx): number | null {
  const p = ctx.snap.products[id];
  if (!p) return null;
  switch (metric) {
    case 'ask':
      return fin(p.ask) ? p.ask : null;
    case 'bid':
      return fin(p.bid) ? p.bid : null;
    case 'spreadPct':
      return fin(p.ask) && fin(p.bid) && p.bid > 0 ? (p.ask - p.bid) / p.bid : null;
    case 'flipProfit':
    case 'flipMargin': {
      const plan = flipPlanFor(id, ctx);
      if (!plan || !fin(plan.profit)) return null;
      if (metric === 'flipProfit') return plan.profit;
      return plan.buy.price > 0 ? plan.profit / plan.buy.price : null;
    }
  }
}

/**
 * Evaluate enabled rules against the current market. A rule fires when its metric is known, the comparison
 * (lt: value < threshold, gt: value > threshold) holds and it is off cooldown (now - lastFiredAt >=
 * cooldownMin minutes). Returns the fired events (rule order) and a new rules array where fired rules are
 * replaced by copies with lastFiredAt = now; all other rule objects are kept by identity.
 */
export function evaluateAlerts(rules: readonly AlertRule[], ctx: CalcCtx, now: number): { fired: AlertEvent[]; rules: AlertRule[] } {
  const fired: AlertEvent[] = [];
  const values = new Map<string, number | null>();
  const valueOf = (metric: AlertMetric, id: string) => {
    const k = `${metric}\u0000${id}`;
    if (!values.has(k)) values.set(k, metricValue(metric, id, ctx));
    return values.get(k)!;
  };
  const out = rules.map((r) => {
    if (!r.enabled) return r;
    if (r.lastFiredAt != null && now - r.lastFiredAt < r.cooldownMin * 60_000) return r;
    const v = valueOf(r.metric, r.id);
    if (v == null) return r;
    const hit = r.op === 'lt' ? v < r.value : v > r.value;
    if (!hit) return r;
    fired.push({ ruleKey: r.key, id: r.id, metric: r.metric, value: v, at: now });
    return { ...r, lastFiredAt: now };
  });
  return { fired, rules: out };
}
