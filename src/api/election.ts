// Mayor / minister info from the Hypixel election resource. Owner: market-apis package.
import type { ElectionInfo } from '../types/contracts.ts';

export interface ElectionPoller {
  start(): void;
  stop(): void;
}

/** Wave 0 stub: never fetches. */
export function createElectionPoller(_opts: { onInfo(i: ElectionInfo): void; onError(e: Error): void }): ElectionPoller {
  return { start() {}, stop() {} };
}
