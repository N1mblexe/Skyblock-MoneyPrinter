// Shared contracts. Every module codes against these; change only via the lead.

// ---------------------------------------------------------------- Market snapshot
export interface OrderLevel {
  price: number;
  amount: number;
  orders: number;
}

export interface QuickStatus {
  buyPrice: number;
  sellPrice: number;
  buyVolume: number;
  sellVolume: number;
  buyMovingWeek: number;
  sellMovingWeek: number;
  buyOrders: number;
  sellOrders: number;
}

export interface Product {
  id: string;
  /** Highest BUY ORDER = sell_summary[0].pricePerUnit. null when no buy orders. */
  bid: number | null;
  /** Lowest SELL OFFER = buy_summary[0].pricePerUnit. null when no sell offers. */
  ask: number | null;
  /** Buy orders (from sell_summary), price desc, max BOOK_DEPTH levels. */
  bids: OrderLevel[];
  /** Sell offers (from buy_summary), price asc, max BOOK_DEPTH levels. */
  asks: OrderLevel[];
  quick: QuickStatus;
  /** = quick.buyMovingWeek: units insta-bought per week (these fill sell offers). */
  instaBuysWeek: number;
  /** = quick.sellMovingWeek: units insta-sold per week (these fill buy orders). */
  instaSellsWeek: number;
}

export type SnapshotSource = 'live' | 'cache' | 'manual' | 'fixture';

export interface Snapshot {
  /** Hypixel's lastUpdated (ms epoch). */
  lastUpdated: number;
  /** When we received it (ms epoch). */
  fetchedAt: number;
  source: SnapshotSource;
  products: Record<string, Product>;
}

// ---------------------------------------------------------------- Catalog (built by scripts/build-data.ts)
export interface CatalogItemEntry {
  /** display name */
  n: string;
  /** tier/rarity */
  t?: string;
  /** NPC sell price (coins per unit) */
  ns?: number;
  /** NPC buy price (coins per unit, coin-only shops, cheapest) */
  nb?: number;
  /** 1 = is a bazaar product */
  bz?: 1;
  /** item category from the Hypixel items API (v2) */
  c?: string;
  /** 1 = can be auctioned (v2) */
  ah?: 1;
  /** attribute shard metadata (v2): rarity, families, alignment */
  sh?: { r: string; f?: string[]; a?: string };
}

/** One non-coin (or coin) NPC shop offer (v2): pay `cq` x `cur`, get `oq` x `o`. */
export interface CatalogShopOffer {
  /** shop NEU id / name */
  s: string;
  /** currency id, e.g. 'SKYBLOCK_COIN', 'SKYBLOCK_BIT', 'SKYBLOCK_COPPER', 'SKYBLOCK_MOTE', or an item id */
  cur: string;
  cq: number;
  o: string;
  oq: number;
}

/** Enchanted-book combining rule (v2), keyed by base enchant id (ENCHANTMENT_<BASE>). */
export interface CatalogBookRule {
  /** max level from the enchanting table */
  t?: number;
  /** curated max level reachable by anvil combining (verified) */
  m?: number;
}

export interface CatalogRecipeEntry {
  /** output id (bazaar-normalized) */
  o: string;
  /** output count */
  c: number;
  /** inputs [id, qty] (bazaar-normalized, qty merged per id) */
  i: [string, number][];
  /** shop: an NPC offer that costs items (and maybe coins, as the input SKYBLOCK_COIN), or a NEU `trade` recipe */
  k: 'craft' | 'forge' | 'shop';
  /** shop recipes: the NEU shop id, or 'trade' */
  s?: string;
  /** forge duration in seconds */
  d?: number;
  /** requirement text */
  r?: string;
}

export interface CatalogFile {
  v: 1 | 2;
  generatedAt: string;
  neuCommit?: string;
  itemsApiUpdated?: number;
  items: Record<string, CatalogItemEntry>;
  recipes: CatalogRecipeEntry[];
  /** v2 */
  shops?: CatalogShopOffer[];
  /** v2 */
  books?: Record<string, CatalogBookRule>;
  /** v2: Kat pet upgrade steps (NEU katgrade recipes); file shape owned by the catalog build */
  kat?: unknown;
  /** v2: pet XP table (NEU constants/pets.json) */
  petLeveling?: unknown;
  /** v2: pet type -> display name (NEU constants/pets.json id_to_display_name) */
  petNames?: Record<string, string>;
  /** v2: item ids that cannot be traded (e.g. bits-shop sacks); hand-kept in scripts/data/bits-rules.json */
  untradeable?: string[];
  /** v2: what George pays for a pet, keyed `TYPE;IDX` (NEU constants/george.json) */
  george?: Record<string, number>;
}

export interface ItemInfo {
  id: string;
  name: string;
  tier?: string;
  npcSell?: number;
  npcBuy?: number;
  bazaar: boolean;
  category?: string;
  auctionable?: boolean;
  shard?: { rarity: string; family: string[]; alignment?: string };
}

export interface ShopOffer {
  shop: string;
  currency: string;
  costQty: number;
  output: string;
  outQty: number;
}

/** One Kat upgrade: pet `${pet};${from}` -> `${pet};${to}` (rarity index, COMMON=0 ... MYTHIC=5). */
export interface KatStep {
  /** pet type, e.g. OCELOT */
  pet: string;
  from: number;
  to: number;
  /** base coin cost before the per-level discount */
  coins: number;
  /** base wait time in hours */
  hours: number;
  items: { id: string; qty: number }[];
}

/** Pet XP curve: total XP for level L at rarity R = sum of levels[offsets[R] .. offsets[R] + L - 2]. */
export interface PetLeveling {
  /** rarity name (COMMON, ..., MYTHIC) -> start index into `levels` */
  offsets: Record<string, number>;
  /** XP needed for each next level */
  levels: number[];
  /** per-pet overrides (e.g. GOLDEN_DRAGON goes to 200) */
  custom: Record<string, { levels?: number[]; maxLevel?: number; append?: boolean }>;
}

export interface BookRule {
  maxLevel: number;
  /** true when maxLevel comes from the curated anvil table, false when only from the enchanting table / guess */
  verified: boolean;
}

export interface Recipe {
  /** stable unique key, e.g. `${output}#${index}` */
  key: string;
  output: string;
  outCount: number;
  inputs: { id: string; qty: number }[];
  kind: 'craft' | 'forge' | 'shop';
  /** shop recipes: the NEU shop id, or 'trade' */
  shop?: string;
  durationSec?: number;
  req?: string;
}

export interface Catalog {
  meta: { generatedAt: string; neuCommit?: string; itemsApiUpdated?: number };
  items: Record<string, ItemInfo>;
  recipes: Recipe[];
  byOutput: Map<string, Recipe[]>;
  byInput: Map<string, Recipe[]>;
  /** Display name; falls back to deriveName(id). */
  name(id: string): string;
  shops: ShopOffer[];
  /** base = 'ENCHANTMENT_<BASE>' (no level suffix); null when unknown */
  bookRule(base: string): BookRule | null;
  /** Kat upgrade steps (empty for older catalogs) */
  kat: KatStep[];
  /** null for older catalogs */
  petLeveling: PetLeveling | null;
  /** pet type -> display name */
  petNames: Record<string, string>;
  /** items that can't be sold to other players */
  untradeable: ReadonlySet<string>;
  /** what George pays for a pet, keyed `TYPE;IDX` (empty for older catalogs) */
  george: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------- Settings
export type CostMode = 'order' | 'insta';
export type SellMode = 'offer' | 'insta';
export type { Lang } from '../i18n/languages.ts';
import type { Lang } from '../i18n/languages.ts';
import type { Msg } from '../i18n/errors.ts';
import type { KatRow } from '../domain/kat.ts';
import type { AhFlipRow } from '../domain/ahFlips.ts';
import type { MarketCore } from '../domain/market.ts';
export type Theme = 'auto' | 'light' | 'dark';
export type TaxRate = 0.0125 | 0.01125 | 0.01;
/** sequential: buy the batch, then sell it; pipelined: buy and sell overlap (needs 2x capital) */
export type FillModel = 'sequential' | 'pipelined';
export type Density = 'comfortable' | 'compact';

export interface Settings {
  taxRate: TaxRate;
  /** total coins you are willing to tie up */
  capital: number;
  /** your share of the market's fill volume, 0..1 */
  share: number;
  /** how often you cycle (relist/collect) orders, hours */
  cycleHours: number;
  costMode: CostMode;
  sellMode: SellMode;
  forgeSlots: number;
  hideSuspicious: boolean;
  autoRefresh: boolean;
  lang: Lang;
  theme: Theme;
  /** bazaar order slots available (each order of up to MAX_ORDER_UNITS uses one) */
  orderSlots: number;
  /** per-item NPC shop purchase limit per day */
  npcDailyLimit: number;
  fillModel: FillModel;
  density: Density;
  /** fire browser notifications for alerts (permission still required) */
  notify: boolean;
  /** scan the auction house for lowest BIN prices */
  ahEnabled: boolean;
  /** your Taming level (0..KAT.maxTaming): Kat upgrades whose target rarity needs more are left out */
  taming: number;
  /**
   * History-based conservatism (on by default): sell legs priced at no more than the recent median, buy legs at no
   * less, fill rates scaled by the recent volume trend, a churn cost for being outbid / undercut, and AH sales at the
   * median sold price. Off: the raw snapshot numbers.
   */
  conservative: boolean;
  /** bits per Booster Cookie multiplier (fame rank or custom), 1..5; set on the Bits page */
  bitsMultiplier: number;
}

// ---------------------------------------------------------------- Domain results
/** ah: bought at the AH lowest BIN; mix: an NPC shop up to its limit, the rest from the bazaar */
export type QuoteSource = 'order' | 'insta' | 'npc' | 'craft' | 'ah' | 'mix';

export interface Quote {
  /** per-unit price (before tax) */
  price: number;
  /** units fillable at this quote (Infinity for order modes / NPC) */
  filled: number;
  /** (price - top of book) / top of book, 0 for order modes */
  slippage: number;
  source: QuoteSource;
  /**
   * order price was clamped: raised to the NPC floor, or capped at the ask. A buy order capped at the ask fills
   * against the sell offers at once, so it comes back as source 'insta' (walk-book VWAP, depth-bound, no slot).
   */
  clamped?: 'npcFloor' | 'ask';
}

export interface Throughput {
  unitsPerHour: number;
  batchQty: number;
  capitalUsed: number;
  fillHours: number;
  /** ahSales: the AH sells this many per hour (measured from auctions_ended, else AH_SALES.defaultPerHour) */
  limitedBy: 'volume' | 'capital' | 'depth' | 'forge' | 'npcLimit' | 'slots' | 'kat' | 'ahSales';
  /** hours to buy / sell one batch */
  buyHours?: number;
  sellHours?: number;
  /** order slots one batch occupies */
  slots?: number;
}

export type RiskFlag =
  | 'DEAD_BID'
  | 'WIDE_SPREAD'
  | 'EXTREME_SPREAD'
  | 'FEW_ORDERS'
  | 'LOW_VOLUME'
  | 'THIN_TOP'
  | 'QUICK_DIVERGENCE'
  | 'VOLUME_IMBALANCE'
  | 'PRICE_SPIKE'
  /** off-bazaar output valued from fewer than AH.minCount auction listings */
  | 'AH_THIN'
  /** AH id that covers many variants (pets: level; gear and tools: stars, reforges, enchants) */
  | 'AH_VARIANT'
  /** the second-lowest BIN is far above the lowest: likely a different variant or a mispriced listing */
  | 'AH_GAP'
  | 'NO_HISTORY';

export type RiskLevel = 'ok' | 'caution' | 'suspect';

export interface RiskReport {
  level: RiskLevel;
  score: number;
  flags: RiskFlag[];
}

export interface PriceStats {
  /** number of history points used */
  n: number;
  medianAsk: number;
  medianBid: number;
  madAsk: number;
  madBid: number;
  /** relative change of mid price vs ~24h ago (0.05 = +5%), null if unknown */
  change24h: number | null;
}

/** What history-based conservatism changed on a row (settings.conservative); absent when nothing changed. */
export interface ConsInfo {
  /** buy price before the adjustment (snapshot quote) */
  buyRef?: number;
  /** sell price before the adjustment */
  sellRef?: number;
  /** fill-rate multiplier from the recent volume trend (<= 1) */
  rateMul?: number;
  /** expected coins lost per unit to re-listing after being outbid / undercut */
  churn?: number;
}

/**
 * A market the planner shares between positions. X:bid = X's insta-sell flow (fills your buy orders on X and your
 * insta-sells of X); X:ask = X's insta-buy flow (your sell offers, your insta-buys); X:npc = X's NPC daily limit;
 * forge = your forge slots (per unit: slot-hours).
 */
export type ResourceKey = `${string}:bid` | `${string}:ask` | `${string}:npc` | 'forge';

export interface ResourceUse {
  key: ResourceKey;
  /** resource units drawn per unit of the opportunity (e.g. 9 Wheat per Enchanted Wheat) */
  perUnit: number;
}

/** One piece of a concave profit curve: units up to `upTo` earn `profitPerUnit` each (insta slippage). */
export interface ProfitSegment {
  upTo: number;
  profitPerUnit: number;
}

/** Planner inputs of one row, priced with unlimited capital and order slots (the planner applies both). */
export interface PlanInputs {
  /** coins tied up per unit (pipelined overlap applied) */
  unitCost: number;
  /** buy cost per unit, before the overlap */
  buyCost: number;
  profitPerUnit: number;
  /** units/hour at maxUnits */
  unitsPerHour: number;
  /** max units per cycle with capital and slots unbounded */
  maxUnits: number;
  /** units per order for each order / offer leg, per unit (slots = sum ceil(u * k / MAX_ORDER_UNITS)) */
  orderUnits: number[];
  uses: ResourceUse[];
  /** non-increasing profit per unit along the size (absent: flat) */
  segments?: ProfitSegment[];
}

export interface FlipRow {
  id: string;
  name: string;
  buyAt: number;
  sellAt: number;
  /** sellAt * (1 - tax) */
  netSell: number;
  profit: number;
  margin: number;
  /** your buy-side fill rate, units/hour (after competition/share) */
  rBuy: number;
  /** your sell-side fill rate, units/hour */
  rSell: number;
  /** competing orders near the top on the buy side / sell side */
  compBuy: number;
  compSell: number;
  weekVol: number;
  tp: Throughput;
  profitPerHour: number;
  risk: RiskReport;
  /** buy order price was clamped (NPC floor raised it / ask capped it) */
  buyClamped?: 'npcFloor' | 'ask';
  cons?: ConsInfo;
  plan?: PlanInputs;
}

export interface IngredientLine {
  id: string;
  name: string;
  qty: number;
  unit: number;
  total: number;
  source: QuoteSource;
  /** crafts/hour this ingredient supports (npc: daily shop limit; craft: limited by the sub-recipe's own inputs) */
  craftsPerHour: number;
  bottleneck: boolean;
  /** recipe key used when source === 'craft' */
  viaRecipe?: string;
  /** what is actually bought for this line (sub-crafts flattened), per craft of the parent recipe */
  leaves?: LeafLine[];
}

/** A bought input under an ingredient line (itself, or the leaves of its sub-craft). */
export interface LeafLine {
  id: string;
  /** units per craft of the top recipe */
  qty: number;
  unit: number;
  source: QuoteSource;
  /** the market it draws on (absent for unlimited sources) */
  res?: ResourceKey;
}

export interface CraftRow {
  recipe: Recipe;
  id: string;
  name: string;
  /** cost per craft */
  cost: number;
  /** value per craft (after tax if bazaar) */
  value: number;
  valueSource: 'bazaar' | 'npc' | 'ah';
  /** output is not a bazaar product (valued at NPC / AH or unpriced) */
  outputOffBazaar?: boolean;
  profit: number;
  margin: number | null;
  outCraftsPerHour: number;
  inCraftsPerHour: number;
  tp: Throughput;
  profitPerHour: number;
  lines: IngredientLine[];
  risk: RiskReport;
  /** ids that could not be priced; non-empty => row is "unpriced" */
  unpriced: string[];
  cons?: ConsInfo;
  plan?: PlanInputs;
}

export interface NpcFlipRow {
  id: string;
  name: string;
  direction: 'bz2npc' | 'npc2bz';
  buyAt: number;
  sellAt: number;
  profit: number;
  margin: number;
  tp: Throughput;
  profitPerHour: number;
  risk: RiskReport;
  cons?: ConsInfo;
  plan?: PlanInputs;
}

export interface FusionRecipe {
  a: string;
  qa: number;
  b: string;
  qb: number;
  out: string;
  qo: number;
}

export interface FusionRow {
  recipe: FusionRecipe;
  cost: number | null;
  value: number | null;
  profit: number | null;
  margin: number | null;
  /** inputs/outputs that could not be resolved or priced */
  missing: string[];
  tp?: Throughput;
  risk?: RiskReport;
  profitPerHour?: number;
}

/** A multi-step crafting move along a chain: buy `fromId`, craft up through `path`, sell `toId`. */
export interface ChainRow {
  /** path ids joined with '>' */
  key: string;
  /** tiers from the bought item to the sold one, e.g. [WHEAT, ENCHANTED_WHEAT, ENCHANTED_HAY_BALE] */
  path: string[];
  fromId: string;
  toId: string;
  /** crafting steps (path.length - 1) */
  steps: number;
  /** units of fromId per unit of toId */
  needFrom: number;
  /** keys of the full ladders (root to top, ids joined with '>') this move lies on */
  ladders: string[];
  /** the move priced as one recipe: fromId (bought, never sub-crafted) + side ingredients -> 1 toId */
  row: CraftRow;
}

export interface BookRow {
  /** output id, e.g. ENCHANTMENT_SHARPNESS_6 */
  id: string;
  name: string;
  /** ENCHANTMENT_SHARPNESS */
  base: string;
  fromLevel: number;
  toLevel: number;
  /** input id (level fromLevel) */
  inputId: string;
  /** input books per output = 2^(toLevel-fromLevel) */
  count: number;
  /** per input book */
  buyAt: number;
  /** per output book (before tax) */
  sellAt: number;
  /** count * buyAt */
  cost: number;
  netSell: number;
  profit: number;
  margin: number;
  tp: Throughput;
  profitPerHour: number;
  risk: RiskReport;
  verified: boolean;
  cons?: ConsInfo;
  plan?: PlanInputs;
}

export interface ShopRow {
  key: string;
  /** output id */
  id: string;
  name: string;
  shop: string;
  currency: string;
  costQty: number;
  outQty: number;
  /** coins per offer when sold (after tax if bazaar) */
  value: number | null;
  valueSource: 'bazaar' | 'npc' | 'ah' | null;
  /** value / costQty */
  coinsPerCurrency: number | null;
  weekVol: number;
  risk: RiskReport | null;
}

export interface MarketStat {
  id: string;
  /** history points used */
  n: number;
  change1h: number | null;
  change24h: number | null;
  /** MAD/median of mid price */
  volatility: number | null;
  /** median (ask-bid)/bid */
  spreadMedian: number | null;
  /** share of points (0..1) where a bid+tick -> ask-tick flip was profitable after tax */
  consistency: number | null;
  /** estimated recent insta-buy / insta-sell volume relative to the weekly average (1 = normal) */
  buyVolTrend: number | null;
  sellVolTrend: number | null;
  /** times per hour the best bid / best ask changed over the raw (3 h) history: how often a top order gets outbid */
  bidMovesPerHour?: number | null;
  askMovesPerHour?: number | null;
}

export type OpportunityKind = 'flip' | 'craft' | 'forge' | 'chain' | 'book' | 'npc' | 'kat' | 'ahflip';

export interface Opportunity {
  kind: OpportunityKind;
  /** unique key, e.g. `flip:ID` / `craft:RECIPEKEY` */
  key: string;
  /** primary item id (one opportunity per id is allocated) */
  id: string;
  /** shared by opportunities that can't run side by side (one per group is allocated; default: the id), e.g. 'kat' */
  group?: string;
  name: string;
  /** coins tied up per unit */
  unitCost: number;
  /** buy cost per unit before the pipelined overlap (unitCost > buyCost when doubled) */
  buyCost?: number;
  profitPerUnit: number;
  /** units/hour ignoring capital */
  unitsPerHour: number;
  /** max units per cycle (volume/depth bound) */
  maxUnits: number;
  /** order slots used at maxUnits */
  slots: number;
  /** units per order for each order / offer leg, per unit (slots at u units = sum ceil(u * k / MAX_ORDER_UNITS)) */
  orderUnits?: number[];
  /** shared markets this opportunity draws on */
  uses?: ResourceUse[];
  segments?: ProfitSegment[];
  risk: RiskReport;
  /** the output is valued at the AH lowest BIN (planner can leave these out) */
  ahSold?: boolean;
}

export interface Allocation {
  opp: Opportunity;
  units: number;
  capital: number;
  /** order slots at the allocated units */
  slots: number;
  profitPerHour: number;
}

export interface PlanResult {
  allocations: Allocation[];
  capitalUsed: number;
  slotsUsed: number;
  profitPerHour: number;
  /** the objective the planner maximized (profit/hour weighted by risk, minus the attention cost) */
  score?: number;
}

// ---------------------------------------------------------------- Market (opportunity) alerts
export type OppMetric = 'profitPerHour' | 'profit' | 'margin';

/** One row that met a market alert. */
export interface OppHit {
  /** opportunity key, e.g. `flip:ID`, `chain:A>B>C` */
  key: string;
  kind: OpportunityKind;
  id: string;
  name: string;
  value: number;
  at: number;
}

/** "Tell me when any <kinds> beats <value> <metric> with risk up to <maxRisk>": not tied to one item. */
export interface OppAlertRule {
  key: string;
  scope: OpportunityKind[];
  metric: OppMetric;
  /** profit/hour or profit per unit in coins; margin as a ratio */
  value: number;
  maxRisk: 'ok' | 'caution';
  enabled: boolean;
  /** keys meeting the rule at the last check: only rows not in here fire */
  seen: string[];
  /** latest hits, newest first (capped) */
  hits: OppHit[];
  lastFiredAt?: number;
}

// ---------------------------------------------------------------- Trades (my orders, journal)
export type OrderSide = 'buy' | 'sell';
/** where your order stands against the live book */
export type OrderStatusKind = 'top' | 'tied' | 'outbid' | 'undercut' | 'unknown';

/** A bazaar order you placed in game and track here. */
export interface MyOrder {
  key: string;
  id: string;
  side: OrderSide;
  /** coins per unit */
  price: number;
  qty: number;
  placedAt: number;
  /** sell offers: what the items cost you per unit (carried into the journal when filled) */
  cost?: number;
  note?: string;
  /** last status seen by the order watcher (alerts fire on top/tied -> outbid/undercut) */
  lastStatus?: OrderStatusKind;
}

/** A finished trade. profit = qty × sell × (1 − tax) − qty × buy − fees */
export interface JournalEntry {
  key: string;
  id: string;
  qty: number;
  /** coins per unit you paid (0 for items you farmed) */
  buy: number;
  /** coins per unit you sold for, before tax */
  sell: number;
  /** sale tax rate applied (bazaar tax; 0 for NPC / AH sales entered net) */
  tax: number;
  /** other costs in coins (AH fees, side ingredients…) */
  fees: number;
  at: number;
  source: 'manual' | 'order' | 'plan';
  note?: string;
}

export interface WatchEntry {
  id: string;
  addedAt: number;
  note?: string;
}

export type AlertMetric = 'ask' | 'bid' | 'spreadPct' | 'flipMargin' | 'flipProfit';

export interface AlertRule {
  key: string;
  id: string;
  metric: AlertMetric;
  op: 'lt' | 'gt';
  value: number;
  enabled: boolean;
  cooldownMin: number;
  lastFiredAt?: number;
}

export interface AlertEvent {
  ruleKey: string;
  id: string;
  metric: AlertMetric;
  value: number;
  at: number;
}

// ---------------------------------------------------------------- Other market data
export interface AhPrice {
  /** lowest BIN price */
  price: number;
  /** number of BIN listings seen */
  count: number;
  /** second-lowest BIN price (scan v2+; absent with a single listing) */
  next?: number;
  /** auction uuid of the cheapest listing (for /viewauction) */
  uuid?: string;
  /** display name of the cheapest listing (pets: "[Lvl 100] Ender Dragon") */
  name?: string;
  /** pets (scan v3+): total XP of the cheapest listing */
  exp?: number;
  /** scan v4: the lowest AH.keepPrices per-item prices, ascending (price = prices[0]) */
  prices?: number[];
  /** scan v4: stack size of the cheapest listing when > 1 (prices are per item) */
  stack?: number;
}

export interface AhSnapshot {
  /**
   * 2 = lowestBin entries carry next / uuid / name; 3 = pets also carry exp and `@MAX` (max-level) keys; 4 = per-item
   * prices (stacks divided), `prices`, deduped by uuid, pet level-band keys
   */
  v?: number;
  fetchedAt: number;
  /** Hypixel lastUpdated of page 0 */
  lastUpdated: number;
  lowestBin: Record<string, AhPrice>;
  /** pages skipped after a retry (partial scan) */
  failedPages?: number[];
  /** scan v4: pages whose lastUpdated still differed from page 0 after a retry (the AH moved mid-scan) */
  mixedPages?: number;
}

/** Realized AH sales of one id (BIN only, per item), from /v2/skyblock/auctions_ended. */
export interface AhSalesStat {
  /** sales recorded */
  n: number;
  /** items sold (stacks counted by size) */
  items: number;
  /** median price per item */
  median: number;
  /** items sold per hour over the covered time; null while coverage < AH_SALES.minCoverageHours */
  perHour: number | null;
  /** hours of the sales feed actually seen */
  coverageHours: number;
  /** ms epoch of the newest sale */
  last: number;
}

export interface AhSalesSnapshot {
  v: 1;
  updatedAt: number;
  /** hours of the sales feed seen in the window (shared by every id) */
  coverageHours: number;
  byId: Record<string, AhSalesStat>;
}

export interface AhScanProgress {
  page: number;
  totalPages: number;
}

export interface ElectionPerk {
  name: string;
  /** formatting codes stripped */
  description: string;
  minister?: boolean;
}

export interface ElectionInfo {
  year: number | null;
  mayor: { key: string; name: string; perks: ElectionPerk[] } | null;
  minister: { key: string; name: string; perk: ElectionPerk } | null;
  fetchedAt: number;
}

export interface CalcCtx {
  snap: Snapshot;
  catalog: Catalog;
  settings: Settings;
  stats?: (id: string) => PriceStats | null;
  /** lowest BIN on the auction house, if scanned */
  ah?: (id: string) => AhPrice | null;
  /** mayor Derpy is in office (AH claim tax ×4) */
  derpy?: boolean;
  /** cross-item market stats (volatility, trends, moves per hour) from history */
  market?: (id: string) => MarketStat | null;
  /** realized AH sales, if the sales feed is on */
  ahSales?: (id: string) => AhSalesStat | null;
  /** shared quotes, risk and pricer memo for this context (domain/market.ts) */
  core?: MarketCore;
}

// ---------------------------------------------------------------- Storage
export interface HistoryPoint {
  ts: number;
  bid: number;
  ask: number;
  instaBuysWeek: number;
  instaSellsWeek: number;
  buyOrders: number;
  sellOrders: number;
}

export type HistoryRange = '3h' | '24h' | '7d';

export interface HistoryRepo {
  init(): Promise<void>;
  /** No-op if this snapshot's lastUpdated was already recorded. */
  record(s: Snapshot): Promise<void>;
  series(id: string, range: HistoryRange): Promise<HistoryPoint[]>;
  /** Sync, in-memory last 24h (for sparklines). */
  recent(id: string): HistoryPoint[];
  /** Sync, from in-memory data. */
  stats(id: string): PriceStats | null;
  saveLatest(s: Snapshot): Promise<void>;
  loadLatest(): Promise<Snapshot | null>;
  /** Sync, cross-item stats from in-memory data; memoized per record, minute (sliding 24h window) and taxRate. */
  marketStats(taxRate: number): ReadonlyMap<string, MarketStat>;
  /** Sync, every item's PriceStats and MarketStat at once (one pass; memoized per record and taxRate). */
  statsAll(taxRate: number): { price: ReadonlyMap<string, PriceStats>; market: ReadonlyMap<string, MarketStat> };
  info(): { raw: number; q15: number; oldest: number | null; persistent: boolean };
  /** Drop all stored history (keeps nothing). */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------- Poller / status
export type DataStatus = 'loading' | 'live' | 'stale' | 'old' | 'cached' | 'error' | 'manual';

export interface Poller {
  start(): void;
  stop(): void;
  refreshNow(): Promise<void>;
  readonly nextAt: number | null;
  readonly failures: number;
}

// ---------------------------------------------------------------- Store / i18n / views
export interface Store<S> {
  get(): S;
  set(p: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: (s: S, prev: S) => void): () => void;
}

export type RouteId = 'overview' | 'flip' | 'ahflip' | 'craft' | 'forge' | 'books' | 'npc' | 'kat' | 'bits' | 'fusion' | 'plan' | 'sell' | 'trades' | 'watch' | 'item';

export interface Route {
  id: RouteId;
  /** item id for 'item' */
  param?: string;
  /** query string params, e.g. #/craft?q=gold */
  query?: Record<string, string>;
}

export interface AppState {
  snapshot: Snapshot | null;
  status: DataStatus;
  /** last fetch error; render with msgText() */
  lastError: Msg | null;
  catalog: Catalog | null;
  /** render with msgText() */
  catalogError: Msg | null;
  settings: Settings;
  fusion: FusionRecipe[];
  route: Route;
  /** incremented whenever history gets a new record */
  historyTick: number;
  /** ms epoch of the next scheduled poll, null if not scheduled */
  nextPollAt: number | null;
  watchlist: WatchEntry[];
  /** market alerts (any flip/craft/… above a threshold) */
  oppAlerts: OppAlertRule[];
  /** bazaar orders you track (Trades page) */
  orders: MyOrder[];
  /** finished trades, newest first */
  journal: JournalEntry[];
  alerts: AlertRule[];
  /** newest first, capped at ALERTS.logMax */
  alertLog: AlertEvent[];
  ah: AhSnapshot | null;
  /** realized AH sales (auctions_ended feed), null until loaded or with the AH off */
  ahSales: AhSalesSnapshot | null;
  /** non-null while an AH scan is running */
  ahProgress: AhScanProgress | null;
  election: ElectionInfo | null;
}

export type TFn = (key: string, params?: Record<string, string | number>) => string;

/** Memoized domain results for the current snapshot/catalog/settings/history. */
export interface Derived {
  flips(): FlipRow[];
  crafts(): CraftRow[];
  /** craft chain moves; `start` = where the first tier is bought (default 'bazaar') */
  chains(start?: 'bazaar' | 'cheapest'): ChainRow[];
  npc(): NpcFlipRow[];
  books(): BookRow[];
  shops(): ShopRow[];
  fusion(): FusionRow[];
  /** Kat upgrade runs without skip items, for settings.taming; [] without a v3+ AH scan */
  kat(): KatRow[];
  /** AH flips on the current scan ([] without one) */
  ahFlips(): AhFlipRow[];
  opportunities(): Opportunity[];
  marketStats(): ReadonlyMap<string, MarketStat>;
  calcCtx(): CalcCtx | null;
}

export type ToastKind = 'info' | 'ok' | 'warn' | 'err';

export interface ViewContext {
  store: Store<AppState>;
  history: HistoryRepo;
  navigate(r: Route): void;
  t: TFn;
  /** Ask the app to refetch now (header refresh button uses this too). */
  refresh(): Promise<void>;
  derived: Derived;
  /** Patch the current route's query (history.replaceState, no new entry, no remount). undefined/'' removes a key. */
  setQuery(patch: Record<string, string | undefined>): void;
  toast(msg: string, kind?: ToastKind): void;
  watch: { has(id: string): boolean; toggle(id: string): void };
}

export interface View {
  id: RouteId;
  mount(root: HTMLElement, ctx: ViewContext, route: Route): void;
  /** Called when the route changes but the view stays (e.g. new item id / query). */
  update?(route: Route): void;
  unmount(): void;
}
