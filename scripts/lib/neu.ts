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
