// The item alert metrics, in one place (storage parsing, rule editors, the item page form, alert texts).
import type { AlertMetric } from '../types/contracts.ts';

export const ALERT_METRICS: readonly AlertMetric[] = ['ask', 'bid', 'spreadPct', 'flipMargin', 'flipProfit'];

/** Metrics stored as ratios (0.05) and edited / shown as percent (5 %). */
export const RATIO_METRICS: ReadonlySet<AlertMetric> = new Set(['spreadPct', 'flipMargin']);

export const isAlertMetric = (x: unknown): x is AlertMetric => (ALERT_METRICS as readonly unknown[]).includes(x);
