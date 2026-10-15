// "Sell or craft?": every way to turn items you already own into coins, compared on what you end up with.
// Raw sales: insta-sell (walks the buy orders), sell offer (top of book − 0.1, takes time), NPC, AH (after fees).
// Crafting up: every chain move that starts at the item; your items are free inputs, side ingredients are bought
// (craft pricer), whole crafts only, and the leftover items are sold raw at the best raw unit price.
import type { CalcCtx, CraftRow } from '../types/contracts.ts';
import { walkBook } from './book.ts';
import { chainGraph, priceMove } from './chains.ts';
import { createCraftPricer } from './craft.ts';
import { afterTax, ahNet, sellSide } from './pricing.ts';

export type SellMethod = 'insta' | 'offer' | 'npc' | 'ah' | 'craft';

export interface CraftPlan {
  /** tiers from your item to the one you sell */
  path: string[];
  toId: string;
  /** your items per crafted item */
  need: number;
  /** crafted items (whole) */
  made: number;
  /** your items used / left over (sold raw) */
  used: number;
  leftover: number;
  /** side-ingredient cost per crafted item */
  sideCost: number;
  /** the move priced by the craft pricer (value = what one crafted item sells for) */
  row: CraftRow;
}

export interface SellOption {
  method: SellMethod;
  /** coins you end up with for the whole quantity (after taxes, fees and side-ingredient costs) */
  net: number;
  /** net per item you own */
  perItem: number;
  /** estimated hours to sell (sell offers); 0 = immediate; null = unknown */
  hours: number | null;
  /** insta-sell: the buy orders hold fewer items than you have (only `filled` are counted) */
  filled?: number;
  craft?: CraftPlan;
}

export interface SellResult {
  id: string;
  name: string;
  qty: number;
  /** best first */
  options: SellOption[];
}

/** Raw sale options for `qty` items (no crafting). */
export function rawOptions(ctx: CalcCtx, id: string, qty: number): SellOption[] {
  const { snap, catalog, settings } = ctx;
  const out: SellOption[] = [];
  const p = snap.products[id];
  const push = (o: Omit<SellOption, 'perItem'>) => o.net > 0 && Number.isFinite(o.net) && out.push({ ...o, perItem: o.net / qty });
  if (p) {
    const walk = walkBook(p.bids, qty);
    if (walk) {
      push({ method: 'insta', net: afterTax(walk.avgPrice, settings.taxRate) * walk.filled, hours: 0, ...(walk.filled < qty ? { filled: walk.filled } : {}) });
    }
    const side = sellSide(p, 'offer', settings.share);
    if (side && side.quote.price > 0) {
      push({ method: 'offer', net: afterTax(side.quote.price, settings.taxRate) * qty, hours: side.rate > 0 ? qty / side.rate : null });
    }
  }
  const ns = catalog.items[id]?.npcSell;
  if (ns != null && ns > 0) push({ method: 'npc', net: ns * qty, hours: 0 });
  const ah = catalog.items[id]?.auctionable ? ctx.ah?.(id) : null;
  if (ah && ah.price > 0) push({ method: 'ah', net: ahNet(ah.price, ctx.derpy) * qty, hours: null });
  return out;
}

/** Every way to sell `qty` of `id`, best first. */
export function sellOptions(ctx: CalcCtx, id: string, qty: number): SellResult {
  const options = rawOptions(ctx, id, qty);
  // leftover items after whole crafts: sold at the best raw price per item (insta-sell priced for the full stack)
  const rawUnit = options.reduce((m, o) => Math.max(m, o.method === 'insta' && o.filled != null ? 0 : o.perItem), 0);

  const g = chainGraph(ctx.catalog);
  const pricer = createCraftPricer(ctx);
  const seen = new Set<string>();
  for (const ladder of g.ladders) {
    const i = ladder.indexOf(id);
    if (i < 0) continue;
    for (let j = i + 1; j < ladder.length; j++) {
      const path = ladder.slice(i, j + 1);
      const key = path.join('>');
      if (seen.has(key)) continue;
      seen.add(key);
      const { row, needFrom } = priceMove(pricer, g, path, 'bazaar');
      // chain steps start at bazaar items, so a priced row has a value; your own items cost nothing here
      if (row.unpriced.length > 0 || !(needFrom > 0)) continue;
      const made = Math.floor(qty / needFrom + 1e-9);
      if (made < 1) continue;
      const sideCost = row.lines.reduce((s, l) => (l.id === id ? s : s + l.total), 0);
      const used = made * needFrom;
      const leftover = qty - used;
      const net = made * (row.value - sideCost) + leftover * rawUnit;
      if (!(net > 0)) continue;
      options.push({
        method: 'craft',
        net,
        perItem: net / qty,
        hours: null,
        craft: { path, toId: path.at(-1)!, need: needFrom, made, used, leftover, sideCost, row },
      });
    }
  }
  options.sort((a, b) => b.net - a.net);
  return { id, name: ctx.catalog.name(id), qty, options };
}
