// NEU repo item JSON -> raw recipes / NPC shop offers (ids still in NEU form).
import { parseNeuStack, stripFormatting } from '../../src/domain/ids.ts';

export interface NeuItem {
  internalname: string;
  displayname?: string;
  crafttext?: string;
  recipe?: Record<string, unknown>;
  recipes?: Record<string, unknown>[];
}

export interface RawRecipe {
  /** NEU id of the output */
  output: string;
  count: number;
  /** NEU ids, not yet merged */
  inputs: { id: string; qty: number }[];
  kind: 'craft' | 'forge';
  duration?: number;
  req?: string;
}

export interface NpcOffer {
  /** NEU id */
  result: string;
  qty: number;
  coins: number;
  /** the shop's NEU id */
  shop: string;
}

/** A single-cost npc_shop offer (v2 shops): pay `costQty` x `currency`, get `qty` x `result` (NEU ids). */
export interface ShopOfferRaw {
  /** the shop's NEU id */
  shop: string;
  /** NEU id of the only cost stack (SKYBLOCK_COIN, SKYBLOCK_BIT, SKYBLOCK_COPPER, an item id, ...) */
  currency: string;
  costQty: number;
  result: string;
  qty: number;
}

/** A Kat pet upgrade from a NEU `katgrade` recipe (ids still in NEU form). */
export interface KatStepRaw {
  /** pet type, e.g. OCELOT */
  pet: string;
  /** rarity index of the input pet (NEU `OCELOT;1` -> 1) */
  from: number;
  to: number;
  coins: number;
  /** wait time in seconds */
  seconds: number;
  /** NEU ids */
  items: { id: string; qty: number }[];
}

const SLOTS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'] as const;

function stack(v: unknown): { id: string; qty: number } | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = parseNeuStack(v);
  if (!s.id || !(s.qty > 0)) return null;
  return s;
}

function posNum(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

function req(item: NeuItem): string | undefined {
  const t = item.crafttext ? stripFormatting(item.crafttext) : '';
  return t || undefined;
}

function fromGrid(item: NeuItem, grid: Record<string, unknown>): RawRecipe | null {
  const inputs: { id: string; qty: number }[] = [];
  for (const k of SLOTS) {
    const s = stack(grid[k]);
    if (s) inputs.push(s);
  }
  if (!inputs.length) return null;
  const override = typeof grid.overrideOutputId === 'string' && grid.overrideOutputId ? grid.overrideOutputId : undefined;
  return {
    output: override ?? item.internalname,
    count: posNum(grid.count) ?? 1,
    inputs,
    kind: 'craft',
    req: req(item),
  };
}

export function extractRecipes(item: NeuItem): RawRecipe[] {
  const out: RawRecipe[] = [];
  if (item.recipe && typeof item.recipe === 'object') {
    const r = fromGrid(item, item.recipe);
    if (r) out.push(r);
  }
  for (const r of item.recipes ?? []) {
    if (!r || typeof r !== 'object') continue;
    if (r.type === 'crafting') {
      const g = fromGrid(item, r);
      if (g) out.push(g);
    } else if (r.type === 'forge') {
      const inputs = (Array.isArray(r.inputs) ? r.inputs : []).map(stack).filter((s): s is { id: string; qty: number } => !!s);
      if (!inputs.length) continue;
      const override = typeof r.overrideOutputId === 'string' && r.overrideOutputId ? r.overrideOutputId : undefined;
      out.push({
        output: override ?? item.internalname,
        count: posNum(r.count) ?? 1,
        inputs,
        kind: 'forge',
        duration: posNum(r.duration),
        req: req(item),
      });
    }
  }
  return out;
}

/** Coin-only npc_shop offers. */
export function extractNpcOffers(item: NeuItem): NpcOffer[] {
  const out: NpcOffer[] = [];
  for (const r of item.recipes ?? []) {
    if (!r || r.type !== 'npc_shop' || !Array.isArray(r.cost)) continue;
    const res = stack(r.result);
    if (!res) continue;
    const costs = r.cost.map(stack);
    if (!costs.length || costs.some((c) => !c || c.id !== 'SKYBLOCK_COIN')) continue;
    const coins = costs.reduce((a, c) => a + c!.qty, 0);
    if (!(coins > 0)) continue;
    out.push({ result: res.id, qty: res.qty, coins, shop: item.internalname });
  }
  return out;
}

/** npc_shop offers paid with exactly one stack (any currency or item); multi-cost offers are skipped. */
export function extractShopOffers(item: NeuItem): ShopOfferRaw[] {
  const out: ShopOfferRaw[] = [];
  for (const r of item.recipes ?? []) {
    if (!r || r.type !== 'npc_shop' || !Array.isArray(r.cost) || r.cost.length !== 1) continue;
    const res = stack(r.result);
    const cost = stack(r.cost[0]);
    if (!res || !cost) continue;
    out.push({ shop: item.internalname, currency: cost.id, costQty: cost.qty, result: res.id, qty: res.qty });
  }
  return out;
}

const PET_ID = /^([A-Z0-9_]+);(\d+)$/;

/**
 * Kat upgrades (`katgrade` recipes, kept in the output pet's file): pay `coins` + `items`, wait `time` seconds, get
 * `input` pet one rarity up. A bare id in `items` means qty 1. Input and output must be the same pet type, one
 * rarity apart or more; everything else is skipped.
 */
export function extractKatSteps(item: NeuItem): KatStepRaw[] {
  const out: KatStepRaw[] = [];
  for (const r of item.recipes ?? []) {
    if (!r || r.type !== 'katgrade' || typeof r.input !== 'string' || typeof r.output !== 'string') continue;
    const a = PET_ID.exec(r.input);
    const b = PET_ID.exec(r.output);
    if (!a || !b || a[1] !== b[1] || !(Number(b[2]) > Number(a[2]))) continue;
    const coins = typeof r.coins === 'number' && Number.isFinite(r.coins) && r.coins >= 0 ? r.coins : undefined;
    const seconds = typeof r.time === 'number' && Number.isFinite(r.time) && r.time >= 0 ? r.time : undefined;
    if (coins === undefined || seconds === undefined) continue;
    const items = (Array.isArray(r.items) ? r.items : []).map(stack).filter((s): s is { id: string; qty: number } => !!s);
    out.push({ pet: a[1]!, from: Number(a[2]), to: Number(b[2]), coins, seconds, items });
  }
  return out;
}
