// @vitest-environment happy-dom
// Cold boots on deep links (filters from the URL query) and the "last route" restore on an empty hash.
import { afterEach, describe, expect, it } from 'vitest';
import { LS_LAST_ROUTE } from '../../src/config.ts';
import { bootApp, expectNoConsoleErrors, go, settle, teardownApp, waitFor } from './harness.ts';

afterEach(teardownApp);

const rows = () => [...document.querySelectorAll<HTMLElement>('#view .tbl-kit tbody [data-key]')];
const filter = <E extends HTMLElement = HTMLInputElement>(key: string) => document.querySelector<E>(`#view [data-filter="${key}"]`)!;

/** Column index (0-based) of the header whose text is exactly `label`. */
function colIndex(label: string): number {
  const ths = [...document.querySelectorAll<HTMLElement>('#view .tbl-kit thead th')];
  const i = ths.findIndex((th) => th.textContent!.replace(/[▲▼]/g, '').trim() === label);
  if (i < 0) throw new Error(`no column ${label}: ${ths.map((t) => t.textContent).join(' | ')}`);
  return i;
}
/** "6.6%" (en) -> 6.6 */
const pct = (s: string) => Number(s.replace('%', '').replace(/,/g, ''));

describe('deep links', () => {
  it('an old #/craft?kind=forge&q=gold link opens the Forge page with the search applied', async () => {
    const b = await bootApp({ hash: '#/craft?kind=forge&q=gold' });
    await waitFor(() => !!document.querySelector('#view .forge-view [data-filter="q"]'), 'forge filter bar');
    await settle(2);
    expect(b.store.get().route).toEqual({ id: 'forge', query: { q: 'gold' } });
    expect(document.querySelector('#view h1')!.textContent).toBe('Forge');
    expect(filter('q').value).toBe('gold');
    // no forge recipe in the fixture market matches "gold": the table is empty, not unfiltered
    expect(rows()).toHaveLength(0);

    // the Craft page lists craft recipes only; its search is live
    await go(b, '#/craft?q=gold');
    await settle(2);
    expect(rows().length).toBeGreaterThan(2);
    for (const r of rows()) expect(r.textContent).toMatch(/gold/i);

    // and the Forge page alone lists forge recipes
    await go(b, '#/forge');
    await settle(2);
    expect(rows().length).toBeGreaterThan(0);
    for (const r of rows()) expect(r.textContent).toMatch(/Forge/);
    expectNoConsoleErrors(b);
  });

  it('#/craft?view=chains&q=melon mounts the chains tab with the search applied', async () => {
    const b = await bootApp({ hash: '#/craft?view=chains&q=melon' });
    await waitFor(() => !!document.querySelector('#view .chains-view') && rows().length > 0, 'chain rows');
    await settle(2);
    expect(b.store.get().route).toEqual({ id: 'craft', query: { view: 'chains', q: 'melon' } });
    expect(filter('q').value).toBe('melon');
    expect(document.querySelector('[data-testid="craft-tab-chains"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(rows().map((r) => r.dataset.key)).toEqual(['MELON>ENCHANTED_MELON>ENCHANTED_MELON_BLOCK']);
    expectNoConsoleErrors(b);
  });

  it('#/flip?minMargin=5 mounts flip with the margin filter applied', async () => {
    const b = await bootApp({ hash: '#/flip?minMargin=5' });
    await waitFor(() => rows().length > 0, 'flip rows');
    await settle(2);
    expect(b.store.get().route).toEqual({ id: 'flip', query: { minMargin: '5' } });
    expect(filter('minMargin').value).toBe('5');
    const m = colIndex('Margin');
    const margins = () => rows().map((r) => pct(r.querySelectorAll('td')[m]!.textContent!));
    const filtered = margins();
    expect(filtered.length).toBeGreaterThan(3);
    for (const v of filtered) expect(v).toBeGreaterThanOrEqual(5);

    // the default (1%) shows more rows, some of them below 5%
    await go(b, '#/flip?minMargin=1');
    await settle(2);
    const all = margins();
    expect(all.length).toBeGreaterThan(filtered.length);
    expect(all.some((v) => v < 5)).toBe(true);
    expectNoConsoleErrors(b);
  });

  it('an empty hash with LS_LAST_ROUTE set restores that route', async () => {
    const b = await bootApp({ ls: { [LS_LAST_ROUTE]: '#/npc' } });
    await waitFor(() => !!document.querySelector('#view h1'), 'view');
    expect(location.hash).toBe('');
    expect(b.store.get().route).toEqual({ id: 'npc' });
    expect(document.querySelector('[data-testid="tab-npc"]')!.getAttribute('aria-current')).toBe('page');
    expect(document.querySelectorAll('#view h1')).toHaveLength(1);
    expectNoConsoleErrors(b);
  });

  it('LS_LAST_ROUTE keeps its query (filters) on restore', async () => {
    const b = await bootApp({ ls: { [LS_LAST_ROUTE]: '#/flip?minMargin=5' } });
    await waitFor(() => rows().length > 0, 'flip rows');
    expect(b.store.get().route).toEqual({ id: 'flip', query: { minMargin: '5' } });
    expect(filter('minMargin').value).toBe('5');
    expectNoConsoleErrors(b);
  });

  it('a hash wins over LS_LAST_ROUTE, and item routes are not remembered', async () => {
    const b = await bootApp({ hash: '#/item/ENCHANTED_GOLD', ls: { [LS_LAST_ROUTE]: '#/npc' } });
    await waitFor(() => !!document.querySelector('[data-testid="item-name"]')?.textContent, 'item page');
    expect(b.store.get().route).toEqual({ id: 'item', param: 'ENCHANTED_GOLD' });
    expect(JSON.parse(localStorage.getItem(LS_LAST_ROUTE)!)).toBe('#/npc');
    await go(b, '#/books');
    expect(JSON.parse(localStorage.getItem(LS_LAST_ROUTE)!)).toBe('#/books');
    expectNoConsoleErrors(b);
  });
});
