import type { CalcCtx, FlipRow, Product } from '../types/contracts.ts';
import { coreOf, mergeCons, sideLeg } from './market.ts';
import { planTrade, tradePlanInputs, type Leg, type TradePlan } from './pricing.ts';

/**
 * The buy and sell legs of a bazaar flip, through the context's market core, for the item `at()` names. One pair of
 * functions serves a whole scan (the item changes between rows), so no closures are built per product.
 */
function flipLegs(ctx: CalcCtx, at: () => string) {
  const core = coreOf(ctx);
  const { taxRate } = ctx.settings;
  const buy = (q: number): Leg | null => {
    const id = at();
    const s = core.buy(id, q);
    return s && sideLeg(id, 'buy', s, taxRate);
  };
  const sell = (q: number): Leg | null => {
    const id = at();
    const s = core.sell(id, q);
    return s && sideLeg(id, 'sell', s, taxRate);
  };
  return { buy, sell };
}

/**
 * Plan the bazaar flip of one product with the current settings (no profit filter). null if a side can't be quoted.
 * `_p` is kept for older callers: the product is read from ctx.snap.
 */
export function planFlip(id: string, _p: Product, ctx: CalcCtx): TradePlan | null {
  const { buy, sell } = flipLegs(ctx, () => id);
  return planTrade(buy, sell, ctx.settings);
}

/** All bazaar flips with profit > 0 (suspect rows included; views filter). */
export function computeFlips(ctx: CalcCtx): FlipRow[] {
  const { snap, catalog, settings } = ctx;
  const core = coreOf(ctx);
  const rows: FlipRow[] = [];
  const use = { buy: settings.costMode, sell: settings.sellMode };
  let id = '';
  const { buy, sell } = flipLegs(ctx, () => id);
  for (const [pid, p] of Object.entries(snap.products)) {
    id = pid;
    const plan = planTrade(buy, sell, settings);
    if (!plan || !(plan.profit > 0) || !(plan.buy.price > 0)) continue;
    const row: FlipRow = {
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
      risk: core.risk(id, use)!,
    };
    if (plan.buy.clamped) row.buyClamped = plan.buy.clamped;
    const cons = mergeCons(plan.buy.cons, plan.sell.cons);
    if (cons) row.cons = cons;
    const pi = tradePlanInputs(buy, sell, settings);
    if (pi) row.plan = pi;
    rows.push(row);
  }
  return rows;
}
