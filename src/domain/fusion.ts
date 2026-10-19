import { FUSION_FEE_COINS } from '../config.ts';
import type { CalcCtx, FusionRecipe, FusionRow, RiskReport } from '../types/contracts.ts';
import { coreOf } from './market.ts';
import { afterTax, throughput, type RateCap } from './pricing.ts';
import { combineRisk } from './risk.ts';
import { resolveUserInput } from './search.ts';

const cleanQty = (qty: number) => (Number.isFinite(qty) ? Math.max(0, qty) : 0);

/** One resolved input of a fusion (qty merged when a and b are the same item). */
interface FusionBuy {
  id: string;
  qty: number;
  /** per item */
  unit: number;
  /** bazaar: your buy rate (units/hour); npc: the shop's hourly cap */
  rate: number;
  npc: boolean;
  /** insta-bought (re-quoted at the batch size) */
  insta: boolean;
  order: boolean;
  depth?: number;
}

/**
 * One row per recipe, same order. Inputs resolved via resolveUserInput; each is bought at the cheaper of the bazaar
 * (in the cost mode, through the market core) and an NPC shop (instant, capped at npcDailyLimit / 24 per hour).
 * Throughput treats a fusion like a craft with two inputs: buy-side rates per input (qty merged when a and b are the
 * same item) and the output's sell-side rate, per fusion. Insta legs are re-quoted once at the batch size.
 * Risk is side-aware: the buy side of bazaar-bought inputs and the sell side of the output.
 */
export function computeFusion(ctx: CalcCtx, recipes: readonly FusionRecipe[]): FusionRow[] {
  const { snap, catalog, settings } = ctx;
  const { costMode, sellMode, taxRate } = settings;
  const core = coreOf(ctx);
  // built once per call, shared by every recipe: outputs sell on the bazaar, inputs may also come from an NPC shop
  const ids = new Set(Object.keys(snap.products));
  for (const i of Object.values(catalog.items)) if (i.bazaar) ids.add(i.id);
  const inputIds = new Set(ids);
  for (const i of Object.values(catalog.items)) if (i.npcBuy != null && i.npcBuy > 0) inputIds.add(i.id);

  return recipes.map((recipe) => {
    const missing: string[] = [];
    const risks: RiskReport[] = [];
    const buys = new Map<string, FusionBuy>();
    const qo = cleanQty(recipe.qo);
    let outId: string | null = null;
    let sellUnit = 0;
    let rSell = 0;
    let sellDepth: number | undefined;
    let sellInsta = false;
    let sellOrder = false;

    const buyInput = (text: string, qtyIn: number): number | null => {
      const id = resolveUserInput(catalog, text, inputIds);
      const bz = id ? core.buy(id) : null;
      const bzOk = bz != null && bz.quote.price > 0 && Number.isFinite(bz.quote.price);
      const npc = id ? core.npcBuy(id) : null;
      if (!id || (!bzOk && !npc)) {
        missing.push(id ?? text.trim());
        return null;
      }
      const qty = cleanQty(qtyIn);
      let b = buys.get(id);
      if (!b) {
        if (npc && (!bzOk || npc.price < bz!.quote.price)) {
          b = { id, qty: 0, unit: npc.price, rate: npc.rate, npc: true, insta: false, order: false };
        } else {
          const r = core.risk(id, { buy: costMode });
          if (r) risks.push(r);
          b = { id, qty: 0, unit: bz!.quote.price, rate: bz!.rate, npc: false, insta: bz!.quote.source === 'insta', order: bz!.quote.source === 'order' };
          if (bz!.depth != null) b.depth = bz!.depth;
        }
        buys.set(id, b);
      }
      b.qty += qty;
      return qty * b.unit;
    };

    const sellOutput = (text: string): number | null => {
      const id = resolveUserInput(catalog, text, ids);
      const s = id ? core.sell(id) : null;
      if (!s || !Number.isFinite(s.quote.price)) {
        missing.push(id ?? text.trim());
        return null;
      }
      const r = core.risk(id!, { sell: sellMode });
      if (r) risks.push(r);
      outId = id;
      sellUnit = afterTax(s.quote.price, taxRate);
      rSell = qo > 0 ? s.rate / qo : Infinity;
      if (s.depth != null && qo > 0) sellDepth = s.depth / qo;
      sellInsta = s.quote.source === 'insta';
      sellOrder = s.quote.source === 'order';
      return qo * sellUnit;
    };

    const ca = buyInput(recipe.a, recipe.qa);
    const cb = buyInput(recipe.b, recipe.qb);
    let value = sellOutput(recipe.out);
    let cost = ca != null && cb != null ? ca + cb + FUSION_FEE_COINS : null;
    const row: FusionRow = { recipe, cost, value, profit: null, margin: null, missing };
    if (risks.length > 0) row.risk = combineRisk(risks);
    if (cost == null || value == null || missing.length > 0) {
      row.profit = cost != null && value != null ? value - cost : null;
      return row;
    }

    const lines = [...buys.values()].filter((b) => b.qty > 0);
    const tpFor = (unitCost: number) => {
      let rBuy = Infinity;
      let depthCap: number | undefined;
      const caps: RateCap[] = [];
      const orderUnits: number[] = [];
      for (const b of lines) {
        if (b.npc) caps.push({ perHour: b.rate / b.qty, bound: 'npcLimit' });
        else rBuy = Math.min(rBuy, b.rate / b.qty);
        if (b.depth != null) depthCap = Math.min(depthCap ?? Infinity, b.depth / b.qty);
        if (b.order) orderUnits.push(b.qty);
      }
      if (sellDepth != null) depthCap = Math.min(depthCap ?? Infinity, sellDepth);
      if (sellOrder && qo > 0) orderUnits.push(qo);
      return throughput({
        rBuy,
        rSell,
        unitCost,
        capital: settings.capital,
        cycleHours: settings.cycleHours,
        depthCap,
        fillModel: settings.fillModel,
        orderSlots: settings.orderSlots,
        orderUnits,
        caps,
      });
    };
    let tp = tpFor(cost);

    // Refine (one pass): re-quote insta legs at the planned batch size so VWAP slippage shows in cost and value.
    const instaLines = lines.filter((b) => b.insta);
    if (tp.batchQty > 1 && value - cost > 0 && (instaLines.length > 0 || sellInsta)) {
      const n = Math.ceil(tp.batchQty);
      for (const b of instaLines) {
        const q = core.buy(b.id, b.qty * n);
        if (q) b.unit = q.quote.price;
      }
      const s = sellInsta && outId ? core.sell(outId, qo * n) : null;
      if (s) sellUnit = afterTax(s.quote.price, taxRate);
      cost = lines.reduce((sum, b) => sum + b.qty * b.unit, 0) + FUSION_FEE_COINS;
      value = qo * sellUnit;
      tp = tpFor(cost);
    }

    const profit = value - cost;
    row.cost = cost;
    row.value = value;
    row.profit = profit;
    row.margin = cost > 0 ? profit / cost : null;
    row.tp = tp;
    row.profitPerHour = tp.unitsPerHour * profit;
    return row;
  });
}
