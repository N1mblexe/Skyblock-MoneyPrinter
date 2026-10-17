// Shared market core: one memo of quotes, risk and NPC / AH purchase legs per CalcCtx, so every strategy prices a
// product the same way and no product is assessed twice. Owner: s1/core.
// Wave 0 stub: wraps buySide / sellSide / assessRisk with memos and no conservative adjustments.
import { AH_SALES } from '../config.ts';
import type { CalcCtx, ConsInfo, CostMode, RiskReport, SellMode } from '../types/contracts.ts';
import { buySide, npcBuyRate, sellSide, type SideInfo } from './pricing.ts';
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

/** The context's core: ctx.core when set, else one memoized per context object. */
export function coreOf(ctx: CalcCtx): MarketCore {
  if (ctx.core) return ctx.core;
  let c = cores.get(ctx);
  if (!c) cores.set(ctx, (c = createMarketCore(ctx)));
  return c;
}

export function createMarketCore(ctx: CalcCtx): MarketCore {
  const { snap, catalog, settings } = ctx;
  const riskMemo = new Map<string, RiskReport | null>();
  const useKey = (u?: RiskUse) => (u ? `${u.buy ?? ''}/${u.sell ?? ''}` : '');
  return {
    ctx,
    buy(id, qty) {
      const p = snap.products[id];
      return p ? buySide(p, settings.costMode, settings.share, qty, catalog.items[id]?.npcSell) : null;
    },
    sell(id, qty) {
      const p = snap.products[id];
      return p ? sellSide(p, settings.sellMode, settings.share, qty) : null;
    },
    risk(id, use) {
      const k = `${id}|${useKey(use)}`;
      if (riskMemo.has(k)) return riskMemo.get(k)!;
      const p = snap.products[id];
      const r = p ? assessRisk(p, ctx.stats?.(id) ?? null) : null;
      riskMemo.set(k, r);
      return r;
    },
    npcBuy(id) {
      const nb = catalog.items[id]?.npcBuy;
      return nb != null && nb > 0 ? { price: nb, rate: npcBuyRate(settings.npcDailyLimit) } : null;
    },
    ahBuy(id) {
      const a = ctx.ah?.(id);
      if (!a || !(a.price > 0)) return null;
      return { price: a.price, rate: ctx.ahSales?.(id)?.perHour ?? AH_SALES.defaultPerHour, count: a.count };
    },
  };
}
