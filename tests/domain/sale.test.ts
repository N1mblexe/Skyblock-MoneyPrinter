import { describe, expect, it } from 'vitest';
import { AH_FLIP, AH_SALES } from '../../src/config.ts';
import { ahNet, sellSide } from '../../src/domain/pricing.ts';
import { assessRisk, reportFromFlags } from '../../src/domain/risk.ts';
import { ahFlags, bestSale, isAuctionable, saleQuotes } from '../../src/domain/sale.ts';
import type { AhPrice, AhSalesStat, CalcCtx, Catalog, Product } from '../../src/types/contracts.ts';
import { baseSettings, catalog, makeProduct } from './helpers.ts';

const B = makeProduct({ id: 'B' });
const BAH = makeProduct({ id: 'BAH' });
const EMPTY = makeProduct({ id: 'EMPTY', bids: [], asks: [], bid: null, ask: null });
const products: Record<string, Product> = { B, BAH, EMPTY };
const TIE = 104.9 * (1 - baseSettings.taxRate);
const cat: Catalog = {
  ...catalog,
  items: {
    ...catalog.items,
    B: { id: 'B', name: 'B', bazaar: true, npcSell: 50, auctionable: false },
    BAH: { id: 'BAH', name: 'Both', bazaar: true, npcSell: TIE, auctionable: true },
    SWORDY: { id: 'SWORDY', name: 'Sword', bazaar: false, npcSell: 5, auctionable: true, category: 'SWORD' },
    PLAIN: { id: 'PLAIN', name: 'Plain', bazaar: false, auctionable: true },
    SOULBOUND: { id: 'SOULBOUND', name: 'Soulbound', bazaar: false, npcSell: 7, auctionable: false },
  },
};
const AH: Record<string, AhPrice> = {
  B: { price: 5000, count: 50 },
  BAH: { price: 90, count: 10 },
  SWORDY: { price: 1000, count: 5, next: 1200 },
  PLAIN: { price: 1000, count: 2, next: 4000 },
  SOULBOUND: { price: 1000, count: 10 },
  UNKNOWN: { price: 300, count: 10 },
  CHEAP: { price: 1, count: 10 },
  BIG: { price: 50_000_000, count: 10 },
};
const sctx = (over: Partial<CalcCtx['settings']> = {}, extra: Partial<CalcCtx> = {}): CalcCtx => ({
  snap: { lastUpdated: 0, fetchedAt: 0, source: 'fixture', products },
  catalog: cat,
  settings: { ...baseSettings, ...over },
  ah: (id) => AH[id] ?? null,
  ...extra,
});
const sales = (o: Partial<AhSalesStat> = {}): AhSalesStat => ({ n: 10, items: 10, median: 900, perHour: 2, coverageHours: 3, last: 0, ...o });

describe('ahFlags', () => {
  it('thin market, a gap to the next price, a variant category', () => {
    expect(ahFlags(AH.SWORDY!, cat, 'SWORDY')).toEqual(['AH_VARIANT']);
    expect(ahFlags(AH.PLAIN!, cat, 'PLAIN')).toEqual(['AH_THIN', 'AH_GAP']);
    expect(ahFlags({ price: 10, count: 3, next: 30 }, cat, 'PLAIN')).toEqual([]); // exactly gapRatio: no gap
    expect(ahFlags({ price: 10, count: 3 }, cat, 'UNKNOWN')).toEqual([]);
  });
});

describe('isAuctionable', () => {
  it('the catalog flag, else (unknown item) not a bazaar product', () => {
    const c = sctx();
    expect(isAuctionable(c, 'SWORDY')).toBe(true);
    expect(isAuctionable(c, 'B')).toBe(false);
    expect(isAuctionable(c, 'UNKNOWN')).toBe(true);
    const unknownBz = { ...c, snap: { ...c.snap, products: { ...products, ZZ: makeProduct({ id: 'ZZ' }) } } };
    expect(isAuctionable(unknownBz, 'ZZ')).toBe(false);
  });
});

describe('saleQuotes: bazaar', () => {
  it('sell offer: after tax, your sell rate, sell-side risk; the NPC after it', () => {
    const qs = saleQuotes(sctx(), 'B');
    const side = sellSide(B, 'offer', baseSettings.share)!;
    expect(qs.map((q) => q.venue)).toEqual(['bazaar', 'npc']); // B is not auctionable: its AH price is ignored
    expect(qs[0]).toEqual({
      venue: 'bazaar',
      gross: 104.9,
      fees: expect.closeTo(104.9 * baseSettings.taxRate, 9),
      net: expect.closeTo(TIE, 9),
      rate: side.rate,
      limitedBy: 'volume',
      liquidity: B.instaBuysWeek,
      risk: assessRisk(B, null, { sell: 'offer' }),
    });
    expect(qs[1]).toEqual({ venue: 'npc', gross: 50, fees: 0, net: 50, rate: Infinity, liquidity: null, risk: null });
  });

  it('insta-sell: re-quoted at qty, depth and the insta-sell volume', () => {
    const [q] = saleQuotes(sctx({ sellMode: 'insta' }), 'B', { qty: 7000 });
    expect(q!.gross).toBeCloseTo((5000 * 100 + 2000 * 99.9) / 7000, 9);
    expect(q!.depth).toBe(10_000);
    expect(q!.liquidity).toBe(B.instaSellsWeek);
  });

  it('conservatism shows in cons', () => {
    const c = sctx({ conservative: true }, { stats: () => ({ n: 20, medianAsk: 104, medianBid: 100, madAsk: 1, madBid: 1, change24h: 0 }) });
    const [q] = saleQuotes(c, 'B');
    expect(q!.gross).toBe(103.9);
    expect(q!.cons).toEqual({ sellRef: 104.9 });
  });

  it('an empty book has no bazaar sale', () => {
    expect(saleQuotes(sctx(), 'EMPTY')).toEqual([]);
  });
});

describe('saleQuotes: AH', () => {
  it('auctionable only: listed at the lowest BIN - undercut, net of the AH fees, default rate, flags', () => {
    const qs = saleQuotes(sctx(), 'SWORDY');
    const list = 1000 - AH_FLIP.undercut;
    expect(qs.map((q) => q.venue)).toEqual(['ah', 'npc']);
    expect(qs[0]).toEqual({
      venue: 'ah',
      gross: list,
      fees: list - ahNet(list),
      net: ahNet(list),
      rate: AH_SALES.defaultPerHour,
      limitedBy: 'ahSales',
      liquidity: 5,
      risk: reportFromFlags(['AH_VARIANT']),
      next: 1200,
    });
    expect(saleQuotes(sctx(), 'SOULBOUND').map((q) => q.venue)).toEqual(['npc']);
    expect(saleQuotes(sctx(), 'UNKNOWN')[0]!.venue).toBe('ah');
    expect(saleQuotes(sctx(), 'UNKNOWN')[0]!.next).toBeUndefined();
  });

  it('the measured sales rate x share (at least the next sale) once coverage reaches AH_SALES.minCoverageHours', () => {
    const rate = (s: AhSalesStat | null) => saleQuotes(sctx({}, { ahSales: () => s }), 'SWORDY')[0]!.rate;
    expect(rate(sales())).toBe(Math.min(2, AH_SALES.defaultPerHour));
    expect(rate(sales({ perHour: 100 }))).toBeCloseTo(100 * baseSettings.share, 12);
    expect(rate(sales({ perHour: null }))).toBe(AH_SALES.defaultPerHour);
    expect(rate(sales({ coverageHours: AH_SALES.minCoverageHours - 1 }))).toBe(AH_SALES.defaultPerHour);
    expect(rate(null)).toBe(AH_SALES.defaultPerHour);
    // nothing sold over the coverage (salesLookup's zero stat): rate 0, and no median cap
    const none: AhSalesStat = { n: 0, items: 0, median: 0, perHour: 0, coverageHours: 3, last: 0 };
    const dead = saleQuotes(sctx({ conservative: true }, { ahSales: () => none }), 'SWORDY', { venues: ['ah'] })[0]!;
    expect(dead).toMatchObject({ rate: 0, gross: 999 });
  });

  it('conservatism lists at no more than the median sold price, given enough sales and coverage', () => {
    const gross = (on: boolean, s: AhSalesStat) => saleQuotes(sctx({ conservative: on }, { ahSales: () => s }), 'SWORDY')[0]!.gross;
    expect(gross(true, sales())).toBe(900);
    expect(gross(false, sales())).toBe(999);
    expect(gross(true, sales({ n: AH_SALES.minSales - 1 }))).toBe(999);
    expect(gross(true, sales({ coverageHours: 1 }))).toBe(999);
    expect(gross(true, sales({ median: 0 }))).toBe(999);
    expect(gross(true, sales({ median: 5000 }))).toBe(999); // never above the listing
  });

  it('Derpy quadruples the claim tax on a big sale; a listing at or below the undercut is skipped', () => {
    const list = 50_000_000 - AH_FLIP.undercut;
    expect(saleQuotes(sctx({}, { derpy: true }), 'BIG')[0]!.net).toBeCloseTo(ahNet(list, true), 6);
    expect(saleQuotes(sctx({}, { derpy: true }), 'BIG')[0]!.net).toBeLessThan(ahNet(list));
    expect(saleQuotes(sctx(), 'CHEAP')).toEqual([]);
  });

  it('no scan, no listing', () => {
    expect(saleQuotes(sctx({}, { ah: undefined }), 'SWORDY').map((q) => q.venue)).toEqual(['npc']);
    expect(saleQuotes(sctx(), 'PLAIN')[0]!.risk!.level).toBe('suspect'); // thin and gapped
  });
});

describe('saleQuotes: ordering and venues', () => {
  it('best net first; ties keep bazaar > AH > NPC', () => {
    // BAH: bazaar net = NPC price, AH far below
    expect(saleQuotes(sctx(), 'BAH').map((q) => q.venue)).toEqual(['bazaar', 'npc', 'ah']);
    const both: Record<string, AhPrice> = { ...AH, BAH: { price: 104.9 * (1 - baseSettings.taxRate) + AH_FLIP.undercut, count: 10 } };
    const tied = saleQuotes(sctx({}, { ah: (id) => both[id] ?? null }), 'BAH');
    expect(tied.map((q) => q.venue)).toEqual(['bazaar', 'npc', 'ah']); // the AH fee puts it below
    expect(saleQuotes(sctx(), 'B', { venues: ['npc'] }).map((q) => q.venue)).toEqual(['npc']);
    expect(saleQuotes(sctx(), 'B', { venues: ['ah', 'bazaar'] }).map((q) => q.venue)).toEqual(['bazaar']);
  });

  it('bestSale: the first quote, or null', () => {
    expect(bestSale(sctx(), 'B')!.venue).toBe('bazaar');
    expect(bestSale(sctx(), 'SWORDY')!.venue).toBe('ah');
    expect(bestSale(sctx(), 'NOWHERE')).toBeNull();
    // an AH that sold nothing over the coverage comes after every venue that sells
    const none = () => ({ n: 0, items: 0, median: 0, perHour: 0, coverageHours: 3, last: 0 });
    expect(saleQuotes(sctx({}, { ahSales: none }), 'SWORDY').map((q) => q.venue)).toEqual(['npc', 'ah']);
    expect(bestSale(sctx({}, { ahSales: none }), 'SWORDY', { venues: ['ah'] })).toMatchObject({ venue: 'ah', rate: 0 });
  });
});
