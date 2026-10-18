// @vitest-environment happy-dom
// The Data section's AH sales store box (size + clear), mounted on its own; the rest of the section is covered
// through the shell in data.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang } from '../../../src/i18n/index.ts';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AhSalesSnapshot, AppState, Store } from '../../../src/types/contracts.ts';
import { CLEAR_CONFIRM_MS, createDataPanel, type DataPanel, type SalesStoreAccess } from '../../../src/ui/shell/dataPanel.ts';

let store: Store<AppState>;
let panel: DataPanel | null = null;
const toast = vi.fn();

const SALES: AhSalesSnapshot = { v: 1, updatedAt: 0, coverageHours: 2, byId: {} };

function salesAccess(over: Partial<SalesStoreAccess> = {}) {
  let info = { sales: 1234, ids: 56, coverageHours: 7.25 };
  const access = {
    info: vi.fn(async () => info),
    clear: vi.fn(async () => {
      info = { sales: 0, ids: 0, coverageHours: 0 };
    }),
    ...over,
  };
  return access;
}

/** mount, then refresh() as the shell does when the drawer opens */
function mount(sales?: SalesStoreAccess): HTMLElement {
  panel = createDataPanel({ store, toast, ...(sales ? { sales } : {}) });
  document.body.append(panel.el);
  panel.refresh();
  return panel.el;
}
const box = () => document.querySelector<HTMLElement>('[data-testid="sales-store"]')!;
const btn = () => document.querySelector<HTMLButtonElement>('[data-testid="sales-clear"]')!;

beforeEach(() => {
  setLang('en');
  store = createStore<AppState>({ ...initialState({ ...defaultSettings }), ahSales: SALES });
  toast.mockReset();
});
afterEach(() => {
  panel?.destroy();
  panel = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('data panel: AH sales store', () => {
  it('is hidden without access to the store', () => {
    mount();
    expect(box().hidden).toBe(true);
  });

  it('shows the stored sales, items and coverage', async () => {
    const access = salesAccess();
    mount(access);
    expect(box().hidden).toBe(false);
    expect(box().querySelector('h4')!.textContent).toBe('AH sales store');
    expect(box().textContent).toContain('Loading');
    await vi.waitFor(() => expect(box().textContent).toContain('Sales stored1,234'));
    expect(box().textContent).toContain('Items56');
    expect(box().textContent).toContain('7.3 h of the sales feed');
    expect(btn().textContent).toBe('Clear AH sales');
    setLang('tr');
    expect(box().querySelector('h4')!.textContent).toBe('AH satış kayıtları');
  });

  it('reads the store only on refresh() and new sales summaries, never at mount', async () => {
    const access = salesAccess();
    const early = createDataPanel({ store, toast, sales: access });
    expect(access.info).not.toHaveBeenCalled();
    early.destroy();
    mount(access);
    await vi.waitFor(() => expect(access.info).toHaveBeenCalledTimes(1));
    store.set({ ahSales: { ...SALES, updatedAt: 1 } });
    expect(access.info).toHaveBeenCalledTimes(2);
    store.set({ ahSales: null });
    expect(access.info).toHaveBeenCalledTimes(2);
    panel!.refresh();
    expect(access.info).toHaveBeenCalledTimes(3);
  });

  it('clears after a confirming second click, drops the summary and toasts', async () => {
    const access = salesAccess();
    mount(access);
    await vi.waitFor(() => expect(box().textContent).toContain('1,234'));
    btn().click();
    expect(access.clear).not.toHaveBeenCalled();
    expect(btn().textContent).toContain('Click again');
    expect(btn().classList.contains('confirming')).toBe(true);
    btn().click();
    await vi.waitFor(() => expect(access.clear).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('AH sales cleared.', 'ok'));
    expect(store.get().ahSales).toBeNull();
    await vi.waitFor(() => expect(box().textContent).toContain('Sales stored0'));
    expect(btn().textContent).toBe('Clear AH sales');
  });

  it('the confirmation times out', async () => {
    vi.useFakeTimers();
    const access = salesAccess();
    mount(access);
    btn().click();
    expect(btn().textContent).toContain('Click again');
    vi.advanceTimersByTime(CLEAR_CONFIRM_MS + 1);
    expect(btn().textContent).toBe('Clear AH sales');
    btn().click();
    expect(access.clear).not.toHaveBeenCalled();
  });

  it('reports a failed clear and an unavailable store', async () => {
    const access = salesAccess({ clear: vi.fn(() => Promise.reject<void>(new Error('blocked'))) });
    mount(access);
    btn().click();
    btn().click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('Could not clear AH sales: blocked', 'err'));
    expect(store.get().ahSales).toBe(SALES);
    panel!.destroy();
    document.body.innerHTML = '';
    mount(salesAccess({ info: vi.fn(() => Promise.reject<{ sales: number; ids: number; coverageHours: number }>(new Error('no idb'))) }));
    await vi.waitFor(() => expect(box().textContent).toContain('not available'));
    expect(btn().disabled).toBe(true);
  });

  it('ignores answers that arrive after destroy', async () => {
    type Info = { sales: number; ids: number; coverageHours: number };
    let resolve!: (v: Info) => void;
    const access = salesAccess({ info: vi.fn(() => new Promise<Info>((r) => (resolve = r))) });
    const el = mount(access);
    panel!.destroy();
    panel = null;
    resolve({ sales: 9, ids: 9, coverageHours: 9 });
    await Promise.resolve();
    expect(el.textContent).not.toContain('Sales stored9');
  });
});
