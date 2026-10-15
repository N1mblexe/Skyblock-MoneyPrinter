# How estimates are made

This page describes the model behind every number the app shows. Constants are named as they appear in `src/config.ts`; the code is in `src/domain/`. All figures are estimates from one bazaar snapshot plus the price history your browser has collected.

## Settings that feed the model

| setting | default | range | used for |
|---|---|---|---|
| Bazaar tax (`taxRate`) | 1.25 % | 1.25 / 1.125 / 1 % | bazaar sales |
| Capital (`capital`) | 5,000,000 | 0 – 10^13 (0 = unlimited) | coins tied up per cycle |
| Your share of volume (`share`) | 5 % | 0 – 100 % | fill rates |
| Cycle length (`cycleHours`) | 1 h | 0.05 – 168 h | batch size |
| When buying (`costMode`) | buy order | buy order / insta-buy | buy quotes |
| When selling (`sellMode`) | sell offer | sell offer / insta-sell | sell quotes |
| Forge slots (`forgeSlots`) | 2 | 1 – 7 | forge throughput |
| Order slots (`orderSlots`) | 14 (`ORDER_SLOTS_DEFAULT`) | 1 – 35 (`ORDER_SLOTS_MAX`) | batch size, planner |
| NPC daily limit (`npcDailyLimit`) | 640 (`NPC_DAILY_LIMIT_DEFAULT`) | 1 – 10,000,000 | NPC purchases |
| Fill model (`fillModel`) | sequential | sequential / pipelined | throughput |
| Auction house scan (`ahEnabled`) | on | on / off | off-bazaar craft outputs |
| Hide suspicious (`hideSuspicious`) | on | on / off | table filters only |

## Quotes

The bazaar API names its sides the other way round: `sell_summary` holds buy orders (bids) and `buy_summary` holds sell offers (asks). The app stores up to 30 levels per side (`BOOK_DEPTH`). `quick_status` averages are not used for prices.

| mode | price per unit | notes |
|---|---|---|
| Buy order | `min(max(bid + 0.1, 0.9 × npcSell), ask)`, rounded to 0.1 | `PRICE_TICK = 0.1`, `NPC_FLOOR_RATIO = 0.9` |
| Insta-buy | volume-weighted average over the asks for the quantity | slippage = (average − best ask) / best ask |
| Sell offer | `max(0.1, ask − 0.1)` | |
| Insta-sell | volume-weighted average over the bids for the quantity | |

**NPC floor.** Raw materials often show a 0.1-coin bid that never fills in real volume. Sellers rarely dump far below what an NPC pays, so a buy order is assumed to cost at least 0.9 × the item's NPC sell price. When the floor raises the price, the quote is marked `npcFloor`. One consequence: a bazaar → NPC flip by buy order can earn at most 0.1 × the NPC price per unit, a margin of 11.1 %.

**Ask clamp.** A buy order above the ask makes no sense, so the price is capped at the ask and the quote is marked `ask`. Such an order fills against the sell offers at once, so it gets the insta-buy fill rate with no queue (see below).

**Insta refine.** Insta quotes are first made for one unit. After the batch size is known, the insta legs are re-quoted once at the batch size so that slippage shows in the profit. Flips, books and NPC flips do this when the trade is profitable at one unit; crafts do it for directly bought insta ingredients and an insta-sold bazaar output.

## Tax

Bazaar sales receive `price × (1 − taxRate)`. Buys and NPC sales are not taxed. AH sales pay the AH fees below. The Bazaar Flipper upgrades in the Community Shop lower the rate to 1.125 % and 1 %.

## Fill rates

Hourly market rates come from the moving-week counters, divided by 168:

| your side | fills from |
|---|---|
| buy order | insta-sells (`sellMovingWeek / 168`) |
| insta-buy | insta-buys (`buyMovingWeek / 168`) |
| sell offer | insta-buys (`buyMovingWeek / 168`) |
| insta-sell | insta-sells (`sellMovingWeek / 168`) |

Your rate is the market rate times your share of it:

- **Orders and offers** queue behind competitors. `n` is the sum of the `orders` counts on every level within 1 % (`COMP_TOL`) of the best price on that side. Your rate is `market × min(share, 1 / (1 + n))`.
- **Insta modes** don't queue. Your rate is `market × share`, and the batch is capped by the units on the book (`depthCap`, the sum over the stored levels).
- **A buy order clamped at the ask** gets `insta-buy rate × share`, with no competition.

Example: 1,680,000 insta-sells a week is 10,000 per hour. With a 5 % share and 3 competing bids, your buy order fills `10,000 × min(0.05, 1/4) = 500` per hour. With 30 competing bids it is `10,000 × 1/31 ≈ 323` per hour.

## Throughput: sequential vs pipelined

Each trade is planned as one batch of `Q` units per period. Let `rB` and `rS` be your buy and sell rates in units per hour, and `hB = 1/rB`, `hS = 1/rS` the hours per unit (0 when a side is instant, for example selling to an NPC).

| | sequential (default) | pipelined |
|---|---|---|
| idea | buy the batch, then sell it | buy the next batch while the previous one sells |
| hours per unit, `hFill` | `hB + hS` | `max(hB, hS)` |
| capital held | `Q × unitCost` | `2 × Q × unitCost` (1× when one side is instant) |

The batch is the smallest of these bounds, and `limitedBy` records which one won:

| bound | formula | `limitedBy` |
|---|---|---|
| volume | `cycleHours / hFill` | `volume`, or `npcLimit` when the binding side is an NPC purchase |
| forge | `forgeCap × cycleHours`, with `forgeCap = forgeSlots × 3600 / durationSec` | `forge` |
| capital | `floor(capital / (overlap × unitCost))`, overlap 2 for pipelined, else 1 | `capital` |
| depth | units on the book (insta legs only) | `depth` |
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

## Order slots and `MAX_ORDER_UNITS`

A bazaar order holds at most `MAX_ORDER_UNITS = 71,680` units. Each order or offer leg of a batch takes `ceil(Q × units per batch unit / 71,680)` slots, at least 1. Insta and NPC legs take none.

- A flip by buy order and sell offer at `Q = 100,000` takes 2 + 2 = 4 slots.
- A craft counts one order per ordered ingredient line (qty per craft × Q) plus the output offer (output count × Q). A sub-crafted ingredient's ordered inputs are counted together as one order, so slots are slightly underestimated there.
- A book combine orders `count × Q` input books plus `Q` output books.

If the batch needs more than `orderSlots` slots, it shrinks to the largest size that fits (`limitedBy = slots`).

## NPC daily limit

NPC shops limit how much of each item you can buy per day, and the in-game limits vary. The app uses one value for every item, the `npcDailyLimit` setting (default 640). It is spread evenly over the day: you can buy `npcDailyLimit / 24` units per hour. This rate caps NPC → bazaar flips and NPC-bought craft ingredients, and shows as `limitedBy = npcLimit`. Selling to an NPC has no limit in the model.

## Crafts and forges

**Ingredients.** Each ingredient takes its cheapest source:

1. a bazaar quote in the current buy mode,
2. the NPC shop price (rate `npcDailyLimit / 24`), or
3. a sub-craft, if strictly cheaper than both. Only `craft` recipes are used as sub-crafts, never forge recipes. Sub-crafts go up to `CRAFT_RECURSION_DEPTH = 3` levels deep, and cycles are cut.

A sub-craft's unit cost is `Σ qty × input cost / outCount`. Its rate is the slowest input's `rate / qty`, times `outCount`.

**Output value.**

| output | value per craft |
|---|---|
| bazaar product | `outCount × max(bazaar sell quote after tax, NPC sell price)` |
| not on the bazaar | `outCount × max(NPC sell price, AH lowest BIN)`, NPC on a tie |
| neither priced | unpriced (cost and value shown as 0, hidden by default) |

When the AH value wins and the item had fewer than `AH.minCount = 2` BIN listings, the row gets the `AH_THIN` flag. NPC and AH sales are not limited by bazaar volume, so only the ingredients and forge slots limit those rows.

**Throughput.** The buy rate is the slowest ingredient line in crafts per hour (the "bottleneck"). The sell rate is the output's bazaar rate / outCount, or unlimited for NPC and AH sales. Forges are also limited by `forgeSlots × 3600 / durationSec` per hour.

**Risk.** A craft row combines the output's market risk (when sold on the bazaar) with only the `PRICE_SPIKE` and `QUICK_DIVERGENCE` flags of bazaar-bought ingredients. Dead bids are normal on raw materials, so the other ingredient flags are ignored.

## Craft chains

The **Chains** tab of Craft & Forge (`#/craft?view=chains`, `src/domain/chains.ts`) prices multi-step crafts along a ladder, such as Wheat → Enchanted Wheat → Enchanted Hay Bale.

**Steps and ladders.** A `craft` recipe with a bazaar output is a chain step when its main input (the input with the largest quantity) is a bazaar item, makes up at least `CHAIN.mainShare = 0.5` of the recipe's input items, and goes in faster than the output comes out (`qty / outCount > 1`; this drops uncrafting such as Hay Bale → 9 Wheat). The other inputs are side ingredients. When several recipes link the same two items, the one with the fewest side inputs wins, then the one with the fewest main units per output. Steps join into ladders from a root (an item no step produces) to a top; a tier with two steps up gives two ladders.

**Moves.** A move buys one tier and crafts it up at least `CHAIN.minSteps = 2` steps (single steps are the Recipes tab's rows). It is priced as one recipe: `need` units of the first tier plus every step's side ingredients, summed top-down (crafts at a step = units needed of its output / outCount), producing one unit of the top tier. Pricing is the craft model above, with one difference: the first tier is always bought, never sub-crafted, so a move means what it says. By default it is bought on the bazaar (`ChainStart` `bazaar`): an NPC shop is often cheaper per item, but its daily limit makes long ladders crawl. The tab's "First tier from: Cheapest" switch allows the NPC price too. Side ingredients always take their cheapest source.

**Best per ladder.** By default the tab shows each ladder's move with the highest profit per hour. The planner gets every priced, profitable move as a `chain` opportunity; a move and the same item's craft row share the planner's one-position-per-item rule.

**Recipe gaps.** `scripts/data/extra-recipes.json` adds hand-checked recipes for outputs NEU has none for. It is empty for now: the hay items without a NEU recipe (`ENCHANTED_HAY_BLOCK`, `TIGHTLY_TIED_HAY_BALE`) are legacy items that can no longer be crafted.

## Auction house values

The AH scan reads every page of `/v2/skyblock/auctions`, keeps unclaimed BIN listings only, decodes each item's NBT and records the lowest price and listing count per id. A page that fails twice is skipped and the scan goes on.

The id is `ExtraAttributes.id`, with two adjustments: pets become `TYPE;RARITY` (for example `ENDER_DRAGON;4`), and single-enchant books become `ENCHANTMENT_<NAME>_<LEVEL>`. Everything else about the item is ignored, so:

- one lowest BIN covers every copy of a base id, whatever its stars, reforge, enchantments or pet level. A starred or levelled item is valued like the cheapest copy;
- the lowest BIN is taken as your sale price, without undercutting;
- every AH sale pays the seller fees (`AH.fees` in `src/config.ts`, `ahNet` in `src/domain/pricing.ts`), per item listed:

| fee | amount |
|---|---|
| BIN listing fee | 1 % up to 10M, 2 % up to 100M, 2.5 % above |
| claim tax | 1 % of sales above 1M, never taking the payout below 1M; ×4 while Derpy is mayor (read from the election data) |

AH values are used only for craft outputs that aren't bazaar products, and only while the AH scan is on. The item page also shows the lowest BIN.

## AH flips

The **AH flips** page (`#/ahflip`, `src/domain/ahFlips.ts`) uses the AH scan's two lowest BIN prices per id (scan v2; an older cached scan shows a "rescan needed" note until the next scan). A row buys the lowest BIN and relists it at the second-lowest minus `AH_FLIP.undercut = 1` coin:

`profit = ahNet(next − 1) − lowest`, `margin = profit / lowest`, using the AH fees above (×4 claim tax under Derpy).

Ids need at least `AH_FLIP.minCount = 3` BIN listings (the page's default filter is 5). Because one id covers every copy of an item, two flags warn about variants: `AH_VARIANT` for pets and for gear and tools (`AH_FLIP.variantCategories`), and `AH_GAP` when the second price is more than `AH_FLIP.gapRatio = 3` times the lowest. Both together make a row suspect, hidden while "Hide suspicious" is on. Prices can change before you reach the listing; the page copies `/viewauction <uuid>` for the cheapest listing.

## Book combining

Two level-k books combine into one level-(k+1) book, so one level-L book takes `2^(L−k)` level-k books. For each output book, the app tries every `k` from `L − 1` down to `L − 4` (`BOOK.maxChainLevels = 4`, at most 16 input books) and keeps the most profitable chain. On a tie, it keeps the shorter chain. One unit is one output book: it costs `count` input books, and the input's fill rate and book depth are divided by `count`.

**Verified vs unverified.** Not every level can be made on an anvil; some exist only as drops or rewards. `scripts/data/book-rules.json` lists the anvil maximum for enchants we are sure about, with sources. A row is verified when its enchant is in that file and `L` is at most the listed maximum. Every other row is unverified: either the enchant isn't listed (the catalog then only knows the enchanting-table maximum from NEU), or `L` is above the maximum, like Sharpness VI or VII. The Books page hides unverified rows by default (`BOOK.hideUnverified`), and the overview card shows only verified ones.

Combining costs no coins in the model. The anvil's XP-level cost is not modelled.

## Shops

Currency shops (bits, copper, motes, North Stars, medals, coupons, essences, …) come from NEU's NPC shop data and SkyMart. Each offer is valued as:

```
value            = outQty × max(bazaar sell quote after tax, NPC sell price)
coinsPerCurrency = value / costQty
```

`coinsPerCurrency` is how many coins one unit of the currency turns into through that offer. Offers with the highest value per currency unit come first. The cost of earning the currency isn't modelled, and there's no throughput: the weekly volume column shows how much the bazaar absorbs.

## NPC flips

| direction | buy | sell |
|---|---|---|
| Bazaar → NPC | bazaar, current buy mode | NPC sell price, no tax, unlimited |
| NPC → Bazaar | NPC buy price, `npcDailyLimit / 24` per hour | bazaar, current sell mode, after tax |

## Fusion

Fusion recipes are entered by the user. Inputs are priced as bazaar buys and the output as a bazaar sale after tax. Throughput treats a fusion like a craft with two inputs: the buy rate is the slower input's `rate / qty`, and the sell rate is the output's rate / qo. Fusion fees are not modelled (`FUSION_FEE_COINS = 0`, and the fee isn't applied anywhere).

## Planner (optimizer)

The planner chooses how many units of each opportunity to run per cycle.

**Inputs.** Profitable flips, priced crafts, craft chain moves, book combines and NPC flips. Fusion and shop rows are not included. For each one:

- `unitCost` = buy cost per unit, doubled under the pipelined fill model;
- `maxUnits` = the batch size the market allows, with the capital bound removed. If a row's batch was limited by capital, it is scaled back up to `batchQty / fillHours × cycleHours`;
- profit per hour per allocated unit = `profitPerUnit × unitsPerHour / maxUnits`, linear up to `maxUnits`;
- slots = the order slots used at `maxUnits`. This is fixed per pick, even if fewer units are allocated.

**Objective.** Maximize total profit per hour.

**Constraints.**

- total capital ≤ capital (0 = unlimited);
- total order slots ≤ order slots;
- capital in one item id ≤ `maxShare × capital`, where `maxShare` defaults to `OPTIMIZER.maxShareOfCapitalPerItem = 0.5`;
- at most one opportunity per item id;
- suspect rows are excluded unless you turn that off (`OPTIMIZER.excludeSuspect = true`).

The planner page can override capital, slots and max share, and choose which kinds to include.

**Algorithm.** Every candidate set is filled greedily by profit per hour per coin, in whole units, with the last pick taking whatever capital is left. The sets come from three starts:

1. density greedy: add candidates in order of profit per hour per coin;
2. standalone greedy: add the 200 candidates with the highest profit per hour if each had the whole budget to itself;
3. Lagrangian: price capital at λ coins per hour per coin for 33 values of λ (0 and 32 densities spread across the candidates). For each λ, pick the best one-per-id set under the slot limit by dynamic programming (a group knapsack over slots).

Each start is then improved by local search: add one or swap one for one, drop one and refill, then swap one and refill. The search works on a pool of the top 200 candidates by density and the top 200 by standalone value, and stops after 3,000,000 steps. The best result wins. Ties are broken by key, so the result is deterministic.

**Quality, as tested** (`tests/domain/optimizer.test.ts`):

- On 200 seeded random instances, the plan is always feasible and reaches at least 0.9 × the brute-force optimum.
- It is exact when slots are unlimited, `maxShare = 1`, ids are distinct and every unit costs the same.

With different unit costs the integer problem is NP-hard, so 0.9 is the bound the tests guarantee there.

## Market stats

Computed from the last 24 h of history. The "thinned" series keeps the last point of each 15-minute bucket, so the dense last 3 hours don't outweigh the rest of the day.

| stat | definition | needs |
|---|---|---|
| change 1 h / 24 h | relative change of the mid price `(bid + ask) / 2` from the point at or before `now − span` to the newest point | history reaching back to `now − span`, newest point recent (tolerance: 15 min for 1 h, 2 h for 24 h) |
| volatility | MAD / median of the mid price, thinned | ≥ 12 thinned points (`STATS.consistencyMinPoints`) |
| spread median | median of `(ask − bid) / bid`, thinned | |
| consistency | share of thinned points where a flip was profitable: `(ask − 0.1) × (1 − tax) − (bid + 0.1) > 0` | ≥ 12 thinned points |
| volume trend | see below | ≥ 30 min between first and last point |

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

## Risk flags

Each product's market is checked against `config.RISK`. Some flags need price history: the baseline is the last 24 h, thinned to one point per 15 minutes, leaving out the last 15 minutes so that a fresh spike doesn't become its own baseline.

| flag | condition | weight |
|---|---|---|
| `DEAD_BID` | no bid; or bid < 0.02 × ask (`deadBidRatio`); or bid ≤ 1 while ask > 100 | hard |
| `EXTREME_SPREAD` | `(ask − bid) / bid > 2` (`extremeSpreadMargin`, 200 %), unless `DEAD_BID` | hard |
| `PRICE_SPIKE` | robust z of the ask vs the baseline median > 3.5 (`spikeZ`); or ask > 1.5 × median ask (`spikeUp`); or bid < 0.67 × median bid (`spikeDown`). Needs ≥ 12 baseline points (`spikeMinPoints`) | hard |
| `WIDE_SPREAD` | `(ask − bid) / bid > 0.6` (`wideSpreadMargin`) | 2 |
| `LOW_VOLUME` | `min(insta-buys, insta-sells)` per week < 1,000 units (`lowVolumeUnits`), or × price < 1,000,000 coins (`lowVolumeCoins`) | 2 |
| `FEW_ORDERS` | fewer than 5 buy orders or 5 sell offers (`fewOrders`) | 1 |
| `THIN_TOP` | second ask > 1.25 × best ask (`thinTopGap`) and the best ask holds less than an hour of insta-buys; or the same on the bid side | 1 |
| `QUICK_DIVERGENCE` | `quick_status` buy price / ask or sell price / bid outside [0.5, 2] (`quickDivergence`) | 1 |
| `VOLUME_IMBALANCE` | insta-buys / insta-sells outside [0.1, 10] (`volumeImbalance`), or one side 0 | 1 |
| `AH_THIN` | AH-valued craft output with fewer than 2 BIN listings (`AH.minCount`) | 2 |
| `NO_HISTORY` | fewer than 12 baseline points | 0 |

Robust z = `0.6745 × (x − median) / MAD`. Hard flags weigh `suspectScore = 3`.

**Levels.** A row is **suspect** if it has any hard flag, or both `WIDE_SPREAD` and `LOW_VOLUME`, or a score ≥ 3 (`suspectScore`). Otherwise it is **caution** at a score ≥ 1 (`cautionScore`), else **ok**. Rows that combine several markets (crafts, books, fusion) take the union of the flags, the highest score and the worst level. "Hide suspicious" hides suspect rows from the tables.

## Deferred / not modelled

- **Minion calculator.** There are no usable drop tables.
- **Automatic shard-fusion candidates.** NEU's `attribute_shards.json` has no recipes, so fusion recipes are entered by hand.
- **Collection and recipe requirements.** Every recipe is assumed to be unlocked.
- **Order book changes during fills.** Prices, competition and volume are taken from the current snapshot and held constant while your orders fill.
- **Fusion fees.** `FUSION_FEE_COINS = 0`.
- Also not modelled: the anvil XP cost of book combining, AH item attributes (stars, reforges, pet level), per-item NPC limits (one global setting), and mayor perks (shown on the overview but not used in calculations).
