// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harness, snap, teardown, type Harness } from './helpers.ts';

let h: Harness | null = null;
afterEach(() => {
  vi.useRealTimers();
  teardown(h);
  h = null;
});

describe('status pill', () => {
  it('shows freshness from snapshot age and countdown', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    h = harness({ status: 'live', snapshot: snap(now - 30_000), nextPollAt: now + 40_000 });
    h.mount();
    const pill = h.q('[data-testid="status-pill"]');
    expect(pill.dataset.status).toBe('live');
    expect(pill.textContent).toBe('Canlı');
    expect(h.q('.status-age').textContent).toBe('veri 30 sn önce');
    expect(h.q('.status-next').textContent).toBe('yenileme 40 sn');
    vi.advanceTimersByTime(5000);
    expect(h.q('.status-age').textContent).toBe('veri 35 sn önce');
    expect(h.q('.status-next').textContent).toBe('yenileme 35 sn');
    // snapshot ages past thresholds while fetches "succeed"
    vi.advanceTimersByTime(4 * 60_000);
    expect(pill.dataset.status).toBe('stale');
    vi.advanceTimersByTime(10 * 60_000);
    expect(pill.dataset.status).toBe('old');
    h.store.set({ status: 'cached' });
    expect(pill.dataset.status).toBe('cached');
  });

  it('the live region only holds the status and is untouched while the clock ticks', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    h = harness({ status: 'live', snapshot: snap(now - 5_000), nextPollAt: now + 50_000 });
    h.mount();
    const live = h.qa('[aria-live]').filter((e) => h!.root.contains(e));
    expect(live).toHaveLength(1);
    const pill = live[0]!;
    expect(pill.dataset.testid).toBe('status-pill');
    expect(pill.getAttribute('role')).toBe('status');
    // ticking texts sit outside the live region
    expect(pill.contains(h.q('.status-age'))).toBe(false);
    expect(pill.contains(h.q('.status-next'))).toBe(false);

    const mutations: MutationRecord[] = [];
    const mo = new MutationObserver((m) => mutations.push(...m));
    mo.observe(pill, { childList: true, characterData: true, subtree: true, attributes: true });
    const ageBefore = h.q('.status-age').textContent;
    for (let i = 0; i < 10; i++) vi.advanceTimersByTime(1000);
    await Promise.resolve();
    mutations.push(...mo.takeRecords());
    expect(h.q('.status-age').textContent).not.toBe(ageBefore);
    expect(pill.textContent).toBe('Canlı');
    expect(mutations).toHaveLength(0);

    // a real status change does update it
    h.store.set({ status: 'error', lastError: 'boom', snapshot: null });
    mutations.push(...mo.takeRecords());
    mo.disconnect();
    expect(pill.textContent).toBe('Hata');
    expect(mutations.length).toBeGreaterThan(0);
    expect(pill.title).toContain('boom');
  });
});
