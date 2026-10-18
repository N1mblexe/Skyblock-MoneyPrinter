// "Sell or craft?": every way to turn items you already own into coins, compared on what you end up with.
// Raw sales: insta-sell (walks the buy orders), sell offer (top of book − 0.1, takes time), NPC, AH (sale.ts: listed
// under the lowest BIN, after fees, at the AH sales rate).
// Crafting up: every chain move that starts at the item; your items are free inputs, side ingredients are bought
// (craft pricer), whole crafts only; the crafted items are sold for the crafted quantity at their best venue
// (sale.ts) and the leftover items raw at the best raw unit price.
import type { CalcCtx, CraftRow } from '../types/contracts.ts';
import { walkBook } from './book.ts';
import { chainGraph, priceMove } from './chains.ts';
import { getPricer } from './craft.ts';
import { afterTax, sellSide } from './pricing.ts';
import { bestSale, saleQuotes, type SaleVenue } from './sale.ts';

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
  /** the move priced by the craft pricer (sideCost comes from it) */
  row: CraftRow;
  /** where the crafted items are sold */
  venue: SaleVenue;
  /** what one crafted item nets when all `made` are sold */
  saleNet: number;
}

export interface SellOption {
  method: SellMethod;
  /** coins you end up with for the whole quantity (after taxes, fees and side-ingredient costs) */
  net: number;
  /** net per item you own */
  perItem: number;
  /** estimated hours to sell (sell offers and AH listings at your share of the market); 0 = immediate; null = unknown */
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
  const ah = saleQuotes(ctx, id, { venues: ['ah'] })[0];
  if (ah) push({ method: 'ah', net: ah.net * qty, hours: hoursAt(qty, ah.rate) });
  return out;
}

/** Hours to sell `qty` at `rate` units/hour; 0 for an unlimited (NPC) rate, null without a rate. */
const hoursAt = (qty: number, rate: number): number | null => (rate === Infinity ? 0 : rate > 0 ? qty / rate : null);

/** Every way to sell `qty` of `id`, best first. */
export function sellOptions(ctx: CalcCtx, id: string, qty: number): SellResult {
  const options = rawOptions(ctx, id, qty);
  // leftover items after whole crafts: sold at the best raw price per item (insta-sell priced for the full stack)
  const rawBest = options.reduce<SellOption | null>((m, o) => (o.method === 'insta' && o.filled != null ? m : !m || o.perItem > m.perItem ? o : m), null);
  const rawUnit = rawBest?.perItem ?? 0;

  const g = chainGraph(ctx.catalog);
  const pricer = getPricer(ctx);
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
      const toId = path.at(-1)!;
      // the crafted quantity sold at once (an insta-sell walks the book for all of it); the move is priced, so the
      // top tier has a venue
      const sale = bestSale(ctx, toId, { qty: made })!;
      const used = made * needFrom;
      const leftover = qty - used;
      const net = made * (sale.net - sideCost) + leftover * rawUnit;
      if (!(net > 0)) continue;
      const saleHours = sale.venue === 'bazaar' && ctx.settings.sellMode === 'insta' ? 0 : hoursAt(made, sale.rate);
      // the leftover sells by the best raw method meanwhile
      const leftHours = leftover > 0 && rawBest ? (rawBest.hours == null ? null : (rawBest.hours * leftover) / qty) : 0;
      options.push({
        method: 'craft',
        net,
        perItem: net / qty,
        hours: saleHours == null || leftHours == null ? null : Math.max(saleHours, leftHours),
        craft: { path, toId, need: needFrom, made, used, leftover, sideCost, row, venue: sale.venue, saleNet: sale.net },
      });
    }
  }
  options.sort((a, b) => b.net - a.net);
  return { id, name: ctx.catalog.name(id), qty, options };
}
