// Capital / order-slot allocation across opportunities. Owner: opportunities package.
import { MAX_ORDER_UNITS } from '../config.ts';
import type {
  Allocation,
  BookRow,
  ChainRow,
  CraftRow,
  FlipRow,
  NpcFlipRow,
  Opportunity,
  OpportunityKind,
  PlanResult,
  RiskReport,
  Settings,
  Throughput,
} from '../types/contracts.ts';

export interface OpportunitySources {
  flips: readonly FlipRow[];
  crafts: readonly CraftRow[];
  /** multi-step craft chain moves (optional: older callers pass none) */
  chains?: readonly ChainRow[];
  books: readonly BookRow[];
  npc: readonly NpcFlipRow[];
}

export interface AllocateOptions {
  capital: number;
  slots: number;
  /** max share of capital in one item id (0..1) */
  maxShare: number;
  excludeSuspect: boolean;
}

/** Bazaar orders needed for `qty` units on one order/offer leg (insta / NPC legs pass on=false and use none). */
const orders = (on: boolean, qty: number) => (on ? Math.max(1, Math.ceil(qty / MAX_ORDER_UNITS)) : 0);

const finitePos = (x: number) => x > 0 && Number.isFinite(x);

/**
 * Per-cycle unit bound and units/hour of a trade with the capital bound removed.
 * Rows are computed with the user's capital, so a capital-limited tp.batchQty understates what the market could absorb;
 * the allocator applies capital itself, so it needs the volume/depth bound. The trade's own fill rate is
 * batchQty / fillHours, and the volume bound is that rate times cycleHours (units/hour scales linearly with it).
 * Limitation: an insta leg's book depth is not visible here, so a capital-limited insta row may overstate depth.
 */
export function uncappedRate(tp: Throughput, cycleHours: number): { maxUnits: number; unitsPerHour: number } {
  const { batchQty, unitsPerHour, fillHours } = tp;
  if (tp.limitedBy !== 'capital' || !(batchQty > 0) || !finitePos(fillHours) || !finitePos(cycleHours)) {
    return { maxUnits: batchQty, unitsPerHour };
  }
  const maxUnits = Math.max(batchQty, (batchQty / fillHours) * cycleHours);
  return { maxUnits, unitsPerHour: unitsPerHour * (maxUnits / batchQty) };
}

/**
 * Normalize domain rows into opportunities (profitable, priced, with a positive rate only).
 * unitCost is coins tied up per unit: the buy cost, doubled under the pipelined fill model when both legs take
 * time (buying the next batch while the previous one sells). maxUnits is the capital-free per-cycle bound (see uncappedRate). slots are the
 * order slots used at maxUnits: tp.slots when the estimator provides it for that batch, else ceil(qty/MAX_ORDER_UNITS)
 * per order/offer leg and 0 per insta/NPC leg.
 */
export function toOpportunities(d: OpportunitySources, s: Settings): Opportunity[] {
  const pipelined = s.fillModel === 'pipelined';
  // Pipelined holds 2x capital only when both legs take time (same rule as throughput()); an instant leg
  // (e.g. selling to an NPC) means 1x. Unknown hours or a 0-unit tp: stay conservative (2x).
  const capMul = (tp: Throughput) => (pipelined && !(tp.batchQty > 0 && (tp.buyHours === 0 || tp.sellHours === 0)) ? 2 : 1);
  const buyOrder = s.costMode === 'order';
  const sellOffer = s.sellMode === 'offer';
  const out: Opportunity[] = [];

  const push = (
    kind: OpportunityKind,
    keyPart: string,
    row: { id: string; name: string; profit: number; tp: Throughput; risk: RiskReport },
    cost: number,
    slotsAt: (units: number) => number,
    ahSold = false,
  ) => {
    if (!finitePos(row.profit) || !finitePos(cost)) return;
    const { maxUnits, unitsPerHour } = uncappedRate(row.tp, s.cycleHours);
    if (!finitePos(maxUnits) || !finitePos(unitsPerHour)) return;
    out.push({
      kind,
      key: `${kind}:${keyPart}`,
      id: row.id,
      name: row.name,
      unitCost: cost * capMul(row.tp),
      profitPerUnit: row.profit,
      unitsPerHour,
      maxUnits,
      slots: row.tp.slots != null && maxUnits === row.tp.batchQty ? row.tp.slots : slotsAt(maxUnits),
      risk: row.risk,
      ...(ahSold ? { ahSold } : {}),
    });
  };

  // flip: one unit = one item bought at buyAt and sold.
  for (const r of d.flips) push('flip', r.id, r, r.buyAt, (u) => orders(buyOrder, u) + orders(sellOffer, u));
  // craft: one unit = one craft; buy orders per bazaar-ordered ingredient, one sell leg when bazaar-valued.
  const craftSlots = (r: CraftRow) => (u: number) =>
    r.lines.reduce((n, l) => n + orders(l.source === 'order', l.qty * u), orders(r.valueSource === 'bazaar' && sellOffer, u * r.recipe.outCount));
  for (const r of d.crafts) {
    if (r.unpriced.length > 0) continue;
    push(r.recipe.kind === 'forge' ? 'forge' : 'craft', r.recipe.key, r, r.cost, craftSlots(r), r.valueSource === 'ah');
  }
  for (const c of d.chains ?? []) {
    if (c.row.unpriced.length > 0) continue;
    push('chain', c.key, c.row, c.row.cost, craftSlots(c.row));
  }
  // book: one unit = one output book, made from `count` input books.
  for (const r of d.books) push('book', r.id, r, r.cost, (u) => orders(buyOrder, u * r.count) + orders(sellOffer, u));
  // npc: the NPC leg needs no slot. Both directions can exist for one id, so the key carries the direction.
  for (const r of d.npc) {
    push('npc', `${r.id}:${r.direction}`, r, r.buyAt, (u) => (r.direction === 'bz2npc' ? orders(buyOrder, u) : orders(sellOffer, u)));
  }
  return out;
}

// ---------------------------------------------------------------- allocation

interface Cand {
  opp: Opportunity;
  /** capital per unit */
  c: number;
  /** profit/hour per allocated unit */
  p: number;
  /** max units (maxUnits and per-item capital cap) */
  cap: number;
  slots: number;
}

/** floor with a relative epsilon so 0.5*100/0.1 = 499.999... still yields 500. */
const fl = (x: number) => Math.max(0, Math.floor(x * (1 + 1e-12)));

/** Search budget (inner-loop steps) for the improvement pass; keeps large inputs bounded and deterministic. */
const SEARCH_BUDGET = 3_000_000;
/** Candidates beyond the greedy start that the improvement pass may swap in (top by density and by standalone value). */
const POOL = 200;
/** Capital prices tried by the Lagrangian start (plus 0). */
const LAMBDA_STEPS = 32;

/**
 * Choose units per opportunity maximizing total profit/hour subject to: total capital <= capital (<= 0 = unlimited),
 * total slots <= slots, capital per item id <= maxShare x capital, at most one opportunity per id, and no suspect
 * opportunities when excludeSuspect. Profit/hour is linear in units (profitPerUnit x unitsPerHour / maxUnits) up to
 * maxUnits. A set of picks is filled greedily by profit/hour per coin (integer units, the last pick partially).
 * Sets come from three starts (density greedy, standalone-value greedy, and a Lagrangian capital-price scan solved as
 * a group knapsack over slots), each improved by add / swap / drop-and-refill moves; the best plan wins.
 * Deterministic (ties by key).
 */
export function allocate(opps: readonly Opportunity[], o: AllocateOptions): PlanResult {
  const capital = o.capital > 0 ? o.capital : Infinity;
  const slotCap = o.slots >= 0 ? Math.floor(o.slots) : 0;
  const share = o.maxShare >= 0 ? Math.min(1, o.maxShare) : 0;
  const perItem = share > 0 ? capital * share : 0;

  const cands: Cand[] = [];
  for (const opp of opps) {
    if (o.excludeSuspect && opp.risk.level === 'suspect') continue;
    const { unitCost: c, profitPerUnit, unitsPerHour, maxUnits } = opp;
    if (!finitePos(c) || !finitePos(profitPerUnit) || !finitePos(unitsPerHour) || !finitePos(maxUnits)) continue;
    const slots = opp.slots > 0 ? Math.ceil(opp.slots) : 0;
    const cap = fl(Math.min(maxUnits, perItem / c));
    if (cap < 1 || slots > slotCap) continue;
    cands.push({ opp, c, p: (profitPerUnit * unitsPerHour) / maxUnits, cap, slots });
  }
  // rank = index in density order (profit/hour per coin desc, key asc); sets are kept as sorted rank arrays.
  cands.sort((a, b) => b.p / b.c - a.p / a.c || (a.opp.key < b.opp.key ? -1 : a.opp.key > b.opp.key ? 1 : 0));
  const n = cands.length;
  let steps = 0;

  /** Fill a set in density order; returns units per member. */
  const fill = (set: readonly number[]): number[] => {
    let rem = capital;
    steps += set.length;
    return set.map((r) => {
      const k = cands[r]!;
      const u = Math.min(k.cap, fl(rem / k.c));
      rem -= u * k.c;
      return u;
    });
  };
  const value = (set: readonly number[]) => fill(set).reduce((v, u, i) => v + u * cands[set[i]!]!.p, 0);
  const slotsOf = (set: readonly number[]) => set.reduce((n, r) => n + cands[r]!.slots, 0);
  const idsOf = (set: readonly number[]) => new Set(set.map((r) => cands[r]!.opp.id));
  const insert = (set: readonly number[], r: number) => {
    const i = set.findIndex((x) => x > r);
    return i < 0 ? [...set, r] : [...set.slice(0, i), r, ...set.slice(i)];
  };

  // Start 1: density greedy over everything (incremental fill = fill() of the chosen set).
  const greedy: number[] = [];
  {
    let rem = capital;
    let used = 0;
    const ids = new Set<string>();
    for (let r = 0; r < n; r++) {
      const k = cands[r]!;
      if (ids.has(k.opp.id) || used + k.slots > slotCap) continue;
      const u = Math.min(k.cap, fl(rem / k.c));
      if (u < 1) continue;
      greedy.push(r);
      ids.add(k.opp.id);
      used += k.slots;
      rem -= u * k.c;
    }
  }

  // Swap pool: top POOL by density plus top POOL by standalone value (best profit/hour if it had the budget alone).
  const standalone = (r: number) => Math.min(cands[r]!.cap, fl(capital / cands[r]!.c)) * cands[r]!.p;
  const byValue = [...Array(n).keys()].sort((a, b) => standalone(b) - standalone(a) || a - b);
  const pool = [...new Set([...Array(Math.min(n, POOL)).keys(), ...byValue.slice(0, POOL)])].sort((a, b) => a - b);

  // Start 2: standalone-value greedy over the pool.
  let byVal: number[] = [];
  let byValV = 0;
  for (const r of byValue.slice(0, POOL)) {
    if (idsOf(byVal).has(cands[r]!.opp.id) || slotsOf(byVal) + cands[r]!.slots > slotCap) continue;
    const next = insert(byVal, r);
    const v = value(next);
    if (v > byValV) {
      byVal = next;
      byValV = v;
    }
  }

  // Start 3: Lagrangian. Price capital at lam coins/hour per coin; each candidate is then worth
  // (p - lam*c) x (units it could take alone), and the best slot-feasible one-per-id set is a group knapsack over slots.
  // Scanning lam over the density range trades breadth (many cheap picks) against depth (few big ones).
  const lagrange = (lam: number): number[] => {
    const groups = new Map<string, { r: number; v: number }[]>();
    for (let r = 0; r < n; r++) {
      const v = (cands[r]!.p - lam * cands[r]!.c) * Math.min(cands[r]!.cap, fl(capital / cands[r]!.c));
      if (v > 0) (groups.get(cands[r]!.opp.id) ?? groups.set(cands[r]!.opp.id, []).get(cands[r]!.opp.id)!).push({ r, v });
    }
    const gs = [...groups.values()];
    steps += n;
    const maxSlots = gs.reduce((t, g) => t + Math.max(...g.map((x) => cands[x.r]!.slots)), 0);
    if (maxSlots <= slotCap) {
      // slots cannot bind: best member of every group
      return gs.map((g) => g.reduce((b, x) => (x.v > b.v ? x : b)).r).sort((a, b) => a - b);
    }
    const S = slotCap; // finite here, since maxSlots > slotCap
    let dp = new Float64Array(S + 1);
    const pick = gs.map(() => new Int32Array(S + 1).fill(-1));
    gs.forEach((g, gi) => {
      const next = dp.slice();
      for (const { r, v } of g) {
        const w = cands[r]!.slots;
        for (let t = S; t >= w; t--) {
          if (dp[t - w]! + v > next[t]!) {
            next[t] = dp[t - w]! + v;
            pick[gi]![t] = r;
          }
        }
      }
      steps += S * (g.length + 1);
      dp = next;
    });
    const set: number[] = [];
    for (let gi = gs.length - 1, t = S; gi >= 0; gi--) {
      const r = pick[gi]![t]!;
      if (r >= 0) {
        set.push(r);
        t -= cands[r]!.slots;
      }
    }
    return set.sort((a, b) => a - b);
  };
  let lagSet: number[] = [];
  let lagV = -1;
  for (let k = 0; k <= LAMBDA_STEPS && n > 0; k++) {
    // lam = 0, then the densities at evenly spaced ranks (every rank when n <= LAMBDA_STEPS)
    const r = k === 0 ? -1 : Math.floor(((k - 1) * (n - 1)) / Math.max(1, LAMBDA_STEPS - 1));
    const lam = r < 0 ? 0 : cands[r]!.p / cands[r]!.c;
    const set = lagrange(lam);
    const v = value(set);
    if (v > lagV) {
      lagSet = set;
      lagV = v;
    }
  }

  /** Greedily add pool candidates (density order) to `base` while they fit and raise the value; `banned` stays out. */
  const complete = (base: readonly number[], banned: number): number[] => {
    let cur = [...base];
    let v = value(cur);
    const ids = idsOf(cur);
    let used = slotsOf(cur);
    for (const i of pool) {
      if (steps >= SEARCH_BUDGET) break;
      const ki = cands[i]!;
      if (i === banned || ids.has(ki.opp.id) || used + ki.slots > slotCap || cur.includes(i)) continue;
      const next = insert(cur, i);
      const nv = value(next);
      if (nv > v) {
        cur = next;
        v = nv;
        ids.add(ki.opp.id);
        used += ki.slots;
      }
    }
    return cur;
  };

  /** Pool candidates that may replace member j (or be added, j = -1) without breaking the id / slot limits. */
  function* swaps(set: readonly number[], withAdds: boolean) {
    const inSet = new Set(set);
    const ids = idsOf(set);
    const used = slotsOf(set);
    for (const i of pool) {
      if (inSet.has(i)) continue;
      const ki = cands[i]!;
      if (withAdds && !ids.has(ki.opp.id) && used + ki.slots <= slotCap) yield { i, j: -1 };
      for (const j of set) {
        const kj = cands[j]!;
        if (ids.has(ki.opp.id) && ki.opp.id !== kj.opp.id) continue;
        if (used - kj.slots + ki.slots <= slotCap) yield { i, j };
      }
    }
  }

  // Neighbourhoods, cheapest first: add one / swap 1-for-1; drop one and refill; swap 1-for-1 and refill
  // (the refills cover 1-for-many exchanges, e.g. one 3-slot pick for a 2-slot and a 1-slot one).
  const neighbourhoods: ((set: readonly number[]) => Iterable<number[]>)[] = [
    function* (set) {
      for (const { i, j } of swaps(set, true)) yield insert(j < 0 ? set : set.filter((x) => x !== j), i);
    },
    function* (set) {
      for (const j of set) yield complete(set.filter((x) => x !== j), j);
    },
    function* (set) {
      for (const { i, j } of swaps(set, false)) yield complete(insert(set.filter((x) => x !== j), i), j);
    },
  ];

  /** Best-improvement local search over the neighbourhoods above, within SEARCH_BUDGET. */
  const improve = (start: number[]): { set: number[]; v: number } => {
    let set = start;
    let v = value(set);
    search: while (steps < SEARCH_BUDGET) {
      for (const hood of neighbourhoods) {
        let best: number[] | null = null;
        let bestV = v + Math.max(1e-9, Math.abs(v) * 1e-12);
        for (const next of hood(set)) {
          if (steps >= SEARCH_BUDGET) break;
          const nv = value(next);
          if (nv > bestV) {
            best = next;
            bestV = nv;
          }
        }
        if (best) {
          set = best;
          v = bestV;
          continue search;
        }
      }
      break;
    }
    return { set, v };
  };

  let chosen: number[] = [];
  let chosenV = -1;
  for (const start of [greedy, byVal, lagSet]) {
    const res = improve(start);
    if (res.v > chosenV) ({ set: chosen, v: chosenV } = res);
  }

  const units = fill(chosen);
  const allocations: Allocation[] = [];
  chosen.forEach((r, i) => {
    const u = units[i]!;
    if (u < 1) return;
    const k = cands[r]!;
    allocations.push({ opp: k.opp, units: u, capital: u * k.c, slots: k.slots, profitPerHour: u * k.p });
  });
  allocations.sort((x, y) => y.profitPerHour - x.profitPerHour || (x.opp.key < y.opp.key ? -1 : 1));
  return {
    allocations,
    capitalUsed: allocations.reduce((s, x) => s + x.capital, 0),
    slotsUsed: allocations.reduce((s, x) => s + x.slots, 0),
    profitPerHour: allocations.reduce((s, x) => s + x.profitPerHour, 0),
  };
}
