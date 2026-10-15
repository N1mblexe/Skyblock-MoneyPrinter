// Namespaced i18n over the static locale files in ./locales (registry: ./languages.ts).
//   t('flip.title')                 -> 'Flip finder'
//   t('common.rows', { n: 5 })      -> '{n} rows' with params filled in
// Plurals: keys ending in _one / _other (any CLDR category) are picked by params.count ?? params.n.
// Lookup: active language, then DEFAULT_LANG, then the key itself.
import { DEFAULT_LANG, languageOf, type Lang } from './languages.ts';
import type { TFn } from '../types/contracts.ts';

export { DEFAULT_LANG, LANGUAGES, isLang, type Lang } from './languages.ts';

type Table = Record<string, Record<string, string>>;

let lang: Lang = DEFAULT_LANG;
const listeners = new Set<(l: Lang) => void>();

const lookup = (l: Lang, ns: string, k: string): string | undefined => (languageOf(l).messages as Table)[ns]?.[k];

const pluralRules = new Map<string, Intl.PluralRules>();

/**
 * Plural count of a call: params.count, else params.n. Counts may arrive formatted ("1,234" / "1.234"); they are
 * whole numbers, so dropping every non-digit recovers the value. Anything else (e.g. '?') has no plural form.
 */
function countOf(params: Record<string, string | number> | undefined): number | null {
  const v = params?.count ?? params?.n;
  if (v == null) return null;
  const n = typeof v === 'number' ? v : /\d/.test(v) ? Number(v.replace(/\D/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
}

function resolve(l: Lang, ns: string, k: string, count: number | null): string | undefined {
  if (count != null) {
    const loc = languageOf(l).locale;
    let pr = pluralRules.get(loc);
    if (!pr) pluralRules.set(loc, (pr = new Intl.PluralRules(loc)));
    // <key>_one / _few / … per the language's CLDR rules, then <key>_other
    const p = lookup(l, ns, `${k}_${pr.select(count)}`) ?? lookup(l, ns, `${k}_other`);
    if (p != null) return p;
  }
  // a plural key called without a usable count reads as plural
  return lookup(l, ns, k) ?? lookup(l, ns, `${k}_other`);
}

export const t: TFn = (key, params) => {
  const dot = key.indexOf('.');
  const ns = dot < 0 ? '' : key.slice(0, dot);
  const k = dot < 0 ? key : key.slice(dot + 1);
  const count = countOf(params);
  let s = resolve(lang, ns, k, count) ?? resolve(DEFAULT_LANG, ns, k, count) ?? key;
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
