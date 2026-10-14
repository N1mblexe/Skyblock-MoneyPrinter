// Enchanted book combining: 2^(L-k) books of level k -> one level L book (anvil). Owner: opportunities package.
// Combining costs no coins, only anvil uses and XP levels, which are not modelled here: profit = sell value - book cost.
import { BOOK } from '../config.ts';
import type { BookRow, CalcCtx, Product, RiskReport } from '../types/contracts.ts';
import { afterTax, buySide, planTrade, sellSide, type Leg, type TradePlan } from './pricing.ts';
import { assessRisk, combineRisk } from './risk.ts';

const BOOK_ID = /^(ENCHANTMENT_.+)_(\d+)$/;

/** 'ENCHANTMENT_ULTIMATE_WISE_5' -> {base:'ENCHANTMENT_ULTIMATE_WISE', level:5}; null when not a levelled book id. */
export function parseBookId(id: string): { base: string; level: number } | null {
  const m = BOOK_ID.exec(id);
  if (!m) return null;
  const level = Number(m[2]);
  return level >= 1 ? { base: m[1]!, level } : null;
}

const byKey = <K extends string | number>([a]: [K, unknown], [b]: [K, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/** Profitable combine rows, at most one per output book (cheapest input level); unverified rows included, views filter on `verified`. */
export function computeBookCombines(ctx: CalcCtx): BookRow[] {
  const { snap, catalog, settings } = ctx;
  const { costMode, sellMode, share, taxRate } = settings;
  const refine = costMode === 'insta' || sellMode === 'insta';

  // base -> level -> product
  const bases = new Map<string, Map<number, Product>>();
  for (const [id, p] of Object.entries(snap.products)) {
    const b = parseBookId(id);
    if (!b) continue;
    (bases.get(b.base) ?? bases.set(b.base, new Map()).get(b.base)!).set(b.level, p);
  }

  const riskMemo = new Map<string, RiskReport>();
  const risk = (id: string, p: Product): RiskReport => {
    let r = riskMemo.get(id);
    if (!r) riskMemo.set(id, (r = assessRisk(p, ctx.stats?.(id) ?? null)));
    return r;
  };
  const bookId = (base: string, level: number) => `${base}_${level}`;

  const rows: BookRow[] = [];
  for (const [base, levels] of [...bases].sort(byKey)) {
    const rule = catalog.bookRule(base);
    for (const [L, out] of [...levels].sort(byKey)) {
      const sell = (q: number): Leg | null => {
        const s = sellSide(out, sellMode, share, q);
        return s && { price: s.quote.price, net: afterTax(s.quote.price, taxRate), rate: s.rate, depth: s.depth, comp: s.comp };
      };
      let best: { k: number; count: number; input: Product; plan: TradePlan } | null = null;
      for (let k = L - 1; k >= 1 && L - k <= BOOK.maxChainLevels; k--) {
        const input = levels.get(k);
        if (!input) continue;
        const count = 2 ** (L - k);
        const inputId = bookId(base, k);
        // One unit = one output book: it costs `count` input books and drains the input's fill rate `count` times faster.
        const buy = (q: number): Leg | null => {
          const s = buySide(input, costMode, share, q * count, catalog.items[inputId]?.npcSell);
          if (!s) return null;
          const price = count * s.quote.price;
          return { price, net: price, rate: s.rate / count, depth: s.depth != null ? s.depth / count : undefined, comp: s.comp };
        };
        const plan = planTrade(buy, sell, settings, refine);
        if (!plan || !(plan.buy.net > 0) || !Number.isFinite(plan.profit)) continue;
        // Strict '>' keeps the shorter chain (visited first) on ties.
        if (!best || plan.profit > best.plan.profit) best = { k, count, input, plan };
      }
      if (!best || !(best.plan.profit > 0)) continue;
      const { k, count, input, plan } = best;
      const id = bookId(base, L);
      const inputId = bookId(base, k);
      rows.push({
        id,
        name: catalog.name(id),
        base,
        fromLevel: k,
        toLevel: L,
        inputId,
        count,
        buyAt: plan.buy.price / count,
        sellAt: plan.sell.price,
        cost: plan.buy.net,
        netSell: plan.sell.net,
        profit: plan.profit,
        margin: plan.profit / plan.buy.net,
        tp: plan.tp,
        profitPerHour: plan.tp.unitsPerHour * plan.profit,
        risk: combineRisk([risk(inputId, input), risk(id, out)]),
        verified: rule != null && rule.verified && L <= rule.maxLevel,
      });
    }
  }
  return rows;
}
