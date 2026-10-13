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
  v: 1;
  generatedAt: string;
  neuCommit?: string;
  itemsApiUpdated?: number;
  items: Record<string, CatalogItemEntry>;
  recipes: CatalogRecipeEntry[];
}

export interface ItemInfo {
  id: string;
  name: string;
  tier?: string;
  npcSell?: number;
  npcBuy?: number;
  bazaar: boolean;
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
  meta: { generatedAt: string; neuCommit?: string };
  items: Record<string, ItemInfo>;
  recipes: Recipe[];
  byOutput: Map<string, Recipe[]>;
  byInput: Map<string, Recipe[]>;
  /** Display name; falls back to deriveName(id). */
  name(id: string): string;
}

// ---------------------------------------------------------------- Settings
export type CostMode = 'order' | 'insta';
export type SellMode = 'offer' | 'insta';
export type Lang = 'tr' | 'en';
export type Theme = 'auto' | 'light' | 'dark';
export type TaxRate = 0.0125 | 0.01125 | 0.01;

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
}

export interface Throughput {
  unitsPerHour: number;
  batchQty: number;
  capitalUsed: number;
  fillHours: number;
  limitedBy: 'volume' | 'capital' | 'depth' | 'forge';
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
  valueSource: 'bazaar' | 'npc';
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
}

export interface CalcCtx {
  snap: Snapshot;
  catalog: Catalog;
  settings: Settings;
  stats?: (id: string) => PriceStats | null;
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

export type RouteId = 'flip' | 'craft' | 'fusion' | 'npc' | 'item';

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
  lastError: string | null;
  catalog: Catalog | null;
  catalogError: string | null;
  settings: Settings;
  fusion: FusionRecipe[];
  route: Route;
  /** incremented whenever history gets a new record */
  historyTick: number;
  /** ms epoch of the next scheduled poll, null if not scheduled */
  nextPollAt: number | null;
}

export type TFn = (key: string, params?: Record<string, string | number>) => string;

export interface ViewContext {
  store: Store<AppState>;
  history: HistoryRepo;
  navigate(r: Route): void;
  t: TFn;
  /** Ask the app to refetch now (header refresh button uses this too). */
  refresh(): Promise<void>;
}

export interface View {
  id: RouteId;
  mount(root: HTMLElement, ctx: ViewContext, route: Route): void;
  /** Called when the route changes but the view stays (e.g. new item id / query). */
  update?(route: Route): void;
  unmount(): void;
}
