// Capital / order-slot allocation across opportunities. Owner: opportunities package.
import type { BookRow, CraftRow, FlipRow, NpcFlipRow, Opportunity, PlanResult, Settings } from '../types/contracts.ts';

export interface OpportunitySources {
  flips: readonly FlipRow[];
  crafts: readonly CraftRow[];
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

/** Normalize domain rows into opportunities. Wave 0 stub. */
export function toOpportunities(_d: OpportunitySources, _s: Settings): Opportunity[] {
  return [];
}

/** Choose units per opportunity maximizing profit/hour within capital and slots. Wave 0 stub. */
export function allocate(_opps: readonly Opportunity[], _o: AllocateOptions): PlanResult {
  return { allocations: [], capitalUsed: 0, slotsUsed: 0, profitPerHour: 0 };
}
