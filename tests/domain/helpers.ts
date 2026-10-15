// Test helpers for domain tests: build runtime Catalog / Snapshot from fixtures without depending on other packages.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveName } from '../../src/domain/ids.ts';
import type { RawBazaar, RawOrder } from '../../src/types/api.ts';
import type {
  CalcCtx,
  Catalog,
  CatalogFile,
  ItemInfo,
  OrderLevel,
  PriceStats,
  Product,
  QuickStatus,
  Recipe,
  Settings,
  Snapshot,
} from '../../src/types/contracts.ts';

// cwd-relative: under happy-dom's web transform import.meta.url is root-relative
const fixture = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures', name), 'utf8'));

export function buildCatalog(f: CatalogFile): Catalog {
  const items: Record<string, ItemInfo> = {};
  for (const [id, e] of Object.entries(f.items)) {
    items[id] = { id, name: e.n, tier: e.t, npcSell: e.ns, npcBuy: e.nb, bazaar: e.bz === 1 };
  }
  const recipes: Recipe[] = f.recipes.map((r, i) => ({
    key: `${r.o}#${i}`,
    output: r.o,
    outCount: r.c,
    inputs: r.i.map(([id, qty]) => ({ id, qty })),
    kind: r.k,
    durationSec: r.d,
    req: r.r,
  }));
  const byOutput = new Map<string, Recipe[]>();
  const byInput = new Map<string, Recipe[]>();
  const add = (m: Map<string, Recipe[]>, k: string, r: Recipe) => (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  for (const r of recipes) {
    add(byOutput, r.output, r);
    for (const inp of r.inputs) add(byInput, inp.id, r);
  }
  return {
    meta: { generatedAt: f.generatedAt },
    items,
    recipes,
    byOutput,
    byInput,
    name: (id) => items[id]?.name || deriveName(id),
    shops: [],
    bookRule: () => null,
  };
}

const lvl = (o: RawOrder): OrderLevel => ({ price: o.pricePerUnit, amount: o.amount, orders: o.orders });

export function buildSnapshot(raw: RawBazaar): Snapshot {
  const products: Record<string, Product> = {};
  for (const [id, rp] of Object.entries(raw.products)) {
    const q = rp.quick_status;
    const bids = rp.sell_summary.map(lvl);
    const asks = rp.buy_summary.map(lvl);
    products[id] = {
      id,
      bid: bids[0]?.price ?? null,
      ask: asks[0]?.price ?? null,
      bids,
      asks,
      quick: {
        buyPrice: q.buyPrice,
        sellPrice: q.sellPrice,
        buyVolume: q.buyVolume,
        sellVolume: q.sellVolume,
        buyMovingWeek: q.buyMovingWeek,
        sellMovingWeek: q.sellMovingWeek,
        buyOrders: q.buyOrders,
        sellOrders: q.sellOrders,
      },
      instaBuysWeek: q.buyMovingWeek,
      instaSellsWeek: q.sellMovingWeek,
    };
  }
  return { lastUpdated: raw.lastUpdated, fetchedAt: raw.lastUpdated, source: 'fixture', products };
}

export const catalogFile = fixture('catalog.json') as CatalogFile;
export const rawBazaar = fixture('bazaar.json') as RawBazaar;
export const catalog = buildCatalog(catalogFile);
export const snap = buildSnapshot(rawBazaar);
export const P = (id: string): Product => {
  const p = snap.products[id];
  if (!p) throw new Error(`fixture lacks ${id}`);
  return p;
};

export const baseSettings: Settings = {
  taxRate: 0.0125,
  capital: 5_000_000,
  share: 0.05,
  cycleHours: 1,
  costMode: 'order',
  sellMode: 'offer',
  forgeSlots: 2,
  hideSuspicious: true,
  autoRefresh: true,
  lang: 'en',
  theme: 'auto',
  orderSlots: 14,
  npcDailyLimit: 640,
  fillModel: 'sequential',
  density: 'comfortable',
  notify: false,
  ahEnabled: true,
};

export function ctx(over: Partial<Settings> = {}, extra: Partial<CalcCtx> = {}): CalcCtx {
  return { snap, catalog, settings: { ...baseSettings, ...over }, ...extra };
}

/** Synthetic healthy product; override anything. */
export type ProductOverrides = Partial<Omit<Product, 'quick'>> & { quick?: Partial<QuickStatus> };

export function makeProduct(over: ProductOverrides = {}): Product {
  const bids: OrderLevel[] = over.bids ?? [
    { price: 100, amount: 5000, orders: 10 },
    { price: 99.9, amount: 5000, orders: 10 },
  ];
  const asks: OrderLevel[] = over.asks ?? [
    { price: 105, amount: 5000, orders: 10 },
    { price: 105.1, amount: 5000, orders: 10 },
  ];
  const instaBuysWeek = over.instaBuysWeek ?? 100_000;
  const instaSellsWeek = over.instaSellsWeek ?? 100_000;
  const quick: QuickStatus = {
    buyPrice: 105,
    sellPrice: 100,
    buyVolume: 10_000,
    sellVolume: 10_000,
    buyMovingWeek: instaBuysWeek,
    sellMovingWeek: instaSellsWeek,
    buyOrders: 50,
    sellOrders: 50,
    ...over.quick,
  };
  return {
    id: over.id ?? 'SYNTH',
    bid: 'bid' in over ? over.bid! : (bids[0]?.price ?? null),
    ask: 'ask' in over ? over.ask! : (asks[0]?.price ?? null),
    bids,
    asks,
    quick,
    instaBuysWeek,
    instaSellsWeek,
  };
}

export const stats = (o: Partial<PriceStats> = {}): PriceStats => ({
  n: 20,
  medianAsk: 105,
  medianBid: 100,
  madAsk: 1,
  madBid: 1,
  change24h: 0,
  ...o,
});
