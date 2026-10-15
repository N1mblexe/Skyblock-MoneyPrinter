// @vitest-environment happy-dom
// Alerts end to end: watchlist + rule from localStorage, a refresh with moved prices fires once
// (Notification + toast + alertLog), the cooldown blocks the immediate next snapshot.
import { afterEach, describe, expect, it } from 'vitest';
import { LS_ALERT_LOG, LS_ALERTS, LS_SETTINGS, LS_WATCH } from '../../src/config.ts';
import { bootApp, expectNoConsoleErrors, freshBazaar, go, settle, teardownApp, waitFor, type Booted } from './harness.ts';

afterEach(teardownApp);

const ID = 'ENCHANTED_MELON';
const RULE = { key: 'r-melon', id: ID, metric: 'ask', op: 'gt', value: 1000, enabled: true, cooldownMin: 15 };

/** The fixture with every sell offer (ask side) of ID priced x10 and a new lastUpdated. */
function pricier(at: number) {
  const b = freshBazaar(at);
  for (const lv of b.products[ID]!.buy_summary) lv.pricePerUnit = Math.round(lv.pricePerUnit * 100) / 10;
  return b;
}

async function refreshWith(b: Booted, at: number): Promise<void> {
  b.net.setBazaar(pricier(at));
  document.querySelector<HTMLButtonElement>('[data-testid="refresh-btn"]')!.click();
  await waitFor(() => b.store.get().snapshot?.lastUpdated === at, `snapshot ${at}`);
  await settle(2);
}

const warnToasts = () => [...document.querySelectorAll<HTMLElement>('.kit-toasts .kit-toast-warn')];
const lsJson = (k: string) => JSON.parse(localStorage.getItem(k) ?? 'null');

describe('alerts end to end', () => {
  it('fires on the second snapshot (notification, toast, log) and the cooldown blocks the third', async () => {
    const b = await bootApp({
      ls: {
        [LS_WATCH]: [{ id: ID, addedAt: 1 }],
        [LS_ALERTS]: [RULE],
        [LS_SETTINGS]: { notify: true },
      },
    });
    await settle(3);
    const s0 = b.store.get();
    expect(s0.settings.notify).toBe(true);
    expect(s0.alerts).toHaveLength(1);
    expect(s0.snapshot!.products[ID]!.ask).toBe(324.7); // below the 1000 threshold: no fire on boot
    expect(b.notifications).toEqual([]);
    expect(s0.alertLog).toEqual([]);
    expect(warnToasts()).toHaveLength(0);

    // 2nd snapshot: ask 3247 > 1000
    const t2 = Date.now() - 2_000;
    await refreshWith(b, t2);
    expect(b.store.get().snapshot!.products[ID]!.ask).toBe(3247);
    await waitFor(() => b.store.get().alertLog.length === 1, 'alert log entry');

    expect(b.notifications).toHaveLength(1);
    expect(b.notifications[0]!.title).toContain('Enchanted Melon');
    expect(b.notifications[0]!.body).toContain('Enchanted Melon');

    const toasts = warnToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.textContent).toContain('Enchanted Melon');
    expect(toasts[0]!.textContent).toBe(`${b.notifications[0]!.body}×`); // message + dismiss button

    const log = lsJson(LS_ALERT_LOG);
    expect(log).toEqual([{ ruleKey: RULE.key, id: ID, metric: 'ask', value: 3247, at: expect.any(Number) }]);
    expect(lsJson(LS_ALERTS)[0].lastFiredAt).toBe(log[0].at);

    // 3rd snapshot right away: still above the threshold, but within the 15 min cooldown
    const t3 = Date.now() - 1_000;
    await refreshWith(b, t3);
    expect(b.store.get().snapshot!.lastUpdated).toBe(t3);
    expect(b.notifications).toHaveLength(1);
    expect(b.store.get().alertLog).toHaveLength(1);
    expect(lsJson(LS_ALERT_LOG)).toHaveLength(1);
    expect(warnToasts()).toHaveLength(1);

    // the watch view's log table shows the event
    await go(b, '#/watch');
    await waitFor(() => document.querySelectorAll('[data-testid="watch-log"] tbody [data-key]').length > 0, 'watch log rows');
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="watch-log"] tbody [data-key]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Enchanted Melon');
    expect(rows[0]!.textContent).toContain('3,247');

    expectNoConsoleErrors(b);
    expect(b.warns).not.toHaveBeenCalled();
  });

  it('with notify off the alert still toasts and logs, but no Notification is created', async () => {
    const b = await bootApp({ ls: { [LS_WATCH]: [{ id: ID, addedAt: 1 }], [LS_ALERTS]: [RULE] } });
    await settle(3);
    expect(b.store.get().settings.notify).toBe(false);
    await refreshWith(b, Date.now() - 2_000);
    await waitFor(() => b.store.get().alertLog.length === 1, 'alert log entry');
    expect(warnToasts()).toHaveLength(1);
    expect(b.notifications).toEqual([]);
    expectNoConsoleErrors(b);
  });
});
