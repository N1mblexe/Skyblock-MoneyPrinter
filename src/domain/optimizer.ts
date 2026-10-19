// Capital / order-slot / shared-market allocation across opportunities. Owner: opportunities package.
import { CONSERVATIVE, OPTIMIZER } from '../config.ts';
import type {
  Allocation,
  BookRow,
  CalcCtx,
  ChainRow,
  CraftRow,
  FlipRow,
  NpcFlipRow,
  Opportunity,
  OpportunityKind,
  PlanInputs,
  PlanResult,
  ProfitSegment,
  RiskLevel,
  RiskReport,
} from '../types/contracts.ts';
import type { AhFlipRow } from './ahFlips.ts';
import type { KatRow } from './kat.ts';
import { npcBuyRate, sideRates, slotsFor } from './pricing.ts';

export interface OpportunitySources {
  flips: readonly FlipRow[];
  crafts: readonly CraftRow[];
  /** multi-step craft chain moves (optional: older callers pass none) */
  chains?: readonly ChainRow[];
  books: readonly BookRow[];
  npc: readonly NpcFlipRow[];
  /** Kat upgrade runs (optional: older callers pass none) */
  kat?: readonly KatRow[];
  /** AH flips and George flips (optional; the planner leaves kind 'ahflip' out by default) */
  ahFlips?: readonly AhFlipRow[];
}

/** Group of every Kat opportunity: Kat holds one pet, so only one upgrade runs at a time. */
export const KAT_GROUP = 'kat';

export interface AllocateOptions {
  capital: number;
  slots: number;
  /** max share of capital in one item id (0..1) */
  maxShare: number;
  excludeSuspect: boolean;
  /** per-cycle capacity of each shared market (resourceCaps); a key not listed is unlimited */
  caps?: Readonly<Record<string, number>>;
  /** profit/hour weight per risk level in the objective (default OPTIMIZER.riskWeight) */
  riskWeight?: Readonly<Record<RiskLevel, number>>;
  /** coins/hour charged per open position (default OPTIMIZER.attentionPerPosition) */
  attention?: number;
}

const finitePos = (x: number) => x > 0 && Number.isFinite(x);

/**
 * A row's plan inputs with the unprofitable tail of its profit curve cut off: the segments up to the last one that
 * still earns, maxUnits at its end, profit per unit averaged over what is left, and units/hour scaled with maxUnits
 * (the rate per unit is the same at any size). null when nothing earns.
 */
function profitable(p: PlanInputs): PlanInputs | null {
  if (!p.segments?.length) return p.profitPerUnit > 0 ? p : null;
  const segs: ProfitSegment[] = [];
  let total = 0;
  let prev = 0;
  for (const s of p.segments) {
    if (!(s.profitPerUnit > 0) || !(s.upTo > prev)) break;
    segs.push(s);
    total += s.profitPerUnit * (s.upTo - prev);
    prev = s.upTo;
  }
  if (!segs.length) return null;
  if (segs.length === p.segments.length) return p;
  return { ...p, maxUnits: prev, profitPerUnit: total / prev, unitsPerHour: (p.unitsPerHour * prev) / p.maxUnits, segments: segs };
}

/**
 * Normalize domain rows into opportunities from their planner inputs (`row.plan`: priced with unlimited capital and
 * slots, the pipelined overlap already in unitCost). Rows without plan inputs, or that earn nothing at their first
 * slice, are left out; a curve that turns unprofitable is cut where it does (see profitable()). `slots` are the
 * order slots at maxUnits; allocate() counts them at the allocated units from orderUnits.
 */
export function toOpportunities(d: OpportunitySources): Opportunity[] {
  const out: Opportunity[] = [];
  const push = (
    kind: OpportunityKind,
    keyPart: string,
    row: { id: string; name: string; risk: RiskReport; plan?: PlanInputs },
    ahSold = false,
    group?: string,
  ) => {
    const p = row.plan && profitable(row.plan);
    if (!p || !finitePos(p.profitPerUnit) || !finitePos(p.unitCost) || !finitePos(p.maxUnits) || !finitePos(p.unitsPerHour)) return;
    out.push({
      kind,
      key: `${kind}:${keyPart}`,
      id: row.id,
      name: row.name,
      unitCost: p.unitCost,
      buyCost: p.buyCost,
      profitPerUnit: p.profitPerUnit,
      unitsPerHour: p.unitsPerHour,
      maxUnits: p.maxUnits,
      slots: slotsFor(p.maxUnits, p.orderUnits),
      orderUnits: p.orderUnits,
      uses: p.uses,
      ...(p.segments ? { segments: p.segments } : {}),
      risk: row.risk,
      ...(ahSold ? { ahSold } : {}),
      ...(group ? { group } : {}),
    });
  };

  for (const r of d.flips) push('flip', r.id, r);
  for (const r of d.crafts) {
    if (r.unpriced.length > 0) continue;
    push(r.recipe.kind === 'forge' ? 'forge' : 'craft', r.recipe.key, r, r.valueSource === 'ah');
  }
  for (const c of d.chains ?? []) {
    if (c.row.unpriced.length > 0) continue;
    push('chain', c.key, c.row);
  }
  for (const r of d.books) push('book', r.id, r);
  // both directions can exist for one id, so the key carries the direction
  for (const r of d.npc) push('npc', `${r.id}:${r.direction}`, r);
  // one unit = one pet bought, upgraded and sold; every row shares KAT_GROUP (Kat holds one pet)
  for (const r of d.kat ?? []) {
    if (r.unpriced.length > 0) continue;
    push('kat', r.key, r, true, KAT_GROUP);
  }
  // AH relists are AH-sold; George buys the pet himself
  for (const r of d.ahFlips ?? []) push('ahflip', r.key, r, r.venue === 'ah');
  return out;
}

// ---------------------------------------------------------------- shared markets

/** The volume trend that scales a side's fills under conservatism (as conservative.ts applies it); 1 otherwise. */
function trendOf(ctx: CalcCtx, id: string, side: 'bid' | 'ask'): number {
  if (!ctx.settings.conservative || !((ctx.stats?.(id)?.n ?? 0) >= CONSERVATIVE.minPoints)) return 1;
  const m = ctx.market?.(id);
  const t = side === 'bid' ? m?.sellVolTrend : m?.buyVolTrend;
  if (t == null || !Number.isFinite(t)) return 1;
  const [lo, hi] = CONSERVATIVE.trendClamp;
  return Math.min(hi, Math.max(lo, t));
}

/**
 * Per-cycle capacity of one shared market (ResourceKey), in the units ResourceUse.perUnit draws:
 *  X:bid  X's insta-sells per hour x share x trend x cycleHours (fills your buy orders and your insta-sells of X)
 *  X:ask  X's insta-buys per hour x share x trend x cycleHours
 *  X:npc  npcDailyLimit / 24 x cycleHours
 *  forge  forgeSlots x cycleHours (slot-hours)
 * A market that is not on the bazaar is unlimited (Infinity).
 */
export function resourceCap(ctx: CalcCtx, key: string): number {
  const s = ctx.settings;
  const cycle = finitePos(s.cycleHours) ? s.cycleHours : 0;
  if (key === 'forge') return Math.max(0, s.forgeSlots) * cycle;
  const i = key.lastIndexOf(':');
  const id = key.slice(0, i);
  const side = key.slice(i + 1);
  if (side === 'npc') return npcBuyRate(s.npcDailyLimit) * cycle;
  const p = ctx.snap.products[id];
  if (i < 0 || !p || (side !== 'bid' && side !== 'ask')) return Infinity;
  // a buy order fills from insta-sells (the bid side's flow), a sell offer from insta-buys
  const rates = sideRates(p, 'order', 'offer');
  return (side === 'bid' ? rates.buy : rates.sell) * Math.max(0, s.share) * trendOf(ctx, id, side) * cycle;
}

/** Capacities of every market the opportunities draw on, for AllocateOptions.caps. */
export function resourceCaps(ctx: CalcCtx, opps: readonly Opportunity[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of opps) for (const u of o.uses ?? []) if (out[u.key] === undefined) out[u.key] = resourceCap(ctx, u.key);
  return out;
}

// ---------------------------------------------------------------- allocation

interface Cand {
  opp: Opportunity;
  /** capital per unit */
  c: number;
  /** per piece of the profit curve: weighted profit/hour per unit, unweighted profit/hour per unit, end (units) */
  pv: number[];
  pp: number[];
  pe: number[];
  /** max units on its own (maxUnits, per-item capital, each market's capacity, the slot count) */
  cap: number;
  /** units per order per unit; null = a fixed slot count (`fixed`) at any size */
  ou: readonly number[] | null;
  fixed: number;
  /** slots at one unit: what a member of a set reserves */
  minSlots: number;
  /** units up to which the slots stay at minSlots (fill()'s fast path) */
  flat: number;
  /** markets drawn: index into the capacity table, units per unit */
  ur: number[];
  uk: number[];
  /** one-per-group key: opp.group, else opp.id */
  g: string;
}

/** floor with a relative epsilon so 0.5*100/0.1 = 499.999... still yields 500. */
const fl = (x: number) => Math.max(0, Math.floor(x * (1 + 1e-12)));

/**
 * Search budget (inner-loop steps: set members filled) for the improvement pass, shared out over the starts; keeps
 * large inputs bounded and deterministic.
 */
const SEARCH_BUDGET = 700_000;
/**
 * The budget for n candidates. The last pass of a converged search (every swap, each refilled) costs about the whole
 * budget while it finds nothing, so a small input gets a smaller one; real inputs converge well within it.
 */
const budgetFor = (n: number) => Math.min(SEARCH_BUDGET, 50_000 + 500 * n);
/** Candidates beyond the greedy start that the improvement pass may swap in (top by density and by standalone value). */
const POOL = 200;

const slotsAt = (k: Cand, u: number) => (u <= 0 ? 0 : k.ou ? slotsFor(u, k.ou) : k.fixed);

/** Largest u in [lo, hi] with slotsAt(k, u) <= budget, given slotsAt(k, lo) <= budget (slots grow with u). */
function maxUnitsForSlots(k: Cand, budget: number, lo: number, hi: number): number {
  if (slotsAt(k, hi) <= budget) return hi;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (slotsAt(k, mid) <= budget) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Sum of per-piece rates over the first u units of a piecewise-linear curve. */
function curve(rates: readonly number[], ends: readonly number[], u: number): number {
  let v = 0;
  let prev = 0;
  for (let j = 0; j < rates.length && u > prev; j++) {
    v += rates[j]! * (Math.min(u, ends[j]!) - prev);
    prev = ends[j]!;
  }
  return v;
}

/**
 * Choose units per opportunity maximizing the score Σ profit/hour x riskWeight − attention x positions, subject to:
 * total capital <= capital (<= 0 = unlimited); order slots, counted at the allocated units (Σ ceil(u x k /
 * MAX_ORDER_UNITS) per order leg), <= slots; each shared market's draw (Σ units x perUnit) <= its capacity in caps;
 * capital per item id <= maxShare x capital; at most one opportunity per id (per group when set: all Kat runs share
 * one); and no suspect opportunities when excludeSuspect.
 *
 * Profit/hour per unit is profitPerUnit x unitsPerHour / maxUnits, piecewise when `segments` give a concave curve
 * (each slice is a sub-candidate). A set of picks is filled by fill(): every member reserves its one-unit slots, then
 * the slices of all members, best profit/hour per coin first, take integer units up to what capital, the markets and
 * the spare slots allow, so a pick shrinks to fit rather than drop out. Sets come from three starts (density greedy,
 * standalone-value greedy, and a Lagrangian start: capital priced at λ, the best slot-feasible one-per-group set
 * solved as a group knapsack over slots, with λ found by bisection so the set's capital demand meets the capital),
 * each improved by add / swap / drop-and-refill moves; the best score wins. Deterministic (ties by key).
 */
export function allocate(opps: readonly Opportunity[], o: AllocateOptions): PlanResult {
  const capital = o.capital > 0 ? o.capital : Infinity;
  const slotCap = o.slots >= 0 ? Math.floor(o.slots) : 0;
  const share = o.maxShare >= 0 ? Math.min(1, o.maxShare) : 0;
  const perItem = share > 0 ? capital * share : 0;
  const weights = o.riskWeight ?? OPTIMIZER.riskWeight;
  const att = o.attention != null && o.attention > 0 && Number.isFinite(o.attention) ? o.attention : 0;

  // capacity table: one entry per capped market a candidate draws on
  const resIdx = new Map<string, number>();
  const resCap: number[] = [];
  const capOf = (key: string): number => {
    const v = o.caps?.[key];
    return typeof v === 'number' && !Number.isNaN(v) ? Math.max(0, v) : Infinity;
  };

  const cands: Cand[] = [];
  for (const opp of opps) {
    if (o.excludeSuspect && opp.risk.level === 'suspect') continue;
    const { unitCost: c, profitPerUnit, unitsPerHour, maxUnits } = opp;
    if (!finitePos(c) || !finitePos(profitPerUnit) || !finitePos(unitsPerHour) || !finitePos(maxUnits)) continue;
    const w = weights[opp.risk.level] ?? 1;
    if (!finitePos(w)) continue;
    const ou = opp.orderUnits ? opp.orderUnits.filter(finitePos) : null;
    const fixed = opp.slots > 0 ? Math.ceil(opp.slots) : 0;
    const k: Cand = { opp, c, pv: [], pp: [], pe: [], cap: 0, ou, fixed, minSlots: 0, flat: 0, ur: [], uk: [], g: opp.group ?? opp.id };
    k.minSlots = slotsAt(k, 1);
    if (k.minSlots > slotCap) continue;
    let cap = Math.min(maxUnits, perItem / c);
    for (const u of opp.uses ?? []) {
      const kc = capOf(u.key);
      if (!(u.perUnit > 0) || kc === Infinity) continue;
      cap = Math.min(cap, kc / u.perUnit);
      let r = resIdx.get(u.key);
      if (r === undefined) {
        resIdx.set(u.key, (r = resCap.length));
        resCap.push(kc);
      }
      k.ur.push(r);
      k.uk.push(u.perUnit);
    }
    cap = fl(cap);
    if (cap >= 1 && ou) cap = maxUnitsForSlots(k, slotCap, 1, cap);
    if (cap < 1) continue;
    k.cap = cap;
    // pieces: the segments (profit per unit non-increasing, clamped so), else one flat piece; the last ends at cap
    const h = unitsPerHour / maxUnits;
    let prev = 0;
    let last = Infinity;
    for (const s of opp.segments?.length ? opp.segments : [{ upTo: maxUnits, profitPerUnit }]) {
      const ppu = Math.min(last, s.profitPerUnit);
      if (!(ppu > 0) || !(s.upTo > prev) || prev >= cap) break;
      last = ppu;
      prev = Math.min(s.upTo, cap);
      k.pp.push(ppu * h);
      k.pv.push(ppu * h * w);
      k.pe.push(prev);
    }
    if (!k.pv.length) continue;
    if (prev < cap) k.cap = Math.max(1, fl(prev));
    k.pe[k.pe.length - 1] = k.cap;
    k.flat = ou ? maxUnitsForSlots(k, k.minSlots, 1, k.cap) : k.cap;
    cands.push(k);
  }
  // rank = index in density order (first-piece profit/hour per coin desc, key asc); sets are sorted rank arrays
  const keyCmp = (a: Cand, b: Cand) => (a.opp.key < b.opp.key ? -1 : a.opp.key > b.opp.key ? 1 : 0);
  cands.sort((a, b) => b.pv[0]! / b.c - a.pv[0]! / a.c || keyCmp(a, b));
  const n = cands.length;
  let steps = 0;

  // every piece in density order (ties: rank, then piece): fill() takes a set's pieces in this order
  const pieces: [number, number][] = [];
  cands.forEach((k, r) => k.pv.forEach((_, j) => pieces.push([r, j])));
  pieces.sort(([ra, ja], [rb, jb]) => cands[rb]!.pv[jb]! / cands[rb]!.c - cands[ra]!.pv[ja]! / cands[ra]!.c || ra - rb || ja - jb);
  const pieceR = Int32Array.from(pieces, (p) => p[0]);
  const pieceJ = Int32Array.from(pieces, (p) => p[1]);
  const pieceOrder = cands.map((k) => k.pv.map(() => 0));
  pieces.forEach(([r, j], i) => (pieceOrder[r]![j] = i));

  // fill scratch: units by rank, remaining capacity by market (initialized lazily per fill: `stamp`)
  const uOf = new Float64Array(n);
  const resRem = new Float64Array(resCap.length);
  const resStamp = new Int32Array(resCap.length);
  let stamp = 0;
  const resLeft = (r: number) => {
    if (resStamp[r] !== stamp) {
      resStamp[r] = stamp;
      resRem[r] = resCap[r]!;
    }
    return resRem[r]!;
  };

  /** Units a candidate can add on top of u0 (up to `target`) within the remaining capital and markets. */
  const room = (k: Cand, u0: number, target: number, rem: number): number => {
    let du = Math.min(target - u0, fl(rem / k.c));
    for (let i = 0; i < k.ur.length && du > 0; i++) du = Math.min(du, fl(resLeft(k.ur[i]!) / k.uk[i]!));
    return du;
  };
  const take = (k: Cand, du: number) => {
    for (let i = 0; i < k.ur.length; i++) resRem[k.ur[i]!] = resLeft(k.ur[i]!) - du * k.uk[i]!;
  };

  // fill() scratch: each market's demand at the members' caps (initialized per fill like resLeft)
  const resDem = new Float64Array(resCap.length);
  const demStamp = new Int32Array(resCap.length);
  const pieceKey = new Float64Array(pieces.length);
  const pressure = (r: number) => (resDem[r]! > resCap[r]! ? resDem[r]! / (resCap[r]! * resCap[r]!) : 0);

  /**
   * Fill a set (see allocate); units land in uOf; returns the score. The slices go by profit/hour per coin while
   * only capital is short. When a market the members share is over-asked at their caps, every short constraint is
   * priced by how over-asked it is (demand / supply², per unit drawn), and the slices go by profit/hour per priced
   * unit instead, so the market goes to whoever earns most from it.
   */
  const fill = (set: readonly number[]): number => {
    stamp++;
    let rem = capital;
    let spare = slotCap;
    let multi = false;
    let capDem = 0;
    let tight = false;
    for (const r of set) {
      const k = cands[r]!;
      uOf[r] = 0;
      spare -= k.minSlots;
      if (k.pv.length > 1) multi = true;
      capDem += k.cap * k.c;
      for (let i = 0; i < k.ur.length; i++) {
        const ri = k.ur[i]!;
        if (demStamp[ri] !== stamp) {
          demStamp[ri] = stamp;
          resDem[ri] = 0;
        }
        const d = resDem[ri]! + k.cap * k.uk[i]!;
        resDem[ri] = d;
        if (d > resCap[ri]!) tight = true;
      }
    }
    let order: readonly number[] = set;
    if (tight) {
      const lamC = capDem > capital ? capDem / (capital * capital) : 0;
      const ps: number[] = [];
      for (const r of set) {
        const k = cands[r]!;
        let cost = k.c * lamC;
        for (let i = 0; i < k.ur.length; i++) cost += k.uk[i]! * pressure(k.ur[i]!);
        for (let j = 0; j < k.pv.length; j++) {
          const x = pieceOrder[r]![j]!;
          ps.push(x);
          pieceKey[x] = cost > 0 ? k.pv[j]! / cost : Infinity;
        }
      }
      order = ps.sort((a, b) => pieceKey[b]! - pieceKey[a]! || a - b);
      multi = true;
    } else if (multi) {
      const ps: number[] = [];
      for (const r of set) for (const i of pieceOrder[r]!) ps.push(i);
      order = ps.sort((a, b) => a - b);
    }
    steps += order.length;
    for (const x of order) {
      const r = multi ? pieceR[x]! : x;
      const j = multi ? pieceJ[x]! : 0;
      const k = cands[r]!;
      const u0 = uOf[r]!;
      const target = j === k.pv.length - 1 ? k.cap : Math.min(k.cap, fl(k.pe[j]!));
      if (target <= u0) continue;
      let du = Math.min(target - u0, fl(rem / k.c));
      for (let i = 0; i < k.ur.length && du > 0; i++) du = Math.min(du, fl(resLeft(k.ur[i]!) / k.uk[i]!));
      if (du <= 0) continue;
      if (u0 + du > k.flat) {
        const base = u0 > 0 ? slotsAt(k, u0) : k.minSlots;
        if (slotsAt(k, u0 + du) - base > spare) du = maxUnitsForSlots(k, base + spare, u0, u0 + du) - u0;
        if (du <= 0) continue;
        spare -= slotsAt(k, u0 + du) - base;
      }
      uOf[r] = u0 + du;
      rem -= du * k.c;
      take(k, du);
    }
    let v = 0;
    for (const r of set) {
      const u = uOf[r]!;
      if (u >= 1) v += (multi ? curve(cands[r]!.pv, cands[r]!.pe, u) : u * cands[r]!.pv[0]!) - att;
    }
    return v;
  };
  const value = fill;
  const slotsOf = (set: readonly number[]) => set.reduce((n, r) => n + cands[r]!.minSlots, 0);
  const idsOf = (set: readonly number[]) => new Set(set.map((r) => cands[r]!.g));
  const insert = (set: readonly number[], r: number) => {
    const i = set.findIndex((x) => x > r);
    return i < 0 ? [...set, r] : [...set.slice(0, i), r, ...set.slice(i)];
  };

  // Start 1: density greedy over everything, each pick taking what is left whole (pieces not interleaved).
  const greedy: number[] = [];
  {
    stamp++;
    let rem = capital;
    let spare = slotCap;
    const ids = new Set<string>();
    for (let r = 0; r < n; r++) {
      const k = cands[r]!;
      if (ids.has(k.g) || k.minSlots > spare) continue;
      let u = room(k, 0, k.cap, rem);
      if (u >= 1 && k.ou) u = maxUnitsForSlots(k, spare, 1, u);
      if (u < 1 || curve(k.pv, k.pe, u) <= att) continue;
      greedy.push(r);
      ids.add(k.g);
      spare -= slotsAt(k, u);
      rem -= u * k.c;
      take(k, u);
    }
  }

  // Swap pool: top POOL by density plus top POOL by standalone value (best score if it had the budget alone).
  const alone = (r: number) => Math.min(cands[r]!.cap, fl(capital / cands[r]!.c));
  const standalone = cands.map((k, r) => curve(k.pv, k.pe, alone(r)) - att);
  const byValue = [...Array(n).keys()].sort((a, b) => standalone[b]! - standalone[a]! || a - b);
  const pool = [...new Set([...Array(Math.min(n, POOL)).keys(), ...byValue.slice(0, POOL)])].sort((a, b) => a - b);

  // Start 2: standalone-value greedy over the pool.
  let byVal: number[] = [];
  let byValV = 0;
  for (const r of byValue.slice(0, POOL)) {
    if (idsOf(byVal).has(cands[r]!.g) || slotsOf(byVal) + cands[r]!.minSlots > slotCap) continue;
    const next = insert(byVal, r);
    const v = value(next);
    if (v > byValV) {
      byVal = next;
      byValV = v;
    }
  }

  // Start 3: Lagrangian. Price capital at lam coins/hour per coin; each candidate is then worth its pieces that still
  // pay (pv - lam*c > 0) over the units it could take alone, minus the attention cost, and the best slot-feasible
  // one-per-group set is a group knapsack over the one-unit slots. Its capital demand falls as lam rises, so lam is
  // bisected to where the demand meets the capital (lam = 0 when capital never binds).
  const lagrange = (lam: number): { set: number[]; demand: number } => {
    const groups = new Map<string, { r: number; v: number; d: number }[]>();
    for (let r = 0; r < n; r++) {
      const k = cands[r]!;
      const lim = alone(r);
      let v = -att;
      let units = 0;
      let prev = 0;
      for (let j = 0; j < k.pv.length && prev < lim; j++) {
        const gain = k.pv[j]! - lam * k.c;
        if (gain <= 0) break;
        const end = Math.min(lim, k.pe[j]!);
        v += gain * (end - prev);
        units = end;
        prev = end;
      }
      if (v > 0) (groups.get(k.g) ?? groups.set(k.g, []).get(k.g)!).push({ r, v, d: units * k.c });
    }
    const gs = [...groups.values()];
    steps += n;
    let set: number[];
    const maxSlots = gs.reduce((t, g) => t + Math.max(...g.map((x) => cands[x.r]!.minSlots)), 0);
    if (maxSlots <= slotCap) {
      // slots cannot bind: best member of every group
      set = gs.map((g) => g.reduce((b, x) => (x.v > b.v ? x : b)).r);
    } else {
      const S = slotCap; // finite here, since maxSlots > slotCap
      let dp = new Float64Array(S + 1);
      const pick = gs.map(() => new Int32Array(S + 1).fill(-1));
      gs.forEach((g, gi) => {
        const next = dp.slice();
        for (const { r, v } of g) {
          const w = cands[r]!.minSlots;
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
      set = [];
      for (let gi = gs.length - 1, t = S; gi >= 0; gi--) {
        const r = pick[gi]![t]!;
        if (r >= 0) {
          set.push(r);
          t -= cands[r]!.minSlots;
        }
      }
    }
    const dOf = new Map(gs.flat().map((x) => [x.r, x.d]));
    return { set: set.sort((a, b) => a - b), demand: set.reduce((t, r) => t + dOf.get(r)!, 0) };
  };
  let lagSet: number[] = [];
  let lagV = -Infinity;
  const tried = new Set<string>();
  const tryLam = (lam: number) => {
    const res = lagrange(lam);
    const key = res.set.join(',');
    if (!tried.has(key)) {
      tried.add(key);
      const v = value(res.set);
      if (v > lagV) {
        lagSet = res.set;
        lagV = v;
      }
    }
    return res.demand;
  };
  if (n > 0 && tryLam(0) > capital) {
    let lo = 0;
    let hi = cands.reduce((m, k) => Math.max(m, k.pv[0]! / k.c), 0);
    for (let it = 0; it < OPTIMIZER.lambdaIters && hi - lo > hi * 1e-9; it++) {
      const mid = (lo + hi) / 2;
      if (tryLam(mid) > capital) lo = mid;
      else hi = mid;
    }
  }

  /** the step count the current improve() run may reach */
  const budget = budgetFor(n);
  let limit = budget;

  /** Greedily add pool candidates (density order) to `base` while they fit and raise the score; `banned` stays out. */
  const complete = (base: readonly number[], banned: number): number[] => {
    let cur = [...base];
    let v = value(cur);
    const ids = idsOf(cur);
    let used = slotsOf(cur);
    for (const i of pool) {
      if (steps >= limit) break;
      const ki = cands[i]!;
      if (i === banned || ids.has(ki.g) || used + ki.minSlots > slotCap || cur.includes(i)) continue;
      const next = insert(cur, i);
      const nv = value(next);
      if (nv > v) {
        cur = next;
        v = nv;
        ids.add(ki.g);
        used += ki.minSlots;
      }
    }
    return cur;
  };

  /** Pool candidates that may replace member j (or be added, j = -1) without breaking the group / slot limits. */
  function* swaps(set: readonly number[], withAdds: boolean) {
    const inSet = new Set(set);
    const ids = idsOf(set);
    const used = slotsOf(set);
    for (const i of pool) {
      if (inSet.has(i)) continue;
      const ki = cands[i]!;
      if (withAdds && !ids.has(ki.g) && used + ki.minSlots <= slotCap) yield { i, j: -1 };
      for (const j of set) {
        const kj = cands[j]!;
        if (ids.has(ki.g) && ki.g !== kj.g) continue;
        if (used - kj.minSlots + ki.minSlots <= slotCap) yield { i, j };
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

  /** Best-improvement local search over the neighbourhoods above, up to `limit` steps. */
  const improve = (start: number[]): { set: number[]; v: number } => {
    let set = start;
    let v = value(set);
    search: while (steps < limit) {
      for (const hood of neighbourhoods) {
        let best: number[] | null = null;
        let bestV = v + Math.max(1e-9, Math.abs(v) * 1e-12);
        for (const next of hood(set)) {
          if (steps >= limit) break;
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
  let chosenV = -Infinity;
  const starts = [greedy, byVal, lagSet];
  for (const [si, start] of starts.entries()) {
    // each start gets an even share of what is left (an early one that converges leaves more to the later ones)
    limit = steps + (budget - steps) / (starts.length - si);
    const res = improve(start);
    if (res.v > chosenV) ({ set: chosen, v: chosenV } = res);
  }

  const score = n > 0 ? fill(chosen) : 0;
  const allocations: Allocation[] = [];
  for (const r of chosen) {
    const u = uOf[r]!;
    if (u < 1) continue;
    const k = cands[r]!;
    allocations.push({ opp: k.opp, units: u, capital: u * k.c, slots: slotsAt(k, u), profitPerHour: curve(k.pp, k.pe, u) });
  }
  allocations.sort((x, y) => y.profitPerHour - x.profitPerHour || (x.opp.key < y.opp.key ? -1 : 1));
  return {
    allocations,
    capitalUsed: allocations.reduce((s, x) => s + x.capital, 0),
    slotsUsed: allocations.reduce((s, x) => s + x.slots, 0),
    profitPerHour: allocations.reduce((s, x) => s + x.profitPerHour, 0),
    score,
  };
}
