import { describe, expect, it } from 'vitest';
import { MAX_ORDER_UNITS } from '../../src/config.ts';
import { computeChains } from '../../src/domain/chains.ts';
import { computeCrafts } from '../../src/domain/craft.ts';
import { computeFlips } from '../../src/domain/flip.ts';
import type { KatRow } from '../../src/domain/kat.ts';
import { computeNpcFlips } from '../../src/domain/npc.ts';
import { allocate, KAT_GROUP, toOpportunities, uncappedRate, type AllocateOptions, type OpportunitySources } from '../../src/domain/optimizer.ts';
import type {
  BookRow,
  CraftRow,
  FlipRow,
  NpcFlipRow,
  Opportunity,
  PlanResult,
  RiskLevel,
  RiskReport,
  Throughput,
} from '../../src/types/contracts.ts';
import { baseSettings, ctx } from './helpers.ts';

// ---------------------------------------------------------------- helpers
const OK: RiskReport = { level: 'ok', score: 0, flags: [] };
const risk = (level: RiskLevel): RiskReport => ({ level, score: level === 'suspect' ? 3 : 0, flags: [] });
const tp = (o: Partial<Throughput> = {}): Throughput => ({
  unitsPerHour: 100,
  batchQty: 100,
  capitalUsed: 0,
  fillHours: 0.5,
  limitedBy: 'volume',
  ...o,
});
const EMPTY: OpportunitySources = { flips: [], crafts: [], books: [], npc: [] };

const flipRow = (id: string, o: Partial<FlipRow> = {}): FlipRow => ({
  id,
  name: id,
  buyAt: 10,
  sellAt: 12,
  netSell: 11.85,
  profit: 1.85,
  margin: 0.185,
  rBuy: 200,
  rSell: 200,
  compBuy: 0,
  compSell: 0,
  weekVol: 1000,
  tp: tp(),
  profitPerHour: 185,
  risk: OK,
  ...o,
});

function opp(o: Partial<Opportunity> & { key: string }): Opportunity {
  return {
    kind: 'flip',
    id: o.key,
    name: o.key,
    unitCost: 10,
    profitPerUnit: 1,
    unitsPerHour: 10,
    maxUnits: 10,
    slots: 1,
    risk: OK,
    ...o,
  };
}

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- brute force (independent of the implementation)
const pph = (o: Opportunity) => (o.profitPerUnit * o.unitsPerHour) / o.maxUnits;

/** Fill a subset greedily by profit/hour per coin (ties by key), integer units. */
function greedyFill(subset: Opportunity[], o: AllocateOptions): number {
  const capital = o.capital > 0 ? o.capital : Infinity;
  const sorted = [...subset].sort((a, b) => pph(b) / b.unitCost - pph(a) / a.unitCost || (a.key < b.key ? -1 : 1));
  let rem = capital;
  let v = 0;
  for (const x of sorted) {
    const cap = Math.floor(Math.min(x.maxUnits, (o.maxShare * capital) / x.unitCost) * (1 + 1e-12));
    const u = Math.max(0, Math.min(cap, Math.floor((rem / x.unitCost) * (1 + 1e-12))));
    rem -= u * x.unitCost;
    v += u * pph(x);
  }
  return v;
}

function bruteForce(opps: Opportunity[], o: AllocateOptions): number {
  const el = opps.filter((x) => !(o.excludeSuspect && x.risk.level === 'suspect'));
  let best = 0;
  for (let mask = 0; mask < 1 << el.length; mask++) {
    const sub = el.filter((_, i) => mask & (1 << i));
    if (new Set(sub.map((x) => x.group ?? x.id)).size !== sub.length) continue;
    if (sub.reduce((s, x) => s + x.slots, 0) > o.slots) continue;
    best = Math.max(best, greedyFill(sub, o));
  }
  return best;
}

function checkFeasible(plan: PlanResult, o: AllocateOptions) {
  const capital = o.capital > 0 ? o.capital : Infinity;
  const tol = 1e-6 * Math.max(1, Number.isFinite(capital) ? capital : 0);
  expect(plan.capitalUsed).toBeLessThanOrEqual(capital + tol);
  expect(plan.slotsUsed).toBeLessThanOrEqual(o.slots);
  const ids = plan.allocations.map((a) => a.opp.group ?? a.opp.id);
  expect(new Set(ids).size).toBe(ids.length);
  let cap = 0;
  let slots = 0;
  let p = 0;
  for (const a of plan.allocations) {
    expect(Number.isInteger(a.units)).toBe(true);
    expect(a.units).toBeGreaterThanOrEqual(1);
    expect(a.units).toBeLessThanOrEqual(a.opp.maxUnits);
    expect(a.capital).toBeCloseTo(a.units * a.opp.unitCost, 6);
    expect(a.capital).toBeLessThanOrEqual(o.maxShare * capital + tol);
    expect(a.profitPerHour).toBeCloseTo(a.units * pph(a.opp), 6);
    if (o.excludeSuspect) expect(a.opp.risk.level).not.toBe('suspect');
    cap += a.capital;
    slots += a.slots;
    p += a.profitPerHour;
  }
  expect(plan.capitalUsed).toBeCloseTo(cap, 6);
  expect(plan.slotsUsed).toBe(slots);
  expect(plan.profitPerHour).toBeCloseTo(p, 6);
}

function randomInstance(r: () => number, distinctIds: boolean, equalCost?: number, groups = false): Opportunity[] {
  const n = 1 + Math.floor(r() * 10);
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  return Array.from({ length: n }, (_, i) =>
    opp({
      key: `k${String(i).padStart(2, '0')}`,
      id: distinctIds ? `ID${i}` : ids[Math.floor(r() * ids.length)]!,
      // Kat-like: a shared group across distinct ids
      ...(groups && r() < 0.4 ? { group: KAT_GROUP } : {}),
      unitCost: equalCost ?? 1 + Math.floor(r() * 1000),
      profitPerUnit: 0.5 + r() * 200,
      unitsPerHour: 1 + r() * 500,
      maxUnits: 1 + Math.floor(r() * 300),
      slots: Math.floor(r() * 4),
      risk: r() < 0.15 ? risk('suspect') : r() < 0.3 ? risk('caution') : OK,
    }),
  );
}

// ---------------------------------------------------------------- tests
describe('uncappedRate', () => {
  it('passes non-capital-limited throughput through', () => {
    expect(uncappedRate(tp({ batchQty: 40, unitsPerHour: 40, limitedBy: 'volume' }), 1)).toEqual({ maxUnits: 40, unitsPerHour: 40 });
  });
  it('removes the capital bound using the fill rate', () => {
    // 10 units fill in 0.1h -> 100 units/h -> 200 units per 2h cycle
    const r = uncappedRate(tp({ batchQty: 10, unitsPerHour: 5, fillHours: 0.1, limitedBy: 'capital' }), 2);
    expect(r.maxUnits).toBeCloseTo(200, 9);
    expect(r.unitsPerHour).toBeCloseTo(100, 9);
  });
  it('never shrinks the batch and ignores degenerate fill times', () => {
    expect(uncappedRate(tp({ batchQty: 10, unitsPerHour: 5, fillHours: 4, limitedBy: 'capital' }), 2).maxUnits).toBe(10);
    expect(uncappedRate(tp({ batchQty: 10, unitsPerHour: 5, fillHours: 0, limitedBy: 'capital' }), 2)).toEqual({ maxUnits: 10, unitsPerHour: 5 });
  });
});

describe('toOpportunities', () => {
  const s = { ...baseSettings };

  it('flip: unitCost = buyAt, per-item profit, two order slots in order/offer mode', () => {
    const [o] = toOpportunities({ ...EMPTY, flips: [flipRow('X')] }, s);
    expect(o).toMatchObject({ kind: 'flip', key: 'flip:X', id: 'X', unitCost: 10, profitPerUnit: 1.85, unitsPerHour: 100, maxUnits: 100, slots: 2 });
  });

  it('pipelined fill doubles the capital per unit', () => {
    const [o] = toOpportunities({ ...EMPTY, flips: [flipRow('X')] }, { ...s, fillModel: 'pipelined' });
    expect(o!.unitCost).toBe(20);
    // an instant leg (e.g. sold to an NPC) overlaps nothing: 1x capital, like throughput()
    const [i] = toOpportunities({ ...EMPTY, flips: [flipRow('Y', { tp: tp({ buyHours: 0.5, sellHours: 0 }) })] }, { ...s, fillModel: 'pipelined' });
    expect(i!.unitCost).toBe(10);
  });

  it('insta legs need no slot; big batches need several orders; tp.slots wins when given', () => {
    const big = flipRow('B', { tp: tp({ batchQty: MAX_ORDER_UNITS * 2 + 1, unitsPerHour: 1e5 }) });
    expect(toOpportunities({ ...EMPTY, flips: [big] }, s)[0]!.slots).toBe(6);
    expect(toOpportunities({ ...EMPTY, flips: [big] }, { ...s, costMode: 'insta' })[0]!.slots).toBe(3);
    expect(toOpportunities({ ...EMPTY, flips: [flipRow('X')] }, { ...s, costMode: 'insta', sellMode: 'insta' })[0]!.slots).toBe(0);
    expect(toOpportunities({ ...EMPTY, flips: [flipRow('X', { tp: tp({ slots: 5 }) })] }, s)[0]!.slots).toBe(5);
  });

  it('capital-limited rows are un-capped', () => {
    const row = flipRow('X', { tp: tp({ batchQty: 10, unitsPerHour: 10, fillHours: 0.05, limitedBy: 'capital' }) });
    const [o] = toOpportunities({ ...EMPTY, flips: [row] }, { ...s, cycleHours: 1 });
    expect(o!.maxUnits).toBeCloseTo(200, 9);
    expect(o!.unitsPerHour).toBeCloseTo(200, 9);
  });

  it('craft: per craft, unpriced skipped, slots per ordered ingredient + sell offer', () => {
    const base = computeCrafts(ctx()).find((r) => r.unpriced.length === 0 && r.profit > 0 && r.tp.batchQty > 0)!;
    const craft: CraftRow = {
      ...base,
      cost: 50,
      profit: 5,
      valueSource: 'bazaar',
      tp: tp({ batchQty: 10, unitsPerHour: 10 }),
      recipe: { ...base.recipe, key: 'R#1', outCount: 1 },
      lines: [
        { ...base.lines[0]!, source: 'order', qty: 8000 },
        { ...base.lines[0]!, source: 'npc', qty: 1 },
        { ...base.lines[0]!, source: 'insta', qty: 1 },
      ],
    };
    const unpriced: CraftRow = { ...craft, recipe: { ...craft.recipe, key: 'R#2' }, unpriced: ['Y'] };
    const npcValued: CraftRow = { ...craft, recipe: { ...craft.recipe, key: 'R#3' }, valueSource: 'npc' };
    const out = toOpportunities({ ...EMPTY, crafts: [craft, unpriced, npcValued] }, s);
    expect(out.map((o) => o.key)).toEqual(['craft:R#1', 'craft:R#3']);
    expect(out[0]).toMatchObject({ kind: 'craft', id: craft.id, unitCost: 50, profitPerUnit: 5, slots: 2 + 1 }); // 80k units -> 2 orders
    expect(out[1]!.slots).toBe(2);
  });

  it('book: per output book, input orders scale with count', () => {
    const b = {
      id: 'ENCHANTMENT_T_5',
      name: 'T5',
      count: 16,
      cost: 160,
      profit: 20,
      tp: tp({ batchQty: 5000, unitsPerHour: 5000 }),
      risk: OK,
    } as BookRow;
    const [o] = toOpportunities({ ...EMPTY, books: [b] }, s);
    expect(o).toMatchObject({ kind: 'book', key: 'book:ENCHANTMENT_T_5', unitCost: 160, profitPerUnit: 20, slots: 2 + 1 });
  });

  it('npc: direction in the key, NPC leg uses no slot', () => {
    const n = (direction: NpcFlipRow['direction']): NpcFlipRow => ({
      id: 'W',
      name: 'W',
      direction,
      buyAt: 3,
      sellAt: 4,
      profit: 1,
      margin: 1 / 3,
      tp: tp(),
      profitPerHour: 100,
      risk: OK,
    });
    const out = toOpportunities({ ...EMPTY, npc: [n('bz2npc'), n('npc2bz')] }, { ...s, costMode: 'insta' });
    expect(out.map((o) => [o.key, o.slots])).toEqual([
      ['npc:W:bz2npc', 0],
      ['npc:W:npc2bz', 1],
    ]);
  });

  it('drops unprofitable, zero-rate or non-finite rows', () => {
    const rows = [
      flipRow('A', { profit: 0 }),
      flipRow('B', { buyAt: 0 }),
      flipRow('C', { tp: tp({ batchQty: 0, unitsPerHour: 0 }) }),
      flipRow('D', { profit: NaN }),
      flipRow('E', { tp: tp({ batchQty: Infinity }) }),
    ];
    expect(toOpportunities({ ...EMPTY, flips: rows }, s)).toEqual([]);
  });

  it('real fixture rows map to unique, finite opportunities', () => {
    const c = ctx();
    const out = toOpportunities({ flips: computeFlips(c), crafts: computeCrafts(c), books: [], npc: computeNpcFlips(c) }, c.settings);
    expect(out.length).toBeGreaterThan(10);
    expect(new Set(out.map((o) => o.key)).size).toBe(out.length);
    for (const o of out) {
      for (const v of [o.unitCost, o.profitPerUnit, o.unitsPerHour, o.maxUnits, o.slots]) expect(Number.isFinite(v)).toBe(true);
      expect(o.maxUnits).toBeGreaterThan(0);
    }
    const plan = allocate(out, { capital: 5_000_000, slots: 14, maxShare: 0.5, excludeSuspect: true });
    checkFeasible(plan, { capital: 5_000_000, slots: 14, maxShare: 0.5, excludeSuspect: true });
    expect(plan.profitPerHour).toBeGreaterThan(0);
    // forge recipes are their own kind; AH-valued outputs are marked
    const crafts = computeCrafts(c);
    for (const o of out.filter((x) => x.kind === 'craft' || x.kind === 'forge')) {
      const r = crafts.find((x) => `${x.recipe.kind}:${x.recipe.key}` === o.key)!;
      expect(r).toBeDefined();
      expect(!!o.ahSold).toBe(r.valueSource === 'ah');
    }
  });
});

describe('toOpportunities: craft chains', () => {
  it('priced, profitable chain moves become chain opportunities with craft-style slots', () => {
    const c = ctx();
    const chains = computeChains(c);
    const out = toOpportunities({ flips: [], crafts: [], chains, books: [], npc: [] }, c.settings);
    const want = chains.filter((r) => r.row.unpriced.length === 0 && r.row.profit > 0 && r.row.tp.unitsPerHour > 0);
    expect(want.length).toBeGreaterThan(0);
    expect(out.map((o) => o.key).sort()).toEqual(want.map((r) => `chain:${r.key}`).sort());
    for (const o of out) {
      const r = chains.find((x) => `chain:${x.key}` === o.key)!;
      expect(o).toMatchObject({ kind: 'chain', id: r.toId, profitPerUnit: r.row.profit });
      expect(o.unitCost).toBeCloseTo(r.row.cost, 9);
      expect(o.slots).toBeGreaterThanOrEqual(1); // buy orders for the first tier at least
    }
    // without chains the sources still work (older callers)
    expect(toOpportunities({ flips: [], crafts: [], books: [], npc: [] }, c.settings)).toEqual([]);
  });
});

describe('toOpportunities: Kat upgrades', () => {
  const katRow = (key: string, o: Partial<KatRow> = {}): KatRow =>
    ({
      key,
      id: key.split('>')[0]!,
      pet: key.split(';')[0]!,
      name: key.split(';')[0]!,
      capital: 2_000_000,
      profit: 400_000,
      margin: 0.2,
      hours: 25,
      profitPerHour: 16_000,
      tp: { unitsPerHour: 1 / 25, batchQty: 1, capitalUsed: 2_000_000, fillHours: 25, limitedBy: 'kat', buyHours: 0, sellHours: 1, slots: 0 },
      risk: OK,
      unpriced: [],
      ...o,
    }) as KatRow;

  it('one unit per pet, capital = buy + upgrade, no slots, AH-sold, all in the Kat group', () => {
    const rows = [katRow('ENDERMAN;3>4:max'), katRow('OCELOT;2>4:any'), katRow('BEE;1>2:any', { unpriced: ['X'] }), katRow('BAT;1>2:any', { profit: -5 })];
    const out = toOpportunities({ ...EMPTY, kat: rows }, { ...baseSettings, fillModel: 'pipelined', cycleHours: 4 });
    expect(out.map((o) => o.key)).toEqual(['kat:ENDERMAN;3>4:max', 'kat:OCELOT;2>4:any']);
    // the AH buy is instant, so pipelined does not double it; the cycle length does not scale a 1-pet batch
    expect(out[0]).toMatchObject({ kind: 'kat', id: 'ENDERMAN;3', unitCost: 2_000_000, profitPerUnit: 400_000, maxUnits: 1, slots: 0, ahSold: true, group: KAT_GROUP });
    expect(out[0]!.unitsPerHour).toBeCloseTo(1 / 25, 12);
    expect(toOpportunities({ ...EMPTY, flips: [flipRow('X')] }, baseSettings)[0]!.group).toBeUndefined();
  });

  it('the allocator runs one Kat upgrade at most, the best one, beside other picks', () => {
    const rows = [katRow('A;3>4:any', { profit: 300_000 }), katRow('B;3>4:any', { profit: 500_000 }), katRow('C;3>5:any', { profit: 400_000, capital: 1_000_000 })];
    const opps = [...toOpportunities({ ...EMPTY, kat: rows }, baseSettings), opp({ key: 'flip:F', id: 'F', unitCost: 10, profitPerUnit: 1, slots: 0 })];
    const o: AllocateOptions = { capital: 1e9, slots: 10, maxShare: 1, excludeSuspect: false };
    const plan = allocate(opps, o);
    checkFeasible(plan, o);
    expect(plan.allocations.map((a) => a.opp.key).sort()).toEqual(['flip:F', 'kat:B;3>4:any']);
    // capital too short for B: the next best one that fits
    const small = allocate(opps, { ...o, capital: 1_500_000 });
    expect(small.allocations.filter((a) => a.opp.kind === 'kat').map((a) => a.opp.key)).toEqual(['kat:C;3>5:any']);
  });

  it('grouped picks: exact against brute force on small instances', () => {
    const r = rng(4242);
    for (let t = 0; t < 100; t++) {
      const opps = randomInstance(r, true, undefined, true);
      const o: AllocateOptions = { capital: 0, slots: Infinity, maxShare: 1, excludeSuspect: false };
      const plan = allocate(opps, o);
      checkFeasible(plan, o);
      // unlimited capital and slots: every ungrouped pick plus the best grouped one
      expect(plan.profitPerHour).toBeCloseTo(bruteForce(opps, o), 6);
    }
  });
});

describe('allocate', () => {
  it('>= 0.9 x brute-force optimum on 200 seeded random instances, always feasible', () => {
    const r = rng(12345);
    let worst = 1;
    for (let t = 0; t < 200; t++) {
      const opps = randomInstance(r, false, undefined, t % 2 === 1);
      const o: AllocateOptions = {
        capital: 100 + Math.floor(r() * 200_000),
        slots: Math.floor(r() * 9),
        maxShare: [0.3, 0.5, 1][Math.floor(r() * 3)]!,
        excludeSuspect: r() < 0.7,
      };
      const plan = allocate(opps, o);
      checkFeasible(plan, o);
      const opt = bruteForce(opps, o);
      expect(plan.profitPerHour).toBeLessThanOrEqual(opt * (1 + 1e-9) + 1e-9);
      expect(plan.profitPerHour).toBeGreaterThanOrEqual(0.9 * opt - 1e-9);
      if (opt > 0) worst = Math.min(worst, plan.profitPerHour / opt);
    }
    expect(worst).toBeGreaterThanOrEqual(0.9);
  });

  // Exactness holds when the only coupling is capital and units are interchangeable in cost: distinct ids, unlimited
  // slots, maxShare = 1 and one common unit cost. Then integer greedy-by-density equals the fractional optimum (every
  // unit costs the same, so leftover capital below one unit cost can buy nothing anywhere). With differing unit costs
  // the integer knapsack is NP-hard (capital 30, costs 6 and 5 already break greedy), and with duplicate ids or a
  // binding slot count the choice is combinatorial, so only the 0.9 bound is asserted there.
  it('exact when slots are unlimited, maxShare = 1, ids distinct and unit cost common (capital divisible)', () => {
    const r = rng(777);
    for (let t = 0; t < 200; t++) {
      const cost = 1 + Math.floor(r() * 50);
      const opps = randomInstance(r, true, cost);
      const o: AllocateOptions = { capital: cost * (1 + Math.floor(r() * 2000)), slots: Infinity, maxShare: 1, excludeSuspect: true };
      const plan = allocate(opps, o);
      checkFeasible(plan, o);
      expect(plan.profitPerHour).toBeCloseTo(bruteForce(opps, o), 6);
    }
  });

  it('greedy by profit/hour per coin with integer fill of the last pick', () => {
    const opps = [
      opp({ key: 'a', unitCost: 10, profitPerUnit: 5, unitsPerHour: 10, maxUnits: 10, slots: 0 }), // 0.5/coin
      opp({ key: 'b', unitCost: 10, profitPerUnit: 2, unitsPerHour: 10, maxUnits: 10, slots: 0 }), // 0.2/coin
    ];
    const plan = allocate(opps, { capital: 155, slots: 0, maxShare: 1, excludeSuspect: false });
    expect(plan.allocations.map((a) => [a.opp.key, a.units])).toEqual([
      ['a', 10],
      ['b', 5],
    ]);
    expect(plan.capitalUsed).toBe(150);
    expect(plan.profitPerHour).toBeCloseTo(60, 9);
  });

  it('swap pass fixes a greedy trap (slots) and same-id alternatives', () => {
    // 1 slot: high density but tiny 'a' vs big 'b'
    const opps = [
      opp({ key: 'a', id: 'A', unitCost: 1, profitPerUnit: 1, unitsPerHour: 1, maxUnits: 1 }),
      opp({ key: 'b', id: 'B', unitCost: 1, profitPerUnit: 0.5, unitsPerHour: 100, maxUnits: 100 }),
    ];
    const plan = allocate(opps, { capital: 1000, slots: 1, maxShare: 1, excludeSuspect: false });
    expect(plan.allocations.map((a) => a.opp.key)).toEqual(['b']);
    // same id: dense-but-small 'x1' vs big 'x2'
    const same = [
      opp({ key: 'x1', id: 'X', unitCost: 1, profitPerUnit: 2, unitsPerHour: 1, maxUnits: 1, slots: 0 }),
      opp({ key: 'x2', id: 'X', unitCost: 1, profitPerUnit: 1, unitsPerHour: 100, maxUnits: 100, slots: 0 }),
    ];
    const p2 = allocate(same, { capital: 1000, slots: 0, maxShare: 1, excludeSuspect: false });
    expect(p2.allocations.map((a) => [a.opp.key, a.units])).toEqual([['x2', 100]]);
  });

  it('caps capital per item id at maxShare', () => {
    const plan = allocate([opp({ key: 'a', unitCost: 0.1, maxUnits: 1e6, slots: 0 })], {
      capital: 100,
      slots: 0,
      maxShare: 0.5,
      excludeSuspect: false,
    });
    expect(plan.allocations[0]!.units).toBe(500); // 0.5 * 100 / 0.1, despite float noise
    expect(plan.capitalUsed).toBeCloseTo(50, 9);
  });

  it('excludes suspect opportunities only when asked', () => {
    const opps = [opp({ key: 's', risk: risk('suspect') }), opp({ key: 'c', risk: risk('caution'), profitPerUnit: 0.1 })];
    const o = { capital: 1000, slots: 10, maxShare: 1, excludeSuspect: true };
    expect(allocate(opps, o).allocations.map((a) => a.opp.key)).toEqual(['c']);
    expect(allocate(opps, { ...o, excludeSuspect: false }).allocations.map((a) => a.opp.key)).toEqual(['s', 'c']);
  });

  it('capital <= 0 means unlimited; bad slot/share inputs allocate nothing that needs them', () => {
    const opps = [opp({ key: 'a', maxUnits: 7, slots: 1 }), opp({ key: 'b', maxUnits: 3, slots: 0 })];
    const unl = allocate(opps, { capital: 0, slots: 5, maxShare: 0.5, excludeSuspect: false });
    expect(unl.allocations.map((a) => a.units).sort()).toEqual([3, 7]);
    expect(allocate(opps, { capital: 1000, slots: -1, maxShare: 1, excludeSuspect: false }).allocations.map((a) => a.opp.key)).toEqual(['b']);
    expect(allocate(opps, { capital: 1000, slots: 5, maxShare: 0, excludeSuspect: false }).allocations).toEqual([]);
    expect(allocate(opps, { capital: 1000, slots: 5, maxShare: NaN, excludeSuspect: false }).allocations).toEqual([]);
    // fractional slot counts are rounded safely (cap down, usage up)
    const frac = allocate([opp({ key: 'f', slots: 1.5 }), opp({ key: 'g', id: 'G', slots: 1 })], { capital: 1000, slots: 2.9, maxShare: 1, excludeSuspect: false });
    expect(frac.slotsUsed).toBeLessThanOrEqual(2);
    expect(allocate([], { capital: 1000, slots: 5, maxShare: 1, excludeSuspect: false })).toEqual({
      allocations: [],
      capitalUsed: 0,
      slotsUsed: 0,
      profitPerHour: 0,
    });
  });

  it('skips invalid opportunities and those too expensive for one unit', () => {
    const opps = [
      opp({ key: 'zero', profitPerUnit: 0 }),
      opp({ key: 'nan', unitCost: NaN }),
      opp({ key: 'inf', maxUnits: Infinity }),
      opp({ key: 'pricey', unitCost: 2000 }),
      opp({ key: 'neg-slots', slots: -3 }),
    ];
    const plan = allocate(opps, { capital: 1000, slots: 0, maxShare: 1, excludeSuspect: false });
    expect(plan.allocations.map((a) => [a.opp.key, a.slots])).toEqual([['neg-slots', 0]]);
  });

  it('is deterministic: input order does not matter, ties broken by key', () => {
    const r = rng(99);
    for (let t = 0; t < 30; t++) {
      const opps = randomInstance(r, false).map((x) => ({ ...x, profitPerUnit: Math.round(x.profitPerUnit / 50) * 50 + 1 }));
      const o = { capital: 50_000, slots: 4, maxShare: 0.5, excludeSuspect: false };
      const a = allocate(opps, o);
      const b = allocate([...opps].reverse(), o);
      expect(b).toEqual(a);
    }
    const tie = [opp({ key: 'b', id: 'X' }), opp({ key: 'a', id: 'X' })];
    expect(allocate(tie, { capital: 1000, slots: 5, maxShare: 1, excludeSuspect: false }).allocations[0]!.opp.key).toBe('a');
  });

  it('handles a large input within the search budget', () => {
    const r = rng(5);
    const opps = Array.from({ length: 3000 }, (_, i) =>
      opp({ key: `k${i}`, id: `I${i % 1500}`, unitCost: 1 + r() * 1e4, profitPerUnit: r() * 100 + 0.1, maxUnits: 1 + Math.floor(r() * 1e4), slots: Math.floor(r() * 3) }),
    );
    const o = { capital: 50_000_000, slots: 14, maxShare: 0.5, excludeSuspect: true };
    const t0 = performance.now();
    const plan = allocate(opps, o);
    expect(performance.now() - t0).toBeLessThan(3000);
    checkFeasible(plan, o);
    expect(plan.allocations.length).toBeGreaterThan(0);
  });
});
