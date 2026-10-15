// Shared setup for the shell tests (not a test file itself).
import { vi } from 'vitest';
import { defaultSettings, initialState } from '../../../src/state/appState.ts';
import { createStore } from '../../../src/state/store.ts';
import type { AppState, Snapshot, Store } from '../../../src/types/contracts.ts';
import { currentPalette } from '../../../src/ui/kit/index.ts';
import { mountShell, type ShellContext, type ShellHandle } from '../../../src/ui/shell.ts';
import { setLang } from '../../../src/i18n/index.ts';

export interface Harness {
  store: Store<AppState>;
  root: HTMLElement;
  ctx: ShellContext & {
    refresh: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
    toast: ReturnType<typeof vi.fn>;
    manualLoad: ReturnType<typeof vi.fn> & ((text: string) => string | null);
  };
  shell: ShellHandle | null;
  mount(): ShellHandle;
  q<E extends Element = HTMLElement>(sel: string): E;
  qa<E extends Element = HTMLElement>(sel: string): E[];
}

export function snap(lastUpdated: number, products: Snapshot['products'] = {}): Snapshot {
  return { lastUpdated, fetchedAt: lastUpdated, source: 'live', products };
}

/** Fresh store + root + ctx; call h.mount() to mount the shell. */
export function harness(state: Partial<AppState> = {}): Harness {
  // The shell suites check Turkish rendering; the English default is covered in tests/ui/i18n.test.ts and the integration tests.
  setLang('tr');
  const store = createStore<AppState>({ ...initialState({ ...defaultSettings, lang: 'tr' }), ...state });
  const root = document.createElement('div');
  document.body.append(root);
  const ctx = {
    store,
    refresh: vi.fn(async () => {}),
    navigate: vi.fn(),
    manualLoad: vi.fn(() => null as string | null),
    toast: vi.fn(),
  };
  const h: Harness = {
    store,
    root,
    ctx,
    shell: null,
    mount() {
      h.shell = mountShell(root, ctx);
      return h.shell;
    },
    // document-wide: drawers, the palette and toasts live under <body>
    q: <E extends Element = HTMLElement>(sel: string) => document.querySelector<E>(sel)!,
    qa: <E extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<E>(sel)],
  };
  return h;
}

export function teardown(h: Harness | null): void {
  currentPalette()?.close();
  h?.shell?.destroy();
  document.body.innerHTML = '';
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
  setLang('tr');
}

/** Dispatch a keydown on target (default: body) like a real key press. */
export function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

/** A MediaQueryList stand-in whose `matches` is fixed (for the mobile layout). */
export function mockMatchMedia(mobile: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('max-width') ? mobile : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

export const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
