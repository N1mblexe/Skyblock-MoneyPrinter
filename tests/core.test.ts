import { describe, expect, it } from 'vitest';
import { createStore } from '../src/state/store.ts';
import { sanitizeSettings, defaultSettings } from '../src/state/appState.ts';
import { median, mad, robustZ, pctChange } from '../src/domain/stats.ts';
import { deriveName } from '../src/domain/ids.ts';
import { setLang, t } from '../src/i18n/index.ts';

describe('store', () => {
  it('notifies only on change', () => {
    const s = createStore({ a: 1, b: 2 });
    let n = 0;
    s.subscribe(() => n++);
    s.set({ a: 1 });
    s.set((st) => ({ b: st.b + 1 }));
    expect(n).toBe(1);
    expect(s.get()).toEqual({ a: 1, b: 3 });
  });
});

describe('settings', () => {
  it('sanitizes', () => {
    expect(sanitizeSettings(null)).toEqual(defaultSettings);
    const s = sanitizeSettings({ taxRate: 0.01, capital: -5, lang: 'en', share: 2 });
    expect(s.taxRate).toBe(0.01);
    expect(s.capital).toBe(defaultSettings.capital);
    expect(s.share).toBe(defaultSettings.share);
    expect(s.lang).toBe('en');
  });
});

describe('stats', () => {
  it('median/mad/z', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    expect(robustZ(5, 2, 0)).toBeNaN();
    expect(pctChange(100, 110)).toBeCloseTo(0.1);
    expect(pctChange(0, 1)).toBeNull();
  });
});

describe('deriveName', () => {
  it.each([
    ['ENCHANTMENT_LIFE_STEAL_2', 'Life Steal II'],
    ['ENCHANTMENT_ULTIMATE_WISE_1', 'Ultimate Wise I'],
    ['SHARD_BLUE_JAY', 'Blue Jay Shard'],
    ['LOG:1', 'Log (1)'],
    ['ENCHANTED_GOLD', 'Enchanted Gold'],
  ])('%s', (id, name) => expect(deriveName(id)).toBe(name));
});

describe('i18n', () => {
  it('translates with params, follows the language and returns unknown keys as-is', () => {
    setLang('tr');
    expect(t('common.rows', { n: 2 })).toBe('2 satır');
    setLang('en');
    expect(t('common.rows', { n: 2 })).toBe('2 rows');
    expect(t('common.rows')).toBe('{n} rows');
    expect(t('nope.missing')).toBe('nope.missing');
    expect(t('common.missing')).toBe('common.missing');
    setLang('tr');
  });
});
