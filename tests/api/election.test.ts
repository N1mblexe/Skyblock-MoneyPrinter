import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElectionPoller, fetchElection, parseElection } from '../../src/api/election.ts';
import { API_ELECTION, ELECTION_POLL_MS, POLL_BACKOFF_MS } from '../../src/config.ts';
import type { ElectionInfo } from '../../src/types/contracts.ts';
import raw from '../fixtures/api/election.json' with { type: 'json' };

const T0 = Date.UTC(2026, 9, 14);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseElection', () => {
  it('parses the live fixture with formatting stripped', () => {
    const e = parseElection(raw, T0);
    expect(e).toEqual({
      year: 519,
      fetchedAt: T0,
      mayor: {
        key: 'dungeons',
        name: 'Paul',
        perks: [
          { name: 'Marauder', description: 'Dungeon reward chests are 20% cheaper.' },
          { name: 'Benediction', description: 'Blessings are 25% stronger.' },
        ],
      },
      minister: {
        key: 'mining',
        name: 'Cole',
        perk: {
          name: 'Mining Fiesta',
          description: 'Gain +25☯ Mining Wisdom, +25% Mining Fortune, and collect Refined Minerals and Glossy Gemstones from mining!',
          minister: true,
        },
      },
    } satisfies ElectionInfo);
    expect(JSON.stringify(e)).not.toContain('§');
  });

  it('handles missing pieces', () => {
    const base = structuredClone(raw) as Record<string, any>;
    delete base.current;
    expect(parseElection(base, 0).year).toBe(519); // mayor.election.year + 1
    delete base.mayor.election;
    delete base.mayor.minister;
    base.mayor.perks = [{ name: '§aOk', description: 5 }, { name: ' \uE053 ', description: 'x' }, { description: 'no name' }, 'junk'];
    const e = parseElection(base, 0);
    expect(e.year).toBeNull();
    expect(e.minister).toBeNull();
    expect(e.mayor!.perks).toEqual([{ name: 'Ok', description: '' }]);
    base.mayor.perks = undefined;
    expect(parseElection(base, 0).mayor!.perks).toEqual([]);
    expect(parseElection({ success: true }, 0)).toEqual({ year: null, mayor: null, minister: null, fetchedAt: 0 });
    expect(parseElection({ success: true, mayor: { key: 'x', name: 'X', minister: { key: 'k', name: 'K' } } }, 0).minister).toBeNull();
  });

  it('rejects invalid payloads', () => {
    expect(() => parseElection(null, 0)).toThrow(/invalid/);
    expect(() => parseElection([], 0)).toThrow(/invalid/);
    expect(() => parseElection({ success: false }, 0)).toThrow(/invalid/);
  });
});

describe('fetchElection', () => {
  it('fetches and parses', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(raw)));
    vi.stubGlobal('fetch', f);
    const e = await fetchElection(undefined, () => T0);
    expect(e.mayor!.name).toBe('Paul');
    expect(e.fetchedAt).toBe(T0);
    expect(f.mock.calls[0]![0]).toBe(API_ELECTION);
    await fetchElection(new AbortController().signal);
  });

  it('throws on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    await expect(fetchElection()).rejects.toThrow('HTTP 500');
  });
});

describe('createElectionPoller', () => {
  const info = (t: number): ElectionInfo => ({ year: 1, mayor: null, minister: null, fetchedAt: t });

  function setup(fetchImpl?: (s: AbortSignal) => Promise<ElectionInfo>) {
    const infos: ElectionInfo[] = [];
    const errors: Error[] = [];
    const fetch = vi.fn(fetchImpl ?? (async () => info(Date.now())));
    const poller = createElectionPoller({ onInfo: (i) => infos.push(i), onError: (e) => errors.push(e), fetch });
    return { poller, infos, errors, fetch };
  }

  it('fetches now, then every ELECTION_POLL_MS', async () => {
    vi.useFakeTimers({ now: T0 });
    const t = setup();
    t.poller.start();
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.infos).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ELECTION_POLL_MS - 1);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.fetch).toHaveBeenCalledTimes(2);
    t.poller.stop();
    await vi.advanceTimersByTimeAsync(ELECTION_POLL_MS * 2);
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it('backs off on errors and resets after a success', async () => {
    vi.useFakeTimers({ now: T0 });
    let fail = 3;
    const t = setup(async () => {
      if (fail-- > 0) throw fail === 1 ? 'plain' : new Error('down');
      return info(0);
    });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MS[0]);
    expect(t.errors).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MS[1]);
    expect(t.errors).toHaveLength(3);
    expect(t.errors[2]).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(POLL_BACKOFF_MS[2]);
    expect(t.infos).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ELECTION_POLL_MS);
    expect(t.fetch).toHaveBeenCalledTimes(5);
    t.poller.stop();
  });

  it('stop aborts the in-flight request and drops its result', async () => {
    let signal!: AbortSignal;
    let resolve!: (i: ElectionInfo) => void;
    const t = setup((s) => {
      signal = s;
      return new Promise((r) => (resolve = r));
    });
    t.poller.start();
    t.poller.stop();
    expect(signal.aborted).toBe(true);
    resolve(info(1));
    await Promise.resolve();
    expect(t.infos).toEqual([]);
  });

  it('callback exceptions are contained', async () => {
    vi.useFakeTimers({ now: T0 });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const poller = createElectionPoller({
      onInfo: () => {
        throw new Error('ui');
      },
      onError: () => {},
      fetch: async () => info(0),
      intervalMs: 1000,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(err).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});
