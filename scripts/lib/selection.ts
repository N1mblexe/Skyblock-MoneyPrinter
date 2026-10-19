// Which recipes go into the catalog (pure; used by scripts/build-data.ts).
import type { CatalogRecipeEntry } from '../../src/types/contracts.ts';

type Rec = Pick<CatalogRecipeEntry, 'o' | 'i' | 'k'>;

/**
 * `priceable(id)`: `direct(id)`, or some recipe of `id` (from `recipesFor`) whose inputs are all priceable one level
 * deeper, at most `maxDepth` levels of sub-crafting (the depth rule of craft.ts `resolve`; recipes of every kind count,
 * as the wave 2 pricer sub-crafts forge and shop recipes too). A sub-recipe input that
 * is already on the path (`blocked`, e.g. the top recipe's output, or an id being resolved) fails that recipe, like
 * the runtime's cycle guard; results a cycle cut are not memoized.
 */
export function makePriceable(
  direct: (id: string) => boolean,
  recipesFor: (id: string) => readonly Rec[],
  maxDepth: number,
): (id: string, blocked?: ReadonlySet<string>) => boolean {
  const memo = new Map<string, boolean>();
  const walk = (id: string, depth: number, stack: Set<string>): { ok: boolean; cut: boolean } => {
    if (direct(id)) return { ok: true, cut: false };
    if (depth >= maxDepth) return { ok: false, cut: false };
    const mk = `${id}@${depth}`;
    const m = memo.get(mk);
    if (m !== undefined) return { ok: m, cut: false };
    stack.add(id);
    let ok = false;
    let cut = false;
    for (const r of recipesFor(id)) {
      let all = true;
      for (const [x] of r.i) {
        if (stack.has(x)) {
          cut = true;
          all = false;
          break;
        }
        const s = walk(x, depth + 1, stack);
        if (s.cut) cut = true;
        if (!s.ok) {
          all = false;
          break;
        }
      }
      if (all) {
        ok = true;
        break;
      }
    }
    stack.delete(id);
    if (!cut) memo.set(mk, ok);
    return { ok, cut };
  };
  return (id, blocked) => walk(id, 0, new Set(blocked)).ok;
}

export interface SelectOptions {
  /** bazaar product */
  bazaar(id: string): boolean;
  /** NPC sell price > 0 */
  npcSellable(id: string): boolean;
  /** can go on the AH: items API flags, bits-rules, minus untradeable */
  auctionable(id: string): boolean;
  /** NPC-buyable for coins (catalog `nb`) */
  npcBuyable(id: string): boolean;
  /** the items API gives it a rarity (`tier`): a SkyBlock item, not a plain vanilla block or dye */
  hasRarity(id: string): boolean;
  /** CRAFT_RECURSION_DEPTH */
  depth: number;
}

export type SelectReason = 'bazaar' | 'forge' | 'shop' | 'ah' | 'subcraft';

/**
 * Catalog recipe selection, first matching rule wins:
 *  - `bazaar`: the output is a bazaar product (any kind);
 *  - `forge`: every forge recipe (the forge view values outputs by NPC sell too);
 *  - `shop`: shop recipes whose output can be sold (bazaar, NPC) or auctioned;
 *  - `ah`: craft recipes for an auctionable non-bazaar output with a rarity (`hasRarity`; vanilla items such as fences
 *    and dyes are not AH goods) whose every input is priceable at runtime: a bazaar product, NPC-buyable, or made by a
 *    recipe of such inputs within `depth` levels (`makePriceable`). AH-priced ingredients do not count: with them the
 *    catalog grows past its 600 KB budget (about 1,630 recipes, 700 KB+);
 *  - `subcraft`: every recipe for an input of an included recipe that is not a bazaar product (NPC-buyable inputs too,
 *    since crafting can be cheaper), breadth first, `depth` levels down.
 */
export function selectRecipes<R extends Rec>(all: readonly R[], opts: SelectOptions): Map<R, SelectReason> {
  const byOut = new Map<string, R[]>();
  for (const r of all) {
    const a = byOut.get(r.o);
    if (a) a.push(r);
    else byOut.set(r.o, [r]);
  }
  const priceable = makePriceable((id) => opts.bazaar(id) || opts.npcBuyable(id), (id) => byOut.get(id) ?? [], opts.depth);
  const out = new Map<R, SelectReason>();
  for (const r of all) {
    if (opts.bazaar(r.o)) out.set(r, 'bazaar');
    else if (r.k === 'forge') out.set(r, 'forge');
    else if (r.k === 'shop') {
      if (opts.npcSellable(r.o) || opts.auctionable(r.o)) out.set(r, 'shop');
    } else if (opts.auctionable(r.o) && opts.hasRarity(r.o) && r.i.every(([x]) => priceable(x, new Set([r.o])))) out.set(r, 'ah');
  }
  let frontier = [...out.keys()];
  const expanded = new Set<string>();
  for (let level = 1; level <= opts.depth && frontier.length; level++) {
    const next: R[] = [];
    for (const r of frontier) {
      for (const [id] of r.i) {
        if (opts.bazaar(id) || expanded.has(id)) continue;
        expanded.add(id);
        for (const sub of byOut.get(id) ?? []) {
          if (out.has(sub)) continue;
          out.set(sub, 'subcraft');
          next.push(sub);
        }
      }
    }
    frontier = next;
  }
  return out;
}
