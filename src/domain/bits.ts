// Bits shop (Elizabeth's Community Shop): which offer turns bits into the most coins, and what a bit costs when
// bought as Booster Cookies at the user's fame rank. A ranking, not a planner opportunity.
import { AH, AH_FLIP, BITS } from '../config.ts';
import type { CalcCtx, RiskFlag, RiskReport } from '../types/contracts.ts';
import { afterTax, ahNet, buyQuote, sellQuote } from './pricing.ts';
import { assessRisk, reportFromFlags } from './risk.ts';

export type BitsSource = 'bazaar' | 'ah' | 'npc';

/** One way to sell an offer's output, per item. */
export interface BitsQuote {
  source: BitsSource;
  /** per item before fees: bazaar sell quote, lowest BIN, or NPC price */
  gross: number;
  /** per item: bazaar tax, or AH listing fee + claim tax (0 for NPC) */
  fees: number;
  /** gross − fees */
  net: number;
  /** bazaar: weekly volume that absorbs your sale in sellMode; AH: BIN listings; NPC: null (unlimited) */
  liquidity: number | null;
  /** null for NPC sales */
  risk: RiskReport | null;
  /** AH only: second-lowest BIN */
  next?: number;
}

export interface BitsRow {
  /** `${id}|${bits}` (unique per offer) */
  key: string;
  id: string;
  name: string;
  /** bits per offer */
  bits: number;
  outQty: number;
  /** coins for the whole offer through the best quote; null when it can't be sold or priced */
  value: number | null;
  valueSource: BitsSource | null;
  /** value / bits */
  coinsPerBit: number | null;
  /** coinsPerBit / summary.cookieCostPerBit: > 1 means buying cookies to buy this item pays */
  vsCookie: number | null;
  /** the winning quote's liquidity */
  liquidity: number | null;
  /** can't be sold to other players (catalog.untradeable): never valued */
  untradeable: boolean;
  /** the winning quote's risk */
  risk: RiskReport | null;
  /** every quote found, best first (the detail panel shows the ones that lost) */
  quotes: BitsQuote[];
}

export interface BitsSummary {
  multiplier: number;
  /** BITS.perCookie × multiplier */
  bitsPerCookie: number;
  /** one Booster Cookie on the bazaar in costMode; null without a price */
  cookieCost: number | null;
  cookieCostPerBit: number | null;
  /** highest coinsPerBit among tradeable, valued, non-suspect rows */
  best: BitsRow | null;
  /** bitsPerCookie × best.coinsPerBit */
  coinsPerCookie: number | null;
  /** coinsPerCookie − cookieCost */
  profitPerCookie: number | null;
}

export interface BitsResult {
  rows: BitsRow[];
  summary: BitsSummary;
}

export interface BitsOptions {
  /** fame-rank (or custom) bits multiplier; invalid values fall back to 1 */
  multiplier: number;
}

const SOURCE_ORDER: Record<BitsSource, number> = { bazaar: 0, ah: 1, npc: 2 };
const pos = (x: number | null | undefined): x is number => x != null && Number.isFinite(x) && x > 0;

/** Multiplier of a fame rank by name (New Player's 1 when unknown). */
export function fameMultiplier(rank: string): number {
  return BITS.fameRanks.find(([name]) => name === rank)?.[2] ?? 1;
}

/** The multiplier in effect: a positive custom value overrides the rank. */
export function bitsMultiplier(rank: string, custom: number | null): number {
  return pos(custom) ? custom : fameMultiplier(rank);
}

/** Every quote for selling one unit of `id` (bazaar, AH when scanned, NPC), best net first. */
export function bitsQuotes(ctx: CalcCtx, id: string): BitsQuote[] {
  const { snap, catalog, settings } = ctx;
  const out: BitsQuote[] = [];
  const p = snap.products[id];
  const sq = p ? sellQuote(p, settings.sellMode) : null;
  if (p && sq && pos(sq.price)) {
    const net = afterTax(sq.price, settings.taxRate);
    out.push({
      source: 'bazaar',
      gross: sq.price,
      fees: sq.price - net,
      net,
      // the volume that absorbs your sales: sell offers fill from insta-buys, insta-selling hits buy orders
      liquidity: (settings.sellMode === 'offer' ? p.instaBuysWeek : p.instaSellsWeek) || 0,
      risk: assessRisk(p, ctx.stats?.(id) ?? null),
    });
  }
  const a = ctx.ah?.(id);
  if (a && pos(a.price)) {
    const net = ahNet(a.price, ctx.derpy);
    const flags: RiskFlag[] = [];
    if (a.count < AH.minCount) flags.push('AH_THIN');
    if (a.next != null && a.next / a.price > AH_FLIP.gapRatio) flags.push('AH_GAP');
    if ((AH_FLIP.variantCategories as readonly string[]).includes(catalog.items[id]?.category ?? '')) flags.push('AH_VARIANT');
    out.push({
      source: 'ah',
      gross: a.price,
      fees: a.price - net,
      net,
      liquidity: a.count,
      risk: reportFromFlags(flags),
      ...(a.next != null ? { next: a.next } : {}),
    });
  }
  const ns = catalog.items[id]?.npcSell;
  if (pos(ns)) out.push({ source: 'npc', gross: ns, fees: 0, net: ns, liquidity: null, risk: null });
  // ties keep bazaar > AH > NPC
  return out.sort((x, y) => y.net - x.net || SOURCE_ORDER[x.source] - SOURCE_ORDER[y.source]);
}

/** Valued rows by coinsPerBit (desc), then unvalued tradeable rows, then untradeable ones; ties by id, then bits. */
function compareRows(a: BitsRow, b: BitsRow): number {
  const rank = (r: BitsRow) => (r.untradeable ? 2 : r.coinsPerBit == null ? 1 : 0);
  return (
    rank(a) - rank(b) ||
    (b.coinsPerBit ?? 0) - (a.coinsPerBit ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
    a.bits - b.bits
  );
}

/**
 * One row per bits offer (catalog shops paid in BITS.currency), valued at the best of the bazaar sell quote after
 * tax, the lowest BIN after AH fees (only when ctx.ah is set) and the NPC price, times outQty. The summary prices a
 * bit through Booster Cookies: cookie buy quote (costMode) / (BITS.perCookie × multiplier).
 */
export function computeBitsRows(ctx: CalcCtx, o: BitsOptions): BitsResult {
  const { snap, catalog, settings } = ctx;
  const multiplier = pos(o.multiplier) ? o.multiplier : 1;
  const bitsPerCookie = BITS.perCookie * multiplier;
  const cp = snap.products[BITS.cookieId];
  const cq = cp ? buyQuote(cp, settings.costMode, 1, catalog.items[BITS.cookieId]?.npcSell) : null;
  const cookieCost = cq && pos(cq.price) ? cq.price : null;
  const cookieCostPerBit = cookieCost != null ? cookieCost / bitsPerCookie : null;

  const rows: BitsRow[] = [];
  for (const off of catalog.shops) {
    if (off.currency !== BITS.currency || !(off.costQty > 0)) continue;
    const untradeable = catalog.untradeable.has(off.output);
    const quotes = untradeable ? [] : bitsQuotes(ctx, off.output);
    const top = off.outQty > 0 ? quotes[0] : undefined;
    const value = top ? top.net * off.outQty : null;
    const coinsPerBit = value != null ? value / off.costQty : null;
    rows.push({
      key: `${off.output}|${off.costQty}`,
      id: off.output,
      name: catalog.name(off.output),
      bits: off.costQty,
      outQty: off.outQty,
      value,
      valueSource: top?.source ?? null,
      coinsPerBit,
      vsCookie: coinsPerBit != null && cookieCostPerBit != null ? coinsPerBit / cookieCostPerBit : null,
      liquidity: top?.liquidity ?? null,
      untradeable,
      risk: top?.risk ?? null,
      quotes,
    });
  }
  rows.sort(compareRows);

  const best = rows.find((r) => !r.untradeable && r.coinsPerBit != null && r.risk?.level !== 'suspect') ?? null;
  const coinsPerCookie = best ? bitsPerCookie * best.coinsPerBit! : null;
  return {
    rows,
    summary: {
      multiplier,
      bitsPerCookie,
      cookieCost,
      cookieCostPerBit,
      best,
      coinsPerCookie,
      profitPerCookie: coinsPerCookie != null && cookieCost != null ? coinsPerCookie - cookieCost : null,
    },
  };
}
