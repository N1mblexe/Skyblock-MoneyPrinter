// npm run fixture                        -> tests/fixtures/bazaar.json : trimmed real bazaar capture for unit tests.
// npm run fixture -- --smoke [--offline] -> smoke/integration fixtures:
//   tests/fixtures/smoke/bazaar.json.gz  all products, order books trimmed to 5 levels (--offline: from the cache,
//                                        $BAZAAR_CACHE_DIR or .cache/bazaar.json)
//   tests/fixtures/ah-page.json          one live auctions page trimmed to ~40 auctions (BIN + non-BIN, item_bytes kept)
//   tests/fixtures/election.json         live election snapshot
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { RawBazaar } from '../src/types/api.ts';
import { CACHE_FILES, cachePath } from './lib/cache.ts';
import { pickAuctions, trimBazaar, type RawAuctionsPage } from './lib/fixtures.ts';

const URLS = {
  bazaar: 'https://api.hypixel.net/v2/skyblock/bazaar',
  auctions: 'https://api.hypixel.net/v2/skyblock/auctions?page=0',
  election: 'https://api.hypixel.net/v2/resources/skyblock/election',
};
const OUT = {
  unit: 'tests/fixtures/bazaar.json',
  smokeBazaar: 'tests/fixtures/smoke/bazaar.json.gz',
  ahPage: 'tests/fixtures/ah-page.json',
  election: 'tests/fixtures/election.json',
};
const LEVELS = 5;
const AH = { bin: 30, nonBin: 10, maxBytes: 148 * 1024 }; // auctions array budget; the page wrapper adds < 200 B (limit 150 KB)
const WANT = [
  'ENCHANTED_MELON', 'ENCHANTED_MELON_BLOCK', 'MELON', 'JALAPENO_BOOK', 'LOG:1', 'INK_SACK:4',
  'ENCHANTMENT_LIFE_STEAL_2', 'ENCHANTMENT_ULTIMATE_WISE_1', 'ENCHANTED_MITHRIL', 'REFINED_MITHRIL', 'MITHRIL_ORE',
  'GOLD_INGOT', 'ENCHANTED_GOLD', 'ENCHANTED_GOLD_BLOCK', 'ENCHANTED_COAL', 'COAL', 'ENCHANTED_DIAMOND', 'DIAMOND',
  'ENCHANTED_IRON', 'IRON_INGOT', 'BONE', 'SPIDER_EYE', 'ENCHANTED_PAPER', 'SUGAR_CANE', 'ENCHANTED_SUGAR',
  'ENCHANTED_SUGAR_CANE', 'WHEAT', 'ENCHANTED_BREAD', 'HAY_BLOCK', 'ENCHANTED_HAY_BLOCK',
];

const args = process.argv.slice(2);
const SMOKE = args.includes('--smoke');
const OFFLINE = args.includes('--offline');

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': 'bazaar-masasi-capture-fixture' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const j = (await res.json()) as T & { success?: boolean };
  if (j.success === false) throw new Error(`${url}: success=false`);
  return j;
}

async function bazaar(): Promise<RawBazaar> {
  if (!OFFLINE) return getJson<RawBazaar>(URLS.bazaar);
  const file = cachePath(CACHE_FILES.bazaar);
  if (!existsSync(file)) throw new Error(`--offline but no cached bazaar at ${file} (set BAZAAR_CACHE_DIR)`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RawBazaar;
  if (!raw.success || !raw.products) throw new Error(`${file}: not a bazaar response`);
  console.log(`bazaar: cache ${file}`);
  return raw;
}

function write(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`wrote ${file} (${(Buffer.byteLength(data) / 1024).toFixed(1)} KB)`);
}

async function unitFixture(): Promise<void> {
  const raw = await bazaar();
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
  writeFileSync(OUT.unit, JSON.stringify(trimBazaar(raw, LEVELS, pick), null, 1));
  console.log(`wrote ${pick.size} products (dead=${dead?.[0]}, empty=${empty?.[0]})`);
}

async function smokeFixtures(): Promise<void> {
  const raw = await bazaar();
  const trimmed = trimBazaar(raw, LEVELS);
  write(OUT.smokeBazaar, gzipSync(JSON.stringify(trimmed), { level: 9 }));
  console.log(`  ${Object.keys(trimmed.products).length} products, lastUpdated ${new Date(trimmed.lastUpdated).toISOString()}`);

  const page = await getJson<RawAuctionsPage>(URLS.auctions);
  const auctions = pickAuctions(page.auctions ?? [], AH);
  const ahJson = JSON.stringify({ success: true, page: 0, totalPages: 1, totalAuctions: auctions.length, lastUpdated: page.lastUpdated, auctions });
  write(OUT.ahPage, ahJson);
  const bins = auctions.filter((a) => a.bin).length;
  console.log(`  ${auctions.length} auctions (${bins} BIN, ${auctions.length - bins} non-BIN) from page 0 of ${page.totalPages} (${page.auctions?.length ?? 0} on page)`);

  const election = await getJson<{ mayor?: { name?: string } }>(URLS.election);
  write(OUT.election, JSON.stringify(election, null, 1));
  console.log(`  mayor ${election.mayor?.name ?? '?'}`);
}

await (SMOKE ? smokeFixtures() : unitFixture());
