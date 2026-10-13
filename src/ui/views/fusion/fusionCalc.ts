// Pure helpers for the fusion view: cached name resolution, per-term unit prices, suggestions.
import { computeFusion } from '../../../domain/fusion.ts';
import { afterTax, buyQuote, sellQuote } from '../../../domain/pricing.ts';
import { resolveUserInput, searchItems } from '../../../domain/search.ts';
import type { CalcCtx, Catalog, FusionRecipe, FusionRow, ItemInfo, Settings, Snapshot } from '../../../types/contracts.ts';

const isShard = (id: string) => id.startsWith('SHARD_');
const RESOLVE_CACHE_MAX = 1000;

export type Resolver = (text: string) => string | null;

/** resolveUserInput over snapshot products ∪ catalog bazaar items, memoized per text. */
export function createResolver(catalog: Catalog, snap: Snapshot | null): Resolver {
  const ids = new Set(snap ? Object.keys(snap.products) : []);
  for (const i of Object.values(catalog.items)) if (i.bazaar) ids.add(i.id);
  const cache = new Map<string, string | null>();
  return (text) => {
    const key = text.trim();
    if (!key) return null;
    let id = cache.get(key);
    if (id === undefined) {
      if (cache.size > RESOLVE_CACHE_MAX) cache.clear();
      id = resolveUserInput(catalog, key, ids);
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
}

export interface FusionDetail {
  row: FusionRow;
  a: TermDetail;
  b: TermDetail;
  out: TermDetail;
  /** some item field is empty */
  incomplete: boolean;
  /** non-empty missing ids/texts */
  missing: string[];
}

export function fusionDetails(ctx: CalcCtx, recipes: readonly FusionRecipe[], resolve: Resolver): FusionDetail[] {
  const { snap, catalog, settings } = ctx;
  // Pre-resolve so computeFusion's resolveUserInput hits its fast exact-id path.
  const pre = recipes.map((r) => ({
    ...r,
    a: resolve(r.a) ?? r.a,
    b: resolve(r.b) ?? r.b,
    out: resolve(r.out) ?? r.out,
  }));
  const rows = computeFusion(ctx, pre);
  const term = (text: string, side: 'buy' | 'sell'): TermDetail => {
    const id = resolve(text);
    const p = id ? snap.products[id] : undefined;
    const q = p
      ? side === 'buy'
        ? buyQuote(p, settings.costMode, undefined, catalog.items[id!]?.npcSell)
        : sellQuote(p, settings.sellMode)
      : null;
    return { text, id, name: id ? catalog.name(id) : null, unit: q && Number.isFinite(q.price) ? q.price : null };
  };
  return recipes.map((r, i) => {
    const row = { ...rows[i]!, recipe: r };
    return {
      row,
      a: term(r.a, 'buy'),
      b: term(r.b, 'buy'),
      out: term(r.out, 'sell'),
      incomplete: !r.a.trim() || !r.b.trim() || !r.out.trim(),
      missing: row.missing.filter((m) => m !== ''),
    };
  });
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
