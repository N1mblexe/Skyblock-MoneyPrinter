// npm run fixture -> tests/fixtures/bazaar.json : trimmed real bazaar capture for unit tests.
import { writeFileSync } from 'node:fs';
import type { RawBazaar, RawProduct } from '../src/types/api.ts';

const URL = 'https://api.hypixel.net/v2/skyblock/bazaar';
const LEVELS = 5;
const WANT = [
  'ENCHANTED_MELON', 'ENCHANTED_MELON_BLOCK', 'MELON', 'JALAPENO_BOOK', 'LOG:1', 'INK_SACK:4',
  'ENCHANTMENT_LIFE_STEAL_2', 'ENCHANTMENT_ULTIMATE_WISE_1', 'ENCHANTED_MITHRIL', 'REFINED_MITHRIL', 'MITHRIL_ORE',
  'GOLD_INGOT', 'ENCHANTED_GOLD', 'ENCHANTED_GOLD_BLOCK', 'ENCHANTED_COAL', 'COAL', 'ENCHANTED_DIAMOND', 'DIAMOND',
  'ENCHANTED_IRON', 'IRON_INGOT', 'BONE', 'SPIDER_EYE', 'ENCHANTED_PAPER', 'SUGAR_CANE', 'ENCHANTED_SUGAR',
  'ENCHANTED_SUGAR_CANE', 'WHEAT', 'ENCHANTED_BREAD', 'HAY_BLOCK', 'ENCHANTED_HAY_BLOCK',
];

const raw = (await (await fetch(URL)).json()) as RawBazaar;
if (!raw.success) throw new Error('API returned success=false');
const all = Object.entries(raw.products);
const pick = new Set(WANT.filter((id) => raw.products[id]));
// a few attribute shards with books on both sides
for (const [id, p] of all) if (id.startsWith('SHARD_') && p.sell_summary.length && p.buy_summary.length && [...pick].filter((x) => x.startsWith('SHARD_')).length < 3) pick.add(id);
// a dead-bid item (bid <= 1, ask > 100)
const dead = all.find(([, p]) => (p.sell_summary[0]?.pricePerUnit ?? 99) <= 1 && (p.buy_summary[0]?.pricePerUnit ?? 0) > 100);
if (dead) pick.add(dead[0]);
// an item with no book at all
const empty = all.find(([, p]) => !p.sell_summary.length && !p.buy_summary.length);
if (empty) pick.add(empty[0]);

const products: Record<string, RawProduct> = {};
for (const id of pick) {
  const p = raw.products[id]!;
  products[id] = { ...p, sell_summary: p.sell_summary.slice(0, LEVELS), buy_summary: p.buy_summary.slice(0, LEVELS) };
}
writeFileSync('tests/fixtures/bazaar.json', JSON.stringify({ success: true, lastUpdated: raw.lastUpdated, products }, null, 1));
console.log(`wrote ${pick.size} products (dead=${dead?.[0]}, empty=${empty?.[0]})`);
