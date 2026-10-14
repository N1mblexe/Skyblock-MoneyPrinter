import { AH, CRAFT_RECURSION_DEPTH } from '../config.ts';
import type { CalcCtx, CraftRow, IngredientLine, Product, QuoteSource, Recipe, RiskReport } from '../types/contracts.ts';
import { bookUnits } from './book.ts';
import { afterTax, buyQuote, buySide, npcBuyRate, sellQuote, sellSide, throughput, type SideBound } from './pricing.ts';
import { assessRisk, combineRisk, reportFromFlags } from './risk.ts';

interface Resolved {
  unit: number;
  source: QuoteSource;
  /** units/hour you can obtain this way (bazaar fill rate, NPC daily limit, or sub-recipe inputs) */
  rate: number;
  /** what limits `rate`: market volume or an NPC shop's daily limit (the sub-recipe's bottleneck for crafts) */
  bound: SideBound;
  /** units resting on bazaar buy orders per unit obtained (1 for 'order', summed over sub-recipe inputs for 'craft') */
  orderUnits: number;
  viaRecipe?: string;
}

/** Ingredient flags that matter even when buying by order (dead bids etc. are normal on raw materials). */
const INGREDIENT_FLAGS = new Set(['PRICE_SPIKE', 'QUICK_DIVERGENCE']);

/**
 * Every catalog recipe, priced (unpriced rows included with unpriced[] set).
 * Bazaar outputs are valued at the better of bazaar (after tax) and NPC sell; outputs that are not bazaar products
 * (`outputOffBazaar`) at NPC sell, else the AH lowest BIN (`ctx.ah`), else they are unpriced.
 * In insta modes, direct bazaar ingredients and the output are re-quoted once at the planned batch size.
 */
export function computeCrafts(ctx: CalcCtx): CraftRow[] {
  const { snap, catalog, settings } = ctx;
  const { costMode, sellMode, share, taxRate } = settings;
  const npcRate = npcBuyRate(settings.npcDailyLimit);

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
    if (q && q.price > 0 && Number.isFinite(q.price))
      best = { unit: q.price, source: q.source, rate: side.rate, bound: 'volume', orderUnits: q.source === 'order' ? 1 : 0 };
    const nb = catalog.items[id]?.npcBuy;
    if (nb != null && nb > 0 && (!best || nb < best.unit)) best = { unit: nb, source: 'npc', rate: npcRate, bound: 'npcLimit', orderUnits: 0 };
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
        let bound: SideBound = 'volume';
        let orderUnits = 0;
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
          orderUnits += inp.qty * sub.res.orderUnits;
          const rIn = inp.qty > 0 ? sub.res.rate / inp.qty : Infinity;
          if (rIn < rate) {
            rate = rIn;
            bound = sub.res.bound;
          }
        }
        const unit = sum / r.outCount;
        if (ok && unit > 0 && Number.isFinite(unit) && (!c || unit < c.unit))
          c = { unit, source: 'craft', rate: rate * r.outCount, bound, orderUnits: orderUnits / r.outCount, viaRecipe: r.key };
      }
      visited.delete(id);
      if (!cut) craftMemo.set(key, c);
    }
    return { res: c && (!d || c.unit < d.unit) ? c : d, cut };
  };

  return catalog.recipes.map(priceRecipe);

  function priceRecipe(recipe: Recipe): CraftRow {
    const unpriced: string[] = [];
    const lines: IngredientLine[] = [];
    const risks: RiskReport[] = [];
    /** per line: units on buy orders per craft, and what limits the line's rate */
    const lineOrderUnits: number[] = [];
    const lineBounds: SideBound[] = [];
    /** direct insta-bought lines, re-quoted at batch size in the refine pass */
    const instaLines: { line: IngredientLine; p: Product }[] = [];
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
      lineOrderUnits.push(res ? inp.qty * res.orderUnits : 0);
      lineBounds.push(res?.bound ?? 'volume');
      if (!res) {
        unpriced.push(inp.id);
      } else {
        line.unit = res.unit;
        line.total = res.unit * inp.qty;
        line.source = res.source;
        if (res.viaRecipe) line.viaRecipe = res.viaRecipe;
        line.craftsPerHour = inp.qty > 0 ? res.rate / inp.qty : Infinity;
        const p = snap.products[inp.id];
        if ((res.source === 'order' || res.source === 'insta') && p) {
          if (res.source === 'insta' && inp.qty > 0) {
            capDepth(bookUnits(p.asks) / inp.qty);
            instaLines.push({ line, p });
          }
          const r = productRisk(inp.id);
          if (r) risks.push(reportFromFlags(r.flags.filter((f) => INGREDIENT_FLAGS.has(f))));
        }
      }
      lines.push(line);
    }
    let cost = lines.reduce((s, l) => s + l.total, 0);

    // Output value. Bazaar output: best of bazaar (after tax) and NPC sell. Off-bazaar: NPC sell, else AH lowest BIN.
    const out = recipe.output;
    const outputOffBazaar = !catalog.items[out]?.bazaar;
    const outP = outputOffBazaar ? undefined : snap.products[out];
    const sq = outP ? sellQuote(outP, sellMode) : null;
    const bzVal = sq && Number.isFinite(sq.price) ? recipe.outCount * afterTax(sq.price, taxRate) : null;
    const ns = catalog.items[out]?.npcSell;
    const npcVal = ns != null && ns > 0 ? recipe.outCount * ns : null;
    const ah = outputOffBazaar && npcVal == null ? ctx.ah?.(out) : null;
    const ahVal = ah && ah.price > 0 && Number.isFinite(ah.price) ? recipe.outCount * ah.price : null;
    let value = 0;
    let valueSource: CraftRow['valueSource'] = 'bazaar';
    // NPC and AH sales are not bound by bazaar volume: only the inputs / forge limit the rate.
    let outCraftsPerHour = Infinity;
    let outOrderUnits = 0;
    if (bzVal != null && (npcVal == null || bzVal >= npcVal)) {
      value = bzVal;
      const side = sellSide(outP!, sellMode, share);
      outCraftsPerHour = side && recipe.outCount > 0 ? side.rate / recipe.outCount : 0;
      if (sellMode === 'insta' && recipe.outCount > 0) capDepth(bookUnits(outP!.bids) / recipe.outCount);
      if (sellMode === 'offer') outOrderUnits = recipe.outCount;
      const outRisk = productRisk(out);
      if (outRisk) risks.unshift(outRisk);
    } else if (npcVal != null) {
      // Sold to an NPC: the output's bazaar market (and its risk) does not matter.
      value = npcVal;
      valueSource = 'npc';
    } else if (ahVal != null) {
      // TODO: AH listing/claim tax is not modelled; the lowest BIN is taken as the sale price.
      value = ahVal;
      valueSource = 'ah';
      // TODO(lead): use an 'AH_THIN' risk flag once contracts have one; LOW_VOLUME stands in for it.
      if (ah!.count < AH.minCount) risks.unshift(reportFromFlags(['LOW_VOLUME']));
    } else {
      unpriced.push(out);
      outCraftsPerHour = 0;
      const outRisk = productRisk(out);
      if (outRisk) risks.unshift(outRisk);
    }

    // Bottleneck ingredient.
    let inCraftsPerHour = Infinity;
    let bottleneck = -1;
    lines.forEach((l, i) => {
      if (l.craftsPerHour < inCraftsPerHour) {
        inCraftsPerHour = l.craftsPerHour;
        bottleneck = i;
      }
    });
    if (bottleneck >= 0 && Number.isFinite(inCraftsPerHour)) lines[bottleneck]!.bottleneck = true;

    const isUnpriced = unpriced.length > 0;
    if (isUnpriced) {
      cost = 0;
      value = 0;
    }
    const forgeCap =
      recipe.kind === 'forge' && recipe.durationSec != null && recipe.durationSec > 0
        ? (Math.max(0, settings.forgeSlots) * 3600) / recipe.durationSec
        : undefined;
    const orderUnits = [...lineOrderUnits, outOrderUnits].filter((u) => u > 0);
    const tpFor = (unitCost: number) =>
      throughput({
        rBuy: inCraftsPerHour,
        rSell: outCraftsPerHour,
        unitCost,
        capital: settings.capital,
        cycleHours: settings.cycleHours,
        depthCap,
        forgeCap,
        fillModel: settings.fillModel,
        orderSlots: settings.orderSlots,
        orderUnits,
        buyBound: bottleneck >= 0 ? lineBounds[bottleneck] : 'volume',
      });
    let tp = tpFor(cost);

    // Refine (one pass): re-quote insta legs at the planned batch size so VWAP slippage shows in cost/value.
    const refineOut = sellMode === 'insta' && valueSource === 'bazaar';
    if (!isUnpriced && tp.batchQty > 0 && (instaLines.length > 0 || refineOut)) {
      const crafts = Math.max(1, Math.ceil(tp.batchQty));
      for (const { line, p } of instaLines) {
        const q = buyQuote(p, 'insta', line.qty * crafts)!;
        line.unit = q.price;
        line.total = q.price * line.qty;
      }
      cost = lines.reduce((s, l) => s + l.total, 0);
      if (refineOut) value = recipe.outCount * afterTax(sellQuote(outP!, 'insta', recipe.outCount * crafts)!.price, taxRate);
      tp = tpFor(cost);
    }

    const profit = value - cost;
    const row: CraftRow = {
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
    if (outputOffBazaar) row.outputOffBazaar = true;
    return row;
  }
}
