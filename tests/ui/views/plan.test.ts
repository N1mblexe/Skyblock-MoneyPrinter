// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toSnapshot, validateRaw } from '../../../src/api/normalize.ts';
import { LS_VIEWPREFS, OPTIMIZER } from '../../../src/config.ts';
import { catalogFromFile, validateCatalogFile } from '../../../src/data/catalog.ts';
import { allocate } from '../../../src/domain/optimizer.ts';
import { setLang, t } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { Allocation, AppState, Catalog, Opportunity, Route, Snapshot, Store, View, ViewContext } from '../../../src/types/contracts.ts';
import { fmtCoins } from '../../../src/ui/format.ts';
import { filterKinds, PLAN_SCHEMA, planOptions, planRows, sourceHref, whyBound } from '../../../src/ui/views/plan/model.ts';
import { createPlanView, OPEN_SETTINGS_EVENT, PLAN_DEBOUNCE_MS } from '../../../src/ui/views/plan/planView.ts';
import bazaarJson from '../../fixtures/bazaar.json';
import catalogJson from '../../fixtures/catalog.json';
import { fakeHistory, fakeViewCtx } from '../../helpers/fakes.ts';

const SNAP: Snapshot = toSnapshot(validateRaw(bazaarJson as unknown), 1_700_000_000_000, 'fixture');
const CATALOG: Catalog = catalogFromFile(validateCatalogFile(catalogJson as unknown));

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const settle = () => flush(PLAN_DEBOUNCE_MS + 80);

let store: Store<AppState>;
let root: HTMLElement;
let view: View;
let ctx: ViewContext;

const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const rowKeys = () => [...root.querySelectorAll<HTMLElement>('.plan-view [data-key]')].map((r) => r.dataset.key!);

function mount(query?: Record<string, string>, patch: Partial<AppState> = { snapshot: SNAP, catalog: CATALOG }) {
  store.set(patch);
  view = createPlanView();
  const route: Route = { id: 'plan', ...(query ? { query } : {}) };
  view.mount(root, ctx, route);
}

/** The plan the view should show for these URL values. */
function expected(query: Record<string, string> = {}) {
  const v = Object.fromEntries(
    Object.entries(PLAN_SCHEMA).map(([k, f]) => {
      const raw = query[k];
      if (raw == null) return [k, f.def];
      if (f.kind === 'number') return [k, Number(raw)];
      if (f.kind === 'bool') return [k, raw === '1'];
      return [k, raw];
    }),
  ) as Parameters<typeof planOptions>[0];
  const opts = planOptions(v, store.get().settings);
  return { opts, res: allocate(filterKinds(ctx.derived.opportunities(), v), opts) };
}

beforeEach(() => {
  setLang('tr');
  localStorage.clear();
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  ctx = fakeViewCtx(store, fakeHistory(), { t, navigate: vi.fn() });
});

afterEach(() => {
  view?.unmount();
  document.body.innerHTML = '';
  setLang('tr');
});


describe('plan view', () => {
  it('fixture yields opportunities of several kinds', () => {
    store.set({ snapshot: SNAP, catalog: CATALOG });
    const kinds = new Set(ctx.derived.opportunities().map((o) => o.kind));
    expect(kinds.has('flip')).toBe(true);
    expect(ctx.derived.opportunities().length).toBeGreaterThan(5);
  });

  it('mounts with an h1, allocates exactly like allocate(), and unmounts cleanly', async () => {
    mount();
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    expect(q('h1').textContent).toBe('Planlayıcı');
    const { res } = expected();
    expect(res.allocations.length).toBeGreaterThan(0);
    expect(rowKeys()).toEqual(res.allocations.map((a) => a.opp.key));
    expect(q('[data-testid="plan-pph"]').textContent).toBe(fmtCoins(res.profitPerHour));
    expect(q('[data-testid="plan-positions"]').textContent).toBe(String(res.allocations.length));
    expect(q('[data-testid="plan-disclaimer"]').textContent).toContain('tahmin');
    view.unmount();
    expect(root.children.length).toBe(0);
    store.set({ snapshot: { ...SNAP } });
    await flush();
    expect(root.children.length).toBe(0);
    view = { id: 'plan', mount() {}, unmount() {} };
  });

  it('summary bars show capital and slots used vs available', () => {
    mount();
    const { res, opts } = expected();
    const cap = q('[data-testid="plan-cap-bar"]');
    expect(cap.getAttribute('role')).toBe('meter');
    expect(Number(cap.getAttribute('aria-valuemax'))).toBe(opts.capital);
    expect(Number(cap.getAttribute('aria-valuenow'))).toBeCloseTo(Math.min(res.capitalUsed, opts.capital));
    const slots = q('[data-testid="plan-slot-bar"]');
    expect(Number(slots.getAttribute('aria-valuemax'))).toBe(defaultSettings.orderSlots);
    expect(Number(slots.getAttribute('aria-valuenow'))).toBe(res.slotsUsed);
    expect(slots.getAttribute('aria-valuetext')).toBe(`${res.slotsUsed} / ${defaultSettings.orderSlots}`);
  });

  it('URL overrides capital, slots and max share', () => {
    const query = { capital: '200000', slots: '2', share: '30' };
    mount(query);
    const { res, opts } = expected(query);
    expect(opts).toEqual({ capital: 200_000, slots: 2, maxShare: 0.3, excludeSuspect: OPTIMIZER.excludeSuspect });
    expect(rowKeys()).toEqual(res.allocations.map((a) => a.opp.key));
    expect(res.slotsUsed).toBeLessThanOrEqual(2);
    expect(Number(q('[data-testid="plan-slot-bar"]').getAttribute('aria-valuemax'))).toBe(2);
    expect(Number(q('[data-testid="plan-cap-bar"]').getAttribute('aria-valuemax'))).toBe(200_000);
    expect(q<HTMLInputElement>('input[data-filter="capital"]').value).toBe('200000');
  });

  it('kind filter limits the plan to the included kinds', () => {
    const query = { craft: '0', book: '0', npc: '0' };
    mount(query);
    const kinds = [...root.querySelectorAll('.plan-view [data-key]')].map((r) => r.getAttribute('data-key')!.split(':')[0]);
    expect(kinds.length).toBeGreaterThan(0);
    expect(new Set(kinds)).toEqual(new Set(['flip']));
    expect(rowKeys()).toEqual(expected(query).res.allocations.map((a) => a.opp.key));
  });

  it('filters write setQuery and recompute after the debounce, showing "computing"', async () => {
    mount();
    const before = rowKeys();
    const box = q<HTMLInputElement>('input[data-filter="flip"]');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(ctx.setQuery).toHaveBeenCalledWith({ flip: '0' });
    expect(q('[data-testid="plan-computing"]').hidden).toBe(false);
    expect(rowKeys()).toEqual(before); // not yet
    await settle();
    expect(q('[data-testid="plan-computing"]').hidden).toBe(true);
    expect(rowKeys()).toEqual(expected({ flip: '0' }).res.allocations.map((a) => a.opp.key));
    expect(rowKeys().some((k) => k.startsWith('flip:'))).toBe(false);
    expect(JSON.parse(localStorage.getItem(LS_VIEWPREFS + 'plan')!)).toMatchObject({ flip: '0' });
  });

  it('update(route) re-reads the URL', async () => {
    mount();
    view.update!({ id: 'plan', query: { slots: '1' } });
    await settle();
    expect(Number(q('[data-testid="plan-slot-bar"]').getAttribute('aria-valuemax'))).toBe(1);
    expect(rowKeys()).toEqual(expected({ slots: '1' }).res.allocations.map((a) => a.opp.key));
  });

  it('memoizes: unrelated store changes do not re-run allocate', async () => {
    mount();
    const opps = ctx.derived.opportunities();
    const rows = q('.plan-view [data-key]');
    store.set((s) => ({ settings: { ...s.settings, theme: 'dark' } }));
    await flush();
    expect(ctx.derived.opportunities()).toBe(opps);
    expect(q('[data-testid="plan-computing"]').hidden).toBe(true);
    expect(q('.plan-view [data-key]')).toBe(rows); // same row elements: nothing re-ran
    // a calc setting change does recompute
    store.set((s) => ({ settings: { ...s.settings, orderSlots: 3 } }));
    await flush(80);
    expect(Number(q('[data-testid="plan-slot-bar"]').getAttribute('aria-valuemax'))).toBe(3);
  });

  it('why column explains each row honestly', () => {
    mount();
    const { res, opts } = expected();
    const rows = planRows(res, opts);
    const why = [...root.querySelectorAll<HTMLElement>('.plan-why')];
    expect(why).toHaveLength(rows.length);
    const best = rows.find((r) => r.rank === 1)!;
    const bestEl = q(`[data-key="${CSS.escape(best.key)}"] .plan-why`);
    expect(bestEl.textContent).toContain('coin başına en iyi kâr');
    for (const r of rows) {
      expect(q(`[data-key="${CSS.escape(r.key)}"] .plan-why`).dataset.bound).toBe(whyBound(r.alloc, opts));
    }
  });

  it('whyBound derives volume / share / capital from the allocate() caps', () => {
    const opp: Opportunity = {
      kind: 'flip',
      key: 'flip:X',
      id: 'X',
      name: 'X',
      unitCost: 10,
      profitPerUnit: 1,
      unitsPerHour: 10,
      maxUnits: 100,
      slots: 2,
      risk: { level: 'ok', score: 0, flags: [] },
    };
    const a = (units: number): Allocation => ({ opp, units, capital: units * 10, slots: 2, profitPerHour: units * 0.1 });
    const o = { capital: 10_000, slots: 14, maxShare: 0.5, excludeSuspect: true };
    expect(whyBound(a(100), o)).toBe('volume');
    expect(whyBound(a(40), { ...o, capital: 800 })).toBe('share'); // 0.5 * 800 / 10 = 40
    expect(whyBound(a(30), { ...o, capital: 800 })).toBe('capital');
    expect(whyBound(a(100), { ...o, capital: 0 })).toBe('volume'); // unlimited capital
    expect(sourceHref(opp)).toBe('#/flip?q=X');
    expect(sourceHref({ ...opp, kind: 'book', id: 'ENCHANTMENT_A_2' })).toBe('#/books?q=ENCHANTMENT_A_2');
    expect(sourceHref({ ...opp, kind: 'craft' })).toBe('#/craft?q=X');
    expect(sourceHref({ ...opp, kind: 'npc' })).toBe('#/npc?q=X');
  });

  it('opens the detail panel with opportunity numbers and a source link', () => {
    mount();
    const first = q<HTMLElement>('.plan-view [data-key]');
    first.querySelector<HTMLElement>('td')!.click();
    const panel = q('.kit-panel');
    expect(panel.hidden).toBe(false);
    const key = first.dataset.key!;
    const alloc = expected().res.allocations.find((a) => a.opp.key === key)!;
    expect(q('[data-testid="plan-detail"] dd[data-k="maxUnits"]')).toBeTruthy();
    expect(q('[data-testid="plan-detail"] dd[data-k="unitCost"]').textContent).toBe(fmtCoins(alloc.opp.unitCost));
    expect(q('[data-testid="plan-source"]').getAttribute('href')).toBe(sourceHref(alloc.opp));
    expect(q('[data-testid="plan-why-long"]').textContent!.length).toBeGreaterThan(20);
  });

  it('★ toggles the watchlist from a row', async () => {
    mount();
    const row = q<HTMLElement>('.plan-view [data-key]');
    const id = expected().res.allocations.find((a) => a.opp.key === row.dataset.key)!.opp.id;
    row.querySelector<HTMLElement>('[data-action="watch"]')!.click();
    expect(store.get().watchlist.map((w) => w.id)).toEqual([id]);
    await flush();
    expect(q(`[data-key="${CSS.escape(row.dataset.key!)}"] [data-action="watch"]`).getAttribute('aria-pressed')).toBe('true');
  });

  it('exports CSV of the allocation', () => {
    mount();
    expect(q('[data-tool="csv"]')).toBeTruthy();
  });

  it('shows waiting / catalog states and the suspect toggle', async () => {
    mount(undefined, {});
    expect(q('[data-testid="plan-msg"]').hidden).toBe(false);
    expect(q('[data-testid="plan-msg"]').textContent).toContain('bekleniyor');
    store.set({ snapshot: SNAP, catalogError: 'boom' });
    await flush(80);
    expect(q('[data-testid="plan-msg"]').textContent).toContain('boom');
    store.set({ catalog: CATALOG, catalogError: null });
    await flush(80);
    expect(q('[data-testid="plan-msg"]').hidden).toBe(true);
    expect(rowKeys().length).toBeGreaterThan(0);
    const suspectN = ctx.derived.opportunities().filter((o) => o.risk.level === 'suspect').length;
    const inc = root.querySelector<HTMLButtonElement>('[data-testid="plan-include-suspect"]');
    if (suspectN) {
      inc!.click();
      expect(ctx.setQuery).toHaveBeenCalledWith({ suspect: '0' });
    } else expect(inc).toBeNull();
  });

  it('fill model is read-only with a settings link', () => {
    const spy = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, spy);
    mount();
    expect(q('[data-testid="plan-fill"]').textContent).toContain('Sıralı');
    q<HTMLButtonElement>('[data-testid="plan-settings"]').click();
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_SETTINGS_EVENT, spy);
  });

  it('switches language', async () => {
    mount();
    setLang('en');
    await flush();
    expect(q('h1').textContent).toBe('Planner');
    expect(q('[data-testid="plan-summary"]').textContent).toContain('Total profit / hour');
    expect(q('.plan-why').textContent).toMatch(/profit per coin/);
  });
});
