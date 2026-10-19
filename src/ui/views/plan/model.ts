// Planner model: URL schema, allocate() options from URL + settings, kind filter, and the per-row "why".
import { AH_FLIP, OPTIMIZER, ORDER_SLOTS_MAX } from '../../../config.ts';
import { resourceCaps, type AllocateOptions } from '../../../domain/optimizer.ts';
import { slotsFor } from '../../../domain/pricing.ts';
import type { Allocation, CalcCtx, Opportunity, OpportunityKind, PlanResult, Settings } from '../../../types/contracts.ts';
import type { QuerySchema, QueryValues } from '../../kit/index.ts';

export const KINDS: readonly OpportunityKind[] = ['flip', 'craft', 'forge', 'chain', 'book', 'npc', 'kat', 'ahflip'];

/** URL state. capital / slots / share default to null = "use settings / OPTIMIZER"; kinds are include toggles. */
export const PLAN_SCHEMA = {
  capital: { kind: 'number', def: null, min: 0 },
  slots: { kind: 'number', def: null, min: 0, max: ORDER_SLOTS_MAX },
  /** max share of capital per item, percent */
  share: { kind: 'number', def: null, min: 1, max: 100 },
  /** coins/hour charged per position (null = OPTIMIZER.attentionPerPosition) */
  attention: { kind: 'number', def: null, min: 0 },
  /** exclude suspect opportunities */
  suspect: { kind: 'bool', def: OPTIMIZER.excludeSuspect },
  flip: { kind: 'bool', def: true },
  craft: { kind: 'bool', def: true },
  forge: { kind: 'bool', def: true },
  chain: { kind: 'bool', def: true },
  book: { kind: 'bool', def: true },
  npc: { kind: 'bool', def: true },
  kat: { kind: 'bool', def: true },
  ahflip: { kind: 'bool', def: AH_FLIP.plannerDefault },
  /** include opportunities whose output is sold on the auction house */
  ah: { kind: 'bool', def: true },
  sort: { kind: 'sort', def: { key: 'pph', dir: 'desc' } },
} as const satisfies QuerySchema;

export type PlanQuery = QueryValues<typeof PLAN_SCHEMA>;

/**
 * allocate() options: URL overrides, else settings (capital, order slots) and OPTIMIZER defaults; `caps` are the
 * shared markets' capacities (planCaps).
 */
export function planOptions(v: PlanQuery, s: Pick<Settings, 'capital' | 'orderSlots'>, caps?: Readonly<Record<string, number>>): AllocateOptions {
  return {
    capital: v.capital ?? s.capital,
    slots: v.slots ?? s.orderSlots,
    maxShare: v.share != null ? v.share / 100 : OPTIMIZER.maxShareOfCapitalPerItem,
    excludeSuspect: v.suspect,
    attention: v.attention ?? OPTIMIZER.attentionPerPosition,
    ...(caps ? { caps } : {}),
  };
}

const capsMemo = new WeakMap<readonly Opportunity[], Record<string, number>>();

/** Shared-market capacities for a set of opportunities (resourceCaps), memoized per opportunities array. */
export function planCaps(ctx: CalcCtx | null, opps: readonly Opportunity[]): Record<string, number> {
  let caps = capsMemo.get(opps);
  if (!caps) capsMemo.set(opps, (caps = ctx ? resourceCaps(ctx, opps) : {}));
  return caps;
}

/** Opportunities of the included kinds, without AH-sold ones when `ah` is off (the input array itself when nothing is left out). */
export function filterKinds(opps: readonly Opportunity[], v: Pick<PlanQuery, OpportunityKind | 'ah'>): readonly Opportunity[] {
  if (KINDS.every((k) => v[k]) && v.ah) return opps;
  return opps.filter((o) => v[o.kind] && (v.ah || !o.ahSold));
}

/**
 * What stopped an allocation from growing:
 *  volume  - it got every unit the market fills per cycle (opp.maxUnits)
 *  share   - it hit the per-item capital cap (maxShare x capital)
 *  market  - a market it shares with other picks is drawn to its capacity (PlanRow.market names it)
 *  slots   - one more unit needs another order slot and none is left
 *  capital - the remaining capital ran out (the last, partially filled pick)
 */
export type WhyBound = 'volume' | 'share' | 'market' | 'slots' | 'capital';

export interface PlanRow {
  key: string;
  alloc: Allocation;
  opp: Opportunity;
  /** share of the plan's total profit/hour (0..1) */
  profitShare: number;
  /** share of the available capital (0..1), null when capital is unlimited */
  capitalShare: number | null;
  /** profit/hour per coin tied up */
  perCoin: number;
  /** 1 = best profit per coin among the allocations */
  rank: number;
  bound: WhyBound;
  /** the full market when bound is 'market' (a ResourceKey) */
  market?: string;
}

/** floor with the optimizer's relative epsilon (so 0.5*100/0.1 = 499.999… still yields 500). */
const fl = (x: number) => Math.max(0, Math.floor(x * (1 + 1e-12)));

/** Each market's draw over a plan's allocations (units x perUnit summed per key). */
export function marketUse(res: PlanResult): Map<string, number> {
  const used = new Map<string, number>();
  for (const a of res.allocations) for (const u of a.opp.uses ?? []) used.set(u.key, (used.get(u.key) ?? 0) + a.units * u.perUnit);
  return used;
}

/** A market of the allocation that one more unit would overdraw (its ResourceKey), if any. */
function fullMarket(a: Allocation, o: AllocateOptions, used: ReadonlyMap<string, number>): string | undefined {
  for (const u of a.opp.uses ?? []) {
    const cap = o.caps?.[u.key];
    if (cap != null && (used.get(u.key) ?? 0) + u.perUnit > cap * (1 + 1e-9)) return u.key;
  }
  return undefined;
}

/**
 * The binding limit of one allocation, derived from the same caps allocate() applies. The shared limits (markets,
 * slots) need the whole plan `res`; without it only volume / share / capital are told apart.
 */
export function whyBound(a: Allocation, o: AllocateOptions, res?: PlanResult, used: ReadonlyMap<string, number> | null = res ? marketUse(res) : null): WhyBound {
  const capital = o.capital > 0 ? o.capital : Infinity;
  const share = o.maxShare >= 0 ? Math.min(1, o.maxShare) : 0;
  const perItem = share > 0 ? capital * share : 0;
  const volCap = fl(a.opp.maxUnits);
  const shareCap = Number.isFinite(perItem) ? fl(perItem / a.opp.unitCost) : Infinity;
  if (a.units >= volCap && volCap <= shareCap) return 'volume';
  if (a.units >= shareCap) return 'share';
  if (res && used) {
    if (fullMarket(a, o, used)) return 'market';
    const ou = a.opp.orderUnits;
    const more = ou ? slotsFor(a.units + 1, ou) - slotsFor(a.units, ou) : 0;
    if (more > 0 && res.slotsUsed + more > Math.floor(o.slots)) return 'slots';
  }
  return 'capital';
}

/** Table rows for a plan, in allocation order. */
export function planRows(res: PlanResult, o: AllocateOptions): PlanRow[] {
  const perCoin = (a: Allocation) => (a.capital > 0 ? a.profitPerHour / a.capital : 0);
  const order = [...res.allocations].sort((x, y) => perCoin(y) - perCoin(x) || (x.opp.key < y.opp.key ? -1 : 1));
  const rank = new Map(order.map((a, i) => [a.opp.key, i + 1]));
  const capital = o.capital > 0 ? o.capital : null;
  const used = marketUse(res);
  return res.allocations.map((a) => {
    const bound = whyBound(a, o, res, used);
    const market = bound === 'market' ? fullMarket(a, o, used) : undefined;
    return {
      key: a.opp.key,
      alloc: a,
      opp: a.opp,
      profitShare: res.profitPerHour > 0 ? a.profitPerHour / res.profitPerHour : 0,
      capitalShare: capital ? a.capital / capital : null,
      perCoin: perCoin(a),
      rank: rank.get(a.opp.key)!,
      bound,
      ...(market ? { market } : {}),
    };
  });
}

/** Source view row for an opportunity: #/flip?q=ID, #/craft?q=OUTPUT, #/books?q=ID, #/npc?q=ID, #/kat?q=PET NAME. */
export function sourceHref(o: Opportunity): string {
  // the Kat page searches pet names (its ids are AH keys like ENDERMAN;3@MAX); minProfit=0 keeps small runs listed
  if (o.kind === 'kat') return `#/kat?q=${encodeURIComponent(o.name)}&minProfit=0`;
  if (o.kind === 'chain') return `#/craft?view=chains&q=${encodeURIComponent(o.id)}`;
  if (o.kind === 'forge') return `#/forge?q=${encodeURIComponent(o.id)}`;
  // AH flips: the George view for George's, minProfit=0 keeps small ones listed
  if (o.kind === 'ahflip') return `#/ahflip?${o.key.startsWith('ahflip:george:') ? 'mode=george&' : ''}q=${encodeURIComponent(o.id)}&minProfit=0`;
  const route = o.kind === 'book' ? 'books' : o.kind;
  return `#/${route}?q=${encodeURIComponent(o.id)}`;
}
