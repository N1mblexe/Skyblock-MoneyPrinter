import type { CalcCtx, FusionRecipe, FusionRow, RiskReport } from '../types/contracts.ts';
import { afterTax, buySide, sellSide, throughput } from './pricing.ts';
import { assessRisk, combineRisk } from './risk.ts';
import { resolveUserInput } from './search.ts';

const cleanQty = (qty: number) => (Number.isFinite(qty) ? Math.max(0, qty) : 0);

/**
 * One row per recipe, same order. Inputs resolved via resolveUserInput.
 * Throughput treats a fusion like a craft with two inputs: buy-side rates per input (qty merged when a and b are the
 * same item) and the output's sell-side rate, per fusion. Risk combines all three products' markets.
 */
export function computeFusion(ctx: CalcCtx, recipes: readonly FusionRecipe[]): FusionRow[] {
  const { snap, catalog, settings } = ctx;
  const { costMode, sellMode, share, taxRate } = settings;
  // built once per call, shared by every recipe
  const ids = new Set(Object.keys(snap.products));
  for (const i of Object.values(catalog.items)) if (i.bazaar) ids.add(i.id);
  const riskMemo = new Map<string, RiskReport>();
  const productRisk = (id: string) => {
    let r = riskMemo.get(id);
    if (!r) riskMemo.set(id, (r = assessRisk(snap.products[id]!, ctx.stats?.(id) ?? null)));
    return r;
  };

  return recipes.map((recipe) => {
    const missing: string[] = [];
    const risks: RiskReport[] = [];
    /** per resolved input id: qty per fusion and your buy rate (units/hour) */
    const buys = new Map<string, { qty: number; rate: number; depth?: number; order: boolean }>();
    let rSell = 0;
    let sellDepth: number | undefined;
    const qo = cleanQty(recipe.qo);

    const price = (text: string, qtyIn: number, side: 'buy' | 'sell'): number | null => {
      const id = resolveUserInput(catalog, text, ids);
      const p = id ? snap.products[id] : undefined;
      const s = p ? (side === 'buy' ? buySide(p, costMode, share, undefined, catalog.items[id!]?.npcSell) : sellSide(p, sellMode, share)) : null;
      if (!s || !Number.isFinite(s.quote.price)) {
        missing.push(id ?? text.trim());
        return null;
      }
      risks.push(productRisk(id!));
      const qty = cleanQty(qtyIn);
      if (side === 'buy') {
        const b = buys.get(id!) ?? { qty: 0, rate: s.rate, depth: s.depth, order: s.quote.source === 'order' };
        b.qty += qty;
        buys.set(id!, b);
        return qty * s.quote.price;
      }
      rSell = qo > 0 ? s.rate / qo : Infinity;
      if (s.depth != null && qo > 0) sellDepth = s.depth / qo;
      return qty * afterTax(s.quote.price, taxRate);
    };
    const ca = price(recipe.a, recipe.qa, 'buy');
    const cb = price(recipe.b, recipe.qb, 'buy');
    const value = price(recipe.out, recipe.qo, 'sell');
    const cost = ca != null && cb != null ? ca + cb : null;
    const profit = cost != null && value != null ? value - cost : null;
    const margin = profit != null && cost != null && cost > 0 && missing.length === 0 ? profit / cost : null;
    const row: FusionRow = { recipe, cost, value, profit, margin, missing };
    if (risks.length > 0) row.risk = combineRisk(risks);
    if (profit != null && missing.length === 0) {
      let rBuy = Infinity;
      let depthCap: number | undefined;
      const orderUnits: number[] = [];
      for (const b of buys.values()) {
        if (!(b.qty > 0)) continue;
        rBuy = Math.min(rBuy, b.rate / b.qty);
        if (b.depth != null) depthCap = Math.min(depthCap ?? Infinity, b.depth / b.qty);
        if (b.order) orderUnits.push(b.qty);
      }
      if (sellDepth != null) depthCap = Math.min(depthCap ?? Infinity, sellDepth);
      if (sellMode === 'offer' && qo > 0) orderUnits.push(qo);
      row.tp = throughput({
        rBuy,
        rSell,
        unitCost: cost!,
        capital: settings.capital,
        cycleHours: settings.cycleHours,
        depthCap,
        fillModel: settings.fillModel,
        orderSlots: settings.orderSlots,
        orderUnits,
      });
      row.profitPerHour = row.tp.unitsPerHour * profit;
    }
    return row;
  });
}
