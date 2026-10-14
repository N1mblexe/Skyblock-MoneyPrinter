// Alert rule evaluation (pure). Owner: history package.
import type { AlertEvent, AlertMetric, AlertRule, CalcCtx } from '../types/contracts.ts';

/** Current value of a metric for an item, or null when it can't be computed. Wave 0 stub. */
export function metricValue(_metric: AlertMetric, _id: string, _ctx: CalcCtx): number | null {
  return null;
}

/**
 * Evaluate enabled rules against the current market. Returns fired events and the rules with
 * lastFiredAt updated (cooldown respected). Wave 0 stub.
 */
export function evaluateAlerts(rules: readonly AlertRule[], _ctx: CalcCtx, _now: number): { fired: AlertEvent[]; rules: AlertRule[] } {
  return { fired: [], rules: [...rules] };
}
