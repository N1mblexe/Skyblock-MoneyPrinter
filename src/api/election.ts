// Mayor / minister info from the Hypixel election resource. Owner: market-apis package.
import { API_ELECTION, ELECTION_POLL_MS, FETCH_TIMEOUT_MS, POLL_BACKOFF_MS } from '../config.ts';
import { stripFormatting } from '../domain/ids.ts';
import type { ElectionInfo, ElectionPerk } from '../types/contracts.ts';

export interface ElectionPoller {
  start(): void;
  stop(): void;
}

export interface ElectionPollerOptions {
  onInfo(i: ElectionInfo): void;
  onError(e: Error): void;
  /** defaults to fetchElection */
  fetch?: (signal: AbortSignal) => Promise<ElectionInfo>;
  intervalMs?: number;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** § codes off, Hypixel resource-pack glyphs (private-use area, render as boxes) off, whitespace collapsed. */
const clean = (v: unknown): string =>
  stripFormatting(str(v))
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function perk(v: unknown): ElectionPerk | null {
  const p = obj(v);
  if (!p) return null;
  const name = clean(p.name);
  if (!name) return null;
  const out: ElectionPerk = { name, description: clean(p.description) };
  if (p.minister === true) out.minister = true;
  return out;
}

/**
 * Parse the `/v2/resources/skyblock/election` payload. Names and descriptions have § codes stripped.
 * year = the current SkyBlock year: `current.year` (the election running now) when present, else the
 * mayor's election year + 1 (an election that closes in year N+1's spring is labelled year N).
 */
export function parseElection(raw: unknown, fetchedAt: number): ElectionInfo {
  const r = obj(raw);
  if (!r || r.success !== true) throw new Error('Election response is invalid');
  const m = obj(r.mayor);
  const mayor =
    m && str(m.key)
      ? {
          key: str(m.key),
          name: clean(m.name),
          perks: (Array.isArray(m.perks) ? m.perks : []).map(perk).filter((p): p is ElectionPerk => p !== null),
        }
      : null;
  const mi = obj(m?.minister);
  const miPerk = perk(mi?.perk);
  const minister = mi && str(mi.key) && miPerk ? { key: str(mi.key), name: clean(mi.name), perk: { ...miPerk, minister: true } } : null;
  const cur = int(obj(r.current)?.year);
  const past = int(obj(m?.election)?.year);
  const year = cur ?? (past !== null ? past + 1 : null);
  return { year, mayor, minister, fetchedAt };
}

/** Fetch and parse the election resource (FETCH_TIMEOUT_MS covers the whole request). */
export async function fetchElection(signal?: AbortSignal, now: () => number = Date.now, timeoutMs = FETCH_TIMEOUT_MS): Promise<ElectionInfo> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(API_ELECTION, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) throw new Error(`Election: HTTP ${res.status}`);
  return parseElection(await res.json(), now());
}

/**
 * Fetch now, then every ELECTION_POLL_MS. After a failure, retry after POLL_BACKOFF_MS[failures-1]
 * (capped at the last step, never later than the normal interval); success resets the backoff.
 */
export function createElectionPoller(opts: ElectionPollerOptions): ElectionPoller {
  const doFetch = opts.fetch ?? ((s: AbortSignal) => fetchElection(s));
  const intervalMs = opts.intervalMs ?? ELECTION_POLL_MS;
  let running = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ctl: AbortController | null = null;

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      console.error('election poller callback failed', e);
    }
  };

  async function poll(): Promise<void> {
    timer = null;
    const c = new AbortController();
    ctl = c;
    try {
      const info = await doFetch(c.signal);
      if (ctl !== c) return;
      failures = 0;
      safe(() => opts.onInfo(info));
    } catch (e) {
      if (ctl !== c) return;
      failures++;
      safe(() => opts.onError(e instanceof Error ? e : new Error(String(e))));
    }
    ctl = null;
    if (!running) return;
    const delay = failures ? Math.min(intervalMs, POLL_BACKOFF_MS[Math.min(failures, POLL_BACKOFF_MS.length) - 1]!) : intervalMs;
    timer = setTimeout(() => void poll(), delay);
  }

  return {
    start() {
      if (running) return;
      running = true;
      void poll();
    },
    stop() {
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      ctl?.abort();
      ctl = null;
    },
  };
}
