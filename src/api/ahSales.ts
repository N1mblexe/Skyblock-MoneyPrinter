// Realized AH sales from /v2/skyblock/auctions_ended (the last 60 s of sales), polled every minute and kept per id
// for AH_SALES.windowMs in IndexedDB. Owner: s1/ahdata. Wave 0 stub: never fetches, never emits.
import type { AhSalesSnapshot } from '../types/contracts.ts';

export interface AhSalesPoller {
  start(): void;
  stop(): void;
  /** the stored sales, summarized (null when nothing is stored) */
  loadCached(): Promise<AhSalesSnapshot | null>;
  /** drop every stored sale */
  clear(): Promise<void>;
  /** stored sales count and covered hours, for Settings -> Data */
  info(): Promise<{ sales: number; ids: number; coverageHours: number }>;
}

export interface AhSalesPollerOptions {
  onUpdate(s: AhSalesSnapshot): void;
  onError(e: Error): void;
  /** polling only runs while this returns true (settings.ahEnabled) */
  enabled?: () => boolean;
  /** defaults to fetching API_AUCTIONS_ENDED */
  fetch?: (signal: AbortSignal) => Promise<unknown>;
  intervalMs?: number;
}

export function createAhSalesPoller(_opts: AhSalesPollerOptions): AhSalesPoller {
  return {
    start() {},
    stop() {},
    loadCached: async () => null,
    clear: async () => {},
    info: async () => ({ sales: 0, ids: 0, coverageHours: 0 }),
  };
}
