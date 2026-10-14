// Auction house lowest-BIN scanner. Owner: market-apis package.
import type { AhScanProgress, AhSnapshot } from '../types/contracts.ts';

export interface AhScannerOptions {
  onSnapshot(s: AhSnapshot): void;
  onProgress(p: AhScanProgress | null): void;
  onError(e: Error): void;
  /** checked before every scheduled scan */
  enabled(): boolean;
}

export interface AhScanner {
  /** schedule scans every AH.pollMs (first scan immediately if the cache is older than that) */
  start(): void;
  stop(): void;
  scanNow(): Promise<void>;
  /** last scan persisted in IndexedDB, if any */
  loadCached(): Promise<AhSnapshot | null>;
}

/** Wave 0 stub: never scans. */
export function createAhScanner(_opts: AhScannerOptions): AhScanner {
  return {
    start() {},
    stop() {},
    async scanNow() {},
    async loadCached() {
      return null;
    },
  };
}
