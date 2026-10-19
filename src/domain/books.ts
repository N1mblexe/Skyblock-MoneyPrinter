// Enchanted book combining: 2^(L-k) books of level k -> one level L book (anvil). Owner: opportunities package.
// Combining costs no coins, only anvil uses and XP levels, which are not modelled here: profit = sell value - book cost.
import { BOOK } from '../config.ts';
import type { BookRow, CalcCtx, Product } from '../types/contracts.ts';
import { coreOf, mergeCons, sideLeg } from './market.ts';
import { planTrade, tradePlanInputs, type Leg, type TradePlan } from './pricing.ts';
import { combineRisk, INGREDIENT_FLAGS, reportFromFlags } from './risk.ts';

const BOOK_ID = /^(ENCHANTMENT_.+)_(\d+)$/;

/** 'ENCHANTMENT_ULTIMATE_WISE_5' -> {base:'ENCHANTMENT_ULTIMATE_WISE', level:5}; null when not a levelled book id. */
export function parseBookId(id: string): { base: string; level: number } | null {
  const m = BOOK_ID.exec(id);
  if (!m) return null;
  const level = Number(m[2]);
  return level >= 1 ? { base: m[1]!, level } : null;
}

const byKey = <K extends string | number>([a]: [K, unknown], [b]: [K, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Profitable combine rows, at most one per output book: the input level with the highest profit per hour (ties keep
 * the shorter chain). Both legs are orders in order modes; the input order holds `count` books per output book.
 * Risk is the output's sell-side risk plus only the INGREDIENT_FLAGS of the input's buy side.
 * Unverified rows are included; views filter on `verified`.
 */
export function computeBookCombines(ctx: CalcCtx): BookRow[] {
  const { snap, catalog, settings } = ctx;
  const { sellMode, taxRate } = settings;
  const core = coreOf(ctx);

  // base -> level -> product
  const bases = new Map<string, Map<number, Product>>();
  for (const [id, p] of Object.entries(snap.products)) {
    const b = parseBookId(id);
    if (!b) continue;
    (bases.get(b.base) ?? bases.set(b.base, new Map()).get(b.base)!).set(b.level, p);
  }
  const bookId = (base: string, level: number) => `${base}_${level}`;

  // one pair of legs for the whole scan, reading the current output / input (no closures per book)
  let id = '';
  let inputId = '';
  let count = 1;
  const sell = (q: number): Leg | null => {
    const s = core.sell(id, q);
    return s && sideLeg(id, 'sell', s, taxRate);
  };
  // One unit = one output book: it costs `count` input books and drains the input's fill rate `count` times faster.
  const buy = (q: number): Leg | null => {
    const s = core.buy(inputId, q * count);
    if (!s) return null;
    const leg = sideLeg(inputId, 'buy', s, taxRate);
    leg.price = leg.net = count * s.quote.price;
    leg.rate = s.rate / count;
    if (s.depth != null) leg.depth = s.depth / count;
    leg.units = count;
    return leg;
  };

  const rows: BookRow[] = [];
  for (const [base, levels] of [...bases].sort(byKey)) {
    const rule = catalog.bookRule(base);
    for (const [L] of [...levels].sort(byKey)) {
      id = bookId(base, L);
      let best: { k: number; plan: TradePlan; pph: number } | null = null;
      for (let k = L - 1; k >= 1 && L - k <= BOOK.maxChainLevels; k--) {
        if (!levels.has(k)) continue;
        count = 2 ** (L - k);
        inputId = bookId(base, k);
        const plan = planTrade(buy, sell, settings);
        if (!plan || !(plan.buy.net > 0) || !(plan.profit > 0) || !Number.isFinite(plan.profit)) continue;
        const pph = plan.tp.unitsPerHour * plan.profit;
        // Strict '>' keeps the shorter chain (visited first) on ties.
        if (!best || pph > best.pph) best = { k, plan, pph };
      }
      if (!best) continue;
      const { k, plan } = best;
      count = 2 ** (L - k);
      inputId = bookId(base, k);
      const inRisk = core.risk(inputId, { buy: plan.buy.order ? 'order' : 'insta' })!;
      const row: BookRow = {
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
        risk: combineRisk([core.risk(id, { sell: sellMode })!, reportFromFlags(inRisk.flags.filter((f) => INGREDIENT_FLAGS.has(f)))]),
        verified: rule != null && rule.verified && L <= rule.maxLevel,
      };
      const cons = mergeCons(plan.buy.cons, plan.sell.cons);
      if (cons) row.cons = cons;
      const pi = tradePlanInputs(buy, sell, settings);
      if (pi) row.plan = pi;
      rows.push(row);
    }
  }
  return rows;
}
