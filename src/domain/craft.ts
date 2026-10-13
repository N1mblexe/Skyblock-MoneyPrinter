import { CRAFT_RECURSION_DEPTH, NPC_BUY_RATE_PER_HOUR } from '../config.ts';
import type { CalcCtx, CraftRow, IngredientLine, QuoteSource, Recipe, RiskReport } from '../types/contracts.ts';
import { bookUnits } from './book.ts';
import { afterTax, buySide, sellQuote, sellSide, throughput } from './pricing.ts';
import { assessRisk, combineRisk, reportFromFlags } from './risk.ts';

interface Resolved {
  unit: number;
  source: QuoteSource;
  /** units/hour you can obtain this way (bazaar fill rate, NPC daily limit, or sub-recipe inputs) */
  rate: number;
  viaRecipe?: string;
}

/** Ingredient flags that matter even when buying by order (dead bids etc. are normal on raw materials). */
const INGREDIENT_FLAGS = new Set(['PRICE_SPIKE', 'QUICK_DIVERGENCE']);

/** Every catalog recipe whose output is a bazaar product, priced (unpriced rows included with unpriced[] set). */
export function computeCrafts(ctx: CalcCtx): CraftRow[] {
  const { snap, catalog, settings } = ctx;
  const { costMode, sellMode, share, taxRate } = settings;

  const directMemo = new Map<string, Resolved | null>();
  const craftMemo = new Map<string, Resolved | null>();
  const riskMemo = new Map<string, RiskReport>();

  const productRisk = (id: string): RiskReport | null => {
    const p = snap.products[id];
    if (!p) return null;
    let r = riskMemo.get(id);
    if (!r) riskMemo.set(id, (r = assessRisk(p, ctx.stats?.(id) ?? null)));
    return r;
  };

  /** Cheapest of bazaar buy quote and NPC buy price. */
  const direct = (id: string): Resolved | null => {
    if (directMemo.has(id)) return directMemo.get(id)!;
    let best: Resolved | null = null;
    const p = snap.products[id];
    const side = p ? buySide(p, costMode, share, undefined, catalog.items[id]?.npcSell) : null;
    const q = side?.quote;
    if (q && q.price > 0 && Number.isFinite(q.price)) best = { unit: q.price, source: q.source, rate: side.rate };
    const nb = catalog.items[id]?.npcBuy;
    if (nb != null && nb > 0 && (!best || nb < best.unit)) best = { unit: nb, source: 'npc', rate: NPC_BUY_RATE_PER_HOUR };
    directMemo.set(id, best);
    return best;
  };

  /**
   * Cheapest way to get one unit of `id`, sub-crafting (kind 'craft' only) up to CRAFT_RECURSION_DEPTH levels deep.
   * `cut` reports whether a cycle guard influenced the result; such results are not memoized.
   */
  const resolve = (id: string, depth: number, visited: Set<string>): { res: Resolved | null; cut: boolean } => {
    const d = direct(id);
    if (depth >= CRAFT_RECURSION_DEPTH) return { res: d, cut: false };
    const key = `${id}|${depth}`;
    let c: Resolved | null = null;
    let cut = false;
    if (craftMemo.has(key)) {
      c = craftMemo.get(key)!;
    } else {
      visited.add(id);
      for (const r of catalog.byOutput.get(id) ?? []) {
        if (r.kind !== 'craft' || !(r.outCount > 0)) continue;
        let sum = 0;
        let rate = Infinity;
        let ok = true;
        for (const inp of r.inputs) {
          if (visited.has(inp.id)) {
            cut = true;
            ok = false;
            break;
          }
          const sub = resolve(inp.id, depth + 1, visited);
          if (sub.cut) cut = true;
          if (!sub.res) {
            ok = false;
            break;
          }
          sum += inp.qty * sub.res.unit;
          rate = Math.min(rate, inp.qty > 0 ? sub.res.rate / inp.qty : Infinity);
        }
        const unit = sum / r.outCount;
        if (ok && unit > 0 && Number.isFinite(unit) && (!c || unit < c.unit))
          c = { unit, source: 'craft', rate: rate * r.outCount, viaRecipe: r.key };
      }
      visited.delete(id);
      if (!cut) craftMemo.set(key, c);
    }
    return { res: c && (!d || c.unit < d.unit) ? c : d, cut };
  };

  const rows: CraftRow[] = [];
  catalog.recipes.forEach((recipe) => {
    if (!catalog.items[recipe.output]?.bazaar) return;
    rows.push(priceRecipe(recipe));
  });
  return rows;

  function priceRecipe(recipe: Recipe): CraftRow {
    const unpriced: string[] = [];
    const lines: IngredientLine[] = [];
    const risks: RiskReport[] = [];
    let cost = 0;
    let depthCap: number | undefined;
    const capDepth = (v: number) => (depthCap = depthCap == null ? v : Math.min(depthCap, v));

    for (const inp of recipe.inputs) {
      const { res } = resolve(inp.id, 0, new Set([recipe.output]));
      const line: IngredientLine = {
        id: inp.id,
        name: catalog.name(inp.id),
        qty: inp.qty,
        unit: 0,
        total: 0,
        source: costMode,
        craftsPerHour: 0,
        bottleneck: false,
      };
      if (!res) {
        unpriced.push(inp.id);
      } else {
        line.unit = res.unit;
        line.total = res.unit * inp.qty;
        line.source = res.source;
        if (res.viaRecipe) line.viaRecipe = res.viaRecipe;
        cost += line.total;
        line.craftsPerHour = inp.qty > 0 ? res.rate / inp.qty : Infinity;
        const p = snap.products[inp.id];
        if ((res.source === 'order' || res.source === 'insta') && p) {
          if (res.source === 'insta' && inp.qty > 0) capDepth(bookUnits(p.asks) / inp.qty);
          const r = productRisk(inp.id);
          if (r) risks.push(reportFromFlags(r.flags.filter((f) => INGREDIENT_FLAGS.has(f))));
        }
      }
      lines.push(line);
    }

    // Output value: best of bazaar (after tax) and NPC sell.
    const out = recipe.output;
    const outP = snap.products[out];
    const sq = outP ? sellQuote(outP, sellMode) : null;
    const bzVal = sq && Number.isFinite(sq.price) ? recipe.outCount * afterTax(sq.price, taxRate) : null;
    const ns = catalog.items[out]?.npcSell;
    const npcVal = ns != null && ns > 0 ? recipe.outCount * ns : null;
    let value = 0;
    let valueSource: CraftRow['valueSource'] = 'bazaar';
    let outCraftsPerHour = 0;
    if (bzVal == null && npcVal == null) {
      unpriced.push(out);
    } else if (bzVal != null && (npcVal == null || bzVal >= npcVal)) {
      value = bzVal;
      const side = sellSide(outP!, sellMode, share);
      outCraftsPerHour = side && recipe.outCount > 0 ? side.rate / recipe.outCount : 0;
      if (sellMode === 'insta' && recipe.outCount > 0) capDepth(bookUnits(outP!.bids) / recipe.outCount);
    } else {
      value = npcVal!;
      valueSource = 'npc';
      outCraftsPerHour = Infinity;
    }
    const outRisk = productRisk(out);
    if (outRisk) risks.unshift(outRisk);

    // Bottleneck ingredient.
    let inCraftsPerHour = Infinity;
    let bottleneck: IngredientLine | null = null;
    for (const l of lines) {
      if (l.craftsPerHour < inCraftsPerHour) {
        inCraftsPerHour = l.craftsPerHour;
        bottleneck = l;
      }
    }
    if (bottleneck && Number.isFinite(inCraftsPerHour)) bottleneck.bottleneck = true;

    const isUnpriced = unpriced.length > 0;
    if (isUnpriced) {
      cost = 0;
      value = 0;
    }
    const forgeCap =
      recipe.kind === 'forge' && recipe.durationSec != null && recipe.durationSec > 0
        ? (Math.max(0, settings.forgeSlots) * 3600) / recipe.durationSec
        : undefined;
    const tp = throughput({
      rBuy: inCraftsPerHour,
      rSell: outCraftsPerHour,
      unitCost: cost,
      capital: settings.capital,
      cycleHours: settings.cycleHours,
      depthCap,
      forgeCap,
    });
    const profit = value - cost;
    return {
      recipe,
      id: out,
      name: catalog.name(out),
      cost,
      value,
      valueSource,
      profit,
      margin: !isUnpriced && cost > 0 ? profit / cost : null,
      outCraftsPerHour,
      inCraftsPerHour,
      tp,
      profitPerHour: isUnpriced ? 0 : tp.unitsPerHour * profit,
      lines,
      risk: combineRisk(risks),
      unpriced,
    };
  }
}
