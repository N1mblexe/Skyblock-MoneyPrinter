// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LANG, LANGUAGES, getLang, locale, setLang, t } from '../../src/i18n/index.ts';
import { defaultSettings, sanitizeSettings } from '../../src/state/appState.ts';

afterEach(() => setLang(DEFAULT_LANG));

describe('language defaults', () => {
  it('English is the default for the module and for new settings', () => {
    expect(DEFAULT_LANG).toBe('en');
    expect(getLang()).toBe('en');
    expect(defaultSettings.lang).toBe('en');
    expect(sanitizeSettings({}).lang).toBe('en');
  });

  it('a stored language is kept; unknown codes fall back to English', () => {
    expect(sanitizeSettings({ lang: 'tr' }).lang).toBe('tr');
    expect(sanitizeSettings({ lang: 'xx' }).lang).toBe('en');
    expect(sanitizeSettings({ lang: 5 }).lang).toBe('en');
  });

  it('the registry lists English first, with unique codes and a locale each', () => {
    expect(LANGUAGES[0].code).toBe('en');
    expect(new Set(LANGUAGES.map((l) => l.code)).size).toBe(LANGUAGES.length);
    for (const l of LANGUAGES) expect(() => new Intl.NumberFormat(l.locale)).not.toThrow();
  });

  it('setLang updates <html lang>, the tab title and the Intl locale', () => {
    setLang('tr');
    expect(document.documentElement.lang).toBe('tr');
    expect(document.title).toBe('Bazaar Masası');
    expect(locale()).toBe('tr-TR');
    setLang('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe('Bazaar Desk');
    expect(locale()).toBe('en-US');
  });
});

describe('common dict', () => {
  it('has non-empty values and required keys', () => {
    for (const k of ['tab_flip', 'tab_craft', 'tab_fusion', 'tab_npc', 'tableShowing', 'manualBadJson', 'st_live', 'st_error']) {
      setLang('tr');
      const trv = t(`common.${k}`);
      setLang('en');
      const env = t(`common.${k}`);
      expect(trv).not.toBe(`common.${k}`);
      expect(env).not.toBe(`common.${k}`);
    }
    setLang('tr');
    expect(t('common.tab_flip')).toBe('Flip bulucu');
    setLang('en');
    expect(t('common.tab_flip')).toBe('Flip finder');
  });
});
