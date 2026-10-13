import type { CalcCtx, FusionRecipe, FusionRow } from '../types/contracts.ts';
import { afterTax, buyQuote, sellQuote } from './pricing.ts';
import { resolveUserInput } from './search.ts';

/** One row per recipe, same order. Inputs resolved via resolveUserInput. */
export function computeFusion(ctx: CalcCtx, recipes: readonly FusionRecipe[]): FusionRow[] {
  const { snap, catalog, settings } = ctx;
  const ids = new Set(Object.keys(snap.products));
  for (const i of Object.values(catalog.items)) if (i.bazaar) ids.add(i.id);

  return recipes.map((recipe) => {
    const missing: string[] = [];
    const price = (text: string, qty: number, side: 'buy' | 'sell'): number | null => {
      const id = resolveUserInput(catalog, text, ids);
      const p = id ? snap.products[id] : undefined;
      const q = p ? (side === 'buy' ? buyQuote(p, settings.costMode, undefined, id ? catalog.items[id]?.npcSell : undefined) : sellQuote(p, settings.sellMode)) : null;
      if (!q || !Number.isFinite(q.price)) {
        missing.push(id ?? text.trim());
        return null;
      }
      const unit = side === 'buy' ? q.price : afterTax(q.price, settings.taxRate);
      return (Number.isFinite(qty) ? Math.max(0, qty) : 0) * unit;
    };
    const ca = price(recipe.a, recipe.qa, 'buy');
    const cb = price(recipe.b, recipe.qb, 'buy');
    const value = price(recipe.out, recipe.qo, 'sell');
    const cost = ca != null && cb != null ? ca + cb : null;
    const profit = cost != null && value != null ? value - cost : null;
    const margin = profit != null && cost != null && cost > 0 && missing.length === 0 ? profit / cost : null;
    return { recipe, cost, value, profit, margin, missing };
  });
}
