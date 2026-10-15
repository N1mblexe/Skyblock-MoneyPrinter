// @vitest-environment happy-dom
// Mount/unmount every route of the real app via location.hash: an h1 per page, no leaked window/document listeners,
// and the accessibility invariants of the table views.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LS_ALERT_LOG, LS_ALERTS, LS_WATCH } from '../../src/config.ts';
import { bootApp, expectNoConsoleErrors, go, liveListeners, settle, teardownApp, type Booted } from './harness.ts';

afterEach(teardownApp);

const ITEM = 'ENCHANTED_MELON';
const ROUTES = ['overview', 'flip', 'books', 'craft', 'fusion', 'npc', 'plan', 'watch', `item/${ITEM}`] as const;
const hashOf = (r: string) => `#/${r}`;

/** Accessible name of a form control (aria-label, aria-labelledby, wrapping/for label, title). */
function accName(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const txt = by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .join(' ')
      .trim();
    if (txt) return txt;
  }
  const wrap = el.closest('label');
  if (wrap) {
    const clone = wrap.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input,select,textarea').forEach((c) => c.remove());
    if (clone.textContent?.trim()) return clone.textContent.trim();
  }
  if (el.id) {
    const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lab?.textContent?.trim()) return lab.textContent.trim();
  }
  return el.getAttribute('title')?.trim() ?? '';
}

/** Problems with the a11y invariants on the current page (empty = ok). */
function a11yProblems(route: string): string[] {
  const out: string[] = [];
  // hidden subtrees are not exposed to assistive tech (the item view keeps a hidden message/heading pair)
  const h1s = [...document.querySelectorAll('h1')].filter((h) => !h.closest('[hidden]'));
  if (h1s.length !== 1) out.push(`${route}: ${h1s.length} visible h1 elements`);

  // nav: aria-current="page" on exactly the active entry (none for item pages)
  const id = route.split('/')[0]!;
  const current = [...document.querySelectorAll('.sidebar [aria-current]')];
  if (id === 'item') {
    if (current.length) out.push(`${route}: nav marks ${current.length} entries current`);
  } else {
    if (current.length !== 1) out.push(`${route}: ${current.length} nav entries have aria-current`);
    const tab = document.querySelector(`[data-testid="tab-${id}"]`);
    if (tab?.getAttribute('aria-current') !== 'page') out.push(`${route}: tab-${id} lacks aria-current=page`);
  }

  // tables: roving tabindex, exactly one row in the tab order
  document.querySelectorAll<HTMLElement>('#view .tbl-kit').forEach((tbl, i) => {
    const rows = [...tbl.querySelectorAll<HTMLElement>('tbody [data-key]')];
    const focusable = rows.filter((r) => r.hasAttribute('tabindex'));
    if (!focusable.length) return; // non-interactive table (wrapper is the tab stop) or empty
    const zero = focusable.filter((r) => r.getAttribute('tabindex') === '0');
    if (zero.length !== 1) out.push(`${route}: table #${i} (${tbl.dataset.testid ?? ''}) has ${zero.length} rows with tabindex=0`);
  });

  // filter bars (and every other form control in the view): an accessible name each
  document.querySelectorAll<HTMLElement>('#view input:not([type="hidden"]), #view select, #view textarea').forEach((c) => {
    if (!accName(c)) out.push(`${route}: unnamed ${c.tagName.toLowerCase()} ${c.outerHTML.slice(0, 120)}`);
  });
  document.querySelectorAll<HTMLElement>('#view .kit-filterbar [role="group"]').forEach((g) => {
    if (!accName(g)) out.push(`${route}: unnamed segment group ${g.dataset.filter ?? ''}`);
  });
  return out;
}

async function cycle(b: Booted, routes: readonly string[]): Promise<void> {
  for (const r of routes) {
    await go(b, hashOf(r));
    const h1 = document.querySelector('#view h1');
    expect(h1, r).not.toBeNull();
    expect(h1!.textContent!.trim(), r).not.toBe('');
  }
}

describe('routes', () => {
  it('mounts every route in sequence, each with one h1', async () => {
    const b = await bootApp();
    const seen: Record<string, string> = {};
    for (const r of ROUTES) {
      await go(b, hashOf(r));
      seen[r] = document.querySelector('#view h1')!.textContent!.trim();
      expect(document.querySelectorAll('h1'), r).toHaveLength(1);
      expect(b.store.get().route.id).toBe(r.split('/')[0]);
    }
    expect(seen).toEqual({
      overview: 'Overview',
      flip: expect.any(String),
      books: expect.any(String),
      craft: expect.any(String),
      fusion: expect.any(String),
      npc: expect.any(String),
      plan: expect.any(String),
      watch: expect.any(String),
      [`item/${ITEM}`]: expect.stringMatching(/Enchanted Melon/i),
    });
    // all titles are different (no view left behind)
    expect(new Set(Object.values(seen)).size).toBe(ROUTES.length);
    expectNoConsoleErrors(b);
    expect(b.warns).not.toHaveBeenCalled();
  });

  it('navigating back and forth leaks no window/document (or matchMedia) listeners', async () => {
    const b = await bootApp();
    await settle(2);
    // the shell's and app's permanent listeners: router hashchange, hotkeys + Escape keydown,
    // the poller's visibilitychange and the settings window event
    const baseline = liveListeners();
    expect(baseline).toEqual(['document:keydown', 'document:keydown', 'document:visibilitychange', 'window:bm:open-settings', 'window:hashchange']);
    const mm0 = b.mm.listeners.size;
    const subs0 = b.subs();
    expect(subs0.store).toBeGreaterThan(5);
    expect(subs0.lang).toBeGreaterThan(2);

    const calls0 = b.subscribeCalls();
    await cycle(b, ROUTES);
    expect(b.subscribeCalls() - calls0).toBeGreaterThanOrEqual(ROUTES.length - 1); // the views do subscribe
    await cycle(b, [...ROUTES].reverse());
    await go(b, '#/flip');
    await go(b, `#/item/${ITEM}`);
    await go(b, '#/flip');
    await go(b, '#/overview');
    await settle(2);

    expect(liveListeners()).toEqual(baseline);
    expect(b.mm.listeners.size).toBe(mm0);
    // views drop their store subscriptions and language listeners on unmount
    expect(b.subs()).toEqual(subs0);
    expectNoConsoleErrors(b);
  });

  it('leaving a view with its detail panel and column popover open leaks nothing either', async () => {
    const b = await bootApp();
    await settle(2);
    const baseline = liveListeners();
    const mm0 = b.mm.listeners.size;
    const subs0 = b.subs();
    const opened: string[] = [];
    for (const r of ROUTES) {
      await go(b, hashOf(r));
      await settle(1);
      const before = liveListeners().length;
      // open a row's detail panel (document keydown while open) ...
      const row = document.querySelector<HTMLElement>('#view .tbl-kit tbody [data-key][tabindex]');
      row?.click();
      // ... and a table's column chooser (document click capture while open)
      document.querySelector<HTMLElement>('#view [data-tool="columns"]')?.click();
      await settle(1);
      if (liveListeners().length > before) opened.push(r);
    }
    await go(b, '#/overview');
    await settle(2);
    // the overlays really added document listeners on several views
    expect(opened.length).toBeGreaterThan(3);
    expect(liveListeners()).toEqual(baseline);
    expect(b.mm.listeners.size).toBe(mm0);
    expect(b.subs()).toEqual(subs0);
    expectNoConsoleErrors(b);
  });
});

describe('a11y invariants', () => {
  it('each page: one h1, aria-current nav, one tabbable row per table, named filter controls', async () => {
    // a watchlist, a rule and a logged alert so the watch view's tables have rows
    const b = await bootApp({
      ls: {
        [LS_WATCH]: [{ id: ITEM, addedAt: 1 }, { id: 'ENCHANTED_GOLD', addedAt: 2 }],
        [LS_ALERTS]: [{ key: 'r1', id: ITEM, metric: 'ask', op: 'gt', value: 1e9, enabled: true, cooldownMin: 15 }],
        [LS_ALERT_LOG]: [{ ruleKey: 'r1', id: ITEM, metric: 'ask', value: 2e9, at: Date.now() - 60_000 }],
      },
    });
    const problems: string[] = [];
    let tables = 0;
    let filterControls = 0;
    const tabbableTables = new Set<string>();
    for (const r of [...ROUTES, 'item/NOPE_ITEM', 'item/ENCHANTED_GOLD']) {
      await go(b, hashOf(r));
      await settle(2);
      const n = document.querySelectorAll('#view .tbl-kit tbody [data-key][tabindex="0"]').length;
      tables += n;
      if (n) tabbableTables.add(r.split('/')[0]!);
      filterControls += document.querySelectorAll('#view .kit-filterbar input, #view .kit-filterbar select').length;
      problems.push(...a11yProblems(r));
    }
    // the checks actually ran against something
    expect(tables).toBeGreaterThanOrEqual(5);
    expect([...tabbableTables].sort()).toEqual(['craft', 'flip', 'npc', 'plan', 'watch']);
    expect(filterControls).toBeGreaterThan(10);
    expect(problems).toEqual([]);
    expectNoConsoleErrors(b);
  });

  it('the status pill live region does not change during a 10 s tick (age text outside it does)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true });
    const b = await bootApp();
    await settle(2);
    const pill = document.querySelector<HTMLElement>('[data-testid="status-pill"]')!;
    expect(pill.getAttribute('aria-live')).toBe('polite');
    expect(pill.dataset.status).toBe('live');
    const age = document.querySelector<HTMLElement>('.status-age')!;
    const before = { html: pill.outerHTML, age: age.textContent };

    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(pill, { subtree: true, childList: true, characterData: true, attributes: true });
    for (let i = 0; i < 10; i++) vi.advanceTimersByTime(1000);
    await settle(1);
    mo.disconnect();

    expect(records).toEqual([]);
    expect(pill.outerHTML).toBe(before.html);
    expect(age.textContent).not.toBe(before.age); // the ticks did run
    // only the pill is a live region in the top bar status
    expect(document.querySelectorAll('.tb-status [aria-live]')).toHaveLength(1);
    expectNoConsoleErrors(b);
  });

  const active = () => document.activeElement as HTMLElement | null;
  const isVisible = (el: Element | null) => !!el && !el.closest('[hidden]');

  it('after navigation focus moves to the new view\'s h1', async () => {
    const b = await bootApp();
    await settle(2);
    for (const r of ['flip', 'craft', `item/${ITEM}`, 'watch', 'item/NOPE_ITEM']) {
      await go(b, hashOf(r));
      await settle(2);
      expect(active()?.tagName, r).toBe('H1');
      expect(isVisible(active()), r).toBe(true);
      expect(active()!.textContent, r).toBe(document.querySelector('#view h1:not([hidden] h1)')!.textContent);
    }
  });

  // Regression: item -> item navigation (same view, update()) used to leave focus on the previous page's h1,
  // including a hidden "not found" heading.
  it('item -> unknown item -> item: focus lands on a visible h1 each time', async () => {
    const b = await bootApp();
    await settle(2);
    await go(b, '#/flip');
    for (const r of ['item/NOPE_ITEM', 'item/ENCHANTED_GOLD', 'item/ENCHANTED_IRON']) {
      await go(b, hashOf(r));
      await settle(2);
      expect(active()?.tagName, r).toBe('H1');
      expect(isVisible(active()), `${r}: focused h1 "${active()?.textContent}" is hidden`).toBe(true);
    }
  });
});
