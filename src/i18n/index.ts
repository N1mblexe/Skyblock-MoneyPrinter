// Namespaced i18n over the static locale files in ./locales (registry: ./languages.ts).
//   t('flip.title')                 -> 'Flip finder'
//   t('common.rows', { n: 5 })      -> '{n} rows' with params filled in
// Lookup: active language, then DEFAULT_LANG, then the key itself.
import { DEFAULT_LANG, languageOf, type Lang } from './languages.ts';
import type { TFn } from '../types/contracts.ts';

export { DEFAULT_LANG, LANGUAGES, isLang, type Lang } from './languages.ts';

type Table = Record<string, Record<string, string>>;

let lang: Lang = DEFAULT_LANG;
const listeners = new Set<(l: Lang) => void>();

const lookup = (l: Lang, ns: string, k: string): string | undefined => (languageOf(l).messages as Table)[ns]?.[k];

export const t: TFn = (key, params) => {
  const dot = key.indexOf('.');
  const ns = dot < 0 ? '' : key.slice(0, dot);
  const k = dot < 0 ? key : key.slice(dot + 1);
  let s = lookup(lang, ns, k) ?? lookup(DEFAULT_LANG, ns, k) ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, p: string) => (p in params ? String(params[p]) : m));
  return s;
};

export const getLang = (): Lang => lang;

/** BCP 47 locale of the active language, for Intl formatters. */
export const locale = (): string => languageOf(lang).locale;

export function setLang(l: Lang): void {
  const changed = l !== lang;
  lang = l;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l;
    document.title = t('common.appTitle');
  }
  if (changed) for (const fn of [...listeners]) fn(l);
}

export function onLangChange(fn: (l: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
