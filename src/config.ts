// All tunable constants live here. Domain/UI code imports from this file instead of hardcoding.

export const API_BAZAAR = 'https://api.hypixel.net/v2/skyblock/bazaar';
export const API_ITEMS = 'https://api.hypixel.net/v2/resources/skyblock/items';
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
 * Assumed per-item daily purchase limit at NPC shops (in-game limits vary; tune here).
 * Caps NPC-bought ingredients and NPC->bazaar flips so NPC loops don't look unlimited.
 */
export const NPC_BUY_LIMIT_PER_DAY = 640;
export const NPC_BUY_RATE_PER_HOUR = NPC_BUY_LIMIT_PER_DAY / 24;
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
    NO_HISTORY: 0,
  },
} as const;

// ---- localStorage keys
export const LS_SETTINGS = 'bazaarMasasi.settings';
export const LS_FUSION = 'bazaarMasasi.fusion';
export const LS_VIEWPREFS = 'bazaarMasasi.view.'; // + view id
