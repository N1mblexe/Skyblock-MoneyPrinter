// Pure helpers for the fusion view: cached name resolution, per-term unit prices, suggestions, sort order.
// Recipe results themselves come from ctx.derived.fusion().
import { coreOf } from '../../../domain/market.ts';
import { afterTax, sellQuote } from '../../../domain/pricing.ts';
import { resolveUserInput, searchItems } from '../../../domain/search.ts';
import type { CalcCtx, Catalog, FusionRow, ItemInfo, QuoteSource, Settings, Snapshot } from '../../../types/contracts.ts';

const isShard = (id: string) => id.startsWith('SHARD_');
const RESOLVE_CACHE_MAX = 1000;

/** 'buy' (an input: a bazaar product or an NPC shop item) or 'sell' (the output: a bazaar product). */
export type Resolver = (text: string, side?: 'buy' | 'sell') => string | null;

/**
 * resolveUserInput over snapshot products ∪ catalog bazaar items (plus, for inputs, items an NPC shop sells, as
 * domain/fusion.ts resolves them), memoized per side and text.
 */
export function createResolver(catalog: Catalog, snap: Snapshot | null): Resolver {
  const ids = new Set(snap ? Object.keys(snap.products) : []);
  for (const i of Object.values(catalog.items)) if (i.bazaar) ids.add(i.id);
  const inputIds = new Set(ids);
  for (const i of Object.values(catalog.items)) if (i.npcBuy != null && i.npcBuy > 0) inputIds.add(i.id);
  const caches = { buy: new Map<string, string | null>(), sell: new Map<string, string | null>() };
  return (text, side = 'sell') => {
    const key = text.trim();
    if (!key) return null;
    const cache = caches[side];
    let id = cache.get(key);
    if (id === undefined) {
      if (cache.size > RESOLVE_CACHE_MAX) cache.clear();
      id = resolveUserInput(catalog, key, side === 'buy' ? inputIds : ids);
      cache.set(key, id);
    }
    return id;
  };
}

export interface TermDetail {
  text: string;
  id: string | null;
  name: string | null;
  /** unit buy price (inputs) or pre-tax unit sell price (output); null if unpriced */
  unit: number | null;
  /** where an input is bought: an NPC shop when cheaper than the bazaar (else the bazaar quote's source) */
  source: QuoteSource | null;
  shard: ItemInfo['shard'] | null;
}

/**
 * Resolved id, display name, unit price, source and shard metadata of one recipe term, priced like
 * domain/fusion.ts through the context's market core: an input at the cheaper of the bazaar and an NPC shop.
 */
export function termDetail(ctx: CalcCtx, text: string, side: 'buy' | 'sell', resolve: Resolver): TermDetail {
  const { catalog } = ctx;
  const core = coreOf(ctx);
  const id = resolve(text, side);
  let unit: number | null = null;
  let source: QuoteSource | null = null;
  if (id && side === 'buy') {
    const bz = core.buy(id);
    const bzOk = bz != null && bz.quote.price > 0 && Number.isFinite(bz.quote.price);
    const npc = core.npcBuy(id);
    if (npc && (!bzOk || npc.price < bz!.quote.price)) {
      unit = npc.price;
      source = 'npc';
    } else if (bzOk) {
      unit = bz!.quote.price;
      source = bz!.quote.source;
    }
  } else if (id) {
    const s = core.sell(id);
    if (s && Number.isFinite(s.quote.price)) unit = s.quote.price;
  }
  return {
    text,
    id,
    name: id ? catalog.name(id) : null,
    unit,
    source,
    shard: (id && catalog.items[id]?.shard) || null,
  };
}

/** Up to `limit` bazaar items for the autocomplete; SHARD_* items first. */
export function itemSuggestions(catalog: Catalog, q: string, limit = 30): ItemInfo[] {
  const shards = searchItems(catalog, q, limit, (i) => i.bazaar && isShard(i.id));
  if (shards.length >= limit) return shards;
  const rest = searchItems(catalog, q, limit - shards.length, (i) => i.bazaar && !isShard(i.id));
  return [...shards, ...rest];
}

export interface ShardPick {
  id: string;
  name: string;
  /** after-tax unit sell value */
  value: number;
}

/** Top-N shards on the bazaar by after-tax sell value (current sell mode). */
export function topShards(snap: Snapshot, catalog: Catalog | null, settings: Settings, n = 20): ShardPick[] {
  const out: ShardPick[] = [];
  for (const [id, p] of Object.entries(snap.products)) {
    if (!isShard(id)) continue;
    const q = sellQuote(p, settings.sellMode);
    if (!q || !Number.isFinite(q.price) || q.price <= 0) continue;
    out.push({ id, name: catalog ? catalog.name(id) : id, value: afterTax(q.price, settings.taxRate) });
  }
  out.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  return out.slice(0, n);
}

export const SORT_MODES = ['manual', 'profit', 'pph', 'margin'] as const;
export type SortMode = (typeof SORT_MODES)[number];

/** Sort metric of a result row (null = unknown, sorts last). */
export function sortValue(r: FusionRow | null | undefined, mode: SortMode): number | null {
  if (!r) return null;
  const v = mode === 'profit' ? r.profit : mode === 'pph' ? r.profitPerHour : mode === 'margin' ? r.margin : null;
  return v != null && Number.isFinite(v) ? v : null;
}

/** Display order (indices into `results`): manual = as stored; otherwise descending, nulls last, stable. */
export function displayOrder(results: readonly (FusionRow | null | undefined)[], mode: SortMode): number[] {
  const idx = results.map((_, i) => i);
  if (mode === 'manual') return idx;
  const val = results.map((r) => sortValue(r, mode));
  return idx.sort((a, b) => {
    const x = val[a]!;
    const y = val[b]!;
    if (x == null || y == null) return x == null && y == null ? a - b : x == null ? 1 : -1;
    return y - x || a - b;
  });
}
