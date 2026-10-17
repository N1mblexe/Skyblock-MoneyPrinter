// The best net sale of an item across the bazaar, NPCs and the AH, with the AH risk flags: one rule for crafts,
// chains, bits, shops and Sell or craft?. Owner: s1/core. Wave 0 stub: today's bitsQuotes logic (one unit, no AH
// undercut, no rate).
import { AH, AH_FLIP } from '../config.ts';
import type { AhPrice, CalcCtx, Catalog, RiskFlag, RiskReport, Throughput } from '../types/contracts.ts';
import { afterTax, ahNet, sellQuote } from './pricing.ts';
import { assessRisk, reportFromFlags } from './risk.ts';

export type SaleVenue = 'bazaar' | 'ah' | 'npc';

export interface SaleQuote {
  venue: SaleVenue;
  /** per unit, before fees / tax */
  gross: number;
  /** tax (bazaar) or listing fee + claim tax (AH) per unit */
  fees: number;
  /** per unit, after fees */
  net: number;
  /** units/hour you can sell this way (Infinity for NPC) */
  rate: number;
  /** what bounds `rate` */
  limitedBy?: Throughput['limitedBy'];
  /** the market that absorbs your sales: bazaar weekly volume on the used side, AH listing count; null for NPC */
  liquidity: number | null;
  risk: RiskReport | null;
  /** AH: second-lowest BIN */
  next?: number;
}

export interface SaleOptions {
  /** units to sell (insta re-quote, AH VWAP); default 1 */
  qty?: number;
  /** venues to consider; default all */
  venues?: readonly SaleVenue[];
}

const pos = (x: number | null | undefined): x is number => x != null && x > 0 && Number.isFinite(x);
const VENUE_ORDER: Record<SaleVenue, number> = { bazaar: 0, ah: 1, npc: 2 };

/** AH flags of a listing: thin market, a big gap to the next price, an id that covers many variants. */
export function ahFlags(a: AhPrice, catalog: Catalog, id: string): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (a.count < AH.minCount) flags.push('AH_THIN');
  if (a.next != null && a.next / a.price > AH_FLIP.gapRatio) flags.push('AH_GAP');
  if ((AH_FLIP.variantCategories as readonly string[]).includes(catalog.items[id]?.category ?? '')) flags.push('AH_VARIANT');
  return flags;
}

/** Every way to sell `id`, best net first (ties keep bazaar > AH > NPC). */
export function saleQuotes(ctx: CalcCtx, id: string, o: SaleOptions = {}): SaleQuote[] {
  const { snap, catalog, settings } = ctx;
  const venues = new Set(o.venues ?? (['bazaar', 'ah', 'npc'] as const));
  const out: SaleQuote[] = [];
  const p = snap.products[id];
  const sq = p && venues.has('bazaar') ? sellQuote(p, settings.sellMode) : null;
  if (p && sq && pos(sq.price)) {
    const net = afterTax(sq.price, settings.taxRate);
    out.push({
      venue: 'bazaar',
      gross: sq.price,
      fees: sq.price - net,
      net,
      rate: ((settings.sellMode === 'offer' ? p.instaBuysWeek : p.instaSellsWeek) || 0) / 168,
      limitedBy: 'volume',
      liquidity: (settings.sellMode === 'offer' ? p.instaBuysWeek : p.instaSellsWeek) || 0,
      risk: assessRisk(p, ctx.stats?.(id) ?? null),
    });
  }
  const a = venues.has('ah') ? ctx.ah?.(id) : null;
  if (a && pos(a.price)) {
    const net = ahNet(a.price, ctx.derpy);
    out.push({
      venue: 'ah',
      gross: a.price,
      fees: a.price - net,
      net,
      rate: Infinity,
      liquidity: a.count,
      risk: reportFromFlags(ahFlags(a, catalog, id)),
      ...(a.next != null ? { next: a.next } : {}),
    });
  }
  const ns = catalog.items[id]?.npcSell;
  if (venues.has('npc') && pos(ns)) out.push({ venue: 'npc', gross: ns, fees: 0, net: ns, rate: Infinity, liquidity: null, risk: null });
  return out.sort((x, y) => y.net - x.net || VENUE_ORDER[x.venue] - VENUE_ORDER[y.venue]);
}

/** The best way to sell `id`, or null when it can't be sold anywhere. */
export function bestSale(ctx: CalcCtx, id: string, o: SaleOptions = {}): SaleQuote | null {
  return saleQuotes(ctx, id, o)[0] ?? null;
}
