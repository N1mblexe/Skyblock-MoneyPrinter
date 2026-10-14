// Pure helpers for scripts/capture-fixture.ts (bazaar trimming, auction page sampling).
import type { RawBazaar, RawProduct } from '../../src/types/api.ts';

/** Raw auction from /v2/skyblock/auctions (only the fields the sampler reads are typed). */
export interface RawAuction {
  uuid?: string;
  item_name?: string;
  item_bytes?: string;
  bin?: boolean;
  [k: string]: unknown;
}

export interface RawAuctionsPage {
  success: boolean;
  page?: number;
  totalPages?: number;
  totalAuctions?: number;
  lastUpdated?: number;
  auctions?: RawAuction[];
}

/** Copy of `raw` with order books cut to `levels` per side, optionally only the products in `ids`. */
export function trimBazaar(raw: RawBazaar, levels: number, ids?: ReadonlySet<string>): RawBazaar {
  const products: Record<string, RawProduct> = {};
  for (const [id, p] of Object.entries(raw.products)) {
    if (ids && !ids.has(id)) continue;
    products[id] = { ...p, sell_summary: p.sell_summary.slice(0, levels), buy_summary: p.buy_summary.slice(0, levels) };
  }
  return { success: true, lastUpdated: raw.lastUpdated, products };
}

const isPet = (a: RawAuction) => /^\[Lvl \d+\]/.test(a.item_name ?? '');
const isBook = (a: RawAuction) => a.item_name === 'Enchanted Book';
const size = (a: RawAuction) => JSON.stringify(a).length;

/**
 * Sample an auctions page: up to `bin` BIN auctions (a few pets and enchanted books first, then distinct item names)
 * plus up to `nonBin` regular auctions, all with item_bytes. Then drops the largest auctions until the JSON array
 * fits in `maxBytes`. Keeps page order.
 */
export function pickAuctions(auctions: readonly RawAuction[], opts: { bin: number; nonBin: number; maxBytes: number }): RawAuction[] {
  const usable = auctions.filter((a) => typeof a.item_bytes === 'string' && a.item_bytes.length > 0);
  const chosen = new Set<RawAuction>();
  const names = new Set<string>();
  const take = (list: RawAuction[], max: number, distinct: boolean) => {
    for (const a of list) {
      if (max <= 0) return;
      if (chosen.has(a) || (distinct && names.has(a.item_name ?? ''))) continue;
      chosen.add(a);
      names.add(a.item_name ?? '');
      max--;
    }
  };
  const bins = usable.filter((a) => a.bin === true);
  take(bins.filter(isPet), Math.min(3, opts.bin), true);
  take(bins.filter(isBook), Math.min(3, opts.bin - chosen.size), false);
  take(bins, opts.bin - chosen.size, true);
  take(bins, opts.bin - chosen.size, false);
  take(usable.filter((a) => a.bin !== true), opts.nonBin, false);

  const out = usable.filter((a) => chosen.has(a));
  let total = JSON.stringify(out).length;
  while (total > opts.maxBytes && out.length) {
    let big = 0;
    for (let i = 1; i < out.length; i++) if (size(out[i]!) > size(out[big]!)) big = i;
    total -= size(out[big]!) + 1;
    out.splice(big, 1);
  }
  return out;
}
