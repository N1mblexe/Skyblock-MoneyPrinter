// NPC / currency shop offers valued in coins (bits, copper, motes, ...). Owner: opportunities package.
import type { CalcCtx, ShopRow } from '../types/contracts.ts';
import { salesOf } from './market.ts';
import { bestSale } from './sale.ts';

/**
 * One row per catalog shop offer; rows whose output cannot be valued keep value/coinsPerCurrency null.
 * value = outQty x the output's best sale (sale.ts: bazaar after tax, AH after fees when scanned, NPC). For
 * SKYBLOCK_COIN offers coinsPerCurrency is a plain coins-out / coins-in ratio (> 1 means buying from the shop and
 * selling is profitable).
 */
export function computeShopRows(ctx: CalcCtx): ShopRow[] {
  const { catalog } = ctx;
  return catalog.shops.map((o) => {
    const q = o.outQty > 0 ? bestSale(ctx, o.output) : null;
    const value = q ? q.net * o.outQty : null;
    // the volume that absorbs your sales: the bazaar's on the used side, else measured AH sales over a week
    const ahWeek = q?.venue === 'ah' ? (salesOf(ctx, o.output)?.perHour ?? 0) * 24 * 7 : 0;
    return {
      key: `${o.shop}|${o.output}|${o.currency}|${o.costQty}`,
      id: o.output,
      name: catalog.name(o.output),
      shop: o.shop,
      currency: o.currency,
      costQty: o.costQty,
      outQty: o.outQty,
      value,
      valueSource: q?.venue ?? null,
      coinsPerCurrency: value != null && o.costQty > 0 ? value / o.costQty : null,
      weekVol: q?.venue === 'bazaar' ? (q.liquidity ?? 0) : ahWeek,
      risk: q?.risk ?? null,
    };
  });
}
