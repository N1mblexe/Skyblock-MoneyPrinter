// The best net sale of an item across the bazaar, NPCs and the AH, with the AH risk flags: one rule for crafts,
// chains, bits, shops and Sell or craft?. Owner: s1/core.
import { AH, AH_FLIP, AH_SALES } from '../config.ts';
import type { AhPrice, CalcCtx, Catalog, ConsInfo, RiskFlag, RiskReport, Throughput } from '../types/contracts.ts';
import { ahRate, coreOf, salesOf } from './market.ts';
import { afterTax, ahNet } from './pricing.ts';
import { reportFromFlags } from './risk.ts';

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
  /** bazaar insta-sell: units on the bids */
  depth?: number;
  /** bazaar: what conservatism changed on the quote */
  cons?: ConsInfo;
}

export interface SaleOptions {
  /** units to sell (bazaar insta-sells are re-quoted at that size); default 1 */
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

/** The item can be listed on the AH: the catalog says so, or (unknown to the catalog) it is not a bazaar product. */
export function isAuctionable(ctx: CalcCtx, id: string): boolean {
  const info = ctx.catalog.items[id];
  return info ? info.auctionable === true : !ctx.snap.products[id];
}

/** An AH that sold nothing over the coverage: listed, it doesn't sell. */
const deadAh = (q: SaleQuote): number => (q.venue === 'ah' && !(q.rate > 0) ? 1 : 0);

/**
 * Every way to sell `id`, best net first (ties keep bazaar > AH > NPC); an AH quote at rate 0 (measured, none sold)
 * comes last, so the best sale is one that sells.
 *  bazaar  the core's sell side (conservatism applied), after tax, your sell rate, sell-side risk
 *  AH      auctionable items only: listed at min(lowest, next) - AH_FLIP.undercut, and with conservatism on at no
 *          more than the median sold price (once AH_SALES.minSales sales are seen); net of the AH fees; rate ahRate
 *          (your share of the sales per hour, else AH_SALES.defaultPerHour; 'ahSales'); flags from ahFlags. Sales seen over less than
 *          AH_SALES.minCoverageHours are ignored (salesOf)
 *  NPC     the NPC sell price, unlimited
 */
export function saleQuotes(ctx: CalcCtx, id: string, o: SaleOptions = {}): SaleQuote[] {
  const { snap, catalog, settings } = ctx;
  const core = coreOf(ctx);
  const venues = new Set(o.venues ?? (['bazaar', 'ah', 'npc'] as const));
  const out: SaleQuote[] = [];
  const p = snap.products[id];
  const side = p && venues.has('bazaar') ? core.sell(id, o.qty) : null;
  if (p && side && pos(side.quote.price)) {
    const gross = side.quote.price;
    const net = afterTax(gross, settings.taxRate);
    const q: SaleQuote = {
      venue: 'bazaar',
      gross,
      fees: gross - net,
      net,
      rate: side.rate,
      limitedBy: 'volume',
      liquidity: (settings.sellMode === 'offer' ? p.instaBuysWeek : p.instaSellsWeek) || 0,
      risk: core.risk(id, { sell: settings.sellMode }),
    };
    if (side.depth != null) q.depth = side.depth;
    if (side.cons) q.cons = side.cons;
    out.push(q);
  }
  const a = venues.has('ah') && isAuctionable(ctx, id) ? ctx.ah?.(id) : null;
  if (a && pos(a.price)) {
    let list = Math.min(a.price, a.next ?? a.price) - AH_FLIP.undercut;
    const sales = salesOf(ctx, id);
    if (settings.conservative && sales && sales.n >= AH_SALES.minSales && pos(sales.median)) list = Math.min(list, sales.median);
    if (pos(list)) {
      const net = ahNet(list, ctx.derpy);
      out.push({
        venue: 'ah',
        gross: list,
        fees: list - net,
        net,
        rate: ahRate(sales?.perHour, settings.share),
        limitedBy: 'ahSales',
        liquidity: a.count,
        risk: reportFromFlags(ahFlags(a, catalog, id)),
        ...(a.next != null ? { next: a.next } : {}),
      });
    }
  }
  const ns = catalog.items[id]?.npcSell;
  if (venues.has('npc') && pos(ns)) out.push({ venue: 'npc', gross: ns, fees: 0, net: ns, rate: Infinity, liquidity: null, risk: null });
  return out.sort((x, y) => deadAh(x) - deadAh(y) || y.net - x.net || VENUE_ORDER[x.venue] - VENUE_ORDER[y.venue]);
}

/** The best way to sell `id`, or null when it can't be sold anywhere. */
export function bestSale(ctx: CalcCtx, id: string, o: SaleOptions = {}): SaleQuote | null {
  return saleQuotes(ctx, id, o)[0] ?? null;
}
