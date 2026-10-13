# Bazaar Masası

A local web app for Hypixel SkyBlock bazaar flipping. It covers bazaar flips, craft and forge flips, NPC flips and shard fusion, using live prices from the Hypixel API. The UI is in Turkish and English. The app only does calculations and never places orders in the game.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
```

Prices refresh every 60 s. Hypixel's CDN can serve the same snapshot for up to about 5 min, and the status pill shows how old the data is. Price history is kept in IndexedDB in your browser: 3 h of per-minute snapshots and 7 days of 15-minute snapshots. Sparklines, the item chart and spike detection fill in while the page stays open.

If live fetching ever fails, there are two fallbacks:
- "Fiyatları elle yükle" (load prices manually) lets you paste or upload the JSON from https://api.hypixel.net/v2/skyblock/bazaar.
- `?fixture=1` (dev only) loads the bundled test capture.

## Scripts

| command | what it does |
|---|---|
| `npm run data` | Rebuilds `public/data/catalog.json` from the NEU repo, the Hypixel items API and the bazaar product list: recipes, forge recipes, NPC buy/sell prices and names. `-- --offline` reuses `.cache/`. |
| `npm test` | Unit tests (vitest) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` / `npm run preview` | Production build in `dist/` and a preview server |
| `npm run sanity` | Runs the domain layer against the live API and checks the results |
| `npm run smoke` | Headless browser test of the built app. Run `npm run build` first. It uses the cached Playwright headless shell, or the browser at `CHROME_PATH`. |

## How profits are estimated

- **Prices come from the top of the order book.** A buy order costs the best buy order + 0.1, and a sell offer gets the best sell offer − 0.1. Insta modes walk the book. `quick_status` averages are not used for pricing.
- **Buy orders cost at least 0.9 × the NPC sell price.** The 0.1 "dead" bids on raw materials don't fill in real volume.
- **Tax** (1.25 / 1.125 / 1 %) applies only to bazaar sales.
- **Fill rate.** Throughput is limited by your share of weekly fill volume, after splitting it with competing orders near the top. It is also limited by capital per cycle, book depth for insta modes, and forge slots.
- **Craft ingredients** use the cheapest source: bazaar, NPC shop, or a sub-craft up to 3 levels deep.
- **Risk flags.** Dead bid, extreme or wide spread, low volume, thin top of book, price spike against the 24 h median, and others. Rows marked suspect are hidden by default.

Not modelled: collection or recipe requirements, NPC daily limits, fusion fees, and changes to the order book while your orders fill.

## Layout

The app is built with Vite and vanilla TypeScript:

- `src/api/`: fetch, normalize, poller
- `src/storage/`: IndexedDB history, localStorage
- `src/domain/`: pure calculations
- `src/ui/`: shell, table and views
- `scripts/`: catalog build, sanity and smoke checks

`bazaar-masasi.html` is the original single-file tool, kept for reference.
