// Bits shop (Elizabeth's Community Shop): which offer turns bits into the most coins, what a bit costs when bought as
// Booster Cookies at the user's fame rank, and the basket one cookie's bits buy. A ranking, not a planner opportunity.
import { BITS } from '../config.ts';
import type { CalcCtx, RiskReport } from '../types/contracts.ts';
import { coreOf } from './market.ts';
import { saleQuotes, type SaleQuote, type SaleVenue } from './sale.ts';

export type BitsSource = SaleVenue;

/** One way to sell an offer's output, per item (sale.ts saleQuotes). */
export type BitsQuote = SaleQuote;

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
  /** the winning quote's liquidity (bazaar: weekly volume on the used side; AH: BIN listings; NPC: null) */
  liquidity: number | null;
  /** the winning quote's sale rate, items/hour (Infinity for NPC); null when unvalued */
  rate: number | null;
  /** can't be sold to other players (catalog.untradeable): never valued */
  untradeable: boolean;
  /** the winning quote's risk */
  risk: RiskReport | null;
  /** every quote found, best first (the detail panel shows the ones that lost) */
  quotes: BitsQuote[];
}

/** One offer in the cookie basket. */
export interface BasketLine {
  row: BitsRow;
  /** offers bought */
  offers: number;
  bits: number;
  coins: number;
}

/**
 * What one cookie's bits buy: the offers by coins per bit, each up to what its market absorbs in BITS.basketHours
 * (sale rate × hours / outQty offers), until the bits run out.
 */
export interface BitsBasket {
  lines: BasketLine[];
  /** bits spent */
  bits: number;
  coins: number;
  /** bits no offer could take (thin markets): kept for later, not valued */
  leftBits: number;
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
  /** one cookie's bits in tradeable, valued, non-suspect offers */
  basket: BitsBasket;
  /** basket.coins; null when the basket is empty */
  coinsPerCookie: number | null;
  /** coinsPerCookie − cookieCost */
  profitPerCookie: number | null;
}

export interface BitsResult {
  rows: BitsRow[];
  summary: BitsSummary;
}

export interface BitsOptions {
  /** fame-rank (or custom) bits multiplier; default settings.bitsMultiplier, invalid values fall back to 1 */
  multiplier?: number;
}

const pos = (x: number | null | undefined): x is number => x != null && Number.isFinite(x) && x > 0;

/** Multiplier of a fame rank by name (New Player's 1 when unknown). */
export function fameMultiplier(rank: string): number {
  return BITS.fameRanks.find(([name]) => name === rank)?.[2] ?? 1;
}

/** The multiplier in effect: a positive custom value overrides the rank. */
export function bitsMultiplier(rank: string, custom: number | null): number {
  return pos(custom) ? custom : fameMultiplier(rank);
}

/** What a bit costs through Booster Cookies (cookie buy side in costMode / bits per cookie). */
export interface CookieCost {
  multiplier: number;
  bitsPerCookie: number;
  cookieCost: number | null;
  perBit: number | null;
}

export function cookieCost(ctx: CalcCtx, multiplier: number = ctx.settings.bitsMultiplier): CookieCost {
  const m = pos(multiplier) ? multiplier : 1;
  const bitsPerCookie = BITS.perCookie * m;
  const price = coreOf(ctx).buy(BITS.cookieId)?.quote.price;
  const cost = pos(price) ? price : null;
  return { multiplier: m, bitsPerCookie, cookieCost: cost, perBit: cost != null ? cost / bitsPerCookie : null };
}

/**
 * Coins per item of every bits-shop item bought with bits from cookies: its cheapest offer's bits per item × the
 * cookie cost per bit. Empty without a cookie price.
 */
export function bitsItemCosts(ctx: CalcCtx, multiplier: number = ctx.settings.bitsMultiplier): Map<string, number> {
  const out = new Map<string, number>();
  const { perBit } = cookieCost(ctx, multiplier);
  if (perBit == null) return out;
  for (const off of ctx.catalog.shops) {
    if (off.currency !== BITS.currency || !(off.costQty > 0) || !(off.outQty > 0)) continue;
    const unit = (off.costQty / off.outQty) * perBit;
    const cur = out.get(off.output);
    if (cur == null || unit < cur) out.set(off.output, unit);
  }
  return out;
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

const usable = (r: BitsRow) => !r.untradeable && r.coinsPerBit != null && r.risk?.level !== 'suspect';

/** Fill `bits` with the usable rows (already sorted best first), each capped by its sales over BITS.basketHours. */
export function fillBasket(rows: readonly BitsRow[], bits: number): BitsBasket {
  const lines: BasketLine[] = [];
  let left = bits;
  let coins = 0;
  const taken = new Map<string, number>();
  for (const r of rows) {
    if (!usable(r) || r.bits > left) continue;
    // offers of one item share its market
    const cap = Math.floor((r.rate! * BITS.basketHours) / r.outQty - (taken.get(r.id) ?? 0) + 1e-9);
    const n = Math.min(cap, Math.floor(left / r.bits));
    if (!(n > 0)) continue;
    taken.set(r.id, (taken.get(r.id) ?? 0) + n * r.outQty);
    lines.push({ row: r, offers: n, bits: n * r.bits, coins: n * r.value! });
    left -= n * r.bits;
    coins += n * r.value!;
  }
  return { lines, bits: bits - left, coins, leftBits: left };
}

/**
 * One row per bits offer (catalog shops paid in BITS.currency), valued at its best sale (sale.ts: the bazaar after tax,
 * the AH after fees when scanned and auctionable, the NPC) times outQty. The summary prices a bit through Booster
 * Cookies (cookieCost) and fills one cookie's bits into a basket (fillBasket).
 */
export function computeBitsRows(ctx: CalcCtx, o: BitsOptions = {}): BitsResult {
  const { catalog } = ctx;
  const cc = cookieCost(ctx, o.multiplier ?? ctx.settings.bitsMultiplier);

  const rows: BitsRow[] = [];
  for (const off of catalog.shops) {
    if (off.currency !== BITS.currency || !(off.costQty > 0)) continue;
    const untradeable = catalog.untradeable.has(off.output);
    const quotes = untradeable ? [] : saleQuotes(ctx, off.output);
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
      valueSource: top?.venue ?? null,
      coinsPerBit,
      vsCookie: coinsPerBit != null && cc.perBit != null ? coinsPerBit / cc.perBit : null,
      liquidity: top?.liquidity ?? null,
      rate: top?.rate ?? null,
      untradeable,
      risk: top?.risk ?? null,
      quotes,
    });
  }
  rows.sort(compareRows);

  const best = rows.find(usable) ?? null;
  const basket = fillBasket(rows, cc.bitsPerCookie);
  const coinsPerCookie = basket.lines.length > 0 ? basket.coins : null;
  return {
    rows,
    summary: {
      multiplier: cc.multiplier,
      bitsPerCookie: cc.bitsPerCookie,
      cookieCost: cc.cookieCost,
      cookieCostPerBit: cc.perBit,
      best,
      basket,
      coinsPerCookie,
      profitPerCookie: coinsPerCookie != null && cc.cookieCost != null ? coinsPerCookie - cc.cookieCost : null,
    },
  };
}
