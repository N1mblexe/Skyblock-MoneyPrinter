import { describe, expect, it } from 'vitest';
import { BOOK, CONSERVATIVE, MAX_ORDER_UNITS } from '../../src/config.ts';
import { computeBookCombines, parseBookId } from '../../src/domain/books.ts';
import { effShare } from '../../src/domain/pricing.ts';
import { assessRisk, combineRisk, INGREDIENT_FLAGS, reportFromFlags } from '../../src/domain/risk.ts';
import type { BookRule, CalcCtx, Catalog, MarketStat, Product, Snapshot } from '../../src/types/contracts.ts';
import { baseSettings, catalog, ctx, makeProduct, stats, type ProductOverrides } from './helpers.ts';

const lvl = (price: number, amount = 5000, orders = 10) => ({ price, amount, orders });
/** Book product with a bid/ask pair (order mode buys at bid+0.1, offer mode sells at ask-0.1). */
const book = (id: string, bid: number | null, ask: number, over: ProductOverrides = {}): Product =>
  makeProduct({
    id,
    bids: bid == null ? [] : [lvl(bid), lvl(bid - 0.1)],
    asks: [lvl(ask), lvl(ask + 0.1)],
    quick: { buyPrice: ask, sellPrice: bid ?? 0 },
    ...over,
  });

const SH = 'ENCHANTMENT_SHARPNESS';
const UW = 'ENCHANTMENT_ULTIMATE_WISE';
const T = 'ENCHANTMENT_TEST';
const TABLE = 'ENCHANTMENT_TABLE_ONLY';

const products: Product[] = [
  // Sharpness: curated max 5, so 6 and 7 are unverified.
  book(`${SH}_5`, 140, 150),
  book(`${SH}_6`, 250, 300),
  book(`${SH}_7`, 700, 800),
  // Ultimate Wise (base has an underscore): 4 -> 5 within the curated max.
  book(`${UW}_4`, 1000, 1100, { quick: { buyOrders: 1 } }),
  book(`${UW}_5`, 2500, 2600),
  // Chain test: cheapest input level wins, chains longer than BOOK.maxChainLevels are ignored.
  book(`${T}_1`, 10, 12, { instaSellsWeek: 16_800 }),
  book(`${T}_3`, 50, 60),
  book(`${T}_4`, 120, 125),
  book(`${T}_5`, 300, 500, { instaBuysWeek: 10_000_000 }),
  book(`${T}_6`, 380, 400),
  // Rule exists but only from the enchanting table (verified:false).
  book(`${TABLE}_1`, 10, 11),
  book(`${TABLE}_2`, 40, 50),
  // No rule at all; and an input without bids (unpriceable in order mode).
  book('ENCHANTMENT_NORULE_1', 10, 11),
  book('ENCHANTMENT_NORULE_2', 40, 50),
  book('ENCHANTMENT_DEAD_1', null, 11),
  book('ENCHANTMENT_DEAD_2', 40, 50),
  // Not books / not levelled.
  makeProduct({ id: 'ENCHANTED_MELON' }),
  makeProduct({ id: 'ENCHANTMENT_ZERO_0' }),
];

const rules: Record<string, BookRule> = {
  [SH]: { maxLevel: 5, verified: true },
  [UW]: { maxLevel: 5, verified: true },
  [T]: { maxLevel: 10, verified: true },
  [TABLE]: { maxLevel: 7, verified: false },
};

const snap: Snapshot = {
  lastUpdated: 0,
  fetchedAt: 0,
  source: 'fixture',
  products: Object.fromEntries(products.map((p) => [p.id, p])),
};
const cat: Catalog = { ...catalog, bookRule: (b) => rules[b] ?? null };
const bctx = (over: Partial<CalcCtx['settings']> = {}, extra: Partial<CalcCtx> = {}): CalcCtx => ({
  snap,
  catalog: cat,
  settings: { ...baseSettings, capital: 0, ...over },
  ...extra,
});

describe('parseBookId', () => {
  it('parses the trailing level, even when the base contains underscores or digits', () => {
    expect(parseBookId('ENCHANTMENT_ULTIMATE_WISE_5')).toEqual({ base: UW, level: 5 });
    expect(parseBookId('ENCHANTMENT_TURBO_WHEAT_10')).toEqual({ base: 'ENCHANTMENT_TURBO_WHEAT', level: 10 });
    expect(parseBookId('ENCHANTMENT_X2_3')).toEqual({ base: 'ENCHANTMENT_X2', level: 3 });
  });
  it('rejects non-books and level 0', () => {
    expect(parseBookId('ENCHANTED_MELON')).toBeNull();
    expect(parseBookId('ENCHANTMENT_SHARPNESS')).toBeNull();
    expect(parseBookId('ENCHANTMENT_ZERO_0')).toBeNull();
  });
});

describe('computeBookCombines', () => {
  const rows = computeBookCombines(bctx());
  const byId = new Map(rows.map((r) => [r.id, r]));

  it('emits at most one row per output, only profitable ones', () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.profit).toBeGreaterThan(0);
      expect(r.count).toBe(2 ** (r.toLevel - r.fromLevel));
      expect(r.toLevel - r.fromLevel).toBeLessThanOrEqual(BOOK.maxChainLevels);
      expect(r.cost).toBeCloseTo(r.count * r.buyAt, 9);
      expect(r.profitPerHour).toBeCloseTo(r.tp.unitsPerHour * r.profit, 9);
      expect(Number.isFinite(r.margin)).toBe(true);
    }
    expect(byId.has('ENCHANTED_MELON')).toBe(false);
    expect(byId.has(`${T}_1`)).toBe(false); // nothing below level 1
  });

  it('Sharpness 6 -> 7 above the curated max is unverified', () => {
    const r = byId.get(`${SH}_7`)!;
    expect(r).toBeDefined();
    expect(r.base).toBe(SH);
    expect(r.fromLevel).toBe(6); // 2 x 250.1 = 500.2 beats 4 x 140.1 = 560.4
    expect(r.inputId).toBe(`${SH}_6`);
    expect(r.verified).toBe(false);
  });

  it('5 -> 6 within the rules is verified; above the max is not', () => {
    const uw = byId.get(`${UW}_5`)!;
    expect(uw.verified).toBe(true);
    expect(uw.fromLevel).toBe(4);
    expect(uw.inputId).toBe(`${UW}_4`);
    expect(uw.count).toBe(2);
    expect(uw.buyAt).toBeCloseTo(1000.1, 9);
    expect(uw.sellAt).toBeCloseTo(2599.9, 9);
    expect(uw.netSell).toBeCloseTo(2599.9 * (1 - baseSettings.taxRate), 9);
    expect(uw.profit).toBeCloseTo(2599.9 * (1 - baseSettings.taxRate) - 2000.2, 6);
    expect(uw.margin).toBeCloseTo(uw.profit / 2000.2, 9);
    expect(byId.get(`${SH}_6`)!.verified).toBe(false);
    expect(byId.get(`${SH}_7`)!.verified).toBe(false);
    expect(byId.get(`${TABLE}_2`)!.verified).toBe(false); // rule not curated
    expect(byId.get('ENCHANTMENT_NORULE_2')!.verified).toBe(false); // no rule
  });

  it('a chain picks the input level with the highest profit per hour, not the cheapest', () => {
    // 16 x 10.1 = 161.6 from level 1 is the cheapest, but level 1 trades 16,800 a week: 2 x 120.1 from level 4 fills
    // ~47x faster and earns more per hour
    const r5 = byId.get(`${T}_5`)!;
    expect(r5.fromLevel).toBe(4);
    expect(r5.count).toBe(2);
    expect(r5.cost).toBeCloseTo(240.2, 9);
    expect(byId.get(`${T}_4`)!.fromLevel).toBe(3); // 2 x 50.1 at level 3's volume beats 8 x 10.1
    expect(byId.get(`${T}_3`)!.fromLevel).toBe(1); // the only input level
  });

  it('the cheapest input level wins when its volume keeps up', () => {
    // 16 x the volume of level 4 per output book: 1.6M a week / 16 vs 100k / 2
    const eq = { ...snap, products: { ...snap.products, [`${T}_1`]: book(`${T}_1`, 10, 12, { instaSellsWeek: 1_600_000 }) } };
    const r5 = computeBookCombines({ ...bctx(), snap: eq }).find((r) => r.id === `${T}_5`)!;
    expect(r5.fromLevel).toBe(1);
    expect(r5.cost).toBeCloseTo(161.6, 9);
  });

  it('respects BOOK.maxChainLevels (level 6 would only profit from level 1 = 32 books)', () => {
    // 32 x 10.1 = 323.2 would be profitable at 399.9 sell, but L-k = 5 > 4; every allowed k loses.
    expect(byId.has(`${T}_6`)).toBe(false);
  });

  it('divides the input fill rate by the book count', () => {
    const r = byId.get(`${T}_5`)!;
    const input = snap.products[`${T}_4`]!;
    const rBuy = (input.instaSellsWeek / 168) * effShare(baseSettings.share, 20);
    expect(r.tp.unitsPerHour).toBeGreaterThan(rBuy / (2 * r.count));
    expect(r.tp.unitsPerHour).toBeLessThanOrEqual((rBuy / r.count) * (1 + 1e-9));
  });

  it('both legs are orders: the input order holds `count` books per output book', () => {
    const r = byId.get(`${T}_5`)!;
    expect(r.tp.slots).toBe(2);
    expect(r.plan!.orderUnits).toEqual([r.count, 1]);
    expect(r.plan!.uses).toEqual([
      { key: `${T}_4:bid`, perUnit: r.count },
      { key: `${T}_5:ask`, perUnit: 1 },
    ]);
    // 71,680 / 2 = 35,840 output books fill one input order
    const big = computeBookCombines(bctx({ cycleHours: 1e6, orderSlots: 3 })).find((x) => x.id === `${T}_5`)!;
    expect(big.tp.limitedBy).toBe('slots');
    expect(big.tp.slots).toBeLessThanOrEqual(3);
    expect(big.tp.batchQty * big.count).toBeLessThanOrEqual(2 * MAX_ORDER_UNITS + 1e-6);
  });

  it('conservatism: the input churn counts per output book, like the input price; buyRef stays per book', () => {
    // history agrees with the snapshot; only the input's bids move (one re-list per hour)
    const hist = { stats: (id: string) => stats({ medianBid: snap.products[id]!.bid!, medianAsk: snap.products[id]!.ask! }) };
    const moves = (id: string): MarketStat => ({
      id,
      n: 20,
      change1h: null,
      change24h: null,
      volatility: null,
      spreadMedian: null,
      consistency: null,
      buyVolTrend: null,
      sellVolTrend: null,
      bidMovesPerHour: id.startsWith(T) && id !== `${T}_5` ? 1 : 0,
    });
    const r = computeBookCombines(bctx({ conservative: true }, { ...hist, market: moves })).find((x) => x.id === `${T}_5`)!;
    const input = snap.products[r.inputId]!;
    const order = Math.round((input.bid! + 0.1) * 10) / 10;
    const churn = Math.max(0.1, CONSERVATIVE.relistStep * order);
    expect(r.count).toBeGreaterThan(1);
    expect(r.buyAt).toBeCloseTo(order + churn, 9);
    expect(r.cost).toBeCloseTo(r.count * (order + churn), 9);
    expect(r.cons).toEqual({ buyRef: order, churn: expect.closeTo(r.count * churn, 9) });
  });

  it('skips inputs that cannot be priced', () => {
    expect(byId.has('ENCHANTMENT_DEAD_2')).toBe(false);
  });

  it('risk: the output sell side plus only the INGREDIENT_FLAGS of the input (stats feed in)', () => {
    const r = byId.get(`${UW}_5`)!;
    const inRisk = assessRisk(snap.products[`${UW}_4`]!, null, { buy: 'order' });
    const outRisk = assessRisk(snap.products[`${UW}_5`]!, null, { sell: 'offer' });
    expect(assessRisk(snap.products[`${UW}_4`]!, null).flags).toContain('FEW_ORDERS'); // side-blind: few sell offers
    expect(inRisk.flags).toContain('QUICK_DIVERGENCE');
    expect(r.risk).toEqual(combineRisk([outRisk, reportFromFlags(inRisk.flags.filter((f) => INGREDIENT_FLAGS.has(f)))]));
    expect(r.risk.flags).toContain('QUICK_DIVERGENCE');
    expect(r.risk.flags).not.toContain('FEW_ORDERS');
    // an input price spike is carried over
    const spiked = computeBookCombines(bctx({}, { stats: (id) => (id === `${UW}_4` ? stats({ medianAsk: 500, medianBid: 480 }) : stats()) }));
    expect(spiked.find((x) => x.id === `${UW}_5`)!.risk.flags).toContain('PRICE_SPIKE');
    const withStats = computeBookCombines(bctx({}, { stats: () => stats() }));
    expect(withStats.find((x) => x.id === `${UW}_5`)!.risk.flags).not.toContain('NO_HISTORY');
    expect(r.risk.flags).toContain('NO_HISTORY');
  });

  it('insta modes walk the book (depth scaled to output books)', () => {
    const insta = computeBookCombines(bctx({ costMode: 'insta', sellMode: 'insta' }));
    expect(insta.length).toBeGreaterThan(0);
    for (const r of insta) {
      const input = snap.products[r.inputId]!;
      expect(r.buyAt).toBeGreaterThanOrEqual(input.ask!);
      expect(r.tp.batchQty * r.count).toBeLessThanOrEqual(input.asks.reduce((s, l) => s + l.amount, 0) + 1e-9);
    }
  });

  it('real fixture: runs without NaN (it has no complete chains)', () => {
    const real = computeBookCombines({ ...ctx(), catalog: { ...ctx().catalog, bookRule: () => ({ maxLevel: 5, verified: true }) } });
    for (const r of real) expect(Number.isFinite(r.profitPerHour)).toBe(true);
  });
});
