import { BOOK_DEPTH } from '../config.ts';
import type { RawBazaar, RawOrder, RawQuickStatus } from '../types/api.ts';
import type { OrderLevel, Product, QuickStatus, Snapshot, SnapshotSource } from '../types/contracts.ts';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Throw a descriptive Error unless `x` looks like a bazaar response ({success:true, products:{...}}). */
export function validateRaw(x: unknown): RawBazaar {
  if (!isObj(x)) throw new Error('Bazaar response is not a JSON object');
  if (x.success !== true) {
    const cause = typeof x.cause === 'string' && x.cause ? x.cause : null;
    throw new Error(cause ? `Hypixel API error: ${cause}` : 'Bazaar response does not have "success": true');
  }
  if (!isObj(x.products)) throw new Error('Bazaar response has no "products" object');
  if (typeof x.lastUpdated !== 'number' || !Number.isFinite(x.lastUpdated)) {
    throw new Error('Bazaar response has no numeric "lastUpdated"');
  }
  return x as unknown as RawBazaar;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function levels(arr: unknown, dir: 1 | -1): OrderLevel[] {
  if (!Array.isArray(arr)) return [];
  const out: OrderLevel[] = [];
  for (const o of arr as Partial<RawOrder>[]) {
    if (!o || typeof o.pricePerUnit !== 'number' || !Number.isFinite(o.pricePerUnit)) continue;
    out.push({ price: o.pricePerUnit, amount: num(o.amount), orders: num(o.orders) });
  }
  // The API already sorts, but don't rely on it.
  out.sort((a, b) => dir * (a.price - b.price));
  if (out.length > BOOK_DEPTH) out.length = BOOK_DEPTH;
  return out;
}

function quick(q: Partial<RawQuickStatus>): QuickStatus {
  return {
    buyPrice: num(q.buyPrice),
    sellPrice: num(q.sellPrice),
    buyVolume: num(q.buyVolume),
    sellVolume: num(q.sellVolume),
    buyMovingWeek: num(q.buyMovingWeek),
    sellMovingWeek: num(q.sellMovingWeek),
    buyOrders: num(q.buyOrders),
    sellOrders: num(q.sellOrders),
  };
}

/**
 * Normalize raw API -> Snapshot.
 * bids = sell_summary (BUY orders, desc), asks = buy_summary (SELL offers, asc); each capped at BOOK_DEPTH.
 * bid/ask = top level or null. instaBuysWeek = quick.buyMovingWeek, instaSellsWeek = quick.sellMovingWeek.
 * Products without quick_status are dropped.
 */
export function toSnapshot(raw: RawBazaar, fetchedAt: number, source: SnapshotSource): Snapshot {
  const products: Record<string, Product> = {};
  for (const [key, rp] of Object.entries(raw.products ?? {})) {
    if (!isObj(rp) || !isObj(rp.quick_status)) continue;
    const id = key || (typeof rp.product_id === 'string' ? rp.product_id : '');
    if (!id) continue;
    // Hypixel naming is inverted: sell_summary holds BUY orders, buy_summary holds SELL offers.
    const bids = levels(rp.sell_summary, -1);
    const asks = levels(rp.buy_summary, 1);
    const q = quick(rp.quick_status);
    products[id] = {
      id,
      bid: bids[0]?.price ?? null,
      ask: asks[0]?.price ?? null,
      bids,
      asks,
      quick: q,
      instaBuysWeek: q.buyMovingWeek,
      instaSellsWeek: q.sellMovingWeek,
    };
  }
  return { lastUpdated: raw.lastUpdated, fetchedAt, source, products };
}
