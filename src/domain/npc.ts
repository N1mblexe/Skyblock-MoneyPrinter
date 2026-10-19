import type { CalcCtx, NpcFlipRow } from '../types/contracts.ts';
import { coreOf, mergeCons, sideLeg, type NpcLeg, type RiskUse } from './market.ts';
import { planTrade, tradePlanInputs, type Leg } from './pricing.ts';

/**
 * Profitable bz2npc and npc2bz flips. Each row's risk covers only the bazaar side it trades: the buy side for
 * bazaar -> NPC, the sell side for NPC -> bazaar. An NPC purchase is instant, capped at npcDailyLimit / 24 per hour.
 */
export function computeNpcFlips(ctx: CalcCtx): NpcFlipRow[] {
  const { snap, catalog, settings } = ctx;
  const { costMode, sellMode, taxRate } = settings;
  const core = coreOf(ctx);
  const rows: NpcFlipRow[] = [];
  const buyUse = { buy: costMode };
  const sellUse = { sell: sellMode };
  // one set of legs for the whole scan, reading the current item (no closures per product)
  let id = '';
  let npcSell = 0;
  let npc: NpcLeg | null = null;
  const bzBuy = (q: number): Leg | null => {
    const s = core.buy(id, q);
    return s && sideLeg(id, 'buy', s, taxRate);
  };
  const npcSale = (): Leg => ({ price: npcSell, net: npcSell, rate: Infinity });
  const npcBuy = (): Leg => ({ price: npc!.price, net: npc!.price, rate: Infinity, cap: npc!.rate, bound: 'npcLimit', res: `${id}:npc` });
  const bzSell = (q: number): Leg | null => {
    const s = core.sell(id, q);
    return s && sideLeg(id, 'sell', s, taxRate);
  };
  const push = (
    direction: NpcFlipRow['direction'],
    buy: (q: number) => Leg | null,
    sell: (q: number) => Leg | null,
    use: RiskUse,
  ) => {
    const plan = planTrade(buy, sell, settings);
    if (!plan || !(plan.profit > 0) || !(plan.buy.net > 0)) return;
    const row: NpcFlipRow = {
      id,
      name: catalog.name(id),
      direction,
      buyAt: plan.buy.net,
      sellAt: plan.sell.net,
      profit: plan.profit,
      margin: plan.profit / plan.buy.net,
      tp: plan.tp,
      profitPerHour: plan.tp.unitsPerHour * plan.profit,
      risk: core.risk(id, use)!,
    };
    const cons = mergeCons(plan.buy.cons, plan.sell.cons);
    if (cons) row.cons = cons;
    const pi = tradePlanInputs(buy, sell, settings);
    if (pi) row.plan = pi;
    rows.push(row);
  };

  for (const pid of Object.keys(snap.products)) {
    const info = catalog.items[pid];
    if (!info) continue;
    id = pid;
    if (info.npcSell != null && info.npcSell > 0) {
      npcSell = info.npcSell;
      push('bz2npc', bzBuy, npcSale, buyUse);
    }
    npc = core.npcBuy(id);
    if (npc) push('npc2bz', npcBuy, bzSell, sellUse);
  }
  return rows;
}
