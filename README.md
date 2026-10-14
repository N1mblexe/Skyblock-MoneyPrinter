# Bazaar Masası

A local web app for Hypixel SkyBlock trading. It finds bazaar flips, enchanted-book combines, craft and forge flips, NPC flips, shop-currency values and shard fusions. It also plans how to spread your capital and order slots across them, and keeps a watchlist with price alerts. Prices come live from the Hypixel API. The UI is in Turkish (default) and English. The app only does calculations and never places orders in the game.

## Run

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
| `npm run fixture` | Captures `tests/fixtures/bazaar.json`. `-- --smoke [--offline]` writes the smoke fixtures (bazaar, one AH page, election) |
| `npm run check:owners -- <wave> <agent> [branch] [base]` | Fails if a branch touched files outside its globs in `scripts/ownership.json` (base defaults to `round2`) |

The build scripts cache their downloads in `.cache/`. To use another directory, such as a shared read-only cache, set `BAZAAR_CACHE_DIR`: `BAZAAR_CACHE_DIR=/path/to/cache npm run data -- --offline`.

## Pages

| page | route | hotkey | what it shows |
|---|---|---|---|
| Overview | `#/overview` | `g o` | Cards: top flips, crafts and book combines; movers (1 h / 24 h); most consistent flips; watchlist; recent alerts; planner summary; mayor and minister; data status |
| Flips | `#/flip` | `g f` | Buy and sell the same bazaar product |
| Books | `#/books` | `g b` | Buy 2^(L−k) level-k enchanted books, combine them on an anvil, sell one level-L book. Unverified chains are hidden by default |
| Craft & Forge | `#/craft` | `g c` | Buy ingredients (bazaar, NPC or sub-craft), craft or forge, then sell to the bazaar, an NPC or the AH |
| Fusion | `#/fusion` | `g u` | Your own shard-fusion recipes (A × qa + B × qb → OUT × qo), editable, with import and export |
| NPC & Shops | `#/npc` | `g n` | Bazaar → NPC and NPC → bazaar flips, and currency shop offers (bits, copper, motes, …) valued in coins |
| Planner | `#/plan` | `g p` | Spreads capital and order slots across flips, crafts, books and NPC flips |
| Watchlist | `#/watch` | `g w` | Watched items with live prices, alert rules, alert log, import and export |
| Item | `#/item/<ID>` | (palette) | One product: your flip, market stats, AH lowest BIN, risk, top 10 levels of the order book, price chart (3 h / 24 h / 7 d), recipes |

Filters and sort orders live in the URL query, so you can bookmark a filtered view. Clicking a row opens a detail panel.

## Keyboard shortcuts

| keys | action |
|---|---|
| `/` or `Ctrl+K` (`Cmd+K`) | Command palette (pages, items, actions) |
| `r` | Refresh prices |
| `?` | Shortcuts help |
| `Esc` | Close the dialog or panel |
| `g` then `o` / `f` / `c` / `b` / `n` / `u` / `p` / `w` | Go to Overview / Flips / Craft / Books / NPC / Fusion / Planner / Watchlist |
| `↑` `↓` or `j` `k`, then `Enter` | Move between table rows and open one |
| `s` | Watch or unwatch the selected row (Flips, Books) |
| `e` | Download the table as CSV (Flips, Books) |

The shortcuts are defined in `HOTKEYS` in `src/config.ts`.

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
| `bazaarMasasi.watch` | Watchlist |
| `bazaarMasasi.alerts`, `bazaarMasasi.alertLog` | Alert rules and the last 100 fired alerts |
| `bazaarMasasi.lastRoute` | Last opened page |
| `bazaarMasasi.view.<view>` | Per-view filters and sort (`flip`, `books`, `craft`, `npc`, `npc.seg`, `npc.shops`, `fusion`, `plan`, `watch`, `overview`, `item`), plus `shell` (sidebar collapsed) |
| `bazaarMasasi.cols.<table>` | Hidden table columns |

The old single-file tool's `bazaarMasasi.recipes` and `bazaarMasasi.tab` keys are migrated once at startup. If IndexedDB isn't available, history and the AH scan are kept in memory only.

## How profits are estimated

[docs/estimates.md](docs/estimates.md) has the full model with formulas. In short:

- **Quotes come from the top of the order book.** A buy order costs the best bid + 0.1, but at least 0.9 × the NPC sell price and at most the ask. A sell offer gets the ask − 0.1. Insta modes walk the book.
- **Tax** (1.25, 1.125 or 1 %) applies only to bazaar sales.
- **Fill rate** is your share of the weekly volume, split with the competing orders at the top of the book.
- **Throughput** per cycle is limited by volume, capital, book depth, forge slots, order slots and the NPC daily limit. The sequential fill model (the default) buys and then sells. The pipelined model overlaps the two but ties up twice the capital.
- **Crafts** use the cheapest source for each ingredient: bazaar, NPC, or a sub-craft up to 3 levels deep. Outputs that aren't sold on the bazaar are valued at the higher of the NPC sell price and the AH lowest BIN.
- **Risk flags** (dead bid, extreme spread, price spike, low volume, …) mark rows as caution or suspect. Suspect rows are hidden by default.

## Not modelled

- AH listing and claim tax, and anything that makes one AH item worth more than another with the same id (stars, reforges, enchantments, pet level)
- Collection and recipe requirements
- Changes to the order book while your orders fill
- The anvil XP cost of combining books
- Fusion fees
- Minion profits and automatic shard-fusion candidates (there's no usable data for them)

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
| `src/i18n/` | Translations (tr, en) |
| `src/ui/` | Shell (sidebar, top bar, palette, settings), UI kit (tables, filters, panels, hotkeys, toasts, CSV) and one folder per page in `views/` |
| `src/styles/` | Theme and shared CSS |
| `src/types/` | API and app contracts |
| `scripts/` | Catalog build, fixture capture, sanity and smoke checks, ownership check, `data/book-rules.json` |
| `tests/` | vitest suites and fixtures |

`bazaar-masasi.html` is the original single-file tool, kept for reference.
