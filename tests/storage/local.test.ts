// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALERTS,
  LS_ALERT_LOG,
  LS_ALERTS,
  LS_FUSION,
  LS_LAST_ROUTE,
  LS_LEGACY_FUSION,
  LS_LEGACY_TAB,
  LS_SETTINGS,
  LS_WATCH,
} from '../../src/config.ts';
import { defaultSettings } from '../../src/state/appState.ts';
import {
  convertLegacyFusion,
  loadAlertLog,
  loadAlerts,
  loadFusion,
  loadSettings,
  loadWatchlist,
  lsGet,
  lsSet,
  migrateLegacy,
  saveAlertLog,
  saveAlerts,
  saveFusion,
  saveSettings,
  saveWatchlist,
} from '../../src/storage/local.ts';
import type { AlertEvent, AlertRule, FusionRecipe } from '../../src/types/contracts.ts';
import { parseHash } from '../../src/ui/router.ts';

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('local storage helpers', () => {
  it('lsGet/lsSet round-trip and fall back', () => {
    expect(lsGet('k', 5)).toBe(5);
    lsSet('k', { a: 1 });
    expect(lsGet('k', null)).toEqual({ a: 1 });
    localStorage.setItem('bad', '{not json');
    expect(lsGet('bad', 'fb')).toBe('fb');
  });

  it('settings: defaults, sanitized merge, round-trip', () => {
    expect(loadSettings()).toEqual(defaultSettings);
    localStorage.setItem(LS_SETTINGS, JSON.stringify({ lang: 'en', capital: -1, theme: 'dark' }));
    const s = loadSettings();
    expect(s.lang).toBe('en');
    expect(s.theme).toBe('dark');
    expect(s.capital).toBe(defaultSettings.capital);
    saveSettings({ ...defaultSettings, share: 0.2 });
    expect(loadSettings().share).toBe(0.2);
  });

  it('fusion: drops invalid entries', () => {
    expect(loadFusion()).toEqual([]);
    const good = { a: 'SHARD_A', qa: 2, b: 'SHARD_B', qb: 1, out: 'SHARD_C', qo: 1 };
    localStorage.setItem(
      LS_FUSION,
      JSON.stringify([good, { ...good, qa: 0 }, { ...good, out: '' }, { ...good, qb: 'x' }, null, 5, { ...good, extra: 1 }]),
    );
    expect(loadFusion()).toEqual([good, { ...good, out: '' }, good]); // unfinished recipes are kept
    localStorage.setItem(LS_FUSION, '{"a":1}');
    expect(loadFusion()).toEqual([]);
    saveFusion([good]);
    expect(loadFusion()).toEqual([good]);
  });

  it('never throws when localStorage is missing or throws', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadSettings()).toEqual(defaultSettings);
    expect(() => saveSettings(defaultSettings)).not.toThrow();
    expect(loadFusion()).toEqual([]);
    const boom = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom, clear: boom });
    expect(loadSettings()).toEqual(defaultSettings);
    expect(() => saveFusion([])).not.toThrow();
    expect(lsGet('x', 1)).toBe(1);
  });
});

describe('watchlist / alerts validation', () => {
  it('watchlist: drops entries without an id, cleans fields, one entry per id', () => {
    expect(loadWatchlist()).toEqual([]);
    localStorage.setItem(
      LS_WATCH,
      JSON.stringify([
        { id: 'A', addedAt: 5, note: 'n', extra: 1 },
        { id: 'A', addedAt: 6 },
        { id: 'B', addedAt: -1, note: 3 },
        { id: 'C', addedAt: 'x', note: '' },
        { id: '' },
        { id: '   ' },
        { id: 5 },
        null,
        'D',
        [1],
        { id: 'X'.repeat(201) },
      ]),
    );
    expect(loadWatchlist()).toEqual([
      { id: 'A', addedAt: 5, note: 'n' },
      { id: 'B', addedAt: 0 },
      { id: 'C', addedAt: 0 },
    ]);
    localStorage.setItem(LS_WATCH, '{"id":"A"}');
    expect(loadWatchlist()).toEqual([]);
    saveWatchlist([{ id: 'Z', addedAt: 1 }]);
    expect(loadWatchlist()).toEqual([{ id: 'Z', addedAt: 1 }]);
  });

  it('alert rules: types and ranges checked, defaults for repairable fields, one rule per key', () => {
    const good: AlertRule = { key: 'k1', id: 'A', metric: 'ask', op: 'lt', value: 10, enabled: true, cooldownMin: 5, lastFiredAt: 100 };
    localStorage.setItem(
      LS_ALERTS,
      JSON.stringify([
        good,
        { ...good, value: 99 }, // duplicate key
        { ...good, key: 'k2', enabled: 'yes', cooldownMin: -1, lastFiredAt: 'x' },
        { ...good, key: 'k3', cooldownMin: 1e9 },
        { ...good, key: 'b1', metric: 'price' },
        { ...good, key: 'b2', op: 'eq' },
        { ...good, key: 'b3', value: null },
        { ...good, key: 'b4', value: 'NaN' },
        { ...good, key: 'b5', id: '' },
        { ...good, key: '' },
        42,
      ]),
    );
    expect(loadAlerts()).toEqual([
      good,
      { key: 'k2', id: 'A', metric: 'ask', op: 'lt', value: 10, enabled: true, cooldownMin: ALERTS.defaultCooldownMin },
      { key: 'k3', id: 'A', metric: 'ask', op: 'lt', value: 10, enabled: true, cooldownMin: ALERTS.defaultCooldownMin, lastFiredAt: 100 },
    ]);
    saveAlerts([good]);
    expect(loadAlerts()).toEqual([good]);
  });

  it('alert log: invalid events dropped, capped at ALERTS.logMax', () => {
    const ev: AlertEvent = { ruleKey: 'k', id: 'A', metric: 'flipMargin', value: -0.5, at: 7 };
    localStorage.setItem(
      LS_ALERT_LOG,
      JSON.stringify([ev, ev, { ...ev, at: -1 }, { ...ev, value: null }, { ...ev, metric: 'x' }, { ...ev, ruleKey: 1 }, { ...ev, id: '' }]),
    );
    expect(loadAlertLog()).toEqual([ev, ev]);
    localStorage.setItem(LS_ALERT_LOG, JSON.stringify(Array.from({ length: ALERTS.logMax + 5 }, (_, i) => ({ ...ev, at: i }))));
    const log = loadAlertLog();
    expect(log.length).toBe(ALERTS.logMax);
    expect(log[0]!.at).toBe(0);
    saveAlertLog(Array.from({ length: ALERTS.logMax + 5 }, () => ev));
    expect(lsGet<unknown[]>(LS_ALERT_LOG, []).length).toBe(ALERTS.logMax);
  });
});

describe('migrateLegacy', () => {
  const legacy = [
    { a: 'SHARD_A', aq: 2, b: 'SHARD_B', bq: 1, out: 'SHARD_C', oq: 1 },
    { a: '', aq: 1, b: '', bq: 1, out: '', oq: 1 }, // unfinished row: kept, like loadFusion
    { a: 'X', aq: 0, b: 'Y', bq: 1, out: 'Z', oq: 1 }, // invalid qty: dropped
    null,
  ];

  it('converts legacy fusion recipes and the last tab, keeps the legacy keys', () => {
    localStorage.setItem(LS_LEGACY_FUSION, JSON.stringify(legacy));
    localStorage.setItem(LS_LEGACY_TAB, JSON.stringify('craft'));
    migrateLegacy();
    expect(loadFusion()).toEqual([
      { a: 'SHARD_A', qa: 2, b: 'SHARD_B', qb: 1, out: 'SHARD_C', qo: 1 },
      { a: '', qa: 1, b: '', qb: 1, out: '', qo: 1 },
    ]);
    expect(lsGet(LS_LAST_ROUTE, null)).toBe('#/craft');
    expect(localStorage.getItem(LS_LEGACY_FUSION)).not.toBeNull();
    expect(localStorage.getItem(LS_LEGACY_TAB)).not.toBeNull();
  });

  it('round trip: the migrated route parses back to the legacy tab', () => {
    for (const tab of ['flip', 'craft', 'fusion'] as const) {
      localStorage.clear();
      localStorage.setItem(LS_LEGACY_TAB, JSON.stringify(tab));
      migrateLegacy();
      expect(parseHash(lsGet<string>(LS_LAST_ROUTE, ''))).toEqual({ id: tab });
    }
    // and the migrated recipes survive a save/load cycle unchanged
    localStorage.setItem(LS_LEGACY_FUSION, JSON.stringify(legacy.slice(0, 1)));
    migrateLegacy();
    const r = loadFusion();
    saveFusion(r);
    expect(loadFusion()).toEqual(r);
    expect(r.map(convertBack)).toEqual(legacy.slice(0, 1));
  });

  it('is idempotent and never overwrites new data', () => {
    localStorage.setItem(LS_LEGACY_FUSION, JSON.stringify(legacy));
    localStorage.setItem(LS_LEGACY_TAB, JSON.stringify('fusion'));
    migrateLegacy();
    const once = { ...localStorage };
    migrateLegacy();
    expect({ ...localStorage }).toEqual(once);

    // user edits after migration are not clobbered by the (kept) legacy keys
    saveFusion([]);
    lsSet(LS_LAST_ROUTE, '#/books');
    migrateLegacy();
    expect(loadFusion()).toEqual([]);
    expect(lsGet(LS_LAST_ROUTE, null)).toBe('#/books');
  });

  it('ignores unknown tabs and bad legacy data; accepts a bare tab string', () => {
    localStorage.setItem(LS_LEGACY_TAB, JSON.stringify('npc'));
    localStorage.setItem(LS_LEGACY_FUSION, '{not json');
    migrateLegacy();
    expect(localStorage.getItem(LS_LAST_ROUTE)).toBeNull();
    expect(localStorage.getItem(LS_FUSION)).toBeNull();
    localStorage.setItem(LS_LEGACY_TAB, 'flip'); // not JSON
    localStorage.setItem(LS_LEGACY_FUSION, JSON.stringify({ a: 1 }));
    migrateLegacy();
    expect(lsGet(LS_LAST_ROUTE, null)).toBe('#/flip');
    expect(localStorage.getItem(LS_FUSION)).toBeNull();
    expect(convertLegacyFusion('x')).toBeNull();
  });

  it('nothing to do without legacy keys; never throws', () => {
    migrateLegacy();
    expect(localStorage.length).toBe(0);
    vi.stubGlobal('localStorage', undefined);
    expect(() => migrateLegacy()).not.toThrow();
    const boom = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom, clear: boom });
    expect(() => migrateLegacy()).not.toThrow();
  });
});

function convertBack(r: FusionRecipe) {
  return { a: r.a, aq: r.qa, b: r.b, bq: r.qb, out: r.out, oq: r.qo };
}
