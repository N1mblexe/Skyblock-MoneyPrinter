// Planner model: URL schema, allocate() options from URL + settings, kind filter, and the per-row "why".
import { OPTIMIZER, ORDER_SLOTS_MAX } from '../../../config.ts';
import type { AllocateOptions } from '../../../domain/optimizer.ts';
import type { Allocation, Opportunity, OpportunityKind, PlanResult, Settings } from '../../../types/contracts.ts';
import type { QuerySchema, QueryValues } from '../../kit/index.ts';

export const KINDS: readonly OpportunityKind[] = ['flip', 'craft', 'forge', 'chain', 'book', 'npc', 'kat'];

/** URL state. capital / slots / share default to null = "use settings / OPTIMIZER"; kinds are include toggles. */
export const PLAN_SCHEMA = {
  capital: { kind: 'number', def: null, min: 0 },
  slots: { kind: 'number', def: null, min: 0, max: ORDER_SLOTS_MAX },
  /** max share of capital per item, percent */
  share: { kind: 'number', def: null, min: 1, max: 100 },
  /** exclude suspect opportunities */
  suspect: { kind: 'bool', def: OPTIMIZER.excludeSuspect },
  flip: { kind: 'bool', def: true },
  craft: { kind: 'bool', def: true },
  forge: { kind: 'bool', def: true },
  chain: { kind: 'bool', def: true },
  book: { kind: 'bool', def: true },
  npc: { kind: 'bool', def: true },
  kat: { kind: 'bool', def: true },
  /** include opportunities whose output is sold on the auction house */
  ah: { kind: 'bool', def: true },
  sort: { kind: 'sort', def: { key: 'pph', dir: 'desc' } },
} as const satisfies QuerySchema;

export type PlanQuery = QueryValues<typeof PLAN_SCHEMA>;

/** allocate() options: URL overrides, else settings (capital, order slots) and OPTIMIZER defaults. */
export function planOptions(v: PlanQuery, s: Pick<Settings, 'capital' | 'orderSlots'>): AllocateOptions {
  return {
    capital: v.capital ?? s.capital,
    slots: v.slots ?? s.orderSlots,
    maxShare: v.share != null ? v.share / 100 : OPTIMIZER.maxShareOfCapitalPerItem,
    excludeSuspect: v.suspect,
  };
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
 *  capital - the remaining capital ran out (the last, partially filled pick)
 */
export type WhyBound = 'volume' | 'share' | 'capital';

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
}

/** floor with the optimizer's relative epsilon (so 0.5*100/0.1 = 499.999… still yields 500). */
const fl = (x: number) => Math.max(0, Math.floor(x * (1 + 1e-12)));

/** The binding limit of one allocation, derived from the same caps allocate() applies. */
export function whyBound(a: Allocation, o: AllocateOptions): WhyBound {
  const capital = o.capital > 0 ? o.capital : Infinity;
  const share = o.maxShare >= 0 ? Math.min(1, o.maxShare) : 0;
  const perItem = share > 0 ? capital * share : 0;
  const volCap = fl(a.opp.maxUnits);
  const shareCap = Number.isFinite(perItem) ? fl(perItem / a.opp.unitCost) : Infinity;
  if (a.units >= volCap && volCap <= shareCap) return 'volume';
  if (a.units >= shareCap) return 'share';
  return 'capital';
}

/** Table rows for a plan, in allocation order. */
export function planRows(res: PlanResult, o: AllocateOptions): PlanRow[] {
  const perCoin = (a: Allocation) => (a.capital > 0 ? a.profitPerHour / a.capital : 0);
  const order = [...res.allocations].sort((x, y) => perCoin(y) - perCoin(x) || (x.opp.key < y.opp.key ? -1 : 1));
  const rank = new Map(order.map((a, i) => [a.opp.key, i + 1]));
  const capital = o.capital > 0 ? o.capital : null;
  return res.allocations.map((a) => ({
    key: a.opp.key,
    alloc: a,
    opp: a.opp,
    profitShare: res.profitPerHour > 0 ? a.profitPerHour / res.profitPerHour : 0,
    capitalShare: capital ? a.capital / capital : null,
    perCoin: perCoin(a),
    rank: rank.get(a.opp.key)!,
    bound: whyBound(a, o),
  }));
}

/** Source view row for an opportunity: #/flip?q=ID, #/craft?q=OUTPUT, #/books?q=ID, #/npc?q=ID, #/kat?q=PET NAME. */
export function sourceHref(o: Opportunity): string {
  // the Kat page searches pet names (its ids are AH keys like ENDERMAN;3@MAX); minProfit=0 keeps small runs listed
  if (o.kind === 'kat') return `#/kat?q=${encodeURIComponent(o.name)}&minProfit=0`;
  if (o.kind === 'chain') return `#/craft?view=chains&q=${encodeURIComponent(o.id)}`;
  if (o.kind === 'forge') return `#/forge?q=${encodeURIComponent(o.id)}`;
  const route = o.kind === 'book' ? 'books' : o.kind;
  return `#/${route}?q=${encodeURIComponent(o.id)}`;
}
