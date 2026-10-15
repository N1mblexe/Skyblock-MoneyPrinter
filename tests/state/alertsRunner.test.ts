import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERTS } from '../../src/config.ts';
import { setLang } from '../../src/i18n/index.ts';
import { alertMessage, fmtMetric, startAlerts } from '../../src/state/alertsRunner.ts';
import { initialState } from '../../src/state/appState.ts';
import { createDerived } from '../../src/state/derived.ts';
import { createStore } from '../../src/state/store.ts';
import type { AlertEvent, AlertRule, AppState, Snapshot } from '../../src/types/contracts.ts';
import { baseSettings, catalog, makeProduct, snap as fixtureSnap } from '../domain/helpers.ts';
import { fakeHistory } from '../helpers/fakes.ts';

const T0 = Date.UTC(2026, 9, 1);
const MIN = 60_000;

const snapAt = (lastUpdated: number, ask = 105, source: Snapshot['source'] = 'live'): Snapshot => ({
  ...fixtureSnap,
  lastUpdated,
  source,
  products: { X: makeProduct({ id: 'X', asks: [{ price: ask, amount: 100, orders: 1 }] }) },
});

const rule = (o: Partial<AlertRule> = {}): AlertRule => ({
  key: 'r1',
  id: 'X',
  metric: 'ask',
  op: 'lt',
  value: 110,
  enabled: true,
  cooldownMin: 15,
  ...o,
});

function setup(state: Partial<AppState> = {}) {
  const clock = { t: T0 };
  const store = createStore<AppState>({ ...initialState({ ...baseSettings, lang: 'tr' }), catalog, ...state });
  const derived = createDerived(store, fakeHistory());
  const toast = vi.fn();
  const notify = vi.fn();
  const stop = startAlerts({ store, derived, toast, notify, now: () => clock.t });
  return { store, toast, notify, stop, clock };
}

beforeEach(() => setLang('tr')); // messages are checked in Turkish unless a test switches
afterEach(() => setLang('tr'));

describe('startAlerts', () => {
  it('fires on a new snapshot: log, lastFiredAt, toast; no notification unless enabled', () => {
    const { store, toast, notify } = setup({ alerts: [rule(), rule({ key: 'r2', op: 'gt', value: 1e6 })] });
    store.set({ snapshot: snapAt(T0) });
    expect(store.get().alertLog).toEqual([{ ruleKey: 'r1', id: 'X', metric: 'ask', value: 105, at: T0 }]);
    expect(store.get().alerts[0]!.lastFiredAt).toBe(T0);
    expect(store.get().alerts[1]!.lastFiredAt).toBeUndefined();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0]![1]).toBe('warn');
    expect(toast.mock.calls[0]![0]).toContain('satış fiyatı');
    expect(notify).not.toHaveBeenCalled();
  });

  it('evaluates each lastUpdated once and respects cooldowns', () => {
    const { store, toast, clock } = setup({ alerts: [rule()] });
    store.set({ snapshot: snapAt(T0) });
    store.set({ snapshot: snapAt(T0) }); // same lastUpdated, new object
    store.set({ nextPollAt: 1 }); // unrelated change
    expect(toast).toHaveBeenCalledTimes(1);
    clock.t = T0 + 5 * MIN;
    store.set({ snapshot: snapAt(T0 + 5 * MIN) }); // cooling down
    expect(toast).toHaveBeenCalledTimes(1);
    clock.t = T0 + 15 * MIN;
    store.set({ snapshot: snapAt(T0 + 15 * MIN) });
    expect(toast).toHaveBeenCalledTimes(2);
    expect(store.get().alertLog.map((e) => e.at)).toEqual([T0 + 15 * MIN, T0]);
  });

  it('notifies when settings.notify, with a localized title', () => {
    const { store, notify, toast } = setup({ alerts: [rule()] });
    setLang('en');
    store.set((s) => ({ settings: { ...s.settings, notify: true } }));
    store.set({ snapshot: snapAt(T0) });
    expect(notify).toHaveBeenCalledTimes(1);
    const [title, body] = notify.mock.calls[0]!;
    expect(title).toBe(`Alert: ${catalog.name('X')}`);
    expect(body).toBe(toast.mock.calls[0]![0]);
    expect(body).toContain('ask');
  });

  it('skips cached snapshots and the snapshot present at start', () => {
    const { store, toast } = setup({ alerts: [rule()], snapshot: snapAt(T0) });
    store.set({ alerts: [rule({ value: 1e9 })] });
    expect(toast).not.toHaveBeenCalled();
    store.set({ snapshot: snapAt(T0 + MIN, 105, 'cache') });
    expect(toast).not.toHaveBeenCalled();
    store.set({ snapshot: snapAt(T0 + 2 * MIN) });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('waits for the catalog when the snapshot comes first', () => {
    const { store, toast } = setup({ alerts: [rule()], catalog: null });
    store.set({ snapshot: snapAt(T0) });
    expect(toast).not.toHaveBeenCalled();
    store.set({ catalog });
    expect(toast).toHaveBeenCalledTimes(1);
    store.set({ historyTick: 1 });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('does nothing without enabled rules or firing rules', () => {
    const { store, toast } = setup({ alerts: [rule({ enabled: false }), rule({ key: 'r2', op: 'gt' })] });
    const before = store.get().alerts;
    store.set({ snapshot: snapAt(T0) });
    expect(toast).not.toHaveBeenCalled();
    expect(store.get().alerts).toBe(before);
    expect(store.get().alertLog).toEqual([]);
  });

  it('caps the log at ALERTS.logMax, newest first', () => {
    const old: AlertEvent[] = Array.from({ length: ALERTS.logMax }, (_, i) => ({ ruleKey: 'o', id: 'X', metric: 'ask', value: i, at: i }));
    const { store } = setup({ alerts: [rule({ key: 'a' }), rule({ key: 'b' })], alertLog: old });
    store.set({ snapshot: snapAt(T0) });
    const log = store.get().alertLog;
    expect(log.length).toBe(ALERTS.logMax);
    expect(log.slice(0, 3).map((e) => e.ruleKey)).toEqual(['b', 'a', 'o']);
    expect(log.at(-1)!.value).toBe(ALERTS.logMax - 3);
  });

  it('unsubscribes', () => {
    const { store, toast, stop } = setup({ alerts: [rule()] });
    stop();
    store.set({ snapshot: snapAt(T0) });
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('alert messages', () => {
  it('formats ratios as percent and prices as coins', () => {
    setLang('en');
    expect(fmtMetric('flipMargin', 0.123)).toBe('12.3%');
    expect(fmtMetric('ask', 1234)).toBe('1,234');
    const m = alertMessage({ ruleKey: 'k', id: 'X', metric: 'spreadPct', value: 0.5, at: 0 }, 0.25, 'gt', 'Thing');
    expect(m).toEqual({ title: 'Alert: Thing', body: 'Thing: spread 50.0% (> 25.0%)' });
    setLang('tr');
    expect(alertMessage({ ruleKey: 'k', id: 'X', metric: 'bid', value: 5, at: 0 }, 6, 'lt', 'Şey').title).toBe('Alarm: Şey');
  });

});
