// Bootstrap wiring: settings -> history/cache -> catalog -> shell -> router/views -> poller.
import { createAhSalesPoller } from './api/ahSales.ts';
import { createAhScanner } from './api/auctions.ts';
import { createElectionPoller } from './api/election.ts';
import { createPoller } from './api/poller.ts';
import { LS_LAST_ROUTE } from './config.ts';
import { toSnapshot, validateRaw } from './api/normalize.ts';
import { loadCatalog } from './data/catalog.ts';
import { msgOf, msgText, setLang, t } from './i18n/index.ts';
import { startAlerts } from './state/alertsRunner.ts';
import { startOrderWatch } from './state/ordersRunner.ts';
import { initialState } from './state/appState.ts';
import { createDerived } from './state/derived.ts';
import { createStore } from './state/store.ts';
import { createHistoryRepo } from './storage/history.ts';
import {
  loadAlertLog,
  loadAlerts,
  loadFusion,
  loadJournal,
  loadOppAlerts,
  loadOrders,
  loadSettings,
  loadWatchlist,
  lsGet,
  lsSet,
  migrateLegacy,
  saveAlertLog,
  saveAlerts,
  saveFusion,
  saveJournal,
  saveOppAlerts,
  saveOrders,
  saveSettings,
  saveWatchlist,
} from './storage/local.ts';
import type { AppState, Route, Snapshot, ToastKind, View, ViewContext } from './types/contracts.ts';
import { toast as kitToast } from './ui/kit/index.ts';
import { createRouter, parseHash, routeToHash } from './ui/router.ts';
import { mountShell } from './ui/shell.ts';
import { views } from './ui/views/index.ts';


export async function bootstrap(root: HTMLElement): Promise<void> {
  migrateLegacy();
  const settings = loadSettings();
  setLang(settings.lang);
  const store = createStore<AppState>({
    ...initialState(settings),
    fusion: loadFusion(),
    watchlist: loadWatchlist(),
    oppAlerts: loadOppAlerts(),
    orders: loadOrders(),
    journal: loadJournal(),
    alerts: loadAlerts(),
    alertLog: loadAlertLog(),
  });
  const history = createHistoryRepo();
  const derived = createDerived(store, history);

  store.subscribe((s, prev) => {
    if (s.settings !== prev.settings) saveSettings(s.settings);
    if (s.fusion !== prev.fusion) saveFusion(s.fusion);
    if (s.watchlist !== prev.watchlist) saveWatchlist(s.watchlist);
    if (s.oppAlerts !== prev.oppAlerts) saveOppAlerts(s.oppAlerts);
    if (s.orders !== prev.orders) saveOrders(s.orders);
    if (s.journal !== prev.journal) saveJournal(s.journal);
    if (s.alerts !== prev.alerts) saveAlerts(s.alerts);
    if (s.alertLog !== prev.alertLog) saveAlertLog(s.alertLog);
  });

  const toast = (msg: string, kind: ToastKind = 'info') => void kitToast(msg, kind);
  const watch = {
    has: (id: string) => store.get().watchlist.some((w) => w.id === id),
    toggle(id: string) {
      store.set((s) =>
        s.watchlist.some((w) => w.id === id)
          ? { watchlist: s.watchlist.filter((w) => w.id !== id) }
          : { watchlist: [...s.watchlist, { id, addedAt: Date.now() }] },
      );
    },
  };

  /**
   * Append a snapshot to history, then show it: one store update (snapshot + historyTick), so every derived result
   * is computed once per snapshot and the alert runner sees stats that include it. A failed history write still
   * shows the snapshot. The latest-snapshot cache is written in the background.
   */
  async function applySnapshot(snap: Snapshot, status: AppState['status']): Promise<void> {
    let recorded = true;
    try {
      await history.record(snap);
    } catch (e) {
      recorded = false;
      console.warn('history write failed', e);
    }
    store.set((s) => ({ snapshot: snap, status, lastError: null, historyTick: recorded ? s.historyTick + 1 : s.historyTick }));
    history.saveLatest(snap).catch((e: unknown) => console.warn('saving latest snapshot failed', e));
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
    .catch((e) => store.set({ catalogError: msgOf(e) }));

  const poller = createPoller({
    onSnapshot: (snap) => void applySnapshot(snap, 'live'),
    onSuccess: () => store.set({ status: 'live', lastError: null }),
    onError: (e) => store.set({ status: 'error', lastError: msgOf(e) }),
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
      return e instanceof SyntaxError ? t('common.manualBadJson') : msgText(msgOf(e));
    }
  }

  // ---- shell + views
  let current: View | null = null;
  const navigate = (r: Route) => router.navigate(r);
  const shell = mountShell(root, { store, refresh, navigate, manualLoad, history, toast, scanAh: () => void ah.scanNow() });
  const setQuery = (patch: Record<string, string | undefined>) => {
    const cur = router.current();
    const query: Record<string, string> = { ...cur.query };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') delete query[k];
      else query[k] = v;
    }
    const next: Route = { ...cur, query };
    if (!Object.keys(query).length) delete next.query;
    router.replace(next);
  };
  const ctx: ViewContext = { store, history, navigate, t, refresh, derived, setQuery, toast, watch };

  function show(route: Route): void {
    store.set({ route });
    if (route.id !== 'item') lsSet(LS_LAST_ROUTE, routeToHash(route));
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
  const router = createRouter(show, () => {
    const h = lsGet<unknown>(LS_LAST_ROUTE, null);
    return typeof h === 'string' && h ? parseHash(h) : null;
  });

  // ---- alerts, auction house, election
  const notify = (title: string, body: string) => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body });
  };
  startAlerts({ store, derived, toast, notify });
  startOrderWatch({ store, toast, notify });
  const ah = createAhScanner({
    onSnapshot: (snap) => store.set({ ah: snap }),
    onProgress: (p) => store.set({ ahProgress: p }),
    onError: (e) => console.warn('AH scan failed', e),
    enabled: () => store.get().settings.ahEnabled,
  });
  // realized AH sales; follows the "Auction house scan" toggle like the scanner. Turning the AH off keeps the last
  // summary in the store, as it keeps store.ah: derived ignores both while settings.ahEnabled is off.
  const ahSales = createAhSalesPoller({
    onUpdate: (s) => store.set({ ahSales: s }),
    onError: (e) => console.warn('AH sales fetch failed', e),
    enabled: () => store.get().settings.ahEnabled,
  });
  const election = createElectionPoller({
    onInfo: (info) => store.set({ election: info }),
    onError: (e) => console.warn('election fetch failed', e),
  });

  // ---- data source: ?fixture=1 (dev only) uses the test capture, otherwise live polling
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixture')) {
    const raw = (await import('../tests/fixtures/bazaar.json')).default as unknown;
    await applySnapshot(toSnapshot(validateRaw(raw), Date.now(), 'fixture'), 'manual');
    return;
  }

  // start() schedules; refreshNow() guarantees an immediate fetch (in-flight requests are shared).
  if (settings.autoRefresh) poller.start();
  void refresh();

  void ah.loadCached().then((c) => c && !store.get().ah && store.set({ ah: c }));
  ahSales
    .loadCached()
    .then((c) => c && !store.get().ahSales && store.set({ ahSales: c }))
    .catch((e: unknown) => console.warn('loading AH sales failed', e));
  if (settings.ahEnabled) {
    ah.start();
    ahSales.start();
  }
  election.start();
  store.subscribe((s, prev) => {
    if (s.settings.ahEnabled === prev.settings.ahEnabled) return;
    if (s.settings.ahEnabled) {
      ah.start();
      void ah.scanNow();
      ahSales.start();
    } else {
      ah.stop();
      ahSales.stop();
    }
  });

  store.subscribe((s, prev) => {
    if (s.settings.autoRefresh === prev.settings.autoRefresh) return;
    if (s.settings.autoRefresh) poller.start();
    else poller.stop();
  });
}
