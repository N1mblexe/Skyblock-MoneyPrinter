import { FILL_MODEL_DEFAULT, NPC_DAILY_LIMIT_DEFAULT, ORDER_SLOTS_DEFAULT, ORDER_SLOTS_MAX } from '../config.ts';
import { DEFAULT_LANG, isLang } from '../i18n/languages.ts';
import type { AppState, Settings } from '../types/contracts.ts';

export const defaultSettings: Settings = {
  taxRate: 0.0125,
  capital: 5_000_000,
  share: 0.05,
  cycleHours: 1,
  costMode: 'order',
  sellMode: 'offer',
  forgeSlots: 2,
  hideSuspicious: true,
  autoRefresh: true,
  lang: DEFAULT_LANG,
  // dark-first terminal look; 'auto' follows the system
  theme: 'dark',
  orderSlots: ORDER_SLOTS_DEFAULT,
  npcDailyLimit: NPC_DAILY_LIMIT_DEFAULT,
  fillModel: FILL_MODEL_DEFAULT,
  density: 'comfortable',
  notify: false,
  ahEnabled: true,
};

/** Merge persisted (possibly partial/invalid) settings over defaults. */
export function sanitizeSettings(raw: unknown): Settings {
  const s = { ...defaultSettings };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  const num = (k: keyof Settings, min: number, max: number) => {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) (s as any)[k] = v;
  };
  if (r.taxRate === 0.0125 || r.taxRate === 0.01125 || r.taxRate === 0.01) s.taxRate = r.taxRate;
  num('capital', 0, 1e13);
  num('share', 0, 1);
  num('cycleHours', 0.05, 168);
  num('forgeSlots', 1, 7);
  num('orderSlots', 1, ORDER_SLOTS_MAX);
  num('npcDailyLimit', 1, 1e7);
  if (r.fillModel === 'sequential' || r.fillModel === 'pipelined') s.fillModel = r.fillModel;
  if (r.density === 'comfortable' || r.density === 'compact') s.density = r.density;
  if (typeof r.notify === 'boolean') s.notify = r.notify;
  if (typeof r.ahEnabled === 'boolean') s.ahEnabled = r.ahEnabled;
  if (r.costMode === 'order' || r.costMode === 'insta') s.costMode = r.costMode;
  if (r.sellMode === 'offer' || r.sellMode === 'insta') s.sellMode = r.sellMode;
  if (typeof r.hideSuspicious === 'boolean') s.hideSuspicious = r.hideSuspicious;
  if (typeof r.autoRefresh === 'boolean') s.autoRefresh = r.autoRefresh;
  if (isLang(r.lang)) s.lang = r.lang;
  if (r.theme === 'auto' || r.theme === 'light' || r.theme === 'dark') s.theme = r.theme;
  return s;
}

export function initialState(settings: Settings = defaultSettings): AppState {
  return {
    snapshot: null,
    status: 'loading',
    lastError: null,
    catalog: null,
    catalogError: null,
    settings,
    fusion: [],
    route: { id: 'overview' },
    historyTick: 0,
    nextPollAt: null,
    watchlist: [],
    alerts: [],
    alertLog: [],
    ah: null,
    ahProgress: null,
    election: null,
  };
}
