// Your bazaar orders against the live order book: are you still on top, how many items are ahead of you, roughly how
// long until it fills, and the price that would put you back on top.
import { PRICE_TICK } from '../config.ts';
import type { MyOrder, OrderStatusKind, Product } from '../types/contracts.ts';
import { round1 } from './pricing.ts';

export interface OrderStatus {
  kind: OrderStatusKind;
  /** best price on your side of the book now (highest buy order / lowest sell offer) */
  best: number | null;
  /** items queued before yours: at better prices, plus others at your price */
  ahead: number;
  /** hours until filled at the item's whole weekly insta volume (you are served in price order); null = unknown */
  etaHours: number | null;
  /** price that would put you on top again (best ± 0.1), null when you are top */
  reprice: number | null;
}

const EPS = PRICE_TICK / 2;

/** Status of one order against the product's current book. */
export function orderStatus(o: MyOrder, p: Product | undefined): OrderStatus {
  if (!p) return { kind: 'unknown', best: null, ahead: 0, etaHours: null, reprice: null };
  const buy = o.side === 'buy';
  const levels = buy ? p.bids : p.asks;
  const best = levels[0]?.price ?? null;
  // better = strictly ahead of you in the queue
  const better = (price: number) => (buy ? price > o.price + EPS : price < o.price - EPS);
  let ahead = 0;
  let same: { amount: number; orders: number } | null = null;
  for (const l of levels) {
    if (better(l.price)) ahead += l.amount;
    else if (Math.abs(l.price - o.price) <= EPS) same = l;
  }
  // your own order is part of `same`; the rest of that level was there before you (or joined at your price)
  const others = same ? Math.max(0, same.amount - o.qty) : 0;
  let kind: OrderStatusKind;
  if (best == null || !better(best)) kind = same && (same.orders > 1 || same.amount > o.qty) ? 'tied' : 'top';
  else kind = buy ? 'outbid' : 'undercut';
  // buy orders fill when others insta-sell into them, sell offers when others insta-buy
  const perHour = (buy ? p.instaSellsWeek : p.instaBuysWeek) / 168;
  const etaHours = perHour > 0 ? (ahead + others + o.qty) / perHour : null;
  const reprice = kind === 'outbid' || kind === 'undercut' || kind === 'tied' ? round1(buy ? best! + PRICE_TICK : Math.max(PRICE_TICK, best! - PRICE_TICK)) : null;
  return { kind, best, ahead: ahead + others, etaHours, reprice };
}

/** Lost the top of the book since the last check (fires order alerts). */
export const lostTop = (prev: OrderStatusKind | undefined, now: OrderStatusKind): boolean =>
  (prev === 'top' || prev === 'tied') && (now === 'outbid' || now === 'undercut');
