// Pure selectors behind the overview cards (lists are already memoized upstream in ctx.derived).
import { OPTIMIZER, STATS } from '../../../config.ts';
import { allocate } from '../../../domain/optimizer.ts';
import type { BookRow, CraftRow, FlipRow, MarketStat, Opportunity, PlanResult, Settings, Snapshot } from '../../../types/contracts.ts';

export type MoverWindow = '1h' | '24h';

export interface Mover {
  id: string;
  change: number;
}

const ok = (x: { risk: { level: string }; profitPerHour: number }) =>
  x.risk.level !== 'suspect' && Number.isFinite(x.profitPerHour) && x.profitPerHour > 0;

const byPph = <T extends { profitPerHour: number }>(a: T, b: T) => b.profitPerHour - a.profitPerHour;

/** Best non-suspect flips by profit/hour. */
export function topFlips(rows: readonly FlipRow[], n: number): FlipRow[] {
  return rows.filter(ok).sort(byPph).slice(0, n);
}

/** Best priced, non-suspect crafts and forges by profit/hour; one row per output item (its best recipe). */
export function topCrafts(rows: readonly CraftRow[], n: number): CraftRow[] {
  const seen = new Set<string>();
  const out: CraftRow[] = [];
  for (const r of rows.filter((x) => ok(x) && x.unpriced.length === 0).sort(byPph)) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

/** Best verified, non-suspect book combines by profit/hour. */
export function topBooks(rows: readonly BookRow[], n: number): BookRow[] {
  return rows.filter((r) => ok(r) && r.verified).sort(byPph).slice(0, n);
}

/**
 * Biggest risers and fallers over the window, among products with weekly volume (insta buys + insta sells)
 * >= STATS.moversMinWeekVol. `known` = how many qualifying products have a change at all (0 => not enough history).
 */
export function movers(
  stats: ReadonlyMap<string, MarketStat>,
  snap: Snapshot,
  win: MoverWindow,
  n: number,
): { up: Mover[]; down: Mover[]; known: number } {
  const all: Mover[] = [];
  for (const [id, s] of stats) {
    const p = snap.products[id];
    if (!p || p.instaBuysWeek + p.instaSellsWeek < STATS.moversMinWeekVol) continue;
    const change = win === '1h' ? s.change1h : s.change24h;
    if (change == null || !Number.isFinite(change)) continue;
    all.push({ id, change });
  }
  const tie = (a: Mover, b: Mover) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const up = all.filter((m) => m.change > 0).sort((a, b) => b.change - a.change || tie(a, b)).slice(0, n);
  const down = all.filter((m) => m.change < 0).sort((a, b) => a.change - b.change || tie(a, b)).slice(0, n);
  return { up, down, known: all.length };
}

export interface ConsistentFlip {
  row: FlipRow;
  consistency: number;
  score: number;
}

/** Non-suspect profitable flips ranked by consistency × profit/hour (items without a consistency are skipped). */
export function mostConsistent(rows: readonly FlipRow[], stats: ReadonlyMap<string, MarketStat>, n: number): ConsistentFlip[] {
  const out: ConsistentFlip[] = [];
  for (const row of rows) {
    if (!ok(row)) continue;
    const c = stats.get(row.id)?.consistency;
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    out.push({ row, consistency: c, score: c * row.profitPerHour });
  }
  return out.sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : 1)).slice(0, n);
}

/** Allocation options the overview uses (same as the planner's defaults). */
export function planOptions(s: Settings): Parameters<typeof allocate>[1] {
  return { capital: s.capital, slots: s.orderSlots, maxShare: OPTIMIZER.maxShareOfCapitalPerItem, excludeSuspect: OPTIMIZER.excludeSuspect };
}

/** Plan for the current opportunities and settings. */
export function planSummary(opps: readonly Opportunity[], s: Settings): PlanResult {
  return allocate(opps, planOptions(s));
}
