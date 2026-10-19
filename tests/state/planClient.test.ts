import { describe, expect, it, vi } from 'vitest';
import { allocate, type AllocateOptions } from '../../src/domain/optimizer.ts';
import { createPlanClient, type PlanReply, type PlanRequest } from '../../src/state/planClient.ts';
import type { Opportunity, PlanResult } from '../../src/types/contracts.ts';

const opp = (key: string, o: Partial<Opportunity> = {}): Opportunity => ({
  kind: 'flip',
  key,
  id: key,
  name: key,
  unitCost: 10,
  profitPerUnit: 1,
  unitsPerHour: 10,
  maxUnits: 10,
  slots: 0,
  risk: { level: 'ok', score: 0, flags: [] },
  ...o,
});
const OPPS = [opp('a'), opp('b', { profitPerUnit: 2 }), opp('c', { profitPerUnit: 3 })];
const opts = (capital: number): AllocateOptions => ({ capital, slots: 5, maxShare: 1, excludeSuspect: true });

/** A Worker stand-in: records what is posted; reply() answers the oldest unanswered request as planWorker.ts does. */
class FakeWorker {
  onmessage: ((e: MessageEvent<PlanReply>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  posted: PlanRequest[] = [];
  terminated = false;
  private opps: Opportunity[] = [];
  private next = 0;
  postMessage(m: PlanRequest) {
    // structured clone: the worker never sees the caller's objects
    this.posted.push(structuredClone(m));
  }
  terminate() {
    this.terminated = true;
  }
  reply(fail = false) {
    const m = this.posted[this.next++]!;
    if (m.opps) this.opps = m.opps;
    let data: PlanReply;
    if (fail) data = { id: m.id, error: 'boom' };
    else {
      const res = allocate(this.opps, m.opts);
      data = {
        id: m.id,
        allocs: res.allocations.map((a) => [this.opps.indexOf(a.opp), a.units, a.capital, a.slots, a.profitPerHour]),
        capitalUsed: res.capitalUsed,
        slotsUsed: res.slotsUsed,
        profitPerHour: res.profitPerHour,
        score: res.score!,
      };
    }
    this.onmessage!({ data } as MessageEvent<PlanReply>);
  }
}

function setup() {
  const w = new FakeWorker();
  const make = vi.fn(() => w as unknown as Worker);
  return { w, make, client: createPlanClient(make) };
}

describe('plan client', () => {
  it('inline without a worker: the answer comes at once and equals allocate()', () => {
    const client = createPlanClient(() => null);
    const done = vi.fn();
    client.request(OPPS, opts(100), done);
    expect(done).toHaveBeenCalledWith(allocate(OPPS, opts(100)));
    expect(client.busy()).toBe(false);
    client.dispose();
    client.request(OPPS, opts(100), done);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('worker: sends the opportunities once per array and maps allocations back to the caller objects', () => {
    const { w, make, client } = setup();
    const done = vi.fn<(r: PlanResult) => void>();
    client.request(OPPS, opts(100), done);
    expect(make).toHaveBeenCalledTimes(1);
    expect(client.busy()).toBe(true);
    expect(done).not.toHaveBeenCalled();
    w.reply();
    const res = done.mock.calls[0]![0];
    expect(res).toEqual(allocate(OPPS, opts(100)));
    expect(res.allocations[0]!.opp).toBe(OPPS[2]); // the caller's object, not a clone
    expect(client.busy()).toBe(false);
    client.request(OPPS, opts(50), done);
    expect(w.posted[1]!.opps).toBeUndefined();
    w.reply();
    expect(done.mock.calls[1]![0]).toEqual(allocate(OPPS, opts(50)));
    const other = [opp('z')];
    client.request(other, opts(50), done);
    expect(w.posted[2]!.opps).toHaveLength(1);
    w.reply();
    expect(done.mock.calls[2]![0].allocations[0]!.opp).toBe(other[0]);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('a request made while one is in flight waits; newer ones replace it, stale answers are dropped', () => {
    const { w, client } = setup();
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    client.request(OPPS, opts(100), first);
    client.request(OPPS, opts(50), second);
    client.request(OPPS, opts(20), third);
    expect(w.posted).toHaveLength(1);
    w.reply(); // the first is stale: a newer request is waiting
    expect(first).not.toHaveBeenCalled();
    expect(w.posted).toHaveLength(2);
    expect(w.posted[1]!.opts.capital).toBe(20);
    w.reply();
    expect(second).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledWith(allocate(OPPS, opts(20)));
    // an answer for an unknown request is ignored
    w.onmessage!({ data: { id: 999, error: 'x' } } as MessageEvent<PlanReply>);
    expect(client.busy()).toBe(false);
  });

  it('an error reply is answered inline; a broken worker switches to inline plans', () => {
    const { w, make, client } = setup();
    const done = vi.fn();
    client.request(OPPS, opts(100), done);
    w.reply(true);
    expect(done).toHaveBeenCalledWith(allocate(OPPS, opts(100)));
    // an error reply with a newer request waiting: only the newer one is answered
    const stale = vi.fn();
    client.request(OPPS, opts(70), stale);
    client.request(OPPS, opts(60), done);
    w.reply(true);
    expect(stale).not.toHaveBeenCalled();
    w.reply();
    expect(done).toHaveBeenLastCalledWith(allocate(OPPS, opts(60)));
    // the worker fails while a request is in flight and one waits: the newest runs inline, later ones too
    const lost = vi.fn();
    client.request(OPPS, opts(40), lost);
    client.request(OPPS, opts(30), done);
    w.onerror!(new Event('error'));
    expect(w.terminated).toBe(true);
    expect(lost).not.toHaveBeenCalled();
    expect(done).toHaveBeenLastCalledWith(allocate(OPPS, opts(30)));
    client.request(OPPS, opts(20), done);
    expect(done).toHaveBeenLastCalledWith(allocate(OPPS, opts(20)));
    expect(make).toHaveBeenCalledTimes(1);
    // a failure with nothing pending changes nothing more
    w.onerror!(new Event('error'));
  });

  it('a postMessage that throws (e.g. DataCloneError) answers inline and leaves the client usable', () => {
    const { w, make, client } = setup();
    w.postMessage = () => {
      throw new DOMException('could not be cloned', 'DataCloneError');
    };
    const done = vi.fn();
    client.request(OPPS, opts(100), done);
    expect(done).toHaveBeenCalledWith(allocate(OPPS, opts(100)));
    expect(w.terminated).toBe(true);
    expect(client.busy()).toBe(false);
    client.request(OPPS, opts(50), done);
    expect(done).toHaveBeenLastCalledWith(allocate(OPPS, opts(50)));
    expect(done).toHaveBeenCalledTimes(2);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('dispose terminates the worker and drops answers still in flight', () => {
    const { w, client } = setup();
    const done = vi.fn();
    client.request(OPPS, opts(100), done);
    client.dispose();
    expect(w.terminated).toBe(true);
    expect(client.busy()).toBe(false);
    w.reply();
    expect(done).not.toHaveBeenCalled();
  });
});
