// NPC / currency shop offers valued in coins (bits, copper, motes, ...). Owner: opportunities package.
import type { CalcCtx, ShopRow } from '../types/contracts.ts';
import { afterTax, sellQuote } from './pricing.ts';
import { assessRisk } from './risk.ts';

/**
 * One row per catalog shop offer; rows whose output cannot be valued keep value/coinsPerCurrency null.
 * value = outQty x max(bazaar sell quote after tax, NPC sell price). For SKYBLOCK_COIN offers coinsPerCurrency
 * is a plain coins-out / coins-in ratio (> 1 means buying from the shop and selling is profitable).
 */
export function computeShopRows(ctx: CalcCtx): ShopRow[] {
  const { snap, catalog, settings } = ctx;
  const { sellMode, taxRate } = settings;
  return catalog.shops.map((o) => {
    const p = snap.products[o.output];
    const sq = p ? sellQuote(p, sellMode) : null;
    const bzUnit = sq && sq.price > 0 && Number.isFinite(sq.price) ? afterTax(sq.price, taxRate) : null;
    const ns = catalog.items[o.output]?.npcSell;
    const npcUnit = ns != null && ns > 0 ? ns : null;

    let unit: number | null = null;
    let valueSource: ShopRow['valueSource'] = null;
    if (bzUnit != null && (npcUnit == null || bzUnit >= npcUnit)) {
      unit = bzUnit;
      valueSource = 'bazaar';
    } else if (npcUnit != null) {
      unit = npcUnit;
      valueSource = 'npc';
    }
    const value = unit != null && o.outQty > 0 ? unit * o.outQty : null;
    const bz = value != null && valueSource === 'bazaar' ? p! : null;
    return {
      key: `${o.shop}|${o.output}|${o.currency}|${o.costQty}`,
      id: o.output,
      name: catalog.name(o.output),
      shop: o.shop,
      currency: o.currency,
      costQty: o.costQty,
      outQty: o.outQty,
      value,
      valueSource: value != null ? valueSource : null,
      coinsPerCurrency: value != null && o.costQty > 0 ? value / o.costQty : null,
      // the volume that absorbs your sales: sell offers fill from insta-buys, insta-selling hits buy orders
      weekVol: bz ? (sellMode === 'offer' ? bz.instaBuysWeek : bz.instaSellsWeek) || 0 : 0,
      risk: bz ? assessRisk(bz, ctx.stats?.(o.output) ?? null) : null,
    };
  });
}
