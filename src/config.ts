// All tunable constants live here. Domain/UI code imports from this file instead of hardcoding.

export const API_BAZAAR = 'https://api.hypixel.net/v2/skyblock/bazaar';
export const API_ITEMS = 'https://api.hypixel.net/v2/resources/skyblock/items';
export const API_AUCTIONS = 'https://api.hypixel.net/v2/skyblock/auctions';
export const API_ELECTION = 'https://api.hypixel.net/v2/resources/skyblock/election';
export const CATALOG_URL = `${import.meta.env?.BASE_URL ?? '/'}data/catalog.json`;

// ---- fetching / polling
export const FETCH_TIMEOUT_MS = 15_000;
export const POLL_INTERVAL_MS = 60_000;
export const POLL_HIDDEN_FACTOR = 2;
export const POLL_BACKOFF_MS = [60_000, 120_000, 300_000] as const;

// ---- order book
export const BOOK_DEPTH = 30;
export const LATEST_BOOK_DEPTH = 10;
export const PRICE_TICK = 0.1;
export const MAX_ORDER_UNITS = 71_680;

// ---- staleness (age = now - snapshot.lastUpdated)
export const STALE_AFTER_MS = 3 * 60_000;
export const OLD_AFTER_MS = 10 * 60_000;

// ---- history
export const HISTORY_DB_NAME = 'bazaar-masasi';
export const AH_DB_NAME = 'bazaar-masasi-ah';
export const HISTORY_RAW_KEEP_MS = 3 * 3600_000;
export const HISTORY_Q15_BUCKET_MS = 15 * 60_000;
export const HISTORY_Q15_KEEP_MS = 7 * 24 * 3600_000;
export const HISTORY_RECENT_MS = 24 * 3600_000;

// ---- scoring
export const COMP_TOL = 0.01;
/**
 * Buy orders are assumed to cost at least this fraction of the NPC sell price: sellers rarely dump
 * far below what an NPC pays, so 0.1 "floor" bids on raw materials don't really fill in volume.
 */
export const NPC_FLOOR_RATIO = 0.9;
export const CRAFT_RECURSION_DEPTH = 3;
/**
 * Craft chains (src/domain/chains.ts). A recipe is a chain step when its main input (largest quantity, a bazaar item)
 * holds at least `mainShare` of the recipe's input units and more of it goes in than comes out. Moves span at least
 * `minSteps` steps (single steps are ordinary craft rows).
 */
export const CHAIN = { mainShare: 0.5, minSteps: 2 } as const;
/**
 * Assumed per-item daily purchase limit at NPC shops (in-game limits vary; tune here).
 * Caps NPC-bought ingredients and NPC->bazaar flips so NPC loops don't look unlimited.
 */
export const NPC_DAILY_LIMIT_DEFAULT = 640;
/** Bazaar order slots (default for a mid-game profile; tune in settings). */
export const ORDER_SLOTS_DEFAULT = 14;
export const ORDER_SLOTS_MAX = 35;
export const FILL_MODEL_DEFAULT = 'sequential' as const;
/** Coins per fusion at the Hunting Box fusion machine. TODO verify in game; 0 = not modelled. */
export const FUSION_FEE_COINS = 0;
export const TABLE_MAX_ROWS = 300;

// ---- risk thresholds
export const RISK = {
  deadBidRatio: 0.02,
  wideSpreadMargin: 0.6,
  /** spread above this (200%) is a hard flag: almost always a stale/manipulated side */
  extremeSpreadMargin: 2,
  lowVolumeUnits: 1000,
  lowVolumeCoins: 1_000_000,
  fewOrders: 5,
  thinTopGap: 1.25,
  quickDivergence: [0.5, 2] as const,
  volumeImbalance: [0.1, 10] as const,
  spikeMinPoints: 12,
  spikeZ: 3.5,
  spikeUp: 1.5,
  spikeDown: 0.67,
  cautionScore: 1,
  suspectScore: 3,
  weights: {
    WIDE_SPREAD: 2,
    LOW_VOLUME: 2,
    FEW_ORDERS: 1,
    THIN_TOP: 1,
    QUICK_DIVERGENCE: 1,
    VOLUME_IMBALANCE: 1,
    AH_THIN: 2,
    NO_HISTORY: 0,
  },
} as const;

// ---- new tools
export const BOOK = {
  /** rows above the curated anvil max are hidden unless the user shows unverified rows */
  hideUnverified: true,
  /** longest chain considered: 2^4 = 16 input books */
  maxChainLevels: 4,
} as const;

export const STATS = {
  /** points needed before consistency/volatility are reported */
  consistencyMinPoints: 12,
  /** movers lists ignore items below this weekly volume (insta buys + insta sells) */
  moversMinWeekVol: 10_000,
  topN: 10,
} as const;

export const OPTIMIZER = {
  /** never put more than this share of capital into one item */
  maxShareOfCapitalPerItem: 0.5,
  excludeSuspect: true,
} as const;

export const ALERTS = {
  defaultCooldownMin: 15,
  logMax: 100,
} as const;

export const AH = {
  pollMs: 10 * 60_000,
  /** parallel page fetches per scan */
  concurrency: 4,
  /** fewer BIN listings than this adds an AH thin-market risk flag */
  minCount: 2,
  /**
   * Seller fees (hypixelskyblock.minecraft.wiki/w/Auction_House, checked 2026-10): a BIN listing fee by price tier
   * (`[upTo, rate]`, first match), and a claim tax of up to 1 % on sales above 1M that never takes the payout below
   * 1M. Mayor Derpy quadruples the claim tax (not the listing fee).
   */
  fees: {
    listing: [
      [10_000_000, 0.01],
      [100_000_000, 0.02],
      [Infinity, 0.025],
    ] as const,
    claimTax: 0.01,
    claimFloor: 1_000_000,
    derpyClaimMul: 4,
  },
} as const;

export const ELECTION_POLL_MS = 30 * 60_000;

export const UI = {
  rowH: 36,
  rowHCompact: 28,
  overscan: 8,
  /** rows per "load more" page in card layout */
  cardPage: 50,
  mobileBp: 760,
  /** detail panel docks beside the table at/above this width, overlays below */
  dockBp: 1280,
  /** tables virtualize above this many rows */
  virtualizeAbove: 100,
} as const;

/** Global keyboard shortcuts ('mod' = Ctrl or Cmd; 'g o' = press g then o). */
export const HOTKEYS = {
  palette: ['/', 'mod+k'],
  refresh: ['r'],
  help: ['?'],
  star: ['s'],
  export: ['e'],
  close: ['Escape'],
  go: { overview: 'g o', flip: 'g f', craft: 'g c', forge: 'g h', books: 'g b', npc: 'g n', fusion: 'g u', plan: 'g p', watch: 'g w' },
} as const;

// ---- localStorage keys
export const LS_SETTINGS = 'bazaarMasasi.settings';
export const LS_FUSION = 'bazaarMasasi.fusion';
export const LS_VIEWPREFS = 'bazaarMasasi.view.'; // + view id
export const LS_WATCH = 'bazaarMasasi.watch';
export const LS_ALERTS = 'bazaarMasasi.alerts';
export const LS_ALERT_LOG = 'bazaarMasasi.alertLog';
export const LS_LAST_ROUTE = 'bazaarMasasi.lastRoute';
export const LS_COLUMNS = 'bazaarMasasi.cols.'; // + table id
/** legacy single-file tool keys (migrated once) */
export const LS_LEGACY_FUSION = 'bazaarMasasi.recipes';
export const LS_LEGACY_TAB = 'bazaarMasasi.tab';
