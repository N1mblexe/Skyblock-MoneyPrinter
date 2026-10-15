# Languages

All user-visible text lives in `locales/<code>/`, one file per namespace (`common`, `shell`, `flip`, …).
English (`locales/en`) is the source: it is the default for new visitors, the fallback for anything missing,
and the type every other language must match.

```
src/i18n/
  index.ts       t(), setLang/getLang/onLangChange, locale(), msgText()
  languages.ts   LANGUAGES registry and DEFAULT_LANG
  errors.ts      LocalizedError (errors shown in the UI)
  locales/en/    English, one file per namespace + index.ts (defines the Messages type)
  locales/tr/    Turkish, same files
```

## Add a language

1. Copy `locales/en` to `locales/<code>` (for example `locales/de`).
2. In every copied file, type the object against English, as the Turkish files do:
   ```ts
   import type { Messages } from '../en/index.ts';
   export const flip: Messages['flip'] = { … };
   ```
   In `locales/<code>/index.ts`, export `export const de: Messages = { common, err, … };`.
3. Translate the strings. Keep every `{param}` and any HTML tags (`<strong>`, `<b>`).
4. Add one line to `LANGUAGES` in `languages.ts`:
   ```ts
   { code: 'de', name: 'Deutsch', locale: 'de-DE', messages: de },
   ```
   `name` is shown in the language picker exactly as written, so use the language's own name. `locale` drives number, date, plural and list formatting.
5. Run `npm run typecheck && npm test`. The compiler reports any missing or extra key, and `tests/i18n/locales.test.ts` reports empty strings and mismatched `{params}`.

The top-bar buttons, the settings drawer and the command palette list languages from `LANGUAGES`, so they need no changes.

## Add or change a string

- Add the key to the English file first, then to every other language (the compiler lists the files that are missing it).
- Use it with `t('ns.key', { param })`. Every literal key used in `src/` must exist (checked by the locales test).
- **Counts:** add `key_one` and `key_other` (plus `_few`, `_many`, … if a language needs them). `t('ns.key', { n })` picks the form with `Intl.PluralRules`; pass `count` when the number that decides the form isn't `n`.
- **Whole sentences only:** don't glue translated pieces together in code. Put word order and punctuation in the template, e.g. `'{label} ({n})'`.
- **Numbers, dates and units:** use the formatters in `src/ui/format.ts` (`fmtCoins`, `fmtPct`, `fmtNum`, `fmtAge`, `fmtHours`, `fmtList`), which follow the active locale.
- **Errors shown to users:** throw `new LocalizedError('err.key', { … })`. Store `msgOf(e)` in state and render it with `msgText()`, so the message follows a language switch.
- Game data (item, mayor and shop names, rarities) stays in English, as in game.
