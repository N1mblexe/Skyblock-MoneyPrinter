// Alert texts shared by the watchlist and the overview: log lines and metric value formatting.
import { t } from '../../../i18n/index.ts';
import { alertMessage, fmtMetric } from '../../../state/alertsRunner.ts';
import { ALERT_METRICS, RATIO_METRICS } from '../../../domain/alertMetrics.ts';
import type { AlertEvent, AlertMetric, AlertRule } from '../../../types/contracts.ts';

export const METRICS = ALERT_METRICS;

/** Ratio metrics are edited in percent and stored as ratios. */
export const isRatio = (m: AlertMetric): boolean => RATIO_METRICS.has(m);

/** One-line message for a logged alert event. Uses the rule's op/threshold when the rule still exists. */
export function logMessage(e: AlertEvent, rules: readonly AlertRule[], name: string): string {
  const r = rules.find((x) => x.key === e.ruleKey);
  if (r) return alertMessage(e, r.value, r.op, name).body;
  return t('watch.logNoRule', { name, metric: t(`alerts.m_${e.metric}`), value: fmtMetric(e.metric, e.value) });
}

/** Rule as a short sentence: "ask < 1,200". */
export function ruleText(r: AlertRule): string {
  return t('alerts.rule', { metric: t(`alerts.m_${r.metric}`), op: t(`alerts.op_${r.op}`), value: fmtMetric(r.metric, r.value) });
}

/** Local date-time for a log entry ("14.10 13:05" style, by the UI locale). */
export function fmtTime(ms: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
  }
}
