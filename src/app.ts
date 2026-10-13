// Bootstrap wiring: settings -> history/cache -> catalog -> shell -> router/views -> poller.
import './i18n/common.ts';
import { createPoller } from './api/poller.ts';
import { toSnapshot, validateRaw } from './api/normalize.ts';
import { loadCatalog } from './data/catalog.ts';
import { setLang, t } from './i18n/index.ts';
import { initialState } from './state/appState.ts';
import { createStore } from './state/store.ts';
import { createHistoryRepo } from './storage/history.ts';
import { loadFusion, loadSettings, saveFusion, saveSettings } from './storage/local.ts';
import type { AppState, Route, Snapshot, View, ViewContext } from './types/contracts.ts';
import { createRouter } from './ui/router.ts';
import { mountShell } from './ui/shell.ts';
import { views } from './ui/views/index.ts';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function bootstrap(root: HTMLElement): Promise<void> {
  const settings = loadSettings();
  setLang(settings.lang);
  const store = createStore<AppState>({ ...initialState(settings), fusion: loadFusion() });
  const history = createHistoryRepo();

  store.subscribe((s, prev) => {
    if (s.settings !== prev.settings) saveSettings(s.settings);
    if (s.fusion !== prev.fusion) saveFusion(s.fusion);
  });

  /** Store a new snapshot and append it to history. */
  async function applySnapshot(snap: Snapshot, status: AppState['status']): Promise<void> {
    store.set({ snapshot: snap, status, lastError: null });
    try {
      await history.record(snap);
      await history.saveLatest(snap);
      store.set((s) => ({ historyTick: s.historyTick + 1 }));
    } catch (e) {
      console.warn('history write failed', e);
    }
  }

  // History + last snapshot from IndexedDB, so the page is useful before the first fetch finishes.
  try {
    await history.init();
    const cached = await history.loadLatest();
    if (cached && !store.get().snapshot) store.set({ snapshot: cached, status: 'cached' });
  } catch (e) {
    console.warn('history unavailable', e);
  }

  // Catalog loads in the background; flips work without it.
  loadCatalog()
    .then((catalog) => store.set({ catalog, catalogError: null }))
    .catch((e) => store.set({ catalogError: errMsg(e) }));

  const poller = createPoller({
    onSnapshot: (snap) => void applySnapshot(snap, 'live'),
    onSuccess: () => store.set({ status: 'live', lastError: null }),
    onError: (e) => store.set({ status: 'error', lastError: e.message }),
    onSchedule: (nextAt) => store.set({ nextPollAt: nextAt }),
  });

  async function refresh(): Promise<void> {
    await poller.refreshNow();
    if (!store.get().settings.autoRefresh) poller.stop();
  }

  function manualLoad(text: string): string | null {
    try {
      const raw = validateRaw(JSON.parse(text));
      void applySnapshot(toSnapshot(raw, Date.now(), 'manual'), 'manual');
      return null;
    } catch (e) {
      return e instanceof SyntaxError ? t('common.manualBadJson') : errMsg(e);
    }
  }

  // ---- shell + views
  let current: View | null = null;
  const navigate = (r: Route) => router.navigate(r);
  const shell = mountShell(root, { store, refresh, navigate, manualLoad });
  const ctx: ViewContext = { store, history, navigate, t, refresh };

  function show(route: Route): void {
    store.set({ route });
    if (current?.id === route.id) {
      current.update?.(route);
      return;
    }
    current?.unmount();
    shell.viewRoot.replaceChildren();
    current = views[route.id]();
    current.mount(shell.viewRoot, ctx, route);
    window.scrollTo?.(0, 0);
  }
  const router = createRouter(show);

  // ---- data source: ?fixture=1 (dev only) uses the test capture, otherwise live polling
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixture')) {
    const raw = (await import('../tests/fixtures/bazaar.json')).default as unknown;
    await applySnapshot(toSnapshot(validateRaw(raw), Date.now(), 'fixture'), 'manual');
    return;
  }

  // start() schedules; refreshNow() guarantees an immediate fetch (in-flight requests are shared).
  if (settings.autoRefresh) poller.start();
  void refresh();

  store.subscribe((s, prev) => {
    if (s.settings.autoRefresh === prev.settings.autoRefresh) return;
    if (s.settings.autoRefresh) poller.start();
    else poller.stop();
  });
}
