import { describe, expect, it } from 'vitest';
import { computeShopRows } from '../../src/domain/shops.ts';
import { ahNet } from '../../src/domain/pricing.ts';
import { assessRisk } from '../../src/domain/risk.ts';
import type { CalcCtx, Catalog, ItemInfo, ShopOffer, Snapshot } from '../../src/types/contracts.ts';
import { baseSettings, catalog, ctx, makeProduct, stats } from './helpers.ts';

const item = (id: string, npcSell?: number, bazaar = true): ItemInfo => ({ id, name: id, npcSell, bazaar });

const snap: Snapshot = {
  lastUpdated: 0,
  fetchedAt: 0,
  source: 'fixture',
  products: {
    // bazaar-valued: offer sells at 104.9 (> NPC 10)
    GOD_POTION_BZ: makeProduct({ id: 'GOD_POTION_BZ', instaBuysWeek: 7000, instaSellsWeek: 3000 }),
    // on the bazaar but NPC pays more than 4.9 after tax
    CHEAP_BZ: makeProduct({ id: 'CHEAP_BZ', asks: [{ price: 5, amount: 10, orders: 1 }], bids: [{ price: 4, amount: 10, orders: 1 }] }),
    // no sell offers: offer mode cannot value it on the bazaar
    NO_ASK: makeProduct({ id: 'NO_ASK', asks: [] }),
  },
};

const offers: ShopOffer[] = [
  { shop: 'ELIZABETH', currency: 'SKYBLOCK_BIT', costQty: 2000, output: 'GOD_POTION_BZ', outQty: 1 },
  { shop: 'ADVENTURER', currency: 'SKYBLOCK_COIN', costQty: 50, output: 'NPC_ONLY', outQty: 4 },
  { shop: 'FARM_MERCHANT', currency: 'SKYBLOCK_COIN', costQty: 12, output: 'CHEAP_BZ', outQty: 2 },
  { shop: 'SKYMART', currency: 'SKYBLOCK_COPPER', costQty: 100, output: 'UNKNOWN_THING', outQty: 1 },
  { shop: 'SKYMART', currency: 'SKYBLOCK_COPPER', costQty: 0, output: 'NPC_ONLY', outQty: 1 },
  { shop: 'X', currency: 'SKYBLOCK_MOTE', costQty: 5, output: 'NO_ASK', outQty: 1 },
  { shop: 'X', currency: 'SKYBLOCK_MOTE', costQty: 5, output: 'GOD_POTION_BZ', outQty: 0 },
];

const cat: Catalog = {
  ...catalog,
  items: {
    ...catalog.items,
    GOD_POTION_BZ: item('GOD_POTION_BZ', 10),
    NPC_ONLY: item('NPC_ONLY', 20, false),
    CHEAP_BZ: item('CHEAP_BZ', 6),
    NO_ASK: item('NO_ASK'),
  },
  shops: offers,
};
const sctx = (over: Partial<CalcCtx['settings']> = {}, extra: Partial<CalcCtx> = {}): CalcCtx => ({
  snap,
  catalog: cat,
  settings: { ...baseSettings, ...over },
  ...extra,
});

describe('computeShopRows', () => {
  const rows = computeShopRows(sctx());

  it('one row per offer, keyed by shop|output|currency|cost', () => {
    expect(rows).toHaveLength(offers.length);
    expect(rows[0]!.key).toBe('ELIZABETH|GOD_POTION_BZ|SKYBLOCK_BIT|2000');
    expect(rows.map((r) => r.id)).toEqual(offers.map((o) => o.output));
  });

  it('bits offer valued at the bazaar sell offer after tax', () => {
    const r = rows[0]!;
    const unit = 104.9 * (1 - baseSettings.taxRate);
    expect(r.valueSource).toBe('bazaar');
    expect(r.value).toBeCloseTo(unit, 9);
    expect(r.coinsPerCurrency).toBeCloseTo(unit / 2000, 12);
    expect(r.weekVol).toBe(7000); // sell offers fill from insta-buys
    expect(r.risk).toEqual(assessRisk(snap.products.GOD_POTION_BZ!, null));
    expect(r.shop).toBe('ELIZABETH');
    expect(r.currency).toBe('SKYBLOCK_BIT');
    expect(r.costQty).toBe(2000);
    expect(r.outQty).toBe(1);
  });

  it('coin offer with an NPC-valued output: direct coin ratio, no volume or risk', () => {
    const r = rows[1]!;
    expect(r.valueSource).toBe('npc');
    expect(r.value).toBe(80);
    expect(r.coinsPerCurrency).toBeCloseTo(1.6, 12);
    expect(r.weekVol).toBe(0);
    expect(r.risk).toBeNull();
  });

  it('a bazaar product is NPC-valued when the NPC pays more', () => {
    const r = rows[2]!;
    expect(r.valueSource).toBe('npc');
    expect(r.value).toBe(12);
    expect(r.coinsPerCurrency).toBe(1);
    expect(r.risk).toBeNull();
  });

  it('unvaluable outputs and zero quantities keep nulls', () => {
    expect(rows[3]).toMatchObject({ value: null, valueSource: null, coinsPerCurrency: null, weekVol: 0, risk: null });
    expect(rows[3]!.name).toBe('Unknown Thing');
    expect(rows[4]).toMatchObject({ value: 20, valueSource: 'npc', coinsPerCurrency: null });
    expect(rows[5]).toMatchObject({ value: null, valueSource: null, coinsPerCurrency: null });
    expect(rows[6]).toMatchObject({ value: null, valueSource: null, coinsPerCurrency: null, risk: null, weekVol: 0 });
  });

  it('insta sell mode values at the bid and uses insta-sell volume; stats feed risk', () => {
    const r = computeShopRows(sctx({ sellMode: 'insta' }, { stats: () => stats() }))[0]!;
    expect(r.value).toBeCloseTo(100 * (1 - baseSettings.taxRate), 9);
    expect(r.weekVol).toBe(3000);
    expect(r.risk!.flags).not.toContain('NO_HISTORY');
    // NO_ASK has bids, so insta mode can value it on the bazaar
    expect(computeShopRows(sctx({ sellMode: 'insta' }))[5]!.valueSource).toBe('bazaar');
  });

  it('auctionable outputs can be valued on the AH (sale.ts), with measured sales as the weekly volume', () => {
    const c: Catalog = { ...cat, items: { ...cat.items, RELIC: { ...item('RELIC', 5, false), auctionable: true } }, shops: [{ shop: 'X', currency: 'SKYBLOCK_MOTE', costQty: 10, output: 'RELIC', outQty: 2 }] };
    const ah = () => ({ price: 1_000, next: 1_200, count: 9 });
    const r = computeShopRows(sctx({}, { catalog: c, ah }))[0]!;
    expect(r.valueSource).toBe('ah');
    expect(r.value).toBeCloseTo(2 * ahNet(999), 9);
    expect(r.weekVol).toBe(0);
    expect(r.risk).toEqual({ level: 'ok', score: 0, flags: [] });
    const sales = () => ({ n: 5, items: 5, median: 1_000, perHour: 0.5, coverageHours: 4, last: 0 });
    expect(computeShopRows(sctx({}, { catalog: c, ah, ahSales: sales }))[0]!.weekVol).toBe(84);
    // without the scan: the NPC
    expect(computeShopRows(sctx({}, { catalog: c }))[0]!.valueSource).toBe('npc');
  });

  it('empty catalog shops (runtime stub) yields no rows', () => {
    expect(computeShopRows(ctx())).toEqual([]);
  });
});
