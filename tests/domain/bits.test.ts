import { describe, expect, it } from 'vitest';
import { AH, BITS } from '../../src/config.ts';
import { bitsMultiplier, bitsQuotes, computeBitsRows, fameMultiplier, type BitsRow } from '../../src/domain/bits.ts';
import { afterTax, ahNet } from '../../src/domain/pricing.ts';
import { assessRisk } from '../../src/domain/risk.ts';
import type { AhPrice, CalcCtx, Catalog, ItemInfo, ShopOffer, Snapshot } from '../../src/types/contracts.ts';
import { baseSettings, catalog, makeProduct, stats } from './helpers.ts';

const item = (id: string, o: Partial<ItemInfo> = {}): ItemInfo => ({ id, name: id, bazaar: false, ...o });
const bit = (output: string, costQty: number, outQty = 1): ShopOffer => ({ shop: 'Elizabeth', currency: BITS.currency, costQty, output, outQty });

const snap: Snapshot = {
  lastUpdated: 0,
  fetchedAt: 0,
  source: 'fixture',
  products: {
    BOOSTER_COOKIE: makeProduct({
      id: 'BOOSTER_COOKIE',
      bids: [{ price: 2_000_000, amount: 500, orders: 20 }],
      asks: [{ price: 2_100_000, amount: 500, orders: 20 }],
    }),
    // on the bazaar and the AH: the AH pays more
    KISMET: makeProduct({
      id: 'KISMET',
      bids: [{ price: 1_400_000, amount: 50, orders: 10 }],
      asks: [{ price: 1_500_000, amount: 50, orders: 10 }],
      instaBuysWeek: 7000,
      instaSellsWeek: 3000,
    }),
    // plain healthy bazaar item (offer 104.9)
    BOOK: makeProduct({ id: 'BOOK' }),
    // the bazaar pays less than the NPC
    CHEAP: makeProduct({ id: 'CHEAP', asks: [{ price: 5, amount: 10, orders: 1 }], bids: [{ price: 4, amount: 10, orders: 1 }] }),
    // 8 per offer
    FUEL: makeProduct({ id: 'FUEL', bids: [{ price: 900, amount: 5000, orders: 10 }], asks: [{ price: 1000, amount: 5000, orders: 10 }] }),
    // no buy orders: DEAD_BID -> suspect, yet the highest coins per bit
    DEAD: makeProduct({ id: 'DEAD', bids: [], bid: null, asks: [{ price: 9_000_000, amount: 1, orders: 1 }] }),
    // no sell offers: offer mode cannot value it
    NO_ASK: makeProduct({ id: 'NO_ASK', asks: [], ask: null }),
  },
};

const ahPrices: Record<string, AhPrice> = {
  KISMET: { price: 1_600_000, next: 1_700_000, count: 12 },
  // AH only, one listing, second price far above
  GOD: { price: 2_000_000, next: 9_000_000, count: 1 },
  WAND: { price: 300_000, count: 4 },
  SACK: { price: 50_000_000, count: 9 },
};

const offers: ShopOffer[] = [
  bit('KISMET', 1350),
  bit('BOOK', 1),
  bit('CHEAP', 1),
  bit('FUEL', 75, 8),
  bit('DEAD', 1),
  bit('GOD', 1500),
  bit('WAND', 12_000),
  bit('SACK', 14_000),
  bit('NOTHING', 500),
  bit('NO_ASK', 100),
  bit('ZERO_OUT', 10, 0),
  bit('BOOK', 0),
  { shop: 'Adventurer', currency: 'SKYBLOCK_COIN', costQty: 10, output: 'BOOK', outQty: 1 },
];

const cat: Catalog = {
  ...catalog,
  items: {
    ...catalog.items,
    BOOSTER_COOKIE: item('BOOSTER_COOKIE', { bazaar: true }),
    KISMET: item('KISMET', { name: 'Kismet Feather', bazaar: true, auctionable: true }),
    BOOK: item('BOOK', { bazaar: true }),
    CHEAP: item('CHEAP', { bazaar: true, npcSell: 6 }),
    FUEL: item('FUEL', { bazaar: true }),
    DEAD: item('DEAD', { bazaar: true }),
    GOD: item('GOD', { auctionable: true }),
    WAND: item('WAND', { auctionable: true, category: 'WAND' }),
    SACK: item('SACK', { category: 'SACK', npcSell: 100 }),
    NO_ASK: item('NO_ASK', { bazaar: true }),
  },
  shops: offers,
  untradeable: new Set(['SACK']),
};
cat.name = (id) => cat.items[id]?.name ?? catalog.name(id);

const bctx = (over: Partial<CalcCtx['settings']> = {}, extra: Partial<CalcCtx> = {}): CalcCtx => ({
  snap,
  catalog: cat,
  settings: { ...baseSettings, ...over },
  ...extra,
});
const withAh = (over: Partial<CalcCtx['settings']> = {}, extra: Partial<CalcCtx> = {}) =>
  bctx(over, { ah: (id) => ahPrices[id] ?? null, ...extra });
const row = (rows: BitsRow[], id: string, bits?: number) => rows.find((r) => r.id === id && (bits == null || r.bits === bits))!;
const TAX = baseSettings.taxRate;

describe('fame multiplier', () => {
  it('reads the rank table, New Player for unknown ranks', () => {
    expect(fameMultiplier('Patron')).toBe(1.6);
    expect(fameMultiplier('Imperator')).toBe(2.38);
    expect(fameMultiplier('nope')).toBe(1);
  });

  it('a positive custom value overrides the rank', () => {
    expect(bitsMultiplier('Patron', null)).toBe(1.6);
    expect(bitsMultiplier('Patron', 2.5)).toBe(2.5);
    expect(bitsMultiplier('Patron', 0)).toBe(1.6);
    expect(bitsMultiplier('Patron', -1)).toBe(1.6);
    expect(bitsMultiplier('Patron', NaN)).toBe(1.6);
  });
});

describe('bitsQuotes', () => {
  it('bazaar, AH and NPC quotes, best net first', () => {
    const q = bitsQuotes(withAh(), 'KISMET');
    expect(q.map((x) => x.source)).toEqual(['ah', 'bazaar']);
    expect(q[0]!.net).toBeCloseTo(ahNet(1_600_000));
    expect(q[0]!.fees).toBeCloseTo(1_600_000 - ahNet(1_600_000));
    expect(q[0]!.liquidity).toBe(12);
    expect(q[0]!.next).toBe(1_700_000);
    expect(q[1]!.gross).toBeCloseTo(1_499_999.9);
    expect(q[1]!.net).toBeCloseTo(afterTax(1_499_999.9, TAX));
    expect(q[1]!.liquidity).toBe(7000);
  });

  it('insta-sell mode quotes the bids and the insta-sell volume', () => {
    const q = bitsQuotes(bctx({ sellMode: 'insta' }), 'KISMET');
    expect(q).toHaveLength(1);
    expect(q[0]!.gross).toBe(1_400_000);
    expect(q[0]!.liquidity).toBe(3000);
  });

  it('bazaar risk uses the price stats when available', () => {
    const s = stats({ medianAsk: 105, medianBid: 100 });
    const q = bitsQuotes(bctx({}, { stats: (id) => (id === 'BOOK' ? s : null) }), 'BOOK');
    expect(q[0]!.risk).toEqual(assessRisk(snap.products.BOOK!, s));
  });

  it('AH flags: thin market, big gap, variant category', () => {
    expect(bitsQuotes(withAh(), 'GOD')[0]!.risk!.flags).toEqual(expect.arrayContaining(['AH_THIN', 'AH_GAP']));
    expect(bitsQuotes(withAh(), 'GOD')[0]!.next).toBe(9_000_000);
    const wand = bitsQuotes(withAh(), 'WAND')[0]!;
    expect(wand.risk!.flags).toEqual(['AH_VARIANT']);
    expect(wand.next).toBeUndefined();
    expect(bitsQuotes(withAh(), 'KISMET')[0]!.risk!.flags).toEqual([]);
    expect(4).toBeGreaterThanOrEqual(AH.minCount);
  });

  it('Derpy quadruples the AH claim tax', () => {
    expect(bitsQuotes(withAh({}, { derpy: true }), 'GOD')[0]!.net).toBeCloseTo(ahNet(2_000_000, true));
    expect(ahNet(2_000_000, true)).toBeLessThan(ahNet(2_000_000));
  });

  it('NPC price wins over a cheaper bazaar quote; NPC quotes have no risk or liquidity', () => {
    const q = bitsQuotes(bctx(), 'CHEAP');
    expect(q[0]).toEqual({ source: 'npc', gross: 6, fees: 0, net: 6, liquidity: null, risk: null });
    expect(q[1]!.source).toBe('bazaar');
  });

  it('ties keep bazaar ahead of the AH and the NPC', () => {
    const net = afterTax(104.9, TAX);
    const c = bctx(
      {},
      {
        catalog: { ...cat, items: { ...cat.items, BOOK: item('BOOK', { bazaar: true, npcSell: net }) } },
        ah: () => ({ price: net, count: 5 }),
      },
    );
    // a sub-1M BIN still pays the 1 % listing fee, so the AH loses here; the NPC tie goes to the bazaar
    expect(bitsQuotes(c, 'BOOK').map((x) => x.source)).toEqual(['bazaar', 'npc', 'ah']);
  });

  it('no product, no BIN, no NPC price: no quotes', () => {
    expect(bitsQuotes(withAh(), 'NOTHING')).toEqual([]);
    expect(bitsQuotes(bctx(), 'NO_ASK')).toEqual([]);
    expect(bitsQuotes(withAh({}, { ah: () => ({ price: 0, count: 3 }) }), 'GOD')).toEqual([]);
  });
});

describe('computeBitsRows', () => {
  const res = computeBitsRows(withAh(), { multiplier: 1 });
  const rows = res.rows;

  it('one row per bits offer; other currencies and zero-cost offers skipped', () => {
    expect(rows).toHaveLength(11);
    expect(rows.every((r) => r.bits > 0)).toBe(true);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(row(rows, 'KISMET').key).toBe('KISMET|1350');
    expect(row(rows, 'KISMET').name).toBe('Kismet Feather');
  });

  it('values each offer at its best quote, per bit', () => {
    const k = row(rows, 'KISMET');
    expect(k.valueSource).toBe('ah');
    expect(k.value).toBeCloseTo(ahNet(1_600_000));
    expect(k.coinsPerBit).toBeCloseTo(ahNet(1_600_000) / 1350);
    expect(k.liquidity).toBe(12);
    expect(k.quotes).toHaveLength(2);
    expect(row(rows, 'BOOK').valueSource).toBe('bazaar');
    expect(row(rows, 'BOOK').risk).toEqual(assessRisk(snap.products.BOOK!, null));
    expect(row(rows, 'CHEAP').valueSource).toBe('npc');
    expect(row(rows, 'CHEAP').risk).toBeNull();
    expect(row(rows, 'CHEAP').liquidity).toBeNull();
  });

  it('outQty > 1 multiplies the value', () => {
    const f = row(rows, 'FUEL');
    expect(f.outQty).toBe(8);
    expect(f.value).toBeCloseTo(8 * afterTax(999.9, TAX));
    expect(f.coinsPerBit).toBeCloseTo((8 * afterTax(999.9, TAX)) / 75);
  });

  it('untradeable items are never valued, even with an AH or NPC price', () => {
    const s = row(rows, 'SACK');
    expect(s.untradeable).toBe(true);
    expect(s.value).toBeNull();
    expect(s.valueSource).toBeNull();
    expect(s.coinsPerBit).toBeNull();
    expect(s.quotes).toEqual([]);
  });

  it('unpriced offers and outQty 0 stay unvalued', () => {
    for (const id of ['NOTHING', 'NO_ASK', 'ZERO_OUT']) {
      const r = row(rows, id);
      expect(r.value, id).toBeNull();
      expect(r.vsCookie, id).toBeNull();
      expect(r.risk, id).toBeNull();
    }
  });

  it('sorts by coins per bit, unvalued then untradeable last, deterministically', () => {
    const valued = rows.filter((r) => r.coinsPerBit != null);
    const cpb = valued.map((r) => r.coinsPerBit!);
    expect(cpb).toEqual([...cpb].sort((a, b) => b - a));
    expect(rows.slice(valued.length).map((r) => r.id)).toEqual(['NOTHING', 'NO_ASK', 'ZERO_OUT', 'SACK']);
    expect(rows[0]!.id).toBe('DEAD');
    const shuffled = computeBitsRows(withAh({}, { catalog: { ...cat, shops: [...offers].reverse() } }), { multiplier: 1 }).rows;
    expect(shuffled.map((r) => r.key)).toEqual(rows.map((r) => r.key));
  });

  it('equal coins per bit: by id, then by bits', () => {
    const c = bctx({}, { catalog: { ...cat, shops: [bit('BOOK', 2, 2), bit('BOOK', 1), bit('A', 1)], items: { ...cat.items, A: item('A', { npcSell: afterTax(104.9, TAX) }) } } });
    expect(computeBitsRows(c, { multiplier: 1 }).rows.map((r) => r.key)).toEqual(['A|1', 'BOOK|1', 'BOOK|2']);
  });

  it('summary: cookie cost per bit at the multiplier, best non-suspect row, profit per cookie', () => {
    const s = res.summary;
    expect(s.multiplier).toBe(1);
    expect(s.bitsPerCookie).toBe(4800);
    expect(s.cookieCost).toBeCloseTo(2_000_000.1);
    expect(s.cookieCostPerBit).toBeCloseTo(2_000_000.1 / 4800);
    // DEAD tops the list but is suspect
    expect(rows[0]!.risk!.level).toBe('suspect');
    expect(s.best!.id).not.toBe('DEAD');
    const want = rows.find((r) => r.coinsPerBit != null && !r.untradeable && r.risk?.level !== 'suspect')!;
    expect(s.best).toBe(want);
    expect(s.coinsPerCookie).toBeCloseTo(4800 * want.coinsPerBit!);
    expect(s.profitPerCookie).toBeCloseTo(4800 * want.coinsPerBit! - 2_000_000.1);
    expect(row(rows, 'KISMET').vsCookie).toBeCloseTo(row(rows, 'KISMET').coinsPerBit! / s.cookieCostPerBit!);
  });

  it('the multiplier scales bits per cookie, so a bit costs less', () => {
    const s = computeBitsRows(withAh(), { multiplier: 1.6 }).summary;
    expect(s.bitsPerCookie).toBeCloseTo(7680);
    expect(s.cookieCostPerBit).toBeCloseTo(2_000_000.1 / 7680);
    expect(s.coinsPerCookie).toBeCloseTo(7680 * s.best!.coinsPerBit!);
    const r1 = row(rows, 'KISMET').vsCookie!;
    expect(row(computeBitsRows(withAh(), { multiplier: 1.6 }).rows, 'KISMET').vsCookie).toBeCloseTo(r1 * 1.6);
  });

  it('an invalid multiplier falls back to 1', () => {
    expect(computeBitsRows(withAh(), { multiplier: 0 }).summary.bitsPerCookie).toBe(4800);
    expect(computeBitsRows(withAh(), { multiplier: NaN }).summary.multiplier).toBe(1);
  });

  it('insta cost mode buys the cookie at the ask', () => {
    expect(computeBitsRows(withAh({ costMode: 'insta' }), { multiplier: 1 }).summary.cookieCost).toBe(2_100_000);
  });

  it('no cookie price: no cost per bit, vsCookie or profit, but still a best row', () => {
    const { BOOSTER_COOKIE: _, ...rest } = snap.products;
    const s = computeBitsRows(withAh({}, { snap: { ...snap, products: rest } }), { multiplier: 1 });
    expect(s.summary.cookieCost).toBeNull();
    expect(s.summary.cookieCostPerBit).toBeNull();
    expect(s.summary.profitPerCookie).toBeNull();
    expect(s.summary.best).not.toBeNull();
    expect(s.summary.coinsPerCookie).not.toBeNull();
    expect(s.rows.every((r) => r.vsCookie == null)).toBe(true);
    const empty = makeProduct({ id: 'BOOSTER_COOKIE', bids: [], bid: null });
    expect(computeBitsRows(bctx({}, { snap: { ...snap, products: { ...snap.products, BOOSTER_COOKIE: empty } } }), { multiplier: 1 }).summary.cookieCost).toBeNull();
  });

  it('without the AH scan, AH-only items are unvalued and the best row comes from bazaar/NPC', () => {
    const off = computeBitsRows(bctx(), { multiplier: 1 });
    expect(row(off.rows, 'GOD').value).toBeNull();
    expect(row(off.rows, 'WAND').value).toBeNull();
    expect(row(off.rows, 'KISMET').valueSource).toBe('bazaar');
    expect(off.summary.best!.valueSource).not.toBe('ah');
  });

  it('nothing valued: no best row', () => {
    const c = bctx({}, { catalog: { ...cat, shops: [bit('NOTHING', 5), bit('SACK', 5)] } });
    const s = computeBitsRows(c, { multiplier: 2 }).summary;
    expect(s.best).toBeNull();
    expect(s.coinsPerCookie).toBeNull();
    expect(s.profitPerCookie).toBeNull();
    expect(computeBitsRows(bctx({}, { catalog: { ...cat, shops: [] } }), { multiplier: 1 }).rows).toEqual([]);
  });
});
