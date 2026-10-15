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
  k: 'craft' | 'forge';
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
  kind: 'craft' | 'forge';
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
}

// ---------------------------------------------------------------- Settings
export type CostMode = 'order' | 'insta';
export type SellMode = 'offer' | 'insta';
export type { Lang } from '../i18n/languages.ts';
import type { Lang } from '../i18n/languages.ts';
import type { Msg } from '../i18n/errors.ts';
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
}

// ---------------------------------------------------------------- Domain results
export type QuoteSource = 'order' | 'insta' | 'npc' | 'craft';

export interface Quote {
  /** per-unit price (before tax) */
  price: number;
  /** units fillable at this quote (Infinity for order modes / NPC) */
  filled: number;
  /** (price - top of book) / top of book, 0 for order modes */
  slippage: number;
  source: QuoteSource;
  /** order price was clamped: raised to the NPC floor, or capped at the ask */
  clamped?: 'npcFloor' | 'ask';
}

export interface Throughput {
  unitsPerHour: number;
  batchQty: number;
  capitalUsed: number;
  fillHours: number;
  limitedBy: 'volume' | 'capital' | 'depth' | 'forge' | 'npcLimit' | 'slots';
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
  valueSource: 'bazaar' | 'npc' | null;
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
}

export type OpportunityKind = 'flip' | 'craft' | 'forge' | 'chain' | 'book' | 'npc';

export interface Opportunity {
  kind: OpportunityKind;
  /** unique key, e.g. `flip:ID` / `craft:RECIPEKEY` */
  key: string;
  /** primary item id (one opportunity per id is allocated) */
  id: string;
  name: string;
  /** coins tied up per unit */
  unitCost: number;
  profitPerUnit: number;
  /** units/hour ignoring capital */
  unitsPerHour: number;
  /** max units per cycle (volume/depth bound) */
  maxUnits: number;
  /** order slots used */
  slots: number;
  risk: RiskReport;
  /** the output is valued at the AH lowest BIN (planner can leave these out) */
  ahSold?: boolean;
}

export interface Allocation {
  opp: Opportunity;
  units: number;
  capital: number;
  slots: number;
  profitPerHour: number;
}

export interface PlanResult {
  allocations: Allocation[];
  capitalUsed: number;
  slotsUsed: number;
  profitPerHour: number;
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
}

export interface AhSnapshot {
  fetchedAt: number;
  /** Hypixel lastUpdated of page 0 */
  lastUpdated: number;
  lowestBin: Record<string, AhPrice>;
  /** pages skipped after a retry (partial scan) */
  failedPages?: number[];
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

export type RouteId = 'overview' | 'flip' | 'craft' | 'forge' | 'books' | 'npc' | 'fusion' | 'plan' | 'watch' | 'item';

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
  alerts: AlertRule[];
  /** newest first, capped at ALERTS.logMax */
  alertLog: AlertEvent[];
  ah: AhSnapshot | null;
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
