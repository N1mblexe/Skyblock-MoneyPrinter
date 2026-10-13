// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LS_FUSION, LS_SETTINGS } from '../../src/config.ts';
import { defaultSettings } from '../../src/state/appState.ts';
import { loadFusion, loadSettings, lsGet, lsSet, saveFusion, saveSettings } from '../../src/storage/local.ts';

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
