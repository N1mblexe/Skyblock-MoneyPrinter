// Errors the UI can show in the active language. A LocalizedError carries a translation key + params; its
// Error.message is the English text, so logs and non-UI callers (scripts, tests) read the same message as before.
import { en } from './locales/en/index.ts';

export type MsgParams = Record<string, string | number>;

/** Text rendered in the active language when shown: a key + params, or raw text from a foreign error. */
export type Msg = string | { key: string; params?: MsgParams };

function english(key: string, params?: MsgParams): string {
  const [ns, k] = key.split('.', 2) as [string, string];
  const s = (en as Record<string, Record<string, string>>)[ns]?.[k] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (m, p: string) => (p in params ? String(params[p]) : m)) : s;
}

export class LocalizedError extends Error {
  readonly key: string;
  readonly params?: MsgParams;
  constructor(key: string, params?: MsgParams) {
    super(english(key, params));
    this.key = key;
    this.params = params;
  }
}

/** What to keep in state for an error: the key of a LocalizedError, otherwise its message. */
export const msgOf = (e: unknown): Msg =>
  e instanceof LocalizedError ? { key: e.key, ...(e.params ? { params: e.params } : {}) } : e instanceof Error ? e.message : String(e);

/** Error message text for logs and nested params (English for LocalizedError). */
export const errDetail = (e: unknown): string => (e instanceof Error ? e.message : String(e));
