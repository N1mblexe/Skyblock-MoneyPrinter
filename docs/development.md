# Developer reference

Everything you need to build, test and change Bazaar Desk (Bazaar Masası). For what the app does, see the [README](../README.md); for the profit model, see [estimates.md](estimates.md).

## Run locally

```sh
npm install
npm run dev        # http://localhost:5173
```

If live fetching fails, there are two fallbacks:
- "Load prices manually" (Settings → Data, and shown on the page when there is no data at all) lets you paste or upload the JSON from https://api.hypixel.net/v2/skyblock/bazaar.
- `?fixture=1` (dev only) loads the bundled test capture. AH and election polling don't start in this mode.

## Scripts

| command | what it does |
|---|---|
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` / `npm run preview` | Typecheck, then a production build in `dist/`; preview server on port 4173 |
| `npm test` | Unit tests (vitest) |
| `npm run coverage` | Tests with v8 coverage. Thresholds: `src/domain` 95 % lines and 90 % branches; `src/{storage,state,api,ui/kit}` 85 % lines |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run data` | Rebuilds `public/data/catalog.json` from the NEU repo, the Hypixel items API, the bazaar product list and `scripts/data/book-rules.json`. `npm run data -- --offline` reads only the cache and fetches nothing |
| `npm run sanity` | Runs the domain layer against the live bazaar and the generated catalog, and checks the results. `npm run sanity -- --offline` reads the cached bazaar instead |
| `npm run smoke` | Headless browser test of the built app (run `npm run build` first). It serves fixture data by default; `npm run smoke -- --live` uses the real API. It finds Chromium through `CHROME_PATH` or Playwright's cached browser |
| `npm run screenshots` | Captures the README screenshots into `docs/images/` (run `npm run build` first). Uses the smoke fixtures, English UI, dark and light theme, and example data for the Sell or craft? and Trades pages |
| `npm run icons` | Renders `public/icons/icon.svg` to the PNG app icons (192, 512, maskable 512, 180 for iOS) |
| `npm run pwa:check` | Offline check of the installable app: loads the Pages build once, stops the server, reloads (run `GITHUB_PAGES=1 npm run build` first) |
| `npm run fixture` | Captures `tests/fixtures/bazaar.json`. `-- --smoke [--offline]` writes the smoke fixtures (bazaar, one AH page, election) |
| `npm run check:owners -- <wave> <agent> [branch] [base]` | Fails if a branch touched files outside its globs in `scripts/ownership.json` (base defaults to `round2`) |

The build scripts cache their downloads in `.cache/`. To use another directory, such as a shared read-only cache, set `BAZAAR_CACHE_DIR`: `BAZAAR_CACHE_DIR=/path/to/cache npm run data -- --offline`.

## Deploying to GitHub Pages

`.github/workflows/pages.yml` runs on every push to `master` (or by hand from the Actions tab): it installs, runs the tests, builds with `GITHUB_PAGES=1` (which sets Vite's `base` to `/Skyblock-MoneyPrinter/`) and publishes `dist/` to GitHub Pages. In the repository settings, Pages → Source must be set to "GitHub Actions" once.

## Installable app (PWA)

- `public/manifest.webmanifest` and `public/icons/` (rendered from `icons/icon.svg` by `npm run icons`) make the app installable; `index.html` links them with relative paths, so the same files work under `/` and under the GitHub Pages base.
- The service worker is `src/pwa/sw.ts`, built to `dist/sw.js` by the `bazaar-desk-pwa` plugin in `vite.config.ts`, which fills in the precache list (every built file, the page, `data/catalog.json`, the manifest and icons) and a build version. Routing rules live in `src/pwa/swRoutes.ts` (unit-tested): hashed assets and icons cache-first; the page, the catalog and the manifest network-first; Google Fonts stale-while-revalidate; the Hypixel API is never touched. Cache lookups ignore `Vary`, since module scripts send an `Origin` header the precache requests did not.
- `src/pwa/register.ts` registers it in production builds only; when a new version takes over, a toast suggests reloading.
- `npm run pwa:check` (after `GITHUB_PAGES=1 npm run build`) loads the app once, stops the server and reloads: the service worker must serve the whole app. It does not use Playwright request routing, because routing makes Playwright bypass service workers.

## Data sources

| source | refresh | notes |
|---|---|---|
| Bazaar (`/v2/skyblock/bazaar`) | every 60 s (120 s while the tab is hidden); after errors, retries back off to 60, 120, then 300 s | Hypixel's CDN can serve the same snapshot for a few minutes. The status pill shows the data age: stale after 3 min, old after 10 min |
| Auction house (`/v2/skyblock/auctions`) | every 10 min, in a Web Worker | Scans every page (4 at a time) and keeps the lowest BIN price and the listing count per item. You can turn it off in Settings → "Auction house scan". When it's off, nothing is scanned and no AH values are used |
| Election (`/v2/resources/skyblock/election`) | every 30 min | Current mayor, minister and perks |
| Catalog (`public/data/catalog.json`) | `npm run data` | Built from the NEU repo (recipes, forge recipes and durations, NPC shops, SkyMart, enchanting-table levels, attribute shards), the Hypixel items API (names, tiers, NPC sell prices, categories) and the bazaar product list |

## Storage

Everything stays in your browser.

| where | contents |
|---|---|
| IndexedDB `bazaar-masasi` | Price history: every snapshot for 3 h and the last snapshot per 15 min for 7 days. It also keeps the latest snapshot (order books trimmed to 10 levels), so the page has data before the first fetch. The size and a "Clear history" button are in Settings → Data |
| IndexedDB `bazaar-masasi-ah` | The last AH lowest-BIN scan |
| `bazaarMasasi.settings` | Settings |
| `bazaarMasasi.fusion` | Fusion recipes |
| `bazaarMasasi.oppAlerts` | Market alert rules with their latest hits |
| `bazaarMasasi.orders`, `bazaarMasasi.journal` | Tracked bazaar orders and the trade journal (Trades page) |
| `bazaarMasasi.sell` | The Sell or craft? item list |
| `bazaarMasasi.watch` | Watchlist |
| `bazaarMasasi.alerts`, `bazaarMasasi.alertLog` | Alert rules and the last 100 fired alerts |
| `bazaarMasasi.lastRoute` | Last opened page |
| `bazaarMasasi.view.<view>` | Per-view filters and sort (`flip`, `books`, `craft`, `npc`, `npc.seg`, `npc.shops`, `fusion`, `plan`, `watch`, `overview`, `item`), plus `shell` (sidebar collapsed) |
| `bazaarMasasi.cols.<table>` | Hidden table columns |

The old single-file tool's `bazaarMasasi.recipes` and `bazaarMasasi.tab` keys are migrated once at startup. If IndexedDB isn't available, history and the AH scan are kept in memory only.

## Layout

The app is built with Vite and vanilla TypeScript, with no framework.

| path | contents |
|---|---|
| `src/config.ts` | Every tunable constant: intervals, thresholds, risk weights, hotkeys, storage keys |
| `src/main.ts`, `src/app.ts` | Bootstrap: settings, history, catalog, shell, router, pollers, alerts |
| `src/api/` | Bazaar client, normalizer and poller; AH scanner, Web Worker, NBT decoder and cache; election poller |
| `src/data/` | Catalog loader |
| `src/domain/` | Pure calculations: pricing and throughput, flips, crafts, NPC, books, shops, fusion, optimizer, risk, market stats, alerts |
| `src/state/` | Store, app state and default settings, memoized derived results, alert runner |
| `src/storage/` | IndexedDB price history, localStorage helpers |
| `src/i18n/` | Language registry, `t()`, and one folder of translations per language in `locales/` (English is the default and the source). See [src/i18n/README.md](../src/i18n/README.md) |
| `src/ui/` | Shell (sidebar, top bar, palette, settings), UI kit (tables, filters, panels, hotkeys, toasts, CSV) and one folder per page in `views/` |
| `src/styles/` | Theme and shared CSS |
| `src/types/` | API and app contracts |
| `scripts/` | Catalog build, fixture capture, sanity and smoke checks, ownership check, `data/book-rules.json` |
| `tests/` | vitest suites and fixtures |

`bazaar-masasi.html` is the original single-file tool, kept for reference.
