// Plan client: allocate() in a Web Worker (planWorker.ts), so the Plan page and the Overview stay responsive while
// a plan computes. Owner: s3/planner.
//
// One request in flight at a time. A request made while one is in flight waits, and a newer one replaces it (stale
// requests are dropped and their callbacks never run); the in-flight answer is delivered only when no newer request
// came in. Without a Worker (tests, old browsers) or after a worker error (or a failed postMessage), plans run inline
// and the callback runs synchronously.
import { allocate, type AllocateOptions } from '../domain/optimizer.ts';
import type { Opportunity, PlanResult } from '../types/contracts.ts';

/** main -> worker: `opps` only when the array changed since the last request */
export interface PlanRequest {
  id: number;
  opps?: Opportunity[];
  opts: AllocateOptions;
}

/** worker -> main: allocations as [opportunity index, units, capital, slots, profit/hour] */
export type PlanReply =
  | { id: number; allocs: [number, number, number, number, number][]; capitalUsed: number; slotsUsed: number; profitPerHour: number; score: number }
  | { id: number; error: string };

export interface PlanClient {
  /** Plan `opps` with `opts`; `done` gets the result (at once when inline), unless a newer request supersedes it. */
  request(opps: readonly Opportunity[], opts: AllocateOptions, done: (res: PlanResult) => void): void;
  /** true while a worker request is in flight or waiting */
  busy(): boolean;
  dispose(): void;
}

interface Pending {
  opps: readonly Opportunity[];
  opts: AllocateOptions;
  done: (res: PlanResult) => void;
}

/* v8 ignore start -- needs a browser Worker (smoke covers it) */
function defaultWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./planWorker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}
/* v8 ignore stop */

/** `makeWorker` defaults to the plan worker; tests pass a fake (or one returning null for inline plans). */
export function createPlanClient(makeWorker: () => Worker | null = defaultWorker): PlanClient {
  let worker: Worker | null = null;
  let started = false;
  let nextId = 1;
  /** the request in flight and the one waiting behind it */
  let flight: (Pending & { id: number }) | null = null;
  let waiting: Pending | null = null;
  /** the opportunities array the worker holds */
  let sent: readonly Opportunity[] | null = null;
  let disposed = false;

  const inline = (p: Pending) => p.done(allocate(p.opps, p.opts));

  const getWorker = (): Worker | null => {
    if (!started) {
      started = true;
      worker = makeWorker();
      if (worker) {
        worker.onmessage = (e: MessageEvent<PlanReply>) => onReply(e.data);
        worker.onerror = () => fail();
      }
    }
    return worker;
  };

  /** The worker broke (failed to load, threw): plan inline from now on, starting with the newest request. */
  function fail(): void {
    worker?.terminate();
    worker = null;
    const p = waiting ?? flight;
    flight = null;
    waiting = null;
    if (p && !disposed) inline(p);
  }

  function send(p: Pending): void {
    const w = getWorker();
    if (!w) return inline(p);
    const id = nextId++;
    flight = { ...p, id };
    const msg: PlanRequest = { id, opts: p.opts };
    if (sent !== p.opps) {
      msg.opps = [...p.opps];
      sent = p.opps;
    }
    try {
      w.postMessage(msg);
    } catch {
      // the request can't be posted (e.g. not cloneable): treat it as a broken worker, so this request is answered
      // inline and later ones don't wait behind a reply that never comes
      fail();
    }
  }

  function onReply(r: PlanReply): void {
    if (disposed || !flight || r.id !== flight.id) return;
    const done = flight;
    flight = null;
    if ('error' in r) {
      // a bad request (not a broken worker): answer it inline
      if (!waiting) inline(done);
    } else if (!waiting) {
      done.done({
        allocations: r.allocs.map(([i, units, capital, slots, profitPerHour]) => ({ opp: done.opps[i]!, units, capital, slots, profitPerHour })),
        capitalUsed: r.capitalUsed,
        slotsUsed: r.slotsUsed,
        profitPerHour: r.profitPerHour,
        score: r.score,
      });
    }
    if (waiting) {
      const next = waiting;
      waiting = null;
      send(next);
    }
  }

  return {
    request(opps, opts, done) {
      if (disposed) return;
      const p = { opps, opts, done };
      if (flight) waiting = p;
      else send(p);
    },
    busy: () => !!flight || !!waiting,
    dispose() {
      disposed = true;
      worker?.terminate();
      worker = null;
      flight = null;
      waiting = null;
    },
  };
}
