// Shared market core: one memo of quotes, risk and NPC / AH purchase legs per CalcCtx, so every strategy prices a
// product the same way and no product is assessed twice. Owner: s1/core.
// The core reads only the market settings (taxRate, share, costMode, sellMode, npcDailyLimit, conservative,
// cycleHours), never capital, orderSlots or fillModel, so one core can serve every throughput setting.
import { AH_SALES } from '../config.ts';
import type { AhSalesStat, CalcCtx, ConsInfo, CostMode, RiskReport, SellMode } from '../types/contracts.ts';
import { walkBook } from './book.ts';
import { sideAdjust } from './conservative.ts';
import { afterTax, buySide, effShare, npcBuyRate, sellSide, sideRes, type Leg, type SideInfo } from './pricing.ts';
import { assessRisk } from './risk.ts';

/** Which sides of a product a strategy trades (absent: both, in the settings' modes). */
export interface RiskUse {
  buy?: CostMode;
  sell?: SellMode;
}

/** A bazaar side quote with what conservatism changed on it. */
export interface CoreSide extends SideInfo {
  cons?: ConsInfo;
}

/** Buying from an NPC shop: instant, capped at the daily limit spread over the day. */
export interface NpcLeg {
  price: number;
  /** units/hour (npcDailyLimit / 24) */
  rate: number;
}

/** Buying on the AH at the lowest BINs. */
export interface AhLeg {
  /** per item; VWAP over the lowest listings for `qty` */
  price: number;
  /** items/hour you can expect to buy (measured AH sales, else AH_SALES.defaultPerHour) */
  rate: number;
  /** BIN listings seen */
  count: number;
}

export interface MarketCore {
  readonly ctx: CalcCtx;
  /** bazaar buy side in settings.costMode (qty: re-quote insta at that size) */
  buy(id: string, qty?: number): CoreSide | null;
  /** bazaar sell side in settings.sellMode */
  sell(id: string, qty?: number): CoreSide | null;
  /** risk of a bazaar product, memoized per id and use; null when not on the bazaar */
  risk(id: string, use?: RiskUse): RiskReport | null;
  /** NPC shop purchase, null when no coin shop sells it */
  npcBuy(id: string): NpcLeg | null;
  /** AH purchase, null without a scan or listing */
  ahBuy(id: string, qty?: number): AhLeg | null;
}

const cores = new WeakMap<CalcCtx, MarketCore>();

/** The id's realized AH sales, or null while the feed has covered less than AH_SALES.minCoverageHours. */
export function salesOf(ctx: CalcCtx, id: string): AhSalesStat | null {
  const s = ctx.ahSales?.(id) ?? null;
  return s && s.coverageHours >= AH_SALES.minCoverageHours ? s : null;
}

/**
 * Your AH sales (or buys) per hour of one id: AH_SALES.defaultPerHour without measured sales, else your share of the
 * measured rate, but no less than the next sale's rate (min(measured, default)): listed at the lowest BIN you are first
 * in line, so a measured market is never slower than an unmeasured one unless it really sells less than the default.
 * Measured 0 (nothing sold over the coverage) stays 0.
 */
export function ahRate(perHour: number | null | undefined, share: number): number {
  if (perHour == null) return AH_SALES.defaultPerHour;
  if (!(perHour > 0)) return 0;
  return Math.max(perHour * share, Math.min(perHour, AH_SALES.defaultPerHour));
}

/** The context's core: ctx.core when set, else one memoized per context object. */
export function coreOf(ctx: CalcCtx): MarketCore {
  if (ctx.core) return ctx.core;
  let c = cores.get(ctx);
  if (!c) cores.set(ctx, (c = createMarketCore(ctx)));
  return c;
}

/**
 * A memo by id and a second key (qty or use), null results included. Hot: every strategy asks for every product, so
 * there is no string key or closure per lookup.
 */
class Memo<K, T> {
  private readonly m = new Map<string, Map<K, T | null>>();
  /** undefined = not computed yet */
  get(id: string, k: K): T | null | undefined {
    return this.m.get(id)?.get(k);
  }
  set(id: string, k: K, v: T | null): T | null {
    let inner = this.m.get(id);
    if (!inner) this.m.set(id, (inner = new Map()));
    inner.set(k, v);
    return v;
  }
}

/** A quote of one unit is the same with or without a qty. */
const qtyKey = (qty?: number) => qty ?? 1;
const BUY_CODE = { '': 0, order: 1, insta: 2 } as const;
const SELL_CODE = { '': 0, offer: 1, insta: 2 } as const;
/** -1 = side-blind, else one number per (buy, sell) mode pair */
const useKey = (u?: RiskUse) => (u ? BUY_CODE[u.buy ?? ''] * 3 + SELL_CODE[u.sell ?? ''] : -1);

export function createMarketCore(ctx: CalcCtx): MarketCore {
  const { snap, catalog, settings } = ctx;
  const buyMemo = new Memo<number, CoreSide>();
  const sellMemo = new Memo<number, CoreSide>();
  const riskMemo = new Memo<number, RiskReport>();
  const ahMemo = new Memo<number, AhLeg>();

  /**
   * Apply sideAdjust to a snapshot side: price moved (and churn added against you), rate scaled by the volume trend
   * and, when competitors weighted by amount outnumber the orders, by the smaller share; cons recorded.
   */
  const adjust = (id: string, side: 'buy' | 'sell', s: SideInfo): CoreSide => {
    if (!settings.conservative) return s;
    const p = snap.products[id]!;
    // a buy order capped at the ask is an insta-buy
    const mode = { ...settings, costMode: s.quote.source === 'insta' ? ('insta' as const) : ('order' as const) };
    const a = sideAdjust(side, p, s.quote.price, ctx.stats?.(id) ?? null, ctx.market?.(id) ?? null, side === 'buy' ? mode : settings);
    if (!a) return s;
    const price = side === 'buy' ? a.price + a.churn : Math.max(0, a.price - a.churn);
    const cons: ConsInfo = {};
    if (price !== s.quote.price) cons[side === 'buy' ? 'buyRef' : 'sellRef'] = s.quote.price;
    if (a.rateMul !== 1) cons.rateMul = a.rateMul;
    if (a.churn > 0) cons.churn = a.churn;
    let rate = s.rate * a.rateMul;
    let comp = s.comp;
    const base = effShare(settings.share, s.comp);
    if (a.comp != null && base > 0) {
      rate *= effShare(settings.share, a.comp) / base;
      comp = a.comp;
    }
    const out: CoreSide = { ...s, quote: { ...s.quote, price }, rate, comp };
    if (Object.keys(cons).length > 0) out.cons = cons;
    return out;
  };

  return {
    ctx,
    buy(id, qty) {
      const k = qtyKey(qty);
      const hit = buyMemo.get(id, k);
      if (hit !== undefined) return hit;
      const p = snap.products[id];
      const s = p ? buySide(p, settings.costMode, settings.share, qty, catalog.items[id]?.npcSell) : null;
      return buyMemo.set(id, k, s && adjust(id, 'buy', s));
    },
    sell(id, qty) {
      const k = qtyKey(qty);
      const hit = sellMemo.get(id, k);
      if (hit !== undefined) return hit;
      const p = snap.products[id];
      const s = p ? sellSide(p, settings.sellMode, settings.share, qty) : null;
      return sellMemo.set(id, k, s && adjust(id, 'sell', s));
    },
    risk(id, use) {
      const k = useKey(use);
      const hit = riskMemo.get(id, k);
      if (hit !== undefined) return hit;
      const p = snap.products[id];
      return riskMemo.set(id, k, p ? assessRisk(p, ctx.stats?.(id) ?? null, use) : null);
    },
    npcBuy(id) {
      const nb = catalog.items[id]?.npcBuy;
      return nb != null && nb > 0 ? { price: nb, rate: npcBuyRate(settings.npcDailyLimit) } : null;
    },
    ahBuy(id, qty) {
      const k = qtyKey(qty);
      const hit = ahMemo.get(id, k);
      if (hit !== undefined) return hit;
      const a = ctx.ah?.(id);
      if (!a || !(a.price > 0)) return ahMemo.set(id, k, null);
      // one listing per kept price (per item, ascending)
      const w = a.prices?.length ? walkBook(a.prices.map((price) => ({ price, amount: 1, orders: 1 })), qty ?? 1) : null;
      return ahMemo.set(id, k, { price: w?.avgPrice ?? a.price, rate: ahRate(salesOf(ctx, id)?.perHour, settings.share), count: a.count });
    },
  };
}

/**
 * A core side as a planTrade leg of item `id`: sell legs net of the bazaar tax, `order` from the quote source (a buy
 * order capped at the ask is insta), the planner resource it draws on, and what conservatism changed.
 */
export function sideLeg(id: string, side: 'buy' | 'sell', s: CoreSide, taxRate: number): Leg {
  const { price, source, clamped } = s.quote;
  const leg: Leg = { price, net: side === 'sell' ? afterTax(price, taxRate) : price, rate: s.rate, comp: s.comp, order: source === 'order' };
  if (s.depth != null) leg.depth = s.depth;
  const res = sideRes(id, side, source);
  if (res) leg.res = res;
  if (clamped) leg.clamped = clamped;
  if (s.cons) leg.cons = s.cons;
  return leg;
}

/** Row-level conservatism of several legs: the first price refs, the lowest rate multiplier, the churn summed. */
export function mergeCons(...cs: (ConsInfo | undefined)[]): ConsInfo | undefined {
  const out: ConsInfo = {};
  for (const c of cs) {
    if (!c) continue;
    if (c.buyRef != null) out.buyRef ??= c.buyRef;
    if (c.sellRef != null) out.sellRef ??= c.sellRef;
    if (c.rateMul != null) out.rateMul = Math.min(out.rateMul ?? 1, c.rateMul);
    if (c.churn != null) out.churn = (out.churn ?? 0) + c.churn;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
