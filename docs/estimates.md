# How estimates are made

This page describes the model behind every number the app shows. Constants are named as they appear in `src/config.ts`; the code is in `src/domain/`. All figures are estimates from one bazaar snapshot plus the price history your browser has collected and, while the AH scan is on, the last AH scan and the AH sales the app has seen.

## Settings that feed the model

| setting | default | range | used for |
|---|---|---|---|
| Bazaar tax (`taxRate`) | 1.25 % | 1.25 / 1.125 / 1 % | bazaar sales |
| Capital (`capital`) | 5,000,000 | 0 – 10^13 (0 = unlimited) | coins tied up per cycle |
| Your share of volume (`share`) | 5 % | 0 – 100 % | fill rates, AH sale rates |
| Cycle length (`cycleHours`) | 1 h | 0.05 – 168 h | batch size, NPC caps, re-listing |
| When buying (`costMode`) | buy order | buy order / insta-buy | buy quotes |
| When selling (`sellMode`) | sell offer | sell offer / insta-sell | sell quotes |
| Forge slots (`forgeSlots`) | 2 | 1 – 7 | forge throughput |
| Order slots (`orderSlots`) | 14 (`ORDER_SLOTS_DEFAULT`) | 1 – 35 (`ORDER_SLOTS_MAX`) | batch size, planner |
| NPC daily limit (`npcDailyLimit`) | 640 (`NPC_DAILY_LIMIT_DEFAULT`) | 1 – 10,000,000 | NPC purchases |
| Fill model (`fillModel`) | sequential | sequential / pipelined | throughput |
| History-based conservatism (`conservative`) | on | on / off | bazaar quotes and rates, AH list prices (see Conservatism) |
| Auction house scan (`ahEnabled`) | on | on / off | AH prices and the AH sales feed: craft inputs and outputs, AH flips, Kat, Bits, Shops, Sell or craft? |
| Taming level (`taming`) | 60 (`KAT.maxTaming`) | 0 – 60 | Kat upgrades (page, planner, alerts) |
| Bits multiplier (`bitsMultiplier`) | 1 | 1 – 5 | Bits shop and bits-priced Kat items; set on the Bits page |
| Hide suspicious (`hideSuspicious`) | on | on / off | table filters only |

## Quotes

The bazaar API names its sides the other way round: `sell_summary` holds buy orders (bids) and `buy_summary` holds sell offers (asks). The app stores up to 30 levels per side (`BOOK_DEPTH`). `quick_status` averages are not used for prices.

| mode | price per unit | notes |
|---|---|---|
| Buy order | `max(bid + 0.1, 0.9 × npcSell)`, rounded to 0.1; at or above the ask it becomes an insta-buy (below) | `PRICE_TICK = 0.1`, `NPC_FLOOR_RATIO = 0.9` |
| Insta-buy | volume-weighted average over the asks for the quantity | slippage = (average − best ask) / best ask |
| Sell offer | `max(0.1, ask − 0.1)` | |
| Insta-sell | volume-weighted average over the bids for the quantity | |

**NPC floor.** Raw materials often show a 0.1-coin bid that never fills in real volume. Sellers rarely dump far below what an NPC pays, so a buy order is assumed to cost at least 0.9 × the item's NPC sell price. When the floor raises the price, the quote is marked `npcFloor`. One consequence: a bazaar → NPC flip by buy order can earn at most 0.1 × the NPC price per unit, a margin of 11.1 %.

**Ask clamp.** A buy order priced at or above the ask would fill against the sell offers at once, so it is quoted as an insta-buy: the asks are walked for the quantity (VWAP, slippage included) and the quote is marked `ask` (`clamped: 'ask'`). From then on the leg is an insta leg everywhere: the insta-buy fill rate with no competition, the book depth as a cap, no order slot, and a re-quote at the batch size. The NPC floor can push an order into the clamp too.

**Insta refine.** Insta quotes are first made for one unit. After the batch size is known, a trade with an insta leg (a clamped buy order included) is re-quoted once at the batch size so that slippage shows in the profit. Flips, books and NPC flips do this when the trade is profitable at one unit; crafts re-quote their insta and AH ingredients and an insta-sold bazaar output; fusion re-quotes its insta legs.

## Tax

Bazaar sales receive `price × (1 − taxRate)`. Buys and NPC sales are not taxed. AH sales pay the AH fees (see Auction house values). The Bazaar Flipper upgrades in the Community Shop lower the rate to 1.125 % and 1 %.

## Fill rates

Hourly market rates come from the moving-week counters, divided by 168:

| your side | fills from |
|---|---|
| buy order | insta-sells (`sellMovingWeek / 168`) |
| insta-buy | insta-buys (`buyMovingWeek / 168`) |
| sell offer | insta-buys (`buyMovingWeek / 168`) |
| insta-sell | insta-sells (`sellMovingWeek / 168`) |

Your rate is the market rate times your share of it:

- **Orders and offers** queue behind competitors. `n` is the sum of the `orders` counts on every level within `max(0.1, 1 % × best price)` of the best price on that side (`COMP_TOL = 0.01`, with `PRICE_TICK` as the floor: on a cheap item the next price is a whole tick away, outside 1 %). Your rate is `market × min(share, 1 / (1 + n))`. With conservatism on, competitors are also weighted by amount (see Conservatism).
- **Insta modes** don't queue. Your rate is `market × share`, and the batch is capped by the units on the book (`depthCap`, the sum over the stored levels).
- **A buy order clamped at the ask** is an insta-buy: `insta-buy rate × share`, no competition, capped by the asks' depth.

Example: 1,680,000 insta-sells a week is 10,000 per hour. With a 5 % share and 3 competing bids, your buy order fills `10,000 × min(0.05, 1/4) = 500` per hour. With 30 competing bids it is `10,000 × 1/31 ≈ 323` per hour.

## Throughput: sequential vs pipelined

Each trade is planned as one batch of `Q` units per period. Let `rB` and `rS` be your buy and sell rates in units per hour, and `hB = 1/rB`, `hS = 1/rS` the hours per unit. An **instant** leg takes no time (`h = 0`): selling to an NPC, buying from an NPC shop, buying on the AH. Instant purchases are capped per cycle instead (below).

| | sequential (default) | pipelined |
|---|---|---|
| idea | buy the batch, then sell it | buy the next batch while the previous one sells |
| hours per unit, `hFill` | `hB + hS` | `max(hB, hS)` |
| capital held | `Q × unitCost` | `2 × Q × unitCost` (1× when one side is instant) |

The batch is the smallest of these bounds, and `limitedBy` records which one won:

| bound | formula | `limitedBy` |
|---|---|---|
| volume | `cycleHours / hFill` | `volume`, or `ahSales` when the binding side is an AH sale |
| forge | `forgeCap × cycleHours`, with `forgeCap = forgeSlots / forge hours per unit` | `forge` |
| capital | `floor(capital / (overlap × unitCost))`, overlap 2 for pipelined with two timed legs, else 1 | `capital` |
| depth | units on the book (insta legs) or AH listings seen (AH purchases) | `depth` |
| instant caps | `perHour × cycleHours` for each instant purchase: an NPC shop (`npcDailyLimit / 24`) or the AH (AH sales per hour) | `npcLimit`, `ahSales` |
| order slots | largest `Q` whose orders fit in `orderSlots` (next section) | `slots` |

If nothing bounds the batch (instant legs, unlimited capital, no orders), `Q = MAX_ORDER_UNITS` and `limitedBy = depth`. Then:

```
buyHours  = Q × hB
sellHours = Q × hS
fillHours = max(sequential ? buyHours + sellHours : max(buyHours, sellHours), Q / forgeCap)
unitsPerHour  = Q / max(cycleHours, fillHours)
profitPerHour = unitsPerHour × profit per unit
```

**Pipelined is not always faster.** It halves the time per unit, but it holds two batches at once and so needs twice the capital for the same batch. When capital binds, the batch halves and pipelined can come out slower. With `rB = rS = 1,000/h`, a unit cost of 1,000 coins and a 1-hour cycle:

| capital | model | Q | bound | fillHours | units/hour |
|---|---|---|---|---|---|
| 400,000 | sequential | 400 | capital | 0.8 | 400 |
| 400,000 | pipelined | 200 | capital | 0.2 | 200 |
| 10,000,000 | sequential | 500 | volume | 1.0 | 500 |
| 10,000,000 | pipelined | 1,000 | volume | 1.0 | 1,000 |

With little capital, pipelined makes half as much per hour. With plenty, it makes twice as much and holds 2,000,000 coins instead of 500,000.

**Planner inputs.** Every flip, book, NPC flip, craft, Kat and AH flip row also carries `plan` (`planInputs` in `src/domain/pricing.ts`): the same throughput with capital and order slots unbounded (the planner applies both), the buy cost and unit cost per unit (doubled under pipelined), the order units, and the markets the row draws on (`X:bid`, `X:ask`, `X:npc`, `forge`). A row with an insta leg or an AH-bought ingredient also gets a concave profit curve, from re-quotes at 25, 50, 75 and 100 % of its largest batch (`OPTIMIZER.segments = 4`); a George flip's curve is its listings, cheapest first. How the planner uses them is under Planner.

## Order slots and `MAX_ORDER_UNITS`

A bazaar order holds at most `MAX_ORDER_UNITS = 71,680` units. Each order or offer leg of a batch takes `ceil(Q × units per batch unit / 71,680)` slots, at least 1. Insta, NPC and AH legs take none, and neither does a buy order clamped at the ask.

- A flip by buy order and sell offer at `Q = 100,000` takes 2 + 2 = 4 slots.
- A book combine has two orders in order modes: the input buy order holds `count × Q` books (`count = 2^(L−k)`), the output sell offer `Q`.
- A craft counts its bought items after sub-crafts are flattened: the bought inputs of every line, sub-crafted ones included, are merged by item and source, and each item bought by order is one order of (its units per craft × Q). The output offer adds one (`outCount × Q`) when the output is sold on the bazaar by sell offer.

If the batch needs more than `orderSlots` slots, it shrinks to the largest size that fits (`limitedBy = slots`).

## NPC daily limit

NPC shops limit how much of each item you can buy per day, and the in-game limits vary. The app uses one value for every item, the `npcDailyLimit` setting (default 640), spread evenly over the day: `npcDailyLimit / 24` units per hour.

An NPC purchase is **instant**: it adds no fill time and no second batch under the pipelined model, but it caps the batch at `npcDailyLimit / 24 × cycleHours` units (`limitedBy = npcLimit`). The cap applies to NPC → bazaar flips, NPC-bought craft and fusion ingredients, and shop trades (each unit a trade makes is bought from the NPC). Coins listed as a recipe input (`SKYBLOCK_COIN`: forge fees, shop prices) are paid as they are, with no cap. Selling to an NPC has no limit in the model.

## Conservatism

The `conservative` setting (on by default, Settings) checks each bazaar quote against the item's recent history and moves it against you (`sideAdjust` in `src/domain/conservative.ts`, applied by the shared market core in `src/domain/market.ts`, so every strategy gets the same numbers). It changes nothing when the setting is off, or when the item has fewer than `CONSERVATIVE.minPoints = 12` points in its risk baseline (see Risk flags): until the browser has collected some history, you see the snapshot numbers.

| leg | price | rate × |
|---|---|---|
| sell offer | `min(quote, medianAsk − 0.1)` | insta-buy volume trend |
| insta-sell | `min(quote, medianBid)` | insta-sell volume trend |
| buy order | `max(quote, medianBid + 0.1)`, never above the ask | insta-sell volume trend |
| insta-buy (or a buy order clamped at the ask) | `max(quote, medianAsk)` | insta-buy volume trend |

Prices are rounded to 0.1. The trend is the volume trend of the flow that fills the leg (Market stats), clamped to `CONSERVATIVE.trendClamp = [0.5, 1]`: a slowing market lowers your rate, a busy one never raises it.

Orders and offers also pay for the queue:

- **Re-listing.** You will be outbid or undercut and re-list. Re-lists per leg = `min(CONSERVATIVE.maxRelists = 6, top-price moves per hour on your side × cycleHours)`, each costing `max(0.1, CONSERVATIVE.relistStep × price)` (`relistStep = 0.2 %`). This churn is added to a buy price and taken off a sell price. Moves per hour come from the last 3 h of history (Market stats).
- **Competitors by amount.** A big order at the top fills before yours however few orders it counts as. Competitors count as `max(orders in the band, amount in the band / typical order size)`, where the typical size is the side's total amount / total orders over the stored levels. When that is more than the order count, your rate is scaled by `min(share, 1 / (1 + weighted)) / min(share, 1 / (1 + orders))`.

On the AH, conservatism caps a list price at the median sold price once `AH_SALES.minSales = 3` sales are seen (Best sale, AH flips, Kat).

Rows record what changed in `cons`: the snapshot prices (`buyRef`, `sellRef`), the lowest rate multiplier and the churn per unit (a craft sums the churn over its bought units and its output). The trade pages show it in the detail panel. Turn the setting off for the raw snapshot numbers.

## Best sale

Crafts, chains, Bits, Shops and Sell or craft? sell an item through one rule (`saleQuotes` / `bestSale` in `src/domain/sale.ts`):

| venue | net per item | rate | risk |
|---|---|---|---|
| bazaar | sell quote in your sell mode (conservatism applied), after tax | your sell rate | the item's sell-side risk |
| AH | listed one coin under the lowest BIN (`AH_FLIP.undercut = 1`) and, with conservatism on, at no more than the median sold price; after the AH fees | measured sales per hour × share, else `AH_SALES.defaultPerHour = 0.25` (`limitedBy = ahSales`) | `AH_THIN`, `AH_GAP`, `AH_VARIANT` |
| NPC | NPC sell price | unlimited | none |

The AH venue is offered only for auctionable items: the catalog says so, or the item is unknown to the catalog and not a bazaar product. The best net wins; ties keep bazaar, then AH, then NPC. Kat and AH flips use their own sale rules (below).

## Crafts, forges and shop trades

Recipes come in three kinds: `craft`, `forge` and `shop`. A shop recipe is an NPC shop offer paid with items (any coins in the price become the input `SKYBLOCK_COIN`) or a NEU trade. The catalog has 1,845 recipes: 1,418 crafts, 124 forges and 303 shop recipes (233 from `npc_shop`, 70 trades). The Craft page lists crafts, shop trades or both (a Crafts / Shop trades / Both switch); the Forge page lists the forges. One shared pricer (`getPricer` in `src/domain/craft.ts`) prices crafts, chain moves, Kat items and Sell or craft?.

**Ingredient sources.**

| source | price per unit | rate |
|---|---|---|
| bazaar | buy quote in your cost mode (a buy order at the ask is an insta-buy) | your fill rate |
| NPC shop | NPC buy price | instant, capped at `npcDailyLimit / 24` per hour |
| AH | VWAP over the scan's per-item prices for the quantity; auctionable items only | instant, capped at the AH sales rate (measured, else `AH_SALES.defaultPerHour = 0.25`); the listings seen cap one batch |
| mix | the NPC up to its limit, the bazaar for the rest, split `cap / (cap + bazaar rate)` | the two rates added |
| sub-recipe | `Σ qty × input cost / outCount` over a craft, forge or shop recipe | the slowest input's rate; a forge sub-recipe adds its forge time, a shop trade draws on its NPC limit |
| coins (`SKYBLOCK_COIN`) | 1 coin | unlimited |

Sub-recipes go up to `CRAFT_RECURSION_DEPTH = 3` levels deep, and cycles are cut.

**Source choice** takes two passes:

1. Each ingredient takes its cheapest source: the cheapest direct one (bazaar, then NPC, then AH on ties), or a sub-recipe when strictly cheaper. The output takes its best net sale.
2. If the row is profitable and its batch is bound by a source (volume, NPC limit, AH sales, forge or depth, not capital or slots), two lifts are tried:
   - when the slowest ingredient line is slower than the output, every other source of that line (bazaar, NPC, AH, mix or sub-recipe) that is faster and keeps the row profitable;
   - when the sell side binds (the output's rate is at most the ingredients'), every faster sale venue that still covers the cost.

   The variant with the most profit per hour wins.

**Output value.** The output goes through Best sale, with the venues its kind allows:

| output | venues |
|---|---|
| bazaar product | bazaar, AH (if auctionable), NPC |
| bazaar product, shop trade | bazaar, AH |
| not on the bazaar | AH, NPC |
| not on the bazaar, shop trade | AH |

A shop trade's output is never valued at the NPC sell price: an NPC shop won't buy back above what it sells for. A row with an unpriced input or no venue is unpriced (cost and value shown as 0, hidden by default).

**Throughput.** The buy rate is the slowest bazaar-bought ingredient in crafts per hour (the "bottleneck"); NPC, AH and shop-trade purchases are instant legs that cap the batch per cycle (`npcLimit`, `ahSales`). The sell rate is the venue's rate / outCount: your bazaar fill rate, the AH sales rate (`ahSales`), or unlimited for an NPC sale. Forges are also limited by `forgeSlots / forge hours` per hour, where the forge hours per unit include those of forge sub-recipes. The Craft page's minimum weekly volume filter applies only to rows sold on the bazaar; AH and NPC sales are bounded in profit per hour instead.

**Refine.** Insta and AH ingredients, and an insta-sold bazaar output, are re-quoted once at the planned batch size.

**Risk.** A craft row combines its sale's risk (the output's sell-side bazaar risk, or the AH flags), only the `PRICE_SPIKE` and `QUICK_DIVERGENCE` flags of bazaar-bought ingredients (`INGREDIENT_FLAGS`, checked on the side each one is bought), and `AH_THIN` for an AH-bought ingredient with fewer than `AH.minCount = 3` listings. Dead bids are normal on raw materials, so the other ingredient flags are ignored.

## Craft chains

The **Chains** tab of Craft & Forge (`#/craft?view=chains`, `src/domain/chains.ts`) prices multi-step crafts along a ladder, such as Wheat → Enchanted Wheat → Enchanted Hay Bale.

**Steps and ladders.** A `craft` recipe with a bazaar output is a chain step when its main input (the input with the largest quantity) is a bazaar item, makes up at least `CHAIN.mainShare = 0.5` of the recipe's input items, and goes in faster than the output comes out (`qty / outCount > 1`; this drops uncrafting such as Hay Bale → 9 Wheat). The other inputs are side ingredients. When several recipes link the same two items, the one with the fewest side inputs wins, then the one with the fewest main units per output. Steps join into ladders from a root (an item no step produces) to a top; a tier with two steps up gives two ladders.

**Moves.** A move buys one tier and crafts it up at least `CHAIN.minSteps = 2` steps (single steps are the Recipes tab's rows). It is priced as one recipe: `need` units of the first tier plus every step's side ingredients, summed top-down (crafts at a step = units needed of its output / outCount), producing one unit of the top tier. Pricing is the craft model above, through the same shared pricer, with one difference: the first tier is always bought, never sub-crafted, so a move means what it says. By default it is bought on the bazaar (`ChainStart` `bazaar`): an NPC shop is often cheaper per item, but its daily limit makes long ladders crawl. The tab's "First tier from: Cheapest" switch allows the other direct sources (NPC shop, AH) too. Side ingredients always take their cheapest source.

**Best per ladder.** By default the tab shows each ladder's move with the highest profit per hour. The planner gets every priced, profitable move as a `chain` opportunity; a move and the same item's craft row share the planner's one-position-per-item rule.

**Recipe gaps.** `scripts/data/extra-recipes.json` adds hand-checked recipes for outputs NEU has none for. It is empty for now: the hay items without a NEU recipe (`ENCHANTED_HAY_BLOCK`, `TIGHTLY_TIED_HAY_BALE`) are legacy items that can no longer be crafted.

## Auction house values

**The scan.** Every 10 minutes (`AH.pollMs`), in a Web Worker, the scan reads every page of `/v2/skyblock/auctions` (4 at a time), keeps unclaimed BIN listings only and decodes each item's NBT (inflated synchronously with `fflate`, skipping the display and skull-texture tags). Per id it records the listing count, the lowest `AH.keepPrices = 8` per-item prices (`price` is the lowest, `next` the second) and the cheapest listing's uuid, name and stack size. Scan v4 (`AH_SCAN_VERSION` in `src/api/auctions.ts`):

- **Per item.** A stack's price is divided by its `Count`.
- **Deduped.** A listing seen again under the same auction uuid, on another page or the same one, counts once.
- **Consistent pages.** A page whose `lastUpdated` differs from page 0's (the AH refreshed mid-scan, or the CDN served an older copy) is fetched once more; if it still differs it is used and counted in `mixedPages`. A page that fails twice is skipped and the scan goes on.
- **Pet levels.** A pet listing is also filed under one level key, read from its `[Lvl N]` name: `TYPE;RARITY@MAX` at max level (`AH.petMaxSuffix`), else the level band `@L49` (1–49), `@L89` (50–89) or `@L99` (90–99) (`AH.petBands`). The plain key's lowest BIN is almost always a level 1 pet. The scanner knows the 200-level pets (Golden, Jade and Rose Dragon) from a hand-kept list; their levels 100–199 get no band. Pets keep the cheapest listing's XP (`exp`). Pets holding a Tier Boost are left out: their id has the base rarity, but they sell as the boosted one.

A saved scan older than v4 still loads, and a new scan starts at once. Kat upgrades work from v3 (pet XP and `@MAX` keys); the level bands need v4.

**Ids.** The id is `ExtraAttributes.id`, with these adjustments: pets become `TYPE;RARITY` (for example `ENDER_DRAGON;4`), single-enchant books become `ENCHANTMENT_<NAME>_<LEVEL>`, and runes and potions take NEU's ids (`MUSIC_RUNE;3`, `POTION_CRITICAL;4`), as the catalog does. Everything else about the item is ignored, so one lowest BIN covers every copy of a base id, whatever its stars, reforge or enchantments. A starred item is valued like the cheapest copy. Pet level is covered only by the level keys.

**Fees.** Every AH sale pays the seller fees (`AH.fees` in `src/config.ts`, `ahNet` in `src/domain/pricing.ts`), per item listed:

| fee | amount |
|---|---|
| BIN listing fee | 1 % up to 10M, 2 % up to 100M, 2.5 % above |
| claim tax | 1 % of sales above 1M, never taking the payout below 1M; ×4 while Derpy is mayor (read from the election data) |

While the AH scan is on, AH values are used for craft ingredients and outputs, Sell or craft?, Bits and Shops (as a sale venue), AH flips and Kat upgrades. The item page shows the lowest BIN.

## AH sales

What actually sold comes from `/v2/skyblock/auctions_ended` (`src/api/ahSales.ts`), polled every 60 s (`AH_SALES.pollMs`) while the AH scan is on and a tab is open. Each response holds the sales of the last minute. Hypixel's CDN can serve the same response for up to 5 minutes, so a response whose `lastUpdated` was already seen is skipped.

- Only BIN sales count. Each is priced per item (`price / Count`) and filed with the scan's id rules, pets also under their level key from the name; Tier-Boosted pets are left out. Sales are deduped by `auction_id`.
- **Coverage** is the time the feed has actually seen: each new response adds the minute before its `lastUpdated`, and overlapping windows merge. Gaps (the app closed, polls missed) don't count.
- The sales are kept for 7 days (`AH_SALES.windowMs`), in IndexedDB (`bazaar-masasi-ahsales`): one record per id with its newest 64 sales (`AH_SALES.maxPrices`) and hourly counts.

Per id the feed gives the sales `n` and items sold in the window, the `median` per-item price of the stored sales, and `perHour = items / coverage hours`. Below `AH_SALES.minCoverageHours = 2` h of coverage the stats are ignored everywhere: AH rates fall back to `AH_SALES.defaultPerHour = 0.25` items per hour (Kat to `KAT.defaultSellHours = 1` h). The median caps a list price only with conservatism on and at least `AH_SALES.minSales = 3` sales.

The status pill shows the coverage, the item page has an AH sales panel (median sold, sales per hour, coverage), and Settings → Data shows the store's size with a Clear button.

## AH flips

The **AH flips** page (`#/ahflip`, `src/domain/ahFlips.ts`) has two modes.

**Relist** (default). Buy the cheapest listing and relist it one coin (`AH_FLIP.undercut = 1`) under the second-lowest per-item price; with conservatism on, at no more than the median sold price. You buy the cheapest listing's whole stack and relist it, so the fees are taken on the stack:

```
profit per item = ahNet(sellAt × stack) / stack − lowest
margin          = profit / lowest
sellHours       = stack / sales per hour   (measured, else AH_SALES.defaultPerHour = 0.25)
profit/hour     = profit per item × sales per hour
```

Ids need at least `AH_FLIP.minCount = 3` BIN listings (the page's default filter is 5). Plain ids and max-level pet keys (`@MAX`, one level per key) are flipped; level-band keys are not. Because one id covers every copy of an item, two flags warn about variants: `AH_VARIANT` for gear and tools (`AH_FLIP.variantCategories`) and for pets other than `@MAX` keys, and `AH_GAP` when the second price is more than `AH_FLIP.gapRatio = 3` times the lowest. Both together make a row suspect, hidden while "Hide suspicious" is on. Without measured sales the sell time is shown as a guess (`~`).

**George.** George buys pets at fixed prices, any level (NEU `constants/george.json`, `catalog.george` keyed `TYPE;RARITY`; 307 prices). A George flip buys a pet listed below his price and sells it to him at once: `profit = George − buy`, with no fees and no wait. Every kept listing below his price counts, cheapest first, as one batch per cycle: `profit/hour = Σ (George − price) / cycleHours`. The listing-count filter doesn't apply.

Prices can change before you reach the listing; both modes copy `/viewauction <uuid>` for the cheapest one.

## Kat upgrades

The **Kat upgrades** page (`#/kat`, `src/domain/kat.ts`) buys a pet at the lowest BIN, takes it up one or more rarities at Kat (consecutive steps of one pet, from catalog.kat), and sells it on the AH or to George. It needs AH scan v3 or newer (`KAT_MIN_SCAN`, also for the planner and alerts). Each start is tried in two bands: the cheapest listing of any level (`PET;i`) and the cheapest max-level one (`PET;i@MAX`).

**Level.** The pet keeps its XP through an upgrade, but higher rarities need more XP per level, so the level is recomputed at each rarity from the leveling table in NEU's `constants/pets.json` (the rarity's offset into the shared table, and per-pet custom tables such as Golden Dragon's levels 101–200). A level 100 Epic comes out a lower-level Legendary. The start level comes from the listing's XP; without it (or with 0 XP on a max-band listing), an any-level listing counts as level 1 (no discount) and a max-band one as max level. Without the listing's XP or a leveling table the level is a guess. The scanner files `@MAX` listings by a hand-kept list of 200-level pets (it has no catalog); a `@MAX` entry whose listing level differs from the catalog's max level is not trusted: as a buy the max band is skipped, as a sale a less specific key is used.

**Cost per step.**

```
coins    = Kat's list price × (1 − KAT.levelDiscount × level)    (0.3 % off per level, at the level the pet goes in)
items    = each upgrade item at its cheapest source (the craft pricer: bazaar, NPC, AH or sub-craft), else its AH
           lowest BIN; a bits-shop item at no more than its bits × the cookie cost per bit
skip     = Kat Flowers / Bouquets (skip option below)
capital  = buy + Σ (coins + items + skip)
```

Items sold in the bits shop cost `min(market price, bits per item × cookieCostPerBit)` (see Bits shop; marked `bits`). Today that is the Kat Flower and the Kat Bouquet: no upgrade item is in the bits shop. A step with an item nobody sells keeps the row, marked unpriced (profit 0).

**Time.** Kat's base wait per step; Kat's wait reduction for higher pet levels is not modelled, so long waits are on the safe side. A Kat Flower skips 24 h (`KAT.flowerHours`), a Kat Bouquet 120 h (`KAT.bouquetHours`); each skipped step buys the cheapest mix that skips every full day of its wait, and the part under one day stays. The skip option:

| option | steps skipped |
|---|---|
| `best` (default) | the steps whose skip raises the profit per hour: skips ranked by cost per saved hour, and the prefix with the most profit per hour is used |
| `none` | none |
| `flowers` | every step that can be |

`hours = Σ waits after skipping + sell hours`. The planner and market alerts use the page default, `best`.

**Sale.** The sale is priced from the most specific AH key that is listed:

1. `PET;j@MAX` when the pet ends at its max level (and the listing's level matches the catalog's max),
2. else the level band `PET;j@L49` / `@L89` / `@L99` when the end level is known (scan v4),
3. else the plain `PET;j`.

The pet is listed one coin under that key's lowest BIN (`AH_FLIP.undercut`) and, with conservatism on, at no more than its median sold price (at least `AH_SALES.minSales = 3` sales). It sells in `1 / sales per hour` of that key, else `KAT.defaultSellHours = 1` h. The sale pays the AH fees (`ahNet`, ×4 claim tax under Derpy).

**George floor.** When George pays more for `PET;j` than the AH sale nets, the pet goes to George: his price, no fees, no wait.

```
profit = sellNet − capital,  margin = profit / capital,  profit/hour = profit / max(hours, 1 min)
```

**Flags.** `AH_THIN` when the buy key, or the AH sale key, has fewer than `KAT.minCount = 3` listings; `AH_GAP` when the second-cheapest start listing is more than `AH_FLIP.gapRatio = 3` times the cheapest; `AH_VARIANT` when the pet is sold on the AH from a key other than `@MAX` (a band or plain key's lowest BIN is whatever level is cheapest in it), or its level is a guess. Suspect rows are hidden while "Hide suspicious" is on.

**Taming.** Each target rarity needs a Taming level (`KAT.tamingReq`: Uncommon 1, Rare 5, Epic 10, Legendary 20, Mythic 25). Your Taming level is a setting (`taming`, also editable on the Kat page): runs whose target needs more are left out of the Kat page, the planner and market alerts; the default (60) drops nothing.

**Not checked.** Pet skins and held items are not part of the AH key, so check the listing in game; whether a skin carries over is not verified. NEU's Special / Very Special steps (Phoenix) are dropped from the catalog. Throughput is one pet per run (`limitedBy: 'kat'`), and Kat holds one pet at a time, so the planner runs at most one Kat upgrade (see Planner).

## Sell or craft?

The **Sell or craft?** page (`#/sell`, `src/domain/sell.ts`) values items you already own. Raw options for `qty` items:

| option | you get | time |
|---|---|---|
| insta-sell | walk the buy orders for `qty` (VWAP), after bazaar tax; if the book holds fewer, only the filled part counts and the row says so | now |
| sell offer | `(ask − 0.1)` after tax × qty | qty / your sell rate (your share of weekly volume) |
| NPC | NPC sell price × qty | now |
| AH | the AH venue of Best sale × qty: one coin under the lowest BIN (median-capped with conservatism), after the AH fees; auctionable items with a scanned price | qty / the AH sales rate |

The insta-sell and sell-offer options read the snapshot as it is.

**Craft up:** for every chain ladder (see Craft chains) that contains the item, every higher tier is an option. Your items are free inputs; side ingredients are bought at their cheapest source (the craft pricer); only whole crafts count (`made = floor(qty / need)`). The crafted items are sold together at their best venue (Best sale for `made` units: an insta-sell walks the book for all of them), and leftover items at the best raw price per item. `net = made × (value of one crafted item − its side-ingredient cost) + leftover × best raw price`; its time is the longer of the crafted sale and the leftover sale. Options are listed best first; the page total adds each item's best option.

## Trades: my orders and the journal

**My orders** (`src/domain/orders.ts`): for each tracked order, against the current book —

| status | buy order | sell offer |
|---|---|---|
| top | your price is the highest bid | your price is the lowest ask |
| tied | others are at your price too (orders > 1 or more items than yours) | same |
| outbid / undercut | a bid above yours | an ask below yours |

"Ahead of you" = items at better prices + others at your price. The fill estimate assumes the whole weekly insta volume on your side (insta-sells for buy orders, insta-buys for sell offers) serves the queue in price order: `(ahead + yours) / (week / 168)` hours. Re-price suggests best ± 0.1. On every new live snapshot the order watcher (`src/state/ordersRunner.ts`) stores each status and toasts (and notifies, if on) once when an order goes from top/tied to outbid/undercut. **Filled** on a buy order opens a sell offer for the same items with the buy price as its cost; on a sell offer it logs a journal entry.

**Journal** (`src/domain/journal.ts`): `profit = qty × sell × (1 − tax) − qty × buy − fees`, where `tax` is the bazaar tax at the time (0 for sales entered net, e.g. from the planner). Totals for today (since local midnight), the last 7 days and all time, ROI = profit / (qty × buy + fees), best and worst items.

## Book combining

Two level-k books combine into one level-(k+1) book, so one level-L book takes `2^(L−k)` level-k books. For each output book, the app tries every `k` from `L − 1` down to `L − 4` (`BOOK.maxChainLevels = 4`, at most 16 input books) and keeps the input level with the most profit per hour. On a tie, it keeps the shorter chain. One unit is one output book: it costs `count` input books, and the input's fill rate and book depth are divided by `count`.

Both legs are bazaar orders in order modes: the input buy order holds `count` books per output book, and the output sell offer one (see Order slots). The row's risk is the output's sell-side risk plus only the `INGREDIENT_FLAGS` (`PRICE_SPIKE`, `QUICK_DIVERGENCE`) of the input's buy side.

**Verified vs unverified.** Not every level can be made on an anvil; some exist only as drops or rewards. `scripts/data/book-rules.json` lists the anvil maximum for enchants we are sure about, with sources. A row is verified when its enchant is in that file and `L` is at most the listed maximum. Every other row is unverified: either the enchant isn't listed (the catalog then only knows the enchanting-table maximum from NEU), or `L` is above the maximum, like Sharpness VI or VII. The Books page hides unverified rows by default (`BOOK.hideUnverified`), and the overview card shows only verified ones.

Combining costs no coins in the model. The anvil's XP-level cost is not modelled.

## Shops

Currency shops (bits, copper, motes, North Stars, medals, coupons, essences, …) come from NEU's NPC shop data and SkyMart. Each offer is valued through Best sale (bazaar after tax, AH after fees while the scan is on, NPC):

```
value            = outQty × best net sale
coinsPerCurrency = value / costQty
```

`coinsPerCurrency` is how many coins one unit of the currency turns into through that offer. Offers with the highest value per currency unit come first. The cost of earning the currency isn't modelled, and there's no throughput: the weekly volume column shows how much the market absorbs (the bazaar's weekly volume on the side you sell to, or a week of measured AH sales).

## Bits shop

The **Bits shop** page (`#/bits`, `src/domain/bits.ts`) ranks Elizabeth's offers paid in bits (`SKYBLOCK_BIT`), prices a bit through Booster Cookies, and fills one cookie's bits into a basket. It is a ranking only: bits offers are not planner opportunities or market-alert kinds.

**Value.** Each offer's output is valued through Best sale, per item:

| quote | net per item |
|---|---|
| bazaar | sell quote in your sell mode, after bazaar tax |
| AH | one coin under the lowest BIN (median-capped with conservatism), after the AH fees (`ahNet`, ×4 claim tax under Derpy), only while the AH scan is on |
| NPC | NPC sell price |

```
value       = outQty × best net
coinsPerBit = value / bits
```

Ties keep bazaar, then AH, then NPC. The detail panel lists the quotes that lost. Risk comes from the winning quote: the bazaar sell-side risk, or `AH_THIN` (fewer than `AH.minCount = 3` listings), `AH_GAP` and `AH_VARIANT` (gear categories) for the AH.

**Cookies.** A Booster Cookie gives `BITS.perCookie = 4,800` bits × your multiplier: the `bitsMultiplier` setting (1 – 5), which the Bits page sets from your fame rank (`BITS.fameRanks`: New Player ×1 up to Imperator ×2.38) or a custom value. The page's older saved rank (`bazaarMasasi.bits`) is moved into the setting once, the first time the page opens.

```
cookieCostPerBit = cookie buy quote (cost mode) / (4,800 × multiplier)
vsCookie         = coinsPerBit / cookieCostPerBit        (> 1: buying cookies to buy this offer pays)
```

**Basket.** One cookie's bits (`4,800 × multiplier`) go to the usable offers (tradeable, valued, not suspect) by coins per bit, best first. Each offer is bought up to what its market absorbs in `BITS.basketHours = 24` h (`sale rate × 24 / outQty` offers; offers of the same item share that), until the bits run out. Bits no offer can take are kept for later and not valued.

```
coinsPerCookie  = the basket's coins
profitPerCookie = coinsPerCookie − cookie cost
```

The same cookie cost per bit prices bits-shop items in Kat upgrades.

**Hand-kept data** (`scripts/data/bits-rules.json`, each entry with a source): Absorb I (4,000 bits) is added because NEU lacks it; the eight abicases and Pure Black / White Dye are kept as auctionable although the Hypixel items API omits them; five sacks are untradeable (`catalog.untradeable`) and are never valued. Untradeable and unpriced rows are hidden by default.

## NPC flips

| direction | buy | sell | risk |
|---|---|---|---|
| Bazaar → NPC | bazaar, current buy mode | NPC sell price, no tax, unlimited | the bazaar buy side only |
| NPC → Bazaar | NPC buy price, instant, at most `npcDailyLimit / 24 × cycleHours` per batch | bazaar, current sell mode, after tax | the bazaar sell side only |

## Fusion

Fusion recipes are entered by the user. Each input is bought at the cheaper of the bazaar (your cost mode) and an NPC shop (instant, capped at `npcDailyLimit / 24` per hour); the output is a bazaar sale after tax. Throughput treats a fusion like a craft with two inputs: the buy rate is the slower bazaar input's `rate / qty`, NPC inputs cap the batch, and the sell rate is the output's rate / qo. Insta legs are re-quoted once at the batch size. Risk covers the buy side of bazaar-bought inputs and the output's sell side.

Fusion fees: the fee per fusion (`FUSION_FEE_COINS`) is added to each fusion's cost, but it is 0 until the real fee is checked in game, so fees are not modelled yet.

## Planner (optimizer)

The planner (`allocate` in `src/domain/optimizer.ts`) chooses how many units of each opportunity to run per cycle.

**Inputs.** `toOpportunities` turns rows into opportunities:

- flips, priced crafts and forges (shop trades count as crafts), craft chain moves, book combines, NPC flips, Kat upgrade runs;
- AH relist flips and George flips as kind `ahflip`. That kind is off by default (`AH_FLIP.plannerDefault`), and the Plan page can switch it on;
- fusion, NPC shop rows and bits offers are not included.

Each opportunity takes its row's planner inputs as they are (`row.plan`, see Throughput):

- `unitCost`: the coins tied up per unit (doubled under pipelined, except for an instant leg);
- `maxUnits`: the most units per cycle the markets allow, with capital and slots unbounded;
- `unitsPerHour`;
- `profitPerUnit`;
- the order units of each order leg;
- the markets it draws on (`uses`);
- for a row with an insta leg or a George flip, a concave profit curve (`segments`).

Profit per hour of an allocated unit is `profitPerUnit × unitsPerHour / maxUnits`. A curve is integrated piece by piece. A curve that turns unprofitable is cut at its last profitable segment, and `maxUnits` ends there.

A Kat run is one unit:

- `unitCost` = buy + upgrade cost, `maxUnits = 1`, `unitsPerHour = 1 / hours`, no order slots;
- it counts as AH-sold, as do AH-valued crafts and AH relist flips. The Plan page's AH toggle leaves AH-sold opportunities out.

**Objective.** Maximize `Σ profit/hour × riskWeight[level] − attention × positions`:

- `OPTIMIZER.riskWeight`: ok 1, caution 0.8, suspect 0.5;
- `attention`: coins per hour charged per open position. The default is `OPTIMIZER.attentionPerPosition = 0`, and the Plan page has an input for it. A higher value favours fewer, bigger positions.

The plan reports the unweighted profit per hour.

**Constraints.**

- total capital ≤ capital (0 = unlimited);
- order slots ≤ order slots, counted at the allocated units: each order leg takes `ceil(u × k / MAX_ORDER_UNITS)`, where `k` is its order units per unit;
- each shared market's draw (`Σ units × perUnit` over every pick that uses it) ≤ its capacity per cycle (`resourceCaps`):

  | market | capacity per cycle |
  |---|---|
  | `X:bid` | X's insta-sells per hour × share × trend × `cycleHours` (it fills your buy orders and takes your insta-sells) |
  | `X:ask` | X's insta-buys per hour × share × trend × `cycleHours` |
  | `X:npc` | `npcDailyLimit / 24 × cycleHours` |
  | `forge` | `forgeSlots × cycleHours` (slot-hours) |

  The trend is the side's volume trend clamped to `CONSERVATIVE.trendClamp`. It applies only with `conservative` on and at least `CONSERVATIVE.minPoints` history points; otherwise it is 1. So a flip and a craft that both buy X by order share X's insta-sell flow instead of each counting all of it.
- capital in one item id ≤ `maxShare × capital`, where `maxShare` defaults to `OPTIMIZER.maxShareOfCapitalPerItem = 0.5`;
- at most one opportunity per item id, and at most one Kat run in total. Kat holds one pet, so every Kat opportunity shares one group (`group = 'kat'`), which the allocator treats like an id;
- suspect opportunities are left out unless you turn that off (`OPTIMIZER.excludeSuspect = true`).

The Plan page can override capital, slots, max share and the attention cost, and choose which kinds to include. Each row's "why" names the limit that stopped it growing:

- `volume`: `maxUnits`;
- `share`: the per-item cap;
- `market`: a market shared with other picks is drawn to its capacity, and the row names it;
- `slots`;
- `capital`.

**Algorithm.**

- *Pieces.* Each opportunity's segments become pieces, with profit per unit non-increasing along them (sub-candidates). A pick never takes a later, cheaper piece before an earlier one.
- *fill(set).* Fills one candidate set:
  1. Every member reserves the slots of one unit.
  2. The pieces take integer units in order of weighted profit per hour per coin.
  3. When a shared market is over-asked by the members at their caps, the pieces go by weighted profit per hour per *priced* unit instead. Each short constraint (that market, and capital when it is short too) is priced at demand / supply², per unit drawn, so the market goes to whoever earns most from it.
  4. Each piece takes what capital, its markets and the spare slots allow.

  A pick that no longer fits whole shrinks to what fits instead of dropping out.
- *Three starts.*
  1. Density greedy: whole picks in order of profit per hour per coin.
  2. Standalone-value greedy: the 200 candidates worth most with the whole budget to themselves.
  3. Lagrangian: price capital at λ coins per hour per coin. Each candidate is worth its pieces that still pay (`profit/h − λ × unitCost > 0`), less the attention cost. The best slot-feasible one-per-group set is a group knapsack over the one-unit slots. λ is bisected over `OPTIMIZER.lambdaIters = 40` steps until the set's capital demand meets the capital, and every distinct set found is evaluated with fill(). λ = 0 when capital never binds.
- *Local search per start.* Moves, cheapest first: best-improvement add or one-for-one swap; drop one and refill; swap one and refill. The refills cover one-for-many exchanges. The search works on a pool of the top 200 candidates by density and the top 200 by standalone value. Its budget is `min(700,000, 50,000 + 500 × n)` fill steps for `n` candidates, split evenly over the starts; a start that converges early leaves the rest to the later ones.

The best score wins. Ties are broken by key, so the result is deterministic and does not depend on the input order.

**Where it runs.** The Plan page and the Overview's plan summary run `allocate` in a Web Worker (`src/state/planWorker.ts`, driven by `src/state/planClient.ts`):

- one request is in flight at a time;
- a newer request replaces one that is waiting, and stale answers are dropped;
- the opportunities array is posted to the worker only when it changes;
- without a Worker (tests, old browsers), or after a worker error, plans run inline.

**Quality, as tested** (`tests/domain/optimizer.test.ts`):

- On 200 seeded random instances the plan is always feasible and reaches at least 0.9 × the brute-force optimum.
- On 150 instances with shared markets, slots counted at the units and an attention cost, it reaches at least 0.9 × the exact optimum.
- A flip and a craft on the same market together stay within its capacity.
- A pick shrinks to the slots left rather than dropping out.
- Concave curves fill their cheaper slices first.
- It is exact when slots are unlimited, `maxShare = 1`, ids are distinct and every unit costs the same.
- Grouped picks (Kat) never break the one-per-group rule and match brute force on small instances.
- 3,000 opportunities over 400 shared markets plan in under 3 s.

With different unit costs the integer problem is NP-hard, so 0.9 is the bound the tests guarantee there.

**Effect on the fixtures** (`npm run bench -- --report`, default settings):

| plan | before round s | now, shared-market capacities ignored | now |
|---|---|---|---|
| 5M capital | 6,119,407/h, 8 positions | 7,233,707/h, 15 positions | 6,445,662/h, 9 positions |
| 1e9 capital | 14,545,720/h, 13 positions | 17,733,388/h, 27 positions | 15,617,813/h, 26 positions |

The shared-market capacities take about 11 % off the plan, because picks no longer each count the whole of a market they share.

## Market stats

Computed from the last 24 h of history in one columnar pass over every item (`statsAll`). The "thinned" series keeps the last point of each 15-minute bucket, so the dense last 3 hours don't outweigh the rest of the day.

| stat | definition | needs |
|---|---|---|
| change 1 h / 24 h | relative change of the mid price `(bid + ask) / 2` from the point at or before `now − span` to the newest point | history reaching back to `now − span`, newest point recent (tolerance: 15 min for 1 h, 2 h for 24 h) |
| volatility | MAD / median of the mid price, thinned | ≥ 12 thinned points (`STATS.consistencyMinPoints`) |
| spread median | median of `(ask − bid) / bid`, thinned | |
| consistency | share of thinned points where a flip was profitable: `(ask − 0.1) × (1 − tax) − (bid + 0.1) > 0` | ≥ 12 thinned points |
| volume trend | see below | ≥ 30 min between first and last point |
| bid / ask moves per hour | how often the best bid (ask) changed between consecutive snapshots in the last 3 h, per hour (used by Conservatism) | ≥ 2 points |

The overview's "Most consistent flips" ranks non-suspect profitable flips by consistency × profit per hour. "Movers" ignores items with fewer than `STATS.moversMinWeekVol = 10,000` insta-buys plus insta-sells a week.

**Volume trend (an estimate).** The API reports only a moving-week counter `W`, the units traded in the last 168 hours. Reading it Δt apart gives:

```
W(t1) − W(t0) = (volume in the last Δt) − (volume in the same Δt one week earlier)
```

The week-earlier volume is unknown, so it is approximated by the average weekly pace `W̄ × Δt / 168 h`, with `W̄ = (W(t0) + W(t1)) / 2`. That gives:

```
trend = 1 + 168 × ΔW / (Δt_h × W̄)      (clamped at ≥ 0)
```

1 means the normal pace and 2 means twice the weekly average. **Caveat:** if the same window last week was unusually busy or quiet, the trend is skewed the other way. History rows are stored as Float32, which keeps about 7 significant digits of `W`.

## Alerts

An alert rule watches one item: `ask`, `bid`, `spreadPct` (`(ask − bid) / bid`), `flipProfit` or `flipMargin`, and fires when the value is below (`lt`) or above (`gt`) a threshold. Flip metrics use the same calculation as the Flips page, without its profit > 0 filter, so a falling margin can trigger an alert.

- Rules are checked once for each new live snapshot. Snapshots restored from cache are skipped.
- A rule that fired waits for its cooldown before firing again: 15 min by default (`ALERTS.defaultCooldownMin`), at most 7 days.
- A fired alert shows a toast, and a browser notification if notifications are on and permitted. The log keeps the last 100 (`ALERTS.logMax`).
- **Alerts only run while a tab with the app is open.** There is no background service.


**Market alerts** (`src/domain/oppAlerts.ts`, Watchlist page): rules over every opportunity instead of one item: kinds (flip, craft, forge, chain, book, NPC, Kat), a metric (profit/hour, profit per item or margin) above a value, and the highest risk level allowed (clean, or clean and caution). On each new live snapshot the runner checks the rows of every page; a rule fires only for rows that were not meeting it at the previous check (`seen`), so a lasting opportunity is reported once, and again only after it drops out and comes back. One grouped toast (and notification) per rule lists the best three; the latest 10 hits are kept on the rule with links to their page.
## Risk flags

Each product's market is checked against `config.RISK`. Some flags need price history: the baseline is the last 24 h, thinned to one point per 15 minutes, leaving out the last 15 minutes so that a fresh spike doesn't become its own baseline.

| flag | condition | weight |
|---|---|---|
| `DEAD_BID` | no bid; or bid < 0.02 × ask (`deadBidRatio`); or bid ≤ 1 while ask > 100 | hard |
| `EXTREME_SPREAD` | `(ask − bid) / bid > 2` (`extremeSpreadMargin`, 200 %), unless `DEAD_BID` | hard |
| `PRICE_SPIKE` | robust z of the ask vs the baseline median > 3.5 (`spikeZ`); or ask > 1.5 × median ask (`spikeUp`); or bid < 0.67 × median bid (`spikeDown`). Needs ≥ 12 baseline points (`spikeMinPoints`) | hard |
| `WIDE_SPREAD` | `(ask − bid) / bid > 0.6` (`wideSpreadMargin`) | 2 |
| `LOW_VOLUME` | the weekly flow that fills the sides used (the smaller one, if both) < 1,000 units (`lowVolumeUnits`), or × price < 1,000,000 coins (`lowVolumeCoins`) | 2 |
| `FEW_ORDERS` | fewer than 5 buy orders or 5 sell offers (`fewOrders`) on a side used | 1 |
| `THIN_TOP` | second ask > 1.25 × best ask (`thinTopGap`) and the best ask holds less than an hour of insta-buys; or the same on the bid side | 1 |
| `QUICK_DIVERGENCE` | `quick_status` buy price / ask or sell price / bid outside [0.5, 2] (`quickDivergence`) | 1 |
| `VOLUME_IMBALANCE` | insta-buys / insta-sells outside [0.1, 10] (`volumeImbalance`), or one side 0 | 1 |
| `AH_THIN` | an AH price or sale with fewer than 3 BIN listings (`AH.minCount`) | 2 |
| `AH_GAP` | the second-lowest BIN is more than 3 × the lowest (`AH_FLIP.gapRatio`) | 2 |
| `AH_VARIANT` | one AH id covers copies that differ: gear and tools (`AH_FLIP.variantCategories`), pets not priced from a `@MAX` key, or a Kat level that is a guess | 1 |
| `NO_HISTORY` | fewer than 12 baseline points | 0 |

Robust z = `0.6745 × (x − median) / MAD`. Hard flags weigh `suspectScore = 3`.

**Side-aware risk.** A strategy is checked only on the sides of the book it trades (`assessRisk(p, stats, use)`, memoized per item and use in the market core). A buy order and an insta-sell use the bids, which fill from insta-sells; an insta-buy and a sell offer use the asks, which fill from insta-buys.

| flag | checked when |
|---|---|
| `DEAD_BID`, `WIDE_SPREAD`, `EXTREME_SPREAD` | a sell side is used: a buyer pays the quote it gets, whatever the spread |
| `LOW_VOLUME`, `FEW_ORDERS`, `THIN_TOP`, `QUICK_DIVERGENCE` | on the book sides used |
| `VOLUME_IMBALANCE` | the side with the smaller flow is used |
| `PRICE_SPIKE`, `NO_HISTORY` | always |

| row | sides checked |
|---|---|
| flip | buy side (cost mode) and sell side (sell mode) |
| bazaar → NPC | buy side only |
| NPC → bazaar | sell side only |
| book combine | output sell side; the input's buy side adds only `PRICE_SPIKE` and `QUICK_DIVERGENCE` |
| craft | the sale's risk; bazaar-bought ingredients add only `PRICE_SPIKE` and `QUICK_DIVERGENCE`, thin AH-bought ones `AH_THIN` |
| fusion | buy side of bazaar-bought inputs, sell side of the output |
| Best sale (Bits, Shops, Sell or craft?) | the winning venue: bazaar sell side, or the AH flags |

The item page shows the side-blind report (every flag on both sides).

**Levels.** A row is **suspect** if it has any hard flag, or both `WIDE_SPREAD` and `LOW_VOLUME`, or a score ≥ 3 (`suspectScore`). Otherwise it is **caution** at a score ≥ 1 (`cautionScore`), else **ok**. Rows that combine several markets (crafts, books, fusion) take the union of the flags, the highest score and the worst level. "Hide suspicious" hides suspect rows from the tables.

## Deferred / not modelled

- **Minion calculator.** There are no usable drop tables.
- **Automatic shard-fusion candidates.** NEU's `attribute_shards.json` has no recipes, so fusion recipes are entered by hand.
- **Collection and recipe requirements.** Every recipe is assumed to be unlocked.
- **Order book changes during fills.** Prices, competition and volume are taken from the current snapshot and held constant while your orders fill. With conservatism on, the recent history makes them less optimistic, but they still don't move during a fill.
- **Fusion fees.** `FUSION_FEE_COINS = 0`.
- Also not modelled: the anvil XP cost of book combining, AH item attributes (stars, reforges, enchantments; pet level only through the level keys), per-item NPC limits (one global setting), and mayor perks (shown on the overview but not used in calculations, apart from Derpy's AH claim tax).
