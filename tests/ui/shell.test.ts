// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../src/state/store.ts';
import { initialState, defaultSettings } from '../../src/state/appState.ts';
import type { AppState, Snapshot, Store } from '../../src/types/contracts.ts';
import { getLang, setLang } from '../../src/i18n/index.ts';
import { mountShell, type ShellContext } from '../../src/ui/shell.ts';

let store: Store<AppState>;
let root: HTMLElement;
let shell: { viewRoot: HTMLElement; destroy(): void } | null = null;
let ctx: ShellContext;

function snap(lastUpdated: number): Snapshot {
  return { lastUpdated, fetchedAt: lastUpdated, source: 'live', products: {} };
}
const q = <E extends Element = HTMLElement>(sel: string) => root.querySelector<E>(sel)!;
const tabTexts = () => [...root.querySelectorAll('.tabs .tab')].map((a) => a.textContent);

beforeEach(() => {
  setLang('tr');
  store = createStore(initialState({ ...defaultSettings }));
  root = document.createElement('div');
  document.body.append(root);
  ctx = {
    store,
    refresh: vi.fn(async () => {}),
    navigate: vi.fn(),
    manualLoad: vi.fn(() => null),
  };
});
afterEach(() => {
  shell?.destroy();
  shell = null;
  document.body.innerHTML = '';
  delete document.documentElement.dataset.theme;
  setLang('tr');
});

describe('mountShell', () => {
  it('renders header, tabs, view root and footer in Turkish', () => {
    shell = mountShell(root, ctx);
    expect(q('h1').textContent).toBe('Bazaar Masası');
    expect(q('h1 span').textContent).toBe('Masası');
    expect(tabTexts()).toEqual(['Flip bulucu', 'Craft flip', 'Shard fusion', 'NPC flip']);
    expect(q('[data-testid="tab-flip"]').getAttribute('aria-selected')).toBe('true');
    expect(shell.viewRoot.children).toHaveLength(0);
    expect(root.contains(shell.viewRoot)).toBe(true);
    expect(q('footer').textContent).toContain('macro');
    expect(q('[data-testid="status-pill"]').dataset.status).toBe('loading');
    expect(q('[data-testid="manual-load"]').tagName).toBe('DETAILS');
    expect(q<HTMLDetailsElement>('[data-testid="manual-load"]').open).toBe(false);
  });

  it('switches language from the toggle and re-renders labels', () => {
    shell = mountShell(root, ctx);
    q('[data-testid="lang-en"]').click();
    expect(store.get().settings.lang).toBe('en');
    expect(getLang()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(tabTexts()).toEqual(['Flip finder', 'Craft flip', 'Shard fusion', 'NPC flip']);
    expect(q('[data-testid="lang-en"]').getAttribute('aria-pressed')).toBe('true');
    expect(q('.refresh-lbl').textContent).toBe('Refresh');
    expect(q('.settings-panel summary').textContent).toContain('Global settings');
    expect(q('[data-field="capital"] .field-label').textContent).toBe('Capital (coins)');
    expect(q('[data-testid="status-pill"]').textContent).toBe('Loading');
    q('[data-testid="lang-tr"]').click();
    expect(tabTexts()[0]).toBe('Flip bulucu');
  });

  it('applies initial lang from settings', () => {
    store.set((s) => ({ settings: { ...s.settings, lang: 'en' } }));
    shell = mountShell(root, ctx);
    expect(getLang()).toBe('en');
    expect(q('h1').textContent).toBe('Bazaar Desk');
  });

  it('applies theme to <html data-theme>', () => {
    shell = mountShell(root, ctx);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    q('[data-theme-set="dark"]').click();
    expect(store.get().settings.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    store.set((s) => ({ settings: { ...s.settings, theme: 'light' } }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(q('[data-theme-set="light"]').getAttribute('aria-pressed')).toBe('true');
    q('[data-theme-set="auto"]').click();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('tab click navigates; active tab follows route; item highlights nothing', () => {
    shell = mountShell(root, ctx);
    q('[data-testid="tab-craft"]').click();
    expect(ctx.navigate).toHaveBeenCalledWith({ id: 'craft' });
    store.set({ route: { id: 'npc' } });
    expect(q('[data-testid="tab-npc"]').getAttribute('aria-selected')).toBe('true');
    expect(q('[data-testid="tab-flip"]').getAttribute('aria-selected')).toBe('false');
    store.set({ route: { id: 'item', param: 'X' } });
    expect(root.querySelectorAll('.tab[aria-selected="true"]')).toHaveLength(0);
  });

  it('refresh button calls ctx.refresh with busy state', async () => {
    let resolve!: () => void;
    ctx.refresh = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    shell = mountShell(root, ctx);
    const btn = q<HTMLButtonElement>('[data-testid="refresh-btn"]');
    btn.click();
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('Yenileniyor');
    btn.click();
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    resolve();
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
    expect(btn.textContent).toContain('Yenile');
  });

  it('shows catalog error banner', () => {
    shell = mountShell(root, ctx);
    const banner = q('.catalog-banner');
    expect(banner.hidden).toBe(true);
    store.set({ catalogError: 'HTTP 404' });
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('HTTP 404');
  });

  it('auto-opens manual load on error without snapshot', () => {
    shell = mountShell(root, ctx);
    const panel = q<HTMLDetailsElement>('[data-testid="manual-load"]');
    store.set({ status: 'error', lastError: 'Failed to fetch' });
    expect(panel.open).toBe(true);
    const pill = q('[data-testid="status-pill"]');
    expect(pill.dataset.status).toBe('error');
    expect(pill.title).toContain('Failed to fetch');
    expect(q('.status-err').textContent).toBe('Failed to fetch');
  });

  it('manual paste calls ctx.manualLoad and shows the error', () => {
    ctx.manualLoad = vi.fn(() => 'bad json');
    shell = mountShell(root, ctx);
    const zone = q('.paste');
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', { value: { getData: () => '{"x":1}' } });
    zone.dispatchEvent(ev);
    expect(ctx.manualLoad).toHaveBeenCalledWith('{"x":1}');
    expect(q('.msg').textContent).toBe('bad json');
    expect(q('.msg').classList.contains('err')).toBe(true);
    (ctx.manualLoad as ReturnType<typeof vi.fn>).mockReturnValue(null);
    zone.dispatchEvent(ev);
    expect(q('.msg').textContent).toBe('Veri yüklendi.');
  });

  it('destroy cleans up', () => {
    shell = mountShell(root, ctx);
    shell.destroy();
    shell = null;
    expect(root.children).toHaveLength(0);
    store.set({ catalogError: 'x' });
  });
});

describe('status pill', () => {
  it('shows freshness from snapshot age and countdown', () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);
      store.set({ status: 'live', snapshot: snap(now - 30_000), nextPollAt: now + 40_000 });
      shell = mountShell(root, ctx);
      const pill = q('[data-testid="status-pill"]');
      expect(pill.dataset.status).toBe('live');
      expect(pill.textContent).toBe('Canlı');
      expect(q('.status-age').textContent).toBe('veri 30 sn önce');
      expect(q('.status-next').textContent).toBe('yenileme 40 sn');
      vi.advanceTimersByTime(5000);
      expect(q('.status-age').textContent).toBe('veri 35 sn önce');
      expect(q('.status-next').textContent).toBe('yenileme 35 sn');
      // snapshot ages past thresholds while fetches "succeed"
      vi.advanceTimersByTime(4 * 60_000);
      expect(pill.dataset.status).toBe('stale');
      vi.advanceTimersByTime(10 * 60_000);
      expect(pill.dataset.status).toBe('old');
      store.set({ status: 'cached' });
      expect(pill.dataset.status).toBe('cached');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('settings panel', () => {
  it('writes validated values to the store', () => {
    shell = mountShell(root, ctx);
    const set = (name: string, value: string) => {
      const el = q<HTMLInputElement>(`[name="${name}"]`);
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el;
    };
    set('share', '10');
    expect(store.get().settings.share).toBeCloseTo(0.1);
    set('capital', '12m');
    expect(store.get().settings.capital).toBe(12_000_000);
    expect(q<HTMLInputElement>('[name="capital"]').value).toBe('12.000.000');
    set('capital', '3.500.000');
    expect(store.get().settings.capital).toBe(3_500_000);
    set('taxRate', '0.01125');
    expect(store.get().settings.taxRate).toBe(0.01125);
    set('sellMode', 'insta');
    expect(store.get().settings.sellMode).toBe('insta');
    const bad = set('forgeSlots', '99');
    expect(store.get().settings.forgeSlots).toBe(defaultSettings.forgeSlots);
    expect(bad.getAttribute('aria-invalid')).toBe('true');
    const cb = q<HTMLInputElement>('[name="hideSuspicious"]');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().settings.hideSuspicious).toBe(false);
    // external change syncs into the form
    store.set((s) => ({ settings: { ...s.settings, cycleHours: 4 } }));
    expect(q<HTMLInputElement>('[name="cycleHours"]').value).toBe('4');
  });
});
