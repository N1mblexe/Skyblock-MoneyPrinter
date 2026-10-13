import { NPC_BUY_RATE_PER_HOUR } from '../config.ts';
import type { CalcCtx, NpcFlipRow } from '../types/contracts.ts';
import { afterTax, buySide, planTrade, sellSide, type Leg } from './pricing.ts';
import { assessRisk } from './risk.ts';

/** Profitable bz2npc and npc2bz flips. */
export function computeNpcFlips(ctx: CalcCtx): NpcFlipRow[] {
  const { snap, catalog, settings } = ctx;
  const { costMode, sellMode, share, taxRate } = settings;
  const rows: NpcFlipRow[] = [];
  for (const [id, p] of Object.entries(snap.products)) {
    const info = catalog.items[id];
    if (!info) continue;
    let risk: NpcFlipRow['risk'] | undefined;
    const push = (direction: NpcFlipRow['direction'], plan: ReturnType<typeof planTrade>) => {
      if (!plan || !(plan.profit > 0) || !(plan.buy.net > 0)) return;
      risk ??= assessRisk(p, ctx.stats?.(id) ?? null);
      rows.push({
        id,
        name: catalog.name(id),
        direction,
        buyAt: plan.buy.net,
        sellAt: plan.sell.net,
        profit: plan.profit,
        margin: plan.profit / plan.buy.net,
        tp: plan.tp,
        profitPerHour: plan.tp.unitsPerHour * plan.profit,
        risk,
      });
    };

    const ns = info.npcSell;
    if (ns != null && ns > 0) {
      const buy = (q: number): Leg | null => {
        const s = buySide(p, costMode, share, q, ns);
        return s && { price: s.quote.price, net: s.quote.price, rate: s.rate, depth: s.depth };
      };
      const sell = (): Leg => ({ price: ns, net: ns, rate: Infinity });
      push('bz2npc', planTrade(buy, sell, settings, costMode === 'insta'));
    }

    const nb = info.npcBuy;
    if (nb != null && nb > 0) {
      const buy = (): Leg => ({ price: nb, net: nb, rate: NPC_BUY_RATE_PER_HOUR });
      const sell = (q: number): Leg | null => {
        const s = sellSide(p, sellMode, share, q);
        return s && { price: s.quote.price, net: afterTax(s.quote.price, taxRate), rate: s.rate, depth: s.depth };
      };
      push('npc2bz', planTrade(buy, sell, settings, sellMode === 'insta'));
    }
  }
  return rows;
}
