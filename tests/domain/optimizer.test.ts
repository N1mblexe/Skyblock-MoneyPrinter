import { describe, expect, it } from 'vitest';
import { MAX_ORDER_UNITS, OPTIMIZER } from '../../src/config.ts';
import type { AhFlipRow } from '../../src/domain/ahFlips.ts';
import { computeBookCombines } from '../../src/domain/books.ts';
import { computeChains } from '../../src/domain/chains.ts';
import { computeCrafts } from '../../src/domain/craft.ts';
import { computeFlips } from '../../src/domain/flip.ts';
import type { KatRow } from '../../src/domain/kat.ts';
import { computeNpcFlips } from '../../src/domain/npc.ts';
import { allocate, KAT_GROUP, resourceCap, resourceCaps, toOpportunities, type AllocateOptions, type OpportunitySources } from '../../src/domain/optimizer.ts';
import { slotsFor } from '../../src/domain/pricing.ts';
import type {
  BookRow,
  CraftRow,
  FlipRow,
  MarketStat,
  NpcFlipRow,
  Opportunity,
  PlanInputs,
  PlanResult,
  PriceStats,
  RiskLevel,
  RiskReport,
} from '../../src/types/contracts.ts';
import { baseSettings, ctx, makeProduct, snap } from './helpers.ts';

// ---------------------------------------------------------------- helpers
const OK: RiskReport = { level: 'ok', score: 0, flags: [] };
const risk = (level: RiskLevel): RiskReport => ({ level, score: level === 'suspect' ? 3 : 0, flags: [] });
const M = MAX_ORDER_UNITS;
const EMPTY: OpportunitySources = { flips: [], crafts: [], books: [], npc: [] };
/** risk weights of 1: the objective is plain profit/hour */
const FLAT = { ok: 1, caution: 1, suspect: 1 };

const plan = (o: Partial<PlanInputs> = {}): PlanInputs => ({
  unitCost: 10,
  buyCost: 10,
  profitPerUnit: 1.85,
  unitsPerHour: 100,
  maxUnits: 100,
  orderUnits: [1, 1],
  uses: [],
  ...o,
});

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
  tp: { unitsPerHour: 100, batchQty: 100, capitalUsed: 0, fillHours: 0.5, limitedBy: 'volume' },
  profitPerHour: 185,
  risk: OK,
  plan: plan({ uses: [{ key: `${id}:bid`, perUnit: 1 }, { key: `${id}:ask`, perUnit: 1 }] }),
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
const W = OPTIMIZER.riskWeight;
const rate = (o: Opportunity) => o.unitsPerHour / o.maxUnits;
const pph = (o: Opportunity) => o.profitPerUnit * rate(o);

/** Profit/hour of u units: the segments' curve when given, else linear. */
function profitAt(o: Opportunity, u: number): number {
  if (!o.segments?.length) return u * pph(o);
  let v = 0;
  let prev = 0;
  for (const s of o.segments) {
    if (u <= prev) break;
    v += s.profitPerUnit * (Math.min(u, s.upTo) - prev);
    prev = s.upTo;
  }
  return v * rate(o);
}
const slotsOf = (o: Opportunity, u: number) => (u <= 0 ? 0 : o.orderUnits ? slotsFor(u, o.orderUnits) : Math.max(0, Math.ceil(o.slots)));

/** Fill a subset greedily by weighted profit/hour per coin (ties by key), integer units. */
function greedyFill(subset: Opportunity[], o: AllocateOptions): number {
  const capital = o.capital > 0 ? o.capital : Infinity;
  const w = (x: Opportunity) => W[x.risk.level];
  const sorted = [...subset].sort((a, b) => (w(b) * pph(b)) / b.unitCost - (w(a) * pph(a)) / a.unitCost || (a.key < b.key ? -1 : 1));
  let rem = capital;
  let v = 0;
  for (const x of sorted) {
    const cap = Math.floor(Math.min(x.maxUnits, (o.maxShare * capital) / x.unitCost) * (1 + 1e-12));
    const u = Math.max(0, Math.min(cap, Math.floor((rem / x.unitCost) * (1 + 1e-12))));
    rem -= u * x.unitCost;
    v += u * pph(x) * w(x);
  }
  return v;
}

/** Best score over every subset (one per group, fixed slots), each filled greedily. */
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

/** Exact optimum over every integer unit vector (tiny instances): capital, share, slots at units, markets, groups. */
function exhaustive(opps: Opportunity[], o: AllocateOptions): number {
  const capital = o.capital > 0 ? o.capital : Infinity;
  const el = opps.filter((x) => !(o.excludeSuspect && x.risk.level === 'suspect'));
  const att = o.attention ?? 0;
  let best = 0;
  const u = el.map(() => 0);
  const rec = (i: number) => {
    if (i === el.length) {
      let cap = 0;
      let slots = 0;
      let v = 0;
      const groups = new Set<string>();
      const used = new Map<string, number>();
      for (let k = 0; k < el.length; k++) {
        const x = el[k]!;
        if (u[k]! === 0) continue;
        const g = x.group ?? x.id;
        if (groups.has(g)) return;
        groups.add(g);
        if (u[k]! * x.unitCost > o.maxShare * capital + 1e-9) return;
        cap += u[k]! * x.unitCost;
        slots += slotsOf(x, u[k]!);
        for (const r of x.uses ?? []) used.set(r.key, (used.get(r.key) ?? 0) + u[k]! * r.perUnit);
        v += profitAt(x, u[k]!) * W[x.risk.level] - att;
      }
      if (cap > capital + 1e-9 || slots > o.slots) return;
      for (const [key, d] of used) if (d > (o.caps?.[key] ?? Infinity) + 1e-9) return;
      best = Math.max(best, v);
      return;
    }
    for (let k = 0; k <= Math.floor(el[i]!.maxUnits); k++) {
      u[i] = k;
      rec(i + 1);
    }
    u[i] = 0;
  };
  rec(0);
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
  let score = 0;
  const used = new Map<string, number>();
  for (const a of plan.allocations) {
    expect(Number.isInteger(a.units)).toBe(true);
    expect(a.units).toBeGreaterThanOrEqual(1);
    expect(a.units).toBeLessThanOrEqual(a.opp.maxUnits);
    expect(a.capital).toBeCloseTo(a.units * a.opp.unitCost, 6);
    expect(a.capital).toBeLessThanOrEqual(o.maxShare * capital + tol);
    expect(a.slots).toBe(slotsOf(a.opp, a.units));
    expect(a.profitPerHour).toBeCloseTo(profitAt(a.opp, a.units), 6);
    if (o.excludeSuspect) expect(a.opp.risk.level).not.toBe('suspect');
    for (const r of a.opp.uses ?? []) used.set(r.key, (used.get(r.key) ?? 0) + a.units * r.perUnit);
    cap += a.capital;
    slots += a.slots;
    p += a.profitPerHour;
    score += a.profitPerHour * (o.riskWeight ?? W)[a.opp.risk.level] - (o.attention ?? 0);
  }
  for (const [key, d] of used) expect(d).toBeLessThanOrEqual((o.caps?.[key] ?? Infinity) * (1 + 1e-9));
  expect(plan.capitalUsed).toBeCloseTo(cap, 6);
  expect(plan.slotsUsed).toBe(slots);
  expect(plan.profitPerHour).toBeCloseTo(p, 6);
  expect(plan.score).toBeCloseTo(score, 6);
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

// ---------------------------------------------------------------- toOpportunities
describe('toOpportunities', () => {
  it('flip: the row plan inputs as they are, slots at maxUnits from orderUnits', () => {
    const [o] = toOpportunities({ ...EMPTY, flips: [flipRow('X')] });
    expect(o).toEqual({
      kind: 'flip',
      key: 'flip:X',
      id: 'X',
      name: 'X',
      unitCost: 10,
      buyCost: 10,
      profitPerUnit: 1.85,
      unitsPerHour: 100,
      maxUnits: 100,
      slots: 2,
      orderUnits: [1, 1],
      uses: [
        { key: 'X:bid', perUnit: 1 },
        { key: 'X:ask', perUnit: 1 },
      ],
      risk: OK,
    });
  });

  it('keeps the pipelined overlap of the plan (unitCost > buyCost) and big batches take several orders', () => {
    const [o] = toOpportunities({ ...EMPTY, flips: [flipRow('X', { plan: plan({ unitCost: 20, buyCost: 10 }) })] });
    expect(o).toMatchObject({ unitCost: 20, buyCost: 10 });
    const big = flipRow('B', { plan: plan({ maxUnits: M * 2 + 1 }) });
    expect(toOpportunities({ ...EMPTY, flips: [big] })[0]!.slots).toBe(6);
    expect(toOpportunities({ ...EMPTY, flips: [flipRow('I', { plan: plan({ orderUnits: [] }) })] })[0]!.slots).toBe(0);
  });

  it('drops rows without plan inputs, unprofitable, zero-rate or non-finite ones', () => {
    const rows = [
      flipRow('A', { plan: plan({ profitPerUnit: 0 }) }),
      flipRow('B', { plan: plan({ unitCost: 0 }) }),
      flipRow('C', { plan: plan({ maxUnits: 0, unitsPerHour: 0 }) }),
      flipRow('D', { plan: plan({ profitPerUnit: NaN }) }),
      flipRow('E', { plan: plan({ maxUnits: Infinity }) }),
      flipRow('F', { plan: undefined }),
    ];
    expect(toOpportunities({ ...EMPTY, flips: rows })).toEqual([]);
  });

  it('cuts a profit curve where it stops paying', () => {
    const segments = [
      { upTo: 25, profitPerUnit: 4 },
      { upTo: 50, profitPerUnit: 2 },
      { upTo: 75, profitPerUnit: -1 },
      { upTo: 100, profitPerUnit: -3 },
    ];
    // the average at maxUnits is (100 + 50 - 25 - 75) / 100 = 0.5; cut at 50 units it is 3
    const [o] = toOpportunities({ ...EMPTY, flips: [flipRow('X', { plan: plan({ profitPerUnit: 0.5, segments }) })] });
    expect(o).toMatchObject({ maxUnits: 50, profitPerUnit: 3, unitsPerHour: 50, segments: segments.slice(0, 2) });
    // a curve that pays all the way is kept whole; one that never pays is dropped
    const whole = toOpportunities({ ...EMPTY, flips: [flipRow('Y', { plan: plan({ segments: segments.slice(0, 2), maxUnits: 50 }) })] })[0]!;
    expect(whole.segments).toHaveLength(2);
    expect(whole.maxUnits).toBe(50);
    expect(toOpportunities({ ...EMPTY, flips: [flipRow('Z', { plan: plan({ segments: segments.slice(2) }) })] })).toEqual([]);
  });

  it('craft: per craft, unpriced skipped, forge kind, AH-valued outputs marked', () => {
    const base = computeCrafts(ctx()).find((r) => r.unpriced.length === 0 && r.plan)!;
    const craft: CraftRow = { ...base, recipe: { ...base.recipe, key: 'R#1', kind: 'craft' }, valueSource: 'bazaar' };
    const unpriced: CraftRow = { ...craft, recipe: { ...craft.recipe, key: 'R#2' }, unpriced: ['Y'] };
    const ahValued: CraftRow = { ...craft, recipe: { ...craft.recipe, key: 'R#3', kind: 'forge' }, valueSource: 'ah' };
    const out = toOpportunities({ ...EMPTY, crafts: [craft, unpriced, ahValued] });
    expect(out.map((o) => o.key)).toEqual(['craft:R#1', 'forge:R#3']);
    expect(out[0]).toMatchObject({ kind: 'craft', id: craft.id, unitCost: base.plan!.unitCost, maxUnits: base.plan!.maxUnits, uses: base.plan!.uses });
    expect(out[0]!.ahSold).toBeUndefined();
    expect(out[1]).toMatchObject({ kind: 'forge', ahSold: true });
  });

  it('book: per output book; the input order holds `count` books per unit', () => {
    const b = {
      id: 'ENCHANTMENT_T_5',
      name: 'T5',
      count: 16,
      cost: 160,
      profit: 20,
      risk: OK,
      // 16 input books per output on a buy order, one sell offer: 5000 outputs need 80,000 inputs (2 orders) + 1
      plan: plan({ unitCost: 160, buyCost: 160, profitPerUnit: 20, unitsPerHour: 5000, maxUnits: 5000, orderUnits: [16, 1] }),
    } as BookRow;
    const [o] = toOpportunities({ ...EMPTY, books: [b] });
    expect(o).toMatchObject({ kind: 'book', key: 'book:ENCHANTMENT_T_5', unitCost: 160, profitPerUnit: 20, slots: 2 + 1, orderUnits: [16, 1] });
    // real book rows carry order legs too
    const real = toOpportunities({ ...EMPTY, books: computeBookCombines(ctx()) });
    for (const x of real) expect(x.slots).toBeGreaterThanOrEqual(1);
  });

  it('npc: direction in the key, only the bazaar leg takes a slot', () => {
    const n = (direction: NpcFlipRow['direction'], orderUnits: number[]): NpcFlipRow => ({
      id: 'W',
      name: 'W',
      direction,
      buyAt: 3,
      sellAt: 4,
      profit: 1,
      margin: 1 / 3,
      tp: { unitsPerHour: 100, batchQty: 100, capitalUsed: 0, fillHours: 0.5, limitedBy: 'volume' },
      profitPerHour: 100,
      risk: OK,
      plan: plan({ orderUnits }),
    });
    const out = toOpportunities({ ...EMPTY, npc: [n('bz2npc', []), n('npc2bz', [1])] });
    expect(out.map((o) => [o.key, o.slots])).toEqual([
      ['npc:W:bz2npc', 0],
      ['npc:W:npc2bz', 1],
    ]);
  });

  it('AH and George flips: kind ahflip, AH relists AH-sold, George segments kept', () => {
    const ah = {
      key: 'ah:HYPERION',
      venue: 'ah',
      id: 'HYPERION',
      name: 'Hyperion',
      risk: OK,
      plan: plan({ unitCost: 1e9, buyCost: 1e9, profitPerUnit: 5e6, unitsPerHour: 0.25, maxUnits: 1, orderUnits: [] }),
    } as AhFlipRow;
    const segments = [
      { upTo: 1, profitPerUnit: 300 },
      { upTo: 2, profitPerUnit: 100 },
    ];
    const george = {
      key: 'george:BEE;1',
      venue: 'george',
      id: 'BEE;1',
      name: 'Bee',
      risk: OK,
      plan: plan({ unitCost: 300, buyCost: 300, profitPerUnit: 200, unitsPerHour: 2, maxUnits: 2, orderUnits: [], segments }),
    } as AhFlipRow;
    const out = toOpportunities({ ...EMPTY, ahFlips: [ah, george] });
    expect(out.map((o) => [o.key, o.kind, !!o.ahSold, o.slots])).toEqual([
      ['ahflip:ah:HYPERION', 'ahflip', true, 0],
      ['ahflip:george:BEE;1', 'ahflip', false, 0],
    ]);
    expect(out[1]!.segments).toEqual(segments);
    // the planner takes the cheap pet first: 1 unit earns 300 x 2/2 per hour, 2 units 400
    const o: AllocateOptions = { capital: 1e6, slots: 0, maxShare: 1, excludeSuspect: true, riskWeight: FLAT };
    expect(allocate([out[1]!], o).allocations[0]).toMatchObject({ units: 2, profitPerHour: 400 });
    expect(allocate([out[1]!], { ...o, capital: 300 }).allocations[0]).toMatchObject({ units: 1, profitPerHour: 300 });
  });

  it('real fixture rows map to unique, finite opportunities equal to their plan inputs', () => {
    const c = ctx();
    const flips = computeFlips(c);
    const out = toOpportunities({ flips, crafts: computeCrafts(c), books: computeBookCombines(c), npc: computeNpcFlips(c) });
    expect(out.length).toBeGreaterThan(10);
    expect(new Set(out.map((o) => o.key)).size).toBe(out.length);
    for (const o of out) {
      for (const v of [o.unitCost, o.profitPerUnit, o.unitsPerHour, o.maxUnits, o.slots]) expect(Number.isFinite(v)).toBe(true);
      expect(o.maxUnits).toBeGreaterThan(0);
      expect(o.uses!.length).toBeGreaterThan(0);
    }
    for (const r of flips.filter((x) => x.plan && x.plan.profitPerUnit > 0 && !x.plan.segments)) {
      const o = out.find((x) => x.key === `flip:${r.id}`)!;
      expect(o).toMatchObject({ unitCost: r.plan!.unitCost, profitPerUnit: r.plan!.profitPerUnit, maxUnits: r.plan!.maxUnits, uses: r.plan!.uses });
    }
    const opts: AllocateOptions = { capital: 5_000_000, slots: 14, maxShare: 0.5, excludeSuspect: true, caps: resourceCaps(c, out) };
    const p = allocate(out, opts);
    checkFeasible(p, opts);
    expect(p.profitPerHour).toBeGreaterThan(0);
  });
});

describe('toOpportunities: craft chains', () => {
  it('priced, profitable chain moves become chain opportunities', () => {
    const c = ctx();
    const chains = computeChains(c);
    const out = toOpportunities({ flips: [], crafts: [], chains, books: [], npc: [] });
    const want = chains.filter((r) => r.row.unpriced.length === 0 && r.row.plan && r.row.plan.unitsPerHour > 0);
    expect(want.length).toBeGreaterThan(0);
    expect(out.map((o) => o.key).sort()).toEqual(want.map((r) => `chain:${r.key}`).sort());
    for (const o of out) {
      const r = chains.find((x) => `chain:${x.key}` === o.key)!;
      expect(o).toMatchObject({ kind: 'chain', id: r.toId, unitCost: r.row.plan!.unitCost });
      expect(o.slots).toBeGreaterThanOrEqual(1); // buy orders for the first tier at least
    }
    // without chains the sources still work (older callers)
    expect(toOpportunities({ flips: [], crafts: [], books: [], npc: [] })).toEqual([]);
    // an unpriced chain row is left out
    expect(toOpportunities({ ...EMPTY, chains: [{ ...want[0]!, row: { ...want[0]!.row, unpriced: ['X'] } }] })).toEqual([]);
  });
});

describe('toOpportunities: Kat upgrades', () => {
  const katRow = (key: string, o: Partial<KatRow> & { capital?: number; profit?: number } = {}): KatRow => {
    const capital = o.capital ?? 2_000_000;
    const profit = o.profit ?? 400_000;
    return {
      key,
      id: key.split('>')[0]!,
      pet: key.split(';')[0]!,
      name: key.split(';')[0]!,
      capital,
      profit,
      margin: 0.2,
      hours: 25,
      profitPerHour: profit / 25,
      risk: OK,
      unpriced: [],
      plan: { unitCost: capital, buyCost: capital, profitPerUnit: profit, unitsPerHour: 1 / 25, maxUnits: 1, orderUnits: [], uses: [] },
      ...o,
    } as KatRow;
  };

  it('one unit per pet, capital = buy + upgrade, no slots, AH-sold, all in the Kat group', () => {
    const rows = [katRow('ENDERMAN;3>4:max'), katRow('OCELOT;2>4:any'), katRow('BEE;1>2:any', { unpriced: ['X'] }), katRow('BAT;1>2:any', { profit: -5 })];
    const out = toOpportunities({ ...EMPTY, kat: rows });
    expect(out.map((o) => o.key)).toEqual(['kat:ENDERMAN;3>4:max', 'kat:OCELOT;2>4:any']);
    expect(out[0]).toMatchObject({ kind: 'kat', id: 'ENDERMAN;3', unitCost: 2_000_000, profitPerUnit: 400_000, maxUnits: 1, slots: 0, ahSold: true, group: KAT_GROUP });
    expect(out[0]!.unitsPerHour).toBeCloseTo(1 / 25, 12);
    expect(toOpportunities({ ...EMPTY, flips: [flipRow('X')] })[0]!.group).toBeUndefined();
  });

  it('the allocator runs one Kat upgrade at most, the best one, beside other picks', () => {
    const rows = [katRow('A;3>4:any', { profit: 300_000 }), katRow('B;3>4:any', { profit: 500_000 }), katRow('C;3>5:any', { profit: 400_000, capital: 1_000_000 })];
    const opps = [...toOpportunities({ ...EMPTY, kat: rows }), opp({ key: 'flip:F', id: 'F', unitCost: 10, profitPerUnit: 1, slots: 0 })];
    const o: AllocateOptions = { capital: 1e9, slots: 10, maxShare: 1, excludeSuspect: false };
    const p = allocate(opps, o);
    checkFeasible(p, o);
    expect(p.allocations.map((a) => a.opp.key).sort()).toEqual(['flip:F', 'kat:B;3>4:any']);
    // capital too short for B: the next best one that fits
    const small = allocate(opps, { ...o, capital: 1_500_000 });
    expect(small.allocations.filter((a) => a.opp.kind === 'kat').map((a) => a.opp.key)).toEqual(['kat:C;3>5:any']);
  });

  it('grouped picks: exact against brute force on small instances', () => {
    const r = rng(4242);
    for (let t = 0; t < 100; t++) {
      const opps = randomInstance(r, true, undefined, true);
      const o: AllocateOptions = { capital: 0, slots: Infinity, maxShare: 1, excludeSuspect: false };
      const p = allocate(opps, o);
      checkFeasible(p, o);
      // unlimited capital and slots: every ungrouped pick plus the best grouped one
      expect(p.score).toBeCloseTo(bruteForce(opps, o), 6);
    }
  });
});

// ---------------------------------------------------------------- shared markets
describe('resourceCap', () => {
  const p = makeProduct({ instaSellsWeek: 168_000, instaBuysWeek: 336_000 });
  const c = (over = {}, extra = {}) => ctx({ share: 0.1, cycleHours: 2, ...over }, { snap: { ...snap, products: { ...snap.products, 'INK_SACK:3': p, X: p } }, ...extra });

  it('bazaar sides: hourly flow x share x cycle; NPC: the daily limit; forge: slot-hours', () => {
    expect(resourceCap(c(), 'X:bid')).toBeCloseTo(1000 * 0.1 * 2, 9);
    expect(resourceCap(c(), 'X:ask')).toBeCloseTo(2000 * 0.1 * 2, 9);
    // ids may contain ':' themselves
    expect(resourceCap(c(), 'INK_SACK:3:bid')).toBeCloseTo(200, 9);
    expect(resourceCap(c({ npcDailyLimit: 480 }), 'X:npc')).toBeCloseTo(40, 9);
    expect(resourceCap(c({ forgeSlots: 3 }), 'forge')).toBe(6);
    expect(resourceCap(c({ forgeSlots: -1 }), 'forge')).toBe(0);
    expect(resourceCap(c({ cycleHours: 0 }), 'X:bid')).toBe(0);
    // not on the bazaar, or not a market key: unlimited
    expect(resourceCap(c(), 'NOPE:bid')).toBe(Infinity);
    expect(resourceCap(c(), 'X:what')).toBe(Infinity);
  });

  it('conservatism scales by the clamped volume trend once there is enough history', () => {
    const stats = (n: number) => () => ({ n }) as PriceStats;
    const market = (sell: number | null, buy: number | null) => () => ({ sellVolTrend: sell, buyVolTrend: buy }) as MarketStat;
    expect(resourceCap(c({ conservative: true }, { stats: stats(50), market: market(0.7, 0.2) }), 'X:bid')).toBeCloseTo(200 * 0.7, 9);
    expect(resourceCap(c({ conservative: true }, { stats: stats(50), market: market(0.7, 0.2) }), 'X:ask')).toBeCloseTo(400 * 0.5, 9);
    expect(resourceCap(c({ conservative: true }, { stats: stats(50), market: market(3, null) }), 'X:bid')).toBeCloseTo(200, 9);
    expect(resourceCap(c({ conservative: true }, { stats: stats(50), market: market(null, null) }), 'X:ask')).toBeCloseTo(400, 9);
    // too little history, or conservatism off: the snapshot flow
    expect(resourceCap(c({ conservative: true }, { stats: stats(2), market: market(0.7, 0.2) }), 'X:bid')).toBeCloseTo(200, 9);
    expect(resourceCap(c({ conservative: false }, { stats: stats(50), market: market(0.7, 0.2) }), 'X:bid')).toBeCloseTo(200, 9);
  });

  it('resourceCaps lists every market the opportunities draw on', () => {
    const opps = [opp({ key: 'a', uses: [{ key: 'X:bid', perUnit: 1 }, { key: 'forge', perUnit: 2 }] }), opp({ key: 'b', uses: [{ key: 'X:bid', perUnit: 9 }] }), opp({ key: 'c' })];
    expect(resourceCaps(c(), opps)).toEqual({ 'X:bid': 200, forge: 4 });
  });
});

// ---------------------------------------------------------------- allocate
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
      const p = allocate(opps, o);
      checkFeasible(p, o);
      const opt = bruteForce(opps, o);
      expect(p.score!).toBeLessThanOrEqual(opt * (1 + 1e-9) + 1e-9);
      expect(p.score!).toBeGreaterThanOrEqual(0.9 * opt - 1e-9);
      if (opt > 0) worst = Math.min(worst, p.score! / opt);
    }
    expect(worst).toBeGreaterThanOrEqual(0.9);
  });

  it('>= 0.9 x the exact optimum with shared markets, slots counted at the units and an attention cost', () => {
    const r = rng(2024);
    let worst = 1;
    for (let t = 0; t < 150; t++) {
      const n = 2 + Math.floor(r() * 3);
      const opps = Array.from({ length: n }, (_, i) =>
        opp({
          key: `k${i}`,
          id: r() < 0.2 ? 'SAME' : `ID${i}`,
          unitCost: 1 + Math.floor(r() * 60),
          profitPerUnit: 1 + r() * 50,
          unitsPerHour: 1 + r() * 10,
          maxUnits: 1 + Math.floor(r() * 5),
          // every 2 units (or every unit) of a leg need another slot, or no order at all
          orderUnits: [[], [M / 2], [M], [M / 2, M]][Math.floor(r() * 4)]!,
          uses: [
            ...(r() < 0.7 ? [{ key: 'R1:bid' as const, perUnit: 1 + Math.floor(r() * 3) }] : []),
            ...(r() < 0.5 ? [{ key: 'R2:ask' as const, perUnit: 1 + Math.floor(r() * 2) }] : []),
          ],
          risk: r() < 0.2 ? risk('caution') : OK,
        }),
      );
      for (const x of opps) x.slots = slotsOf(x, x.maxUnits);
      const o: AllocateOptions = {
        capital: 20 + Math.floor(r() * 400),
        slots: Math.floor(r() * 5),
        maxShare: r() < 0.5 ? 1 : 0.6,
        excludeSuspect: true,
        caps: { 'R1:bid': 1 + Math.floor(r() * 10), 'R2:ask': 1 + Math.floor(r() * 8) },
        attention: r() < 0.3 ? r() * 20 : 0,
      };
      const p = allocate(opps, o);
      checkFeasible(p, o);
      const opt = exhaustive(opps, o);
      expect(p.score!).toBeLessThanOrEqual(opt + 1e-6);
      if (opt > 0) worst = Math.min(worst, p.score! / opt);
      if (process.env.DBG && t === 149) console.log("WORST", worst);
    }
    expect(worst).toBeGreaterThanOrEqual(0.9);
  });

  it('a flip and a craft on the same market share its capacity', () => {
    const flip = opp({ key: 'flip:X', id: 'X', unitCost: 10, profitPerUnit: 2, unitsPerHour: 100, maxUnits: 100, slots: 0, orderUnits: [], uses: [{ key: 'X:bid', perUnit: 1 }, { key: 'X:ask', perUnit: 1 }] });
    // 9 X per craft
    const craft = opp({ key: 'craft:Y', id: 'Y', kind: 'craft', unitCost: 90, profitPerUnit: 30, unitsPerHour: 50, maxUnits: 50, slots: 0, orderUnits: [], uses: [{ key: 'X:bid', perUnit: 9 }, { key: 'Y:ask', perUnit: 1 }] });
    const o: AllocateOptions = { capital: 1e9, slots: 14, maxShare: 1, excludeSuspect: true };
    const free = allocate([flip, craft], o);
    const units = (p: PlanResult, k: string) => p.allocations.find((a) => a.opp.key === k)?.units ?? 0;
    // without capacities both take their own volume: 100 + 50 x 9 = 550 X
    expect(units(free, 'flip:X') + 9 * units(free, 'craft:Y')).toBe(550);
    const caps = { 'X:bid': 200, 'X:ask': 1000, 'Y:ask': 1000 };
    const shared = allocate([flip, craft], { ...o, caps });
    checkFeasible(shared, { ...o, caps });
    const drawn = units(shared, 'flip:X') + 9 * units(shared, 'craft:Y');
    expect(drawn).toBeLessThanOrEqual(200);
    expect(drawn).toBeGreaterThan(190); // the market is used, not left idle
    expect(shared.profitPerHour).toBeLessThan(free.profitPerHour);
    // a market at 0 leaves out what needs it; a key not listed is unlimited
    expect(allocate([flip, craft], { ...o, caps: { 'X:bid': 0 } }).allocations).toEqual([]);
    expect(allocate([flip], { ...o, caps: { 'Z:bid': 0 } }).allocations[0]!.units).toBe(100);
  });

  it('shrinks a pick to the slots left instead of dropping it, and counts slots at the allocated units', () => {
    // three orders' worth at full volume; two slots available
    const big = opp({ key: 'big', unitCost: 1, profitPerUnit: 1, unitsPerHour: 3 * M, maxUnits: 3 * M, slots: 3, orderUnits: [1] });
    const o: AllocateOptions = { capital: 1e12, slots: 2, maxShare: 1, excludeSuspect: true };
    const p = allocate([big], o);
    checkFeasible(p, o);
    expect(p.allocations[0]).toMatchObject({ units: 2 * M, slots: 2 });
    // beside a one-slot pick, it shrinks to one order
    const small = opp({ key: 'small', unitCost: 1, profitPerUnit: 1e5, unitsPerHour: 10, maxUnits: 10, slots: 1, orderUnits: [1] });
    const both = allocate([big, small], o);
    checkFeasible(both, o);
    expect(both.allocations.map((a) => [a.opp.key, a.units, a.slots])).toEqual([
      ['small', 10, 1],
      ['big', M, 1],
    ]);
    // a pick whose first unit needs more slots than there are is left out
    expect(allocate([opp({ key: 'x', orderUnits: [1, 1, 1] })], o).allocations).toEqual([]);
  });

  it('concave profit curves: cheaper slices first, the pick stops where its slice no longer beats the rest', () => {
    const curve = opp({
      key: 'curve',
      unitCost: 10,
      profitPerUnit: 2.5,
      unitsPerHour: 40,
      maxUnits: 40,
      slots: 0,
      segments: [
        { upTo: 10, profitPerUnit: 5 },
        { upTo: 20, profitPerUnit: 3 },
        { upTo: 30, profitPerUnit: 1.5 },
        { upTo: 40, profitPerUnit: 1 },
      ],
    });
    const flat = opp({ key: 'flat', unitCost: 10, profitPerUnit: 2, unitsPerHour: 100, maxUnits: 100, slots: 0 });
    const o: AllocateOptions = { capital: 300, slots: 0, maxShare: 1, excludeSuspect: true };
    const p = allocate([curve, flat], o);
    checkFeasible(p, o);
    // 30 units: curve's first two slices (20 units, 5 and 3 per unit) beat flat's 2, then flat takes the other 10
    expect(p.allocations.map((a) => [a.opp.key, a.units])).toEqual([
      ['curve', 20],
      ['flat', 10],
    ]);
    expect(p.profitPerHour).toBeCloseTo(80 + 20, 9);
    // a curve whose later slices pay more is clamped to non-increasing
    const odd = opp({ key: 'odd', unitCost: 1, profitPerUnit: 1, maxUnits: 10, unitsPerHour: 10, slots: 0, segments: [{ upTo: 5, profitPerUnit: 1 }, { upTo: 10, profitPerUnit: 4 }] });
    expect(allocate([odd], o).profitPerHour).toBeCloseTo(10, 9);
  });

  it('weights profit by risk and charges the attention cost per position', () => {
    const ok = opp({ key: 'ok', unitCost: 10, profitPerUnit: 1, unitsPerHour: 10, maxUnits: 10, slots: 0 });
    const caution = opp({ key: 'caution', id: 'ok', unitCost: 10, profitPerUnit: 1.2, unitsPerHour: 10, maxUnits: 10, slots: 0, risk: risk('caution') });
    const o: AllocateOptions = { capital: 1000, slots: 0, maxShare: 1, excludeSuspect: true };
    // same id: 1.2 x 0.8 = 0.96 < 1, so the plain one wins under the default weights, the caution one without them
    expect(allocate([ok, caution], o).allocations.map((a) => a.opp.key)).toEqual(['ok']);
    expect(allocate([ok, caution], { ...o, riskWeight: FLAT }).allocations.map((a) => a.opp.key)).toEqual(['caution']);
    const p = allocate([ok, caution], { ...o, riskWeight: FLAT });
    expect(p.score).toBeCloseTo(p.profitPerHour, 9);
    // attention: three small positions vs one; at 8 coins/h each only the 10/h one pays
    const tiny = [1, 2, 3].map((i) => opp({ key: `t${i}`, unitCost: 1, profitPerUnit: i === 1 ? 1 : 0.5, unitsPerHour: 10, maxUnits: 10, slots: 0 }));
    expect(allocate(tiny, o).allocations).toHaveLength(3);
    const att = allocate(tiny, { ...o, attention: 8 });
    expect(att.allocations.map((a) => a.opp.key)).toEqual(['t1']);
    expect(att.score).toBeCloseTo(10 - 8, 9);
    expect(allocate(tiny, { ...o, attention: 100 }).allocations).toEqual([]);
    // a weight of 0 leaves a level out
    expect(allocate([caution], { ...o, riskWeight: { ...FLAT, caution: 0 } }).allocations).toEqual([]);
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
      const p = allocate(opps, o);
      checkFeasible(p, o);
      expect(p.score).toBeCloseTo(bruteForce(opps, o), 6);
    }
  });

  it('greedy by profit/hour per coin with integer fill of the last pick', () => {
    const opps = [
      opp({ key: 'a', unitCost: 10, profitPerUnit: 5, unitsPerHour: 10, maxUnits: 10, slots: 0 }), // 0.5/coin
      opp({ key: 'b', unitCost: 10, profitPerUnit: 2, unitsPerHour: 10, maxUnits: 10, slots: 0 }), // 0.2/coin
    ];
    const p = allocate(opps, { capital: 155, slots: 0, maxShare: 1, excludeSuspect: false });
    expect(p.allocations.map((a) => [a.opp.key, a.units])).toEqual([
      ['a', 10],
      ['b', 5],
    ]);
    expect(p.capitalUsed).toBe(150);
    expect(p.profitPerHour).toBeCloseTo(60, 9);
  });

  it('swap pass fixes a greedy trap (slots) and same-id alternatives', () => {
    // 1 slot: high density but tiny 'a' vs big 'b'
    const opps = [
      opp({ key: 'a', id: 'A', unitCost: 1, profitPerUnit: 1, unitsPerHour: 1, maxUnits: 1 }),
      opp({ key: 'b', id: 'B', unitCost: 1, profitPerUnit: 0.5, unitsPerHour: 100, maxUnits: 100 }),
    ];
    const p = allocate(opps, { capital: 1000, slots: 1, maxShare: 1, excludeSuspect: false });
    expect(p.allocations.map((a) => a.opp.key)).toEqual(['b']);
    // same id: dense-but-small 'x1' vs big 'x2'
    const same = [
      opp({ key: 'x1', id: 'X', unitCost: 1, profitPerUnit: 2, unitsPerHour: 1, maxUnits: 1, slots: 0 }),
      opp({ key: 'x2', id: 'X', unitCost: 1, profitPerUnit: 1, unitsPerHour: 100, maxUnits: 100, slots: 0 }),
    ];
    const p2 = allocate(same, { capital: 1000, slots: 0, maxShare: 1, excludeSuspect: false });
    expect(p2.allocations.map((a) => [a.opp.key, a.units])).toEqual([['x2', 100]]);
  });

  it('caps capital per item id at maxShare', () => {
    const p = allocate([opp({ key: 'a', unitCost: 0.1, maxUnits: 1e6, slots: 0 })], {
      capital: 100,
      slots: 0,
      maxShare: 0.5,
      excludeSuspect: false,
    });
    expect(p.allocations[0]!.units).toBe(500); // 0.5 * 100 / 0.1, despite float noise
    expect(p.capitalUsed).toBeCloseTo(50, 9);
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
    // a NaN capacity or attention counts as none
    expect(allocate(opps, { capital: 1000, slots: 5, maxShare: 1, excludeSuspect: false, caps: { 'a:bid': NaN }, attention: NaN }).allocations).toHaveLength(2);
    expect(allocate([], { capital: 1000, slots: 5, maxShare: 1, excludeSuspect: false })).toEqual({
      allocations: [],
      capitalUsed: 0,
      slotsUsed: 0,
      profitPerHour: 0,
      score: 0,
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
    const p = allocate(opps, { capital: 1000, slots: 0, maxShare: 1, excludeSuspect: false });
    expect(p.allocations.map((a) => [a.opp.key, a.slots])).toEqual([['neg-slots', 0]]);
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
      opp({
        key: `k${i}`,
        id: `I${i % 1500}`,
        unitCost: 1 + r() * 1e4,
        profitPerUnit: r() * 100 + 0.1,
        maxUnits: 1 + Math.floor(r() * 1e4),
        slots: Math.floor(r() * 3),
        uses: [{ key: `M${i % 400}:bid`, perUnit: 1 + Math.floor(r() * 3) }],
        ...(i % 7 === 0 ? { segments: [{ upTo: 5, profitPerUnit: 200 }, { upTo: 1e4, profitPerUnit: 1 }] } : {}),
      }),
    );
    const caps = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`M${i}:bid`, 500 + i * 10]));
    const o: AllocateOptions = { capital: 50_000_000, slots: 14, maxShare: 0.5, excludeSuspect: true, caps };
    const t0 = performance.now();
    const p = allocate(opps, o);
    expect(performance.now() - t0).toBeLessThan(3000);
    checkFeasible(p, o);
    expect(p.allocations.length).toBeGreaterThan(0);
  });
});
