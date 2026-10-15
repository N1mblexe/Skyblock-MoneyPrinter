// Craft chains: ladders of recipes where each step's main input is the previous tier
// (Wheat -> Enchanted Wheat -> Enchanted Hay Bale, Rough -> Flawed -> Fine -> Flawless gems, ...).
// A move buys one tier and crafts up two or more steps; it is priced as one synthetic recipe by the craft pricer, so
// sourcing of side ingredients, output valuation, insta refinement, order slots and risk match the Craft view.
import { CHAIN } from '../config.ts';
import type { CalcCtx, Catalog, ChainRow, CraftRow, Recipe } from '../types/contracts.ts';
import { createCraftPricer, type CraftPricer } from './craft.ts';
import { afterTax, buySide, sellQuote } from './pricing.ts';

/** One chain step: `recipe` turns `mainQty` × `from` (plus side inputs) into `recipe.outCount` × `to`. */
export interface ChainStep {
  from: string;
  to: string;
  recipe: Recipe;
  mainQty: number;
}

export interface ChainGraph {
  /** from -> steps leaving it (one per distinct `to`) */
  next: Map<string, ChainStep[]>;
  /** full ladders, root to top; a branching tier yields one ladder per branch */
  ladders: string[][];
}

/** The step a recipe forms, or null when it is not a chain step (see CHAIN in config). */
export function chainStep(r: Recipe, catalog: Catalog): ChainStep | null {
  if (r.kind !== 'craft' || !(r.outCount > 0) || !catalog.items[r.output]?.bazaar || r.inputs.length === 0) return null;
  const total = r.inputs.reduce((s, i) => s + i.qty, 0);
  let main = r.inputs[0]!;
  for (const i of r.inputs) if (i.qty > main.qty) main = i;
  if (main.id === r.output || !catalog.items[main.id]?.bazaar) return null;
  if (!(total > 0) || main.qty / total < CHAIN.mainShare || !(main.qty / r.outCount > 1)) return null;
  return { from: main.id, to: r.output, recipe: r, mainQty: main.qty };
}

/** Prefer fewer side ingredients, then fewer main units per output; recipe key breaks ties. */
const better = (a: ChainStep, b: ChainStep) =>
  a.recipe.inputs.length - b.recipe.inputs.length || a.mainQty / a.recipe.outCount - b.mainQty / b.recipe.outCount || (a.recipe.key < b.recipe.key ? -1 : 1);

const graphs = new WeakMap<Catalog, ChainGraph>();

/** Chain steps and ladders of a catalog (memoised per catalog object). */
export function chainGraph(catalog: Catalog): ChainGraph {
  const hit = graphs.get(catalog);
  if (hit) return hit;
  const pick = new Map<string, ChainStep>();
  for (const r of catalog.recipes) {
    const s = chainStep(r, catalog);
    if (!s) continue;
    const k = `${s.from}>${s.to}`;
    const cur = pick.get(k);
    if (!cur || better(s, cur) < 0) pick.set(k, s);
  }
  const next = new Map<string, ChainStep[]>();
  const hasIn = new Set<string>();
  for (const s of [...pick.values()].sort((a, b) => (a.to < b.to ? -1 : 1))) {
    (next.get(s.from) ?? next.set(s.from, []).get(s.from)!).push(s);
    hasIn.add(s.to);
  }
  const ladders: string[][] = [];
  const walk = (path: string[]) => {
    const out = (next.get(path.at(-1)!) ?? []).filter((s) => !path.includes(s.to));
    if (!out.length) {
      if (path.length > 1) ladders.push(path);
      return;
    }
    for (const s of out) walk([...path, s.to]);
  };
  for (const root of [...next.keys()].filter((id) => !hasIn.has(id)).sort()) walk([root]);
  const g = { next, ladders };
  graphs.set(catalog, g);
  return g;
}

const stepOf = (g: ChainGraph, from: string, to: string): ChainStep => g.next.get(from)!.find((s) => s.to === to)!;

/**
 * The move along `path` as one recipe: N × path[0] plus every step's side inputs -> 1 × path[last].
 * Walks top-down: crafts at a step = units needed of its output / outCount.
 */
export function moveRecipe(g: ChainGraph, path: readonly string[]): { recipe: Recipe; needFrom: number } {
  let need = 1;
  const sides = new Map<string, number>();
  for (let k = path.length - 2; k >= 0; k--) {
    const st = stepOf(g, path[k]!, path[k + 1]!);
    const crafts = need / st.recipe.outCount;
    let main = 0;
    for (const i of st.recipe.inputs) {
      if (i.id === st.from && main === 0) main = crafts * i.qty;
      else sides.set(i.id, (sides.get(i.id) ?? 0) + crafts * i.qty);
    }
    need = main;
  }
  const from = path[0]!;
  const inputs = [{ id: from, qty: need + (sides.get(from) ?? 0) }, ...[...sides].filter(([id]) => id !== from).map(([id, qty]) => ({ id, qty }))];
  return { recipe: { key: `chain:${path.join('>')}`, output: path.at(-1)!, outCount: 1, inputs, kind: 'craft' }, needFrom: need };
}

/** Where a move buys its first tier: the bazaar only, or the cheaper of bazaar and NPC shop. */
export type ChainStart = 'bazaar' | 'cheapest';

/** Price one path with a shared pricer; the first tier is bought (per `start`), never sub-crafted. */
export function priceMove(
  pricer: CraftPricer,
  g: ChainGraph,
  path: readonly string[],
  start: ChainStart = 'bazaar',
): { row: CraftRow; needFrom: number } {
  const { recipe, needFrom } = moveRecipe(g, path);
  const first = new Set([path[0]!]);
  return { row: pricer.price(recipe, start === 'bazaar' ? { bazaarIds: first } : { directIds: first }), needFrom };
}

/**
 * Every move of at least CHAIN.minSteps steps on every ladder, priced (unpriced rows included, like crafts).
 * By default the first tier is bought on the bazaar: NPC shops are often cheaper per unit, but their daily limit
 * makes long ladders (25,600 Wheat per Enchanted Hay Bale) look useless.
 */
export function computeChains(ctx: CalcCtx, start: ChainStart = 'bazaar'): ChainRow[] {
  const g = chainGraph(ctx.catalog);
  const pricer = createCraftPricer(ctx);
  const moves = new Map<string, { path: string[]; ladders: string[] }>();
  for (const ladder of g.ladders) {
    const lk = ladder.join('>');
    for (let i = 0; i < ladder.length; i++) {
      for (let j = i + CHAIN.minSteps; j < ladder.length; j++) {
        const path = ladder.slice(i, j + 1);
        const k = path.join('>');
        const m = moves.get(k);
        if (m) m.ladders.push(lk);
        else moves.set(k, { path, ladders: [lk] });
      }
    }
  }
  return [...moves].map(([key, { path, ladders }]) => {
    const { row, needFrom } = priceMove(pricer, g, path, start);
    return { key, path, fromId: path[0]!, toId: path.at(-1)!, steps: path.length - 1, needFrom, ladders, row };
  });
}

/** Keys of the best move (profit/hour, priced and positive) on each ladder. */
export function bestPerLadder(rows: readonly ChainRow[]): Set<string> {
  const best = new Map<string, ChainRow>();
  for (const r of rows) {
    if (r.row.unpriced.length || !(r.row.profitPerHour > 0)) continue;
    for (const l of r.ladders) {
      const b = best.get(l);
      if (!b || r.row.profitPerHour > b.row.profitPerHour) best.set(l, r);
    }
  }
  return new Set([...best.values()].map((r) => r.key));
}

export interface LadderTier {
  id: string;
  name: string;
  /** units of the start tier inside one unit of this tier (1 for the start) */
  need: number;
  /** price to buy one unit now (cost mode), null when not buyable */
  buyUnit: number | null;
  /** what one unit sells for after tax (sell mode; NPC sell when higher), null when unsellable */
  sellNet: number | null;
  /** the move start -> this tier (null for the start tier itself) */
  move: CraftRow | null;
}

/** Each tier of `ladder` seen from the tier at `fromIndex`: unit prices and the move that ends there. */
export function ladderDetail(ctx: CalcCtx, ladder: readonly string[], fromIndex: number, start: ChainStart = 'bazaar'): LadderTier[] {
  const { snap, catalog, settings } = ctx;
  const g = chainGraph(catalog);
  const pricer = createCraftPricer(ctx);
  return ladder.map((id, i) => {
    const p = snap.products[id];
    const npcSell = catalog.items[id]?.npcSell;
    const bq = p ? buySide(p, settings.costMode, settings.share, undefined, npcSell)?.quote : null;
    const npcBuy = catalog.items[id]?.npcBuy;
    const buys = [bq && Number.isFinite(bq.price) && bq.price > 0 ? bq.price : null, npcBuy != null && npcBuy > 0 ? npcBuy : null].filter((x): x is number => x != null);
    const sq = p ? sellQuote(p, settings.sellMode) : null;
    const sells = [sq && Number.isFinite(sq.price) ? afterTax(sq.price, settings.taxRate) : null, npcSell != null && npcSell > 0 ? npcSell : null].filter((x): x is number => x != null);
    const priced = i > fromIndex ? priceMove(pricer, g, ladder.slice(fromIndex, i + 1), start) : null;
    return {
      id,
      name: catalog.name(id),
      need: priced ? priced.needFrom : i === fromIndex ? 1 : 0,
      buyUnit: buys.length ? Math.min(...buys) : null,
      sellNet: sells.length ? Math.max(...sells) : null,
      move: priced?.row ?? null,
    };
  });
}
