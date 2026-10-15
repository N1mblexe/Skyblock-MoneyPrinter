// Trade journal math: realized profit per entry, totals for a period, ROI and best / worst items.
import type { JournalEntry } from '../types/contracts.ts';

/** Coins in, after the sale tax: qty × sell × (1 − tax). */
export const revenueOf = (e: JournalEntry): number => e.qty * e.sell * (1 - e.tax);
/** Coins out: qty × buy + fees. */
export const costOf = (e: JournalEntry): number => e.qty * e.buy + e.fees;
export const profitOf = (e: JournalEntry): number => revenueOf(e) - costOf(e);

export interface JournalTotals {
  trades: number;
  revenue: number;
  cost: number;
  profit: number;
  /** profit / cost; null when nothing was spent */
  roi: number | null;
}

export function totals(entries: readonly JournalEntry[]): JournalTotals {
  let revenue = 0;
  let cost = 0;
  for (const e of entries) {
    revenue += revenueOf(e);
    cost += costOf(e);
  }
  const profit = revenue - cost;
  return { trades: entries.length, revenue, cost, profit, roi: cost > 0 ? profit / cost : null };
}

/** Local midnight of `now`'s day. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface JournalSummary {
  today: JournalTotals;
  week: JournalTotals;
  all: JournalTotals;
}

/** Today (since local midnight), the last 7 days, and all time. */
export function summarize(entries: readonly JournalEntry[], now: number): JournalSummary {
  const day = startOfDay(now);
  const week = now - 7 * 24 * 3600_000;
  return {
    today: totals(entries.filter((e) => e.at >= day)),
    week: totals(entries.filter((e) => e.at >= week)),
    all: totals(entries),
  };
}

export interface ItemProfit {
  id: string;
  profit: number;
  trades: number;
}

/** Profit per item, best first. */
export function byItem(entries: readonly JournalEntry[]): ItemProfit[] {
  const m = new Map<string, ItemProfit>();
  for (const e of entries) {
    const cur = m.get(e.id) ?? { id: e.id, profit: 0, trades: 0 };
    cur.profit += profitOf(e);
    cur.trades++;
    m.set(e.id, cur);
  }
  return [...m.values()].sort((a, b) => b.profit - a.profit);
}

/** A unique key for a new order or journal entry. */
export const newTradeKey = (prefix: string, now = Date.now()): string => `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
