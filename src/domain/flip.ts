import type { CalcCtx, FlipRow } from '../types/contracts.ts';
import { afterTax, buySide, planTrade, sellSide, type Leg } from './pricing.ts';
import { assessRisk } from './risk.ts';

/** All bazaar flips with profit > 0 (suspect rows included; views filter). */
export function computeFlips(ctx: CalcCtx): FlipRow[] {
  const { snap, catalog, settings } = ctx;
  const { costMode, sellMode, share, taxRate } = settings;
  const refine = costMode === 'insta' || sellMode === 'insta';
  const rows: FlipRow[] = [];
  for (const [id, p] of Object.entries(snap.products)) {
    const buy = (q: number): Leg | null => {
      const s = buySide(p, costMode, share, q, catalog.items[id]?.npcSell);
      return s && { price: s.quote.price, net: s.quote.price, rate: s.rate, depth: s.depth, comp: s.comp };
    };
    const sell = (q: number): Leg | null => {
      const s = sellSide(p, sellMode, share, q);
      return s && { price: s.quote.price, net: afterTax(s.quote.price, taxRate), rate: s.rate, depth: s.depth, comp: s.comp };
    };
    const plan = planTrade(buy, sell, settings, refine);
    if (!plan || !(plan.profit > 0) || !(plan.buy.price > 0)) continue;
    rows.push({
      id,
      name: catalog.name(id),
      buyAt: plan.buy.price,
      sellAt: plan.sell.price,
      netSell: plan.sell.net,
      profit: plan.profit,
      margin: plan.profit / plan.buy.price,
      rBuy: plan.buy.rate,
      rSell: plan.sell.rate,
      compBuy: plan.buy.comp ?? 0,
      compSell: plan.sell.comp ?? 0,
      weekVol: Math.min(p.instaBuysWeek, p.instaSellsWeek),
      tp: plan.tp,
      profitPerHour: plan.tp.unitsPerHour * plan.profit,
      risk: assessRisk(p, ctx.stats?.(id) ?? null),
    });
  }
  return rows;
}
