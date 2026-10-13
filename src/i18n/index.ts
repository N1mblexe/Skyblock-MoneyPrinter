// Minimal namespaced i18n. Each module registers its own namespace:
//   registerDict('flip', { tr: { title: 'Flip bulucu' }, en: { title: 'Flip finder' } })
//   t('flip.title')  ->  'Flip bulucu'
// Params: t('common.rows', { n: 5 }) with "{n} satır".
import type { Lang, TFn } from '../types/contracts.ts';

export type Dict = Record<string, string>;
const dicts = new Map<string, { tr: Dict; en: Dict }>();
let lang: Lang = 'tr';
const listeners = new Set<(l: Lang) => void>();

export function registerDict(ns: string, d: { tr: Dict; en: Dict }): void {
  dicts.set(ns, d);
}

export const t: TFn = (key, params) => {
  const dot = key.indexOf('.');
  const ns = dot < 0 ? '' : key.slice(0, dot);
  const k = dot < 0 ? key : key.slice(dot + 1);
  const d = dicts.get(ns);
  let s = d?.[lang][k] ?? d?.tr[k] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, p: string) => (p in params ? String(params[p]) : m));
  return s;
};

export const getLang = (): Lang => lang;

export function setLang(l: Lang): void {
  if (l === lang) return;
  lang = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  for (const fn of [...listeners]) fn(l);
}

export function onLangChange(fn: (l: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Keys registered for a namespace (used by TR/EN parity tests). */
export function dictKeys(ns: string): { tr: string[]; en: string[] } {
  const d = dicts.get(ns);
  return { tr: Object.keys(d?.tr ?? {}).sort(), en: Object.keys(d?.en ?? {}).sort() };
}
