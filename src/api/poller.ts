import { POLL_BACKOFF_MS, POLL_HIDDEN_FACTOR, POLL_INTERVAL_MS } from '../config.ts';
import type { RawBazaar } from '../types/api.ts';
import type { Poller, Snapshot } from '../types/contracts.ts';
import { fetchBazaar } from './bazaarClient.ts';
import { toSnapshot } from './normalize.ts';

export interface PollerOptions {
  intervalMs?: number;
  /** defaults to fetchBazaar */
  fetch?: (signal: AbortSignal) => Promise<RawBazaar>;
  now?: () => number;
  /** called only when lastUpdated changed (or first time) */
  onSnapshot(s: Snapshot): void;
  /** called on every failure; last good snapshot must be kept by the caller */
  onError(e: Error, failures: number): void;
  /** called whenever a fetch succeeded, even when lastUpdated was unchanged */
  onSuccess?(): void;
  /** called whenever the next poll is (re)scheduled; null when stopped */
  onSchedule?(nextAt: number | null): void;
  /** visibility probe, defaults to document.hidden when available */
  isHidden?: () => boolean;
}

const safe = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    console.error('poller callback failed', e);
  }
};

/**
 * Poll every intervalMs (x POLL_HIDDEN_FACTOR while hidden).
 * On error: backoff POLL_BACKOFF_MS[failures-1] (capped at last). Success resets failures.
 * refreshNow() fetches immediately and reschedules; concurrent calls share one in-flight request.
 * start() fetches immediately (sharing any in-flight request), then keeps polling until stop().
 * refreshNow() while not started fetches once without scheduling.
 */
export function createPoller(opts: PollerOptions): Poller {
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const doFetch = opts.fetch ?? ((signal: AbortSignal) => fetchBazaar(signal));
  const now = opts.now ?? Date.now;
  const isHidden = opts.isHidden ?? (() => typeof document !== 'undefined' && document.hidden === true);

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextAt: number | null = null;
  let failures = 0;
  let lastUpdated: number | null = null;
  let lastSuccessAt: number | null = null;
  let inFlight: Promise<void> | null = null;
  let ctl: AbortController | null = null;

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule(delay: number): void {
    clearTimer();
    if (!running) return;
    const d = Math.max(0, delay);
    nextAt = now() + d;
    timer = setTimeout(() => {
      timer = null;
      void refreshNow();
    }, d);
    opts.onSchedule?.(nextAt);
  }

  function nextDelay(): number {
    if (failures > 0) return POLL_BACKOFF_MS[Math.min(failures - 1, POLL_BACKOFF_MS.length - 1)]!;
    return intervalMs * (isHidden() ? POLL_HIDDEN_FACTOR : 1);
  }

  async function run(c: AbortController): Promise<void> {
    let raw: RawBazaar;
    try {
      raw = await doFetch(c.signal);
    } catch (e) {
      if (ctl !== c) return; // stopped meanwhile: ignore (also covers our own abort)
      failures++;
      const err = e instanceof Error ? e : new Error(String(e));
      safe(() => opts.onError(err, failures));
      return;
    }
    if (ctl !== c) return; // stopped while fetching
    failures = 0;
    lastSuccessAt = now();
    if (raw.lastUpdated !== lastUpdated) {
      let snap: Snapshot;
      try {
        snap = toSnapshot(raw, now(), 'live');
      } catch (e) {
        failures++;
        const err = e instanceof Error ? e : new Error(String(e));
        safe(() => opts.onError(err, failures));
        return;
      }
      lastUpdated = raw.lastUpdated;
      safe(() => opts.onSnapshot(snap));
    }
    safe(() => opts.onSuccess?.());
  }

  function refreshNow(): Promise<void> {
    if (inFlight) return inFlight;
    clearTimer();
    const c = new AbortController();
    ctl = c;
    const p = run(c).finally(() => {
      if (ctl === c) {
        ctl = null;
        inFlight = null;
        schedule(nextDelay());
      }
    });
    inFlight = p;
    return p;
  }

  function onVisibility(): void {
    // Coming back to the tab: don't wait out the doubled hidden interval.
    if (!running || inFlight || failures > 0 || isHidden()) return;
    const due = (lastSuccessAt ?? 0) + intervalMs;
    if (nextAt !== null && nextAt > due) schedule(due - now());
  }

  function start(): void {
    if (running) return;
    running = true;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    // If a request is already in flight its completion schedules the next poll.
    if (!inFlight) void refreshNow();
  }

  function stop(): void {
    running = false;
    clearTimer();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    const c = ctl;
    ctl = null;
    inFlight = null;
    c?.abort();
    nextAt = null;
    opts.onSchedule?.(null);
  }

  return {
    start,
    stop,
    refreshNow,
    get nextAt() {
      return nextAt;
    },
    get failures() {
      return failures;
    },
  };
}
