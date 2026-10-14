// Module Web Worker that runs the AH scan off the main thread. Owner: market-apis package.
import { fetchAhPage, scanAuctions, type AhPageFetcher, type AhWorkerRequest, type AhWorkerResponse } from './auctions.ts';

/** The bits of a worker global scope this module uses (DedicatedWorkerGlobalScope isn't in our TS lib). */
export interface AhWorkerScope {
  onmessage: ((ev: MessageEvent<AhWorkerRequest>) => void) | null;
  postMessage(m: AhWorkerResponse): void;
}

/** Wire the scan protocol onto `scope`: 'scan' runs one scan (one at a time), 'abort' cancels it. */
export function attachAhWorker(scope: AhWorkerScope, fetchPage: AhPageFetcher = fetchAhPage): void {
  let ctl: AbortController | null = null;
  scope.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'abort') {
      ctl?.abort();
      ctl = null;
      return;
    }
    if (msg.type !== 'scan' || ctl) return;
    const c = new AbortController();
    ctl = c;
    scanAuctions(fetchPage, (progress) => scope.postMessage({ type: 'progress', progress }), c.signal)
      .then(
        (result) => scope.postMessage({ type: 'done', result }),
        (e: unknown) => scope.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) }),
      )
      .finally(() => {
        if (ctl === c) ctl = null;
      });
  };
}

// Only attach inside a real worker; under tests / on the main thread this module just exports.
const WGS = (globalThis as { WorkerGlobalScope?: abstract new () => unknown }).WorkerGlobalScope;
/* v8 ignore next */
if (WGS && globalThis instanceof WGS) attachAhWorker(globalThis as unknown as AhWorkerScope);
