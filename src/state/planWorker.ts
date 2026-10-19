// Plan worker: runs allocate() off the main thread for planClient.ts. Owner: s3/planner.
// The opportunities are sent once per array (the client tracks which one the worker holds); allocations come back
// as indices into that array, so the client hands its own Opportunity objects to the views.
import { allocate } from '../domain/optimizer.ts';
import type { Opportunity } from '../types/contracts.ts';
import type { PlanReply, PlanRequest } from './planClient.ts';

/* v8 ignore start -- worker glue: runs in a browser Worker only (smoke covers it) */
let opps: Opportunity[] = [];
let index = new Map<Opportunity, number>();

self.onmessage = (e: MessageEvent<PlanRequest>) => {
  const m = e.data;
  if (m.opps) {
    opps = m.opps;
    index = new Map(opps.map((o, i) => [o, i]));
  }
  let reply: PlanReply;
  try {
    const res = allocate(opps, m.opts);
    reply = {
      id: m.id,
      allocs: res.allocations.map((a) => [index.get(a.opp)!, a.units, a.capital, a.slots, a.profitPerHour]),
      capitalUsed: res.capitalUsed,
      slotsUsed: res.slotsUsed,
      profitPerHour: res.profitPerHour,
      score: res.score ?? 0,
    };
  } catch (err) {
    reply = { id: m.id, error: String(err) };
  }
  self.postMessage(reply);
};
/* v8 ignore stop */
