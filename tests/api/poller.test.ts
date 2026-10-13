import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPoller, type PollerOptions } from '../../src/api/poller.ts';
import type { RawBazaar } from '../../src/types/api.ts';
import type { Snapshot } from '../../src/types/contracts.ts';

const rawAt = (lastUpdated: number): RawBazaar => ({ success: true, lastUpdated, products: {} });

function setup(over: Partial<PollerOptions> = {}) {
  let lastUpdated = 1000;
  let fail = false;
  let hidden = false;
  const calls = { fetch: 0 };
  const snaps: Snapshot[] = [];
  const errors: [string, number][] = [];
  const schedules: (number | null)[] = [];
  let successes = 0;
  const fetch = vi.fn(async (_signal: AbortSignal) => {
    calls.fetch++;
    if (fail) throw new Error('boom');
    return rawAt(lastUpdated);
  });
  const poller = createPoller({
    intervalMs: 60_000,
    fetch,
    now: () => Date.now(),
    onSnapshot: (s) => snaps.push(s),
    onError: (e, n) => errors.push([e.message, n]),
    onSuccess: () => successes++,
    onSchedule: (at) => schedules.push(at),
    isHidden: () => hidden,
    ...over,
  });
  return {
    poller,
    fetch,
    snaps,
    errors,
    schedules,
    get successes() {
      return successes;
    },
    setLastUpdated: (v: number) => (lastUpdated = v),
    setFail: (v: boolean) => (fail = v),
    setHidden: (v: boolean) => (hidden = v),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('poller', () => {
  it('fetches on start and then every interval', async () => {
    const t = setup();
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.snaps.length).toBe(1);
    expect(t.snaps[0]!.source).toBe('live');
    expect(t.poller.nextAt).toBe(60_000);
    expect(t.schedules.at(-1)).toBe(60_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    t.poller.stop();
  });

  it('unchanged lastUpdated -> onSuccess but no onSnapshot', async () => {
    const t = setup();
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(t.snaps.length).toBe(1);
    expect(t.successes).toBe(2);
    t.setLastUpdated(2000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.snaps.length).toBe(2);
    expect(t.snaps[1]!.lastUpdated).toBe(2000);
    t.poller.stop();
  });

  it('doubles the interval when hidden', async () => {
    const t = setup();
    t.setHidden(true);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.poller.nextAt).toBe(120_000);
    t.poller.stop();
  });

  it('backs off 60/120/300/300 s and resets after success', async () => {
    const t = setup({ intervalMs: 10_000 });
    t.setFail(true);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    const gaps: number[] = [];
    let prev = 0;
    for (let i = 0; i < 4; i++) {
      expect(t.poller.failures).toBe(i + 1);
      const next = t.poller.nextAt!;
      gaps.push(next - prev);
      prev = next;
      await vi.advanceTimersByTimeAsync(next - Date.now());
    }
    expect(gaps).toEqual([60_000, 120_000, 300_000, 300_000]);
    expect(t.errors.map((e) => e[1])).toEqual([1, 2, 3, 4, 5]);
    expect(t.snaps.length).toBe(0);
    t.setFail(false);
    await vi.advanceTimersByTimeAsync(t.poller.nextAt! - Date.now());
    expect(t.poller.failures).toBe(0);
    expect(t.snaps.length).toBe(1);
    expect(t.poller.nextAt! - Date.now()).toBe(10_000);
    t.poller.stop();
  });

  it('refreshNow shares the in-flight request and reschedules', async () => {
    let release!: () => void;
    const fetch = vi.fn(
      () =>
        new Promise<RawBazaar>((res) => {
          release = () => res(rawAt(5));
        }),
    );
    const t = setup({ fetch });
    t.poller.start();
    const a = t.poller.refreshNow();
    const b = t.poller.refreshNow();
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1_000);
    release();
    await a;
    expect(t.snaps.length).toBe(1);
    expect(t.poller.nextAt).toBe(61_000);

    // a manual refresh mid-interval fetches now and restarts the interval
    await vi.advanceTimersByTimeAsync(30_000);
    const c = t.poller.refreshNow();
    expect(fetch).toHaveBeenCalledTimes(2);
    release();
    await c;
    expect(t.poller.nextAt).toBe(91_000);
    await vi.advanceTimersByTimeAsync(30_000); // old timer (61s) must not fire
    expect(fetch).toHaveBeenCalledTimes(2);
    t.poller.stop();
  });

  it('refreshNow without start fetches once and does not schedule', async () => {
    const t = setup();
    await t.poller.refreshNow();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.poller.nextAt).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it('stop clears timers, aborts in-flight and reports null', async () => {
    let signal!: AbortSignal;
    const fetch = vi.fn(
      (s: AbortSignal) =>
        new Promise<RawBazaar>((_res, rej) => {
          signal = s;
          s.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    );
    const t = setup({ fetch });
    t.poller.start();
    expect(fetch).toHaveBeenCalledTimes(1);
    t.poller.stop();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors).toEqual([]);
    expect(t.poller.nextAt).toBeNull();
    expect(t.schedules.at(-1)).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stop after a scheduled poll cancels it; start again resumes', async () => {
    const t = setup();
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    t.poller.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    expect(t.poller.nextAt).not.toBeNull();
    t.poller.stop();
  });

  it('callback exceptions do not break polling', async () => {
    const t = setup({
      onSnapshot: () => {
        throw new Error('ui bug');
      },
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.poller.failures).toBe(0);
    expect(t.poller.nextAt).toBe(60_000);
    spy.mockRestore();
    t.poller.stop();
  });
});
