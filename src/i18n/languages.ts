// The languages the app ships. To add one, copy src/i18n/locales/en to locales/<code>, translate it and add an
// entry here (see src/i18n/README.md). The first-time default and the fallback for missing keys is DEFAULT_LANG.
import { en, type Messages } from './locales/en/index.ts';
import { tr } from './locales/tr/index.ts';

export interface LanguageDef {
  /** settings value, <html lang>, data-lang / testid suffix */
  code: string;
  /** native name, shown in the language picker */
  name: string;
  /** BCP 47 locale for Intl number, date, plural and list formatting */
  locale: string;
  messages: Messages;
}

export const LANGUAGES = [
  { code: 'en', name: 'English', locale: 'en-US', messages: en },
  { code: 'tr', name: 'Türkçe', locale: 'tr-TR', messages: tr },
] as const satisfies readonly LanguageDef[];

export type Lang = (typeof LANGUAGES)[number]['code'];

export const DEFAULT_LANG: Lang = 'en';

export const isLang = (x: unknown): x is Lang => LANGUAGES.some((l) => l.code === x);

export const languageOf = (code: Lang): LanguageDef => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0];
