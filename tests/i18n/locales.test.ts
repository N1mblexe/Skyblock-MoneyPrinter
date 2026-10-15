// Guards for the language system (src/i18n): every locale matches English, every literal key used in the code
// exists, and no Turkish text lives outside the Turkish locale.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, LocalizedError, msgOf, msgText, setLang, t } from '../../src/i18n/index.ts';
import { en } from '../../src/i18n/locales/en/index.ts';

type Table = Record<string, Record<string, string>>;
const EN = en as Table;
const SRC = join(import.meta.dirname, '..', '..', 'src');
const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}
/** Source without comments, so prose in comments doesn't count as UI text. */
const code = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('locales', () => {
  for (const lang of LANGUAGES) {
    describe(lang.code, () => {
      const msgs = lang.messages as Table;

      it('has exactly the namespaces and keys of English', () => {
        expect(Object.keys(msgs).sort()).toEqual(Object.keys(EN).sort());
        for (const ns of Object.keys(EN)) expect(Object.keys(msgs[ns]!).sort(), ns).toEqual(Object.keys(EN[ns]!).sort());
      });

      it('has no empty strings and the same {params} as English', () => {
        for (const [ns, d] of Object.entries(msgs)) {
          for (const [k, v] of Object.entries(d)) {
            // empty only where English is deliberately empty (e.g. a blank column header)
            if (EN[ns]![k] !== '') expect(v.trim(), `${lang.code} ${ns}.${k}`).not.toBe('');
            // a singular form may spell out the count ("one recipe") instead of using {n}
            const want = params(EN[ns]![k]!).filter((p) => !(k.endsWith('_one') && p === 'n'));
            const got = params(v).filter((p) => !(k.endsWith('_one') && p === 'n'));
            expect(got, `${lang.code} ${ns}.${k}`).toEqual(want);
          }
        }
      });

      it('gives every plural key an _other form', () => {
        for (const [ns, d] of Object.entries(msgs)) {
          for (const k of Object.keys(d)) {
            const m = /^(.*)_(zero|one|two|few|many)$/.exec(k);
            if (m) expect(d[`${m[1]}_other`], `${lang.code} ${ns}.${k}`).toBeDefined();
          }
        }
      });
    });
  }
});

describe('keys used in the code', () => {
  const exists = (ns: string, k: string) => EN[ns]?.[k] != null || EN[ns]?.[`${k}_other`] != null;
  // views whose local t() adds their namespace to keys without a dot
  const LOCAL_NS: Record<string, string> = { 'ui/views/item/itemView.ts': 'item', 'ui/views/plan/planView.ts': 'plan' };

  it("every literal t('ns.key') resolves in English", () => {
    const missing: string[] = [];
    for (const p of files(SRC)) {
      const rel = relative(SRC, p).replace(/\\/g, '/');
      if (rel.startsWith('i18n/locales/')) continue;
      const src = code(p);
      for (const m of src.matchAll(/\bt\(\s*'([a-z]+)\.(\w+)'/g)) if (!exists(m[1]!, m[2]!)) missing.push(`${rel}: ${m[1]}.${m[2]}`);
      const local = LOCAL_NS[rel];
      if (local) for (const m of src.matchAll(/\bt\(\s*'(\w+)'/g)) if (!exists(local, m[1]!)) missing.push(`${rel}: ${local}.${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('no Turkish text outside src/i18n/locales/tr', () => {
    // the search normaliser folds Turkish letters; the language registry shows each language's native name
    const allowed = new Set(['domain/search.ts', 'i18n/languages.ts']);
    const hits: string[] = [];
    for (const p of files(SRC)) {
      const rel = relative(SRC, p).replace(/\\/g, '/');
      if (rel.startsWith('i18n/locales/tr/') || allowed.has(rel)) continue;
      code(p)
        .split('\n')
        .forEach((line, i) => /[çğıöşüİÇĞÖŞÜ]/.test(line) && hits.push(`${rel}:${i + 1}: ${line.trim()}`));
    }
    expect(hits).toEqual([]);
  });
});

describe('LocalizedError', () => {
  it('keeps an English message and renders in the active language', () => {
    const e = new LocalizedError('err.timeout', { s: 12 });
    expect(e.message).toBe('Bazaar request timed out after 12s');
    const m = msgOf(e);
    expect(m).toEqual({ key: 'err.timeout', params: { s: 12 } });
    setLang('tr');
    expect(msgText(m)).toBe('Bazaar isteği 12 sn sonra zaman aşımına uğradı');
    setLang('en');
    expect(msgText(m)).toBe('Bazaar request timed out after 12s');
    expect(msgOf(new Error('boom'))).toBe('boom');
    expect(msgText('raw text')).toBe('raw text');
    expect(t('err.http', { status: 503 })).toBe('HTTP 503');
  });
});
