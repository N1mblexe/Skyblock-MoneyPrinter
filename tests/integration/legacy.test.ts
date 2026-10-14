// @vitest-environment happy-dom
// Legacy single-file tool keys (bazaarMasasi.recipes / bazaarMasasi.tab) are migrated on boot.
import { afterEach, describe, expect, it } from 'vitest';
import { LS_FUSION, LS_LAST_ROUTE, LS_LEGACY_FUSION, LS_LEGACY_TAB } from '../../src/config.ts';
import { bootApp, expectNoConsoleErrors, go, settle, teardownApp, waitFor } from './harness.ts';

afterEach(teardownApp);

const LEGACY = [
  { a: 'SHARD_SALMON', aq: 2, b: 'SHARD_WIKI_TIKI', bq: 3, out: 'SHARD_BEEHEEMOTH', oq: 1 },
  { a: 'ENCHANTED_MELON', aq: 5, b: 'MELON', bq: 7, out: 'ENCHANTED_MELON_BLOCK', oq: 2 },
  { a: 'BROKEN', aq: 0, b: 'X', bq: 1, out: 'Y', oq: 1 }, // invalid (qty 0): dropped
];

const fusionRows = () =>
  [...document.querySelectorAll<HTMLElement>('#view .fu-row')].map((r) => {
    const v = (f: string) => r.querySelector<HTMLInputElement>(`[data-f="${f}"]`)!.value;
    return { a: v('a'), qa: v('qa'), b: v('b'), qb: v('qb'), out: v('out'), qo: v('qo') };
  });

describe('legacy migration', () => {
  it.each([
    ['JSON-encoded tab', JSON.stringify('craft')],
    ['bare tab string', 'craft'],
  ])('recipes + tab (%s) -> fusion recipes and the craft route', async (_label, tab) => {
    const b = await bootApp({ rawLs: { [LS_LEGACY_FUSION]: JSON.stringify(LEGACY), [LS_LEGACY_TAB]: tab } });
    await waitFor(() => !!document.querySelector('#view h1'), 'view');
    expect(b.store.get().route).toEqual({ id: 'craft' });
    expect(document.querySelector('[data-testid="tab-craft"]')!.getAttribute('aria-current')).toBe('page');
    expect(JSON.parse(localStorage.getItem(LS_LAST_ROUTE)!)).toBe('#/craft');

    const migrated = [
      { a: 'SHARD_SALMON', qa: 2, b: 'SHARD_WIKI_TIKI', qb: 3, out: 'SHARD_BEEHEEMOTH', qo: 1 },
      { a: 'ENCHANTED_MELON', qa: 5, b: 'MELON', qb: 7, out: 'ENCHANTED_MELON_BLOCK', qo: 2 },
    ];
    expect(b.store.get().fusion).toEqual(migrated);
    expect(JSON.parse(localStorage.getItem(LS_FUSION)!)).toEqual(migrated);
    // the legacy keys are kept (migration never deletes)
    expect(localStorage.getItem(LS_LEGACY_FUSION)).not.toBeNull();

    await go(b, '#/fusion');
    await settle(2);
    expect(fusionRows()).toEqual(migrated.map((r) => ({ ...r, qa: String(r.qa), qb: String(r.qb), qo: String(r.qo) })));
    expectNoConsoleErrors(b);
  });

  it('does not overwrite existing new-format data', async () => {
    const mine = [{ a: 'COAL', qa: 1, b: 'BONE', qb: 1, out: 'ENCHANTED_COAL', qo: 1 }];
    const b = await bootApp({
      rawLs: {
        [LS_LEGACY_FUSION]: JSON.stringify(LEGACY),
        [LS_LEGACY_TAB]: '"fusion"',
        [LS_FUSION]: JSON.stringify(mine),
        [LS_LAST_ROUTE]: JSON.stringify('#/books'),
      },
    });
    await waitFor(() => !!document.querySelector('#view h1'), 'view');
    expect(b.store.get().route.id).toBe('books');
    expect(b.store.get().fusion).toEqual(mine);
    expectNoConsoleErrors(b);
  });
});
