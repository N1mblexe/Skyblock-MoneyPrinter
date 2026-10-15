// Runs alert rules on every new snapshot; fires notifications/toasts. Owner: history package.
import { evaluateOppAlerts, oppCandidates, type OppCandidate } from '../domain/oppAlerts.ts';
import { RATIO_METRICS } from '../domain/alertMetrics.ts';
import { ALERTS } from '../config.ts';
import { evaluateAlerts } from '../domain/alerts.ts';
import { t } from '../i18n/index.ts';
import type { AlertEvent, AlertMetric, AppState, CalcCtx, Derived, OppAlertRule, Store, ToastKind } from '../types/contracts.ts';
import { fmtCoins, fmtPct } from '../ui/format.ts';

export interface AlertsRunnerOptions {
  store: Store<AppState>;
  derived: Derived;
  toast(msg: string, kind?: ToastKind): void;
  /** browser notification (only called when settings.notify and permission is granted) */
  notify(title: string, body: string): void;
  /** clock (tests) */
  now?: () => number;
}


/** Value formatted for its metric: ratios as percent, prices/profits as coins. */
export function fmtMetric(metric: AlertMetric, v: number): string {
  return RATIO_METRICS.has(metric) ? fmtPct(v) : fmtCoins(v);
}

/** Localized one-line message and notification title for a fired alert. */
export function alertMessage(e: AlertEvent, threshold: number, op: 'lt' | 'gt', name: string): { title: string; body: string } {
  return {
    title: t('alerts.title', { name }),
    body: t('alerts.fired', {
      name,
      metric: t(`alerts.m_${e.metric}`),
      value: fmtMetric(e.metric, e.value),
      op: t(`alerts.op_${op}`),
      threshold: fmtMetric(e.metric, threshold),
    }),
  };
}

/**
 * Evaluates alert rules once per new snapshot (by lastUpdated). Snapshots restored from cache are skipped (old
 * prices), as is the snapshot present at start. A snapshot that arrives before the catalog is evaluated as soon as
 * derived.calcCtx() is available. Fired events are prepended to alertLog (capped at ALERTS.logMax), the rules'
 * lastFiredAt is stored, and each event is toasted (and notified when settings.notify). Returns an unsubscribe.
 */
/** Text for newly met market-alert rows: "3 new opportunities above 1,000,000 profit/hour: A, B, C". */
export function oppAlertMessage(r: OppAlertRule, fresh: readonly OppCandidate[]): { title: string; body: string } {
  const value = r.metric === 'margin' ? fmtPct(r.value) : fmtCoins(r.value);
  const names = fresh
    .slice(0, 3)
    .map((c) => `${c.name} (${r.metric === 'margin' ? fmtPct(c.margin) : fmtCoins(c[r.metric])})`)
    .join(', ');
  const more = fresh.length > 3 ? ` ${t('alerts.oppMore', { n: fresh.length - 3 })}` : '';
  return {
    title: t('alerts.oppTitle'),
    body: t('alerts.oppFired', { n: fresh.length, metric: t(`alerts.om_${r.metric}`), value, names: names + more }),
  };
}

export function startAlerts(opts: AlertsRunnerOptions): () => void {
  const { store, derived } = opts;
  let done: number | null = store.get().snapshot?.lastUpdated ?? null;

  const clock = opts.now ?? Date.now;

  function run(ctx: CalcCtx, rules: AppState['alerts']): void {
    if (!rules.some((r) => r.enabled)) return;
    const now = clock();
    const res = evaluateAlerts(rules, ctx, now);
    if (!res.fired.length) return;
    const firedKeys = new Set(res.fired.map((e) => e.ruleKey));
    // each event is prepended in turn, so the log stays newest-first
    const newest = [...res.fired].reverse();
    store.set((cur) => ({
      alerts: cur.alerts.map((r) => (firedKeys.has(r.key) ? { ...r, lastFiredAt: now } : r)),
      alertLog: [...newest, ...cur.alertLog].slice(0, ALERTS.logMax),
    }));
    const byKey = new Map(rules.map((r) => [r.key, r]));
    const notify = store.get().settings.notify;
    for (const e of res.fired) {
      const r = byKey.get(e.ruleKey)!;
      const m = alertMessage(e, r.value, r.op, ctx.catalog.name(e.id));
      opts.toast(m.body, 'warn');
      if (notify) opts.notify(m.title, m.body);
    }
  }

  /** Market alerts: rows of every page that newly meet a rule; one grouped toast / notification per rule. */
  function runOpp(rules: AppState['oppAlerts']): void {
    if (!rules.some((r) => r.enabled)) return;
    const cands = oppCandidates({ flips: derived.flips(), crafts: derived.crafts(), chains: derived.chains(), books: derived.books(), npc: derived.npc() });
    const res = evaluateOppAlerts(rules, cands, clock());
    if (res.rules.every((r, i) => r === rules[i])) return;
    store.set({ oppAlerts: res.rules });
    const notify = store.get().settings.notify;
    for (const r of res.rules) {
      const fresh = res.fired.get(r.key);
      if (!fresh) continue;
      const m = oppAlertMessage(r, fresh);
      opts.toast(m.body, 'warn');
      if (notify) opts.notify(m.title, m.body);
    }
  }

  return store.subscribe(() => {
    const s = store.get(); // not the listener's argument: an earlier listener may have changed the state since
    const snap = s.snapshot;
    if (!snap || snap.lastUpdated === done) return;
    if (snap.source === 'cache') {
      done = snap.lastUpdated;
      return;
    }
    const ctx = derived.calcCtx();
    if (!ctx || ctx.snap !== snap) return; // catalog not loaded yet: retry on the next store change
    done = snap.lastUpdated; // before store.set in run() re-enters this listener
    run(ctx, s.alerts);
    runOpp(store.get().oppAlerts);
  });
}
