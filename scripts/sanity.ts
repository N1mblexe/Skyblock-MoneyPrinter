// npm run sanity [-- --offline] : end-to-end check of the domain layer against the real bazaar + generated catalog.
// --offline reads the cached bazaar ($BAZAAR_CACHE_DIR or .cache/bazaar.json) instead of fetching it.
import { existsSync, readFileSync } from 'node:fs';
import { scanAuctions, type RawAhPage } from '../src/api/auctions.ts';
import { fetchBazaar } from '../src/api/bazaarClient.ts';
import { toSnapshot, validateRaw } from '../src/api/normalize.ts';
import { catalogFromFile } from '../src/data/catalog.ts';
import { computeBookCombines } from '../src/domain/books.ts';
import { computeCrafts } from '../src/domain/craft.ts';
import { computeFlips } from '../src/domain/flip.ts';
import { computeNpcFlips } from '../src/domain/npc.ts';
import { slotsFor } from '../src/domain/pricing.ts';
import { median } from '../src/domain/stats.ts';
import { defaultSettings } from '../src/state/appState.ts';
import type { CalcCtx, CatalogFile } from '../src/types/contracts.ts';
import type { RawBazaar } from '../src/types/api.ts';
import { CACHE_FILES, cachePath } from './lib/cache.ts';

const OFFLINE = process.argv.includes('--offline');

const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
};

function cachedBazaar(): RawBazaar {
  const file = cachePath(CACHE_FILES.bazaar);
  if (!existsSync(file)) throw new Error(`--offline but no cached bazaar at ${file} (set BAZAAR_CACHE_DIR or run npm run data)`);
  return validateRaw(JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

const raw = OFFLINE ? cachedBazaar() : await fetchBazaar();
// offline: pretend we received it when Hypixel produced it, so age-based checks see a fresh snapshot
const snap = OFFLINE ? toSnapshot(raw, raw.lastUpdated, 'cache') : toSnapshot(raw, Date.now(), 'live');
if (OFFLINE) console.log(`offline: ${cachePath(CACHE_FILES.bazaar)}`);
const catalog = catalogFromFile(JSON.parse(readFileSync('public/data/catalog.json', 'utf8')) as CatalogFile);
const ctx: CalcCtx = { snap, catalog, settings: defaultSettings };
console.log(`products=${Object.keys(snap.products).length} recipes=${catalog.recipes.length} lastUpdated=${new Date(raw.lastUpdated).toISOString()}`);

// ---- top of book, not quick_status
const melon = raw.products.ENCHANTED_MELON!;
const melonFlip = computeFlips({ ...ctx, settings: { ...defaultSettings, hideSuspicious: false } }).find((r) => r.id === 'ENCHANTED_MELON');
const melonBid = melon.sell_summary[0]!.pricePerUnit;
if (melonFlip) check(Math.abs(melonFlip.buyAt - (melonBid + 0.1)) < 0.11, `ENCHANTED_MELON buyAt ${melonFlip.buyAt} ≈ top buy order ${melonBid} + 0.1 (quick_status ${melon.quick_status.buyPrice.toFixed(1)})`);
else check(snap.products.ENCHANTED_MELON?.bid === melonBid, `ENCHANTED_MELON bid ${snap.products.ENCHANTED_MELON?.bid} == sell_summary[0] ${melonBid} (no profitable flip right now)`);

// ---- flips
const flips = computeFlips(ctx).filter((r) => r.risk.level !== 'suspect');
const top = [...flips].sort((a, b) => b.profitPerHour - a.profitPerHour).slice(0, 20);
console.log('\nTop 10 flips (default settings, suspect hidden):');
for (const r of top.slice(0, 10))
  console.log(`  ${r.name.padEnd(32)} buy ${r.buyAt.toFixed(1).padStart(11)} sell ${r.sellAt.toFixed(1).padStart(11)} margin ${(r.margin * 100).toFixed(1).padStart(6)}%  ${Math.round(r.profitPerHour).toLocaleString('en')}/h  [${r.risk.level}]`);
check(top.length >= 20, `≥20 non-suspect profitable flips (got ${flips.length})`);
check(median(top.map((r) => r.margin)) < 0.3, `median top-20 margin < 30% (got ${(median(top.map((r) => r.margin)) * 100).toFixed(1)}%)`);
check(top.every((r) => { const p = snap.products[r.id]!; return p.bid !== null && p.ask !== null && r.buyAt >= p.bid && r.buyAt <= p.ask; }), 'every top flip buyAt within [bid, ask]');
check(top.every((r) => (snap.products[r.id]!.bid ?? 0) >= 1), 'no top flip with bid < 1');
check(top.every((r) => r.profitPerHour <= (defaultSettings.capital * r.margin) / defaultSettings.cycleHours + 1e-6), 'profit/h ≤ capital × margin / cycleHours');

// ---- crafts
const crafts = computeCrafts(ctx);
const priced = crafts.filter((r) => r.unpriced.length === 0);
const craftsOnly = priced.filter((r) => r.recipe.kind !== 'shop');
console.log(`\ncrafts: ${crafts.length} recipes, ${priced.length} fully priced, ${priced.filter((r) => r.profit > 0).length} profitable`);
check(craftsOnly.length >= 380, `≥380 priceable craft / forge recipes (legacy tool matched 322) — got ${craftsOnly.length}`);
check(crafts.every((r) => Number.isFinite(r.cost) && Number.isFinite(r.value) && (r.margin === null || Number.isFinite(r.margin))), 'no NaN/Infinity in craft rows');
const topCraft = priced.filter((r) => r.risk.level !== 'suspect').sort((a, b) => b.profitPerHour - a.profitPerHour).slice(0, 5);
for (const r of topCraft) console.log(`  ${r.name.padEnd(32)} cost ${Math.round(r.cost).toLocaleString('en').padStart(12)} value ${Math.round(r.value).toLocaleString('en').padStart(12)} ${Math.round(r.profitPerHour).toLocaleString('en')}/h`);

// shop trades (NPC offers that cost items) price as crafts: the Craft page's "Shop trades" source
const shops = crafts.filter((r) => r.recipe.kind === 'shop');
const shopPriced = shops.filter((r) => r.unpriced.length === 0);
console.log(`shop trades: ${shops.length} recipes, ${shopPriced.length} fully priced, ${shopPriced.filter((r) => r.profit > 0).length} profitable`);
check(shopPriced.length >= 80, `≥80 priced shop-trade recipes (got ${shopPriced.length} of ${shops.length})`);
check(shopPriced.every((r) => Number.isFinite(r.profitPerHour) && Number.isFinite(r.outCraftsPerHour)), 'shop-trade rows have finite rates and profit/h');

// AH-sold outputs (off-bazaar items valued from the AH) get a finite sales rate: the fixture AH page stands in for a scan
const ahPage = { ...(JSON.parse(readFileSync('tests/fixtures/ah-page.json', 'utf8')) as RawAhPage), page: 0, totalPages: 1 };
const ah = await scanAuctions(async () => ahPage, () => {});
const ahCrafts = computeCrafts({ ...ctx, ah: (id) => ah.lowestBin[id] ?? null }).filter((r) => r.valueSource === 'ah' && r.unpriced.length === 0);
console.log(`AH-sold crafts (fixture AH page): ${ahCrafts.length}, sell bound ${[...new Set(ahCrafts.map((r) => r.tp.limitedBy))].join('/')}`);
check(ahCrafts.length > 0, `some crafts sell on the AH with the fixture scan (got ${ahCrafts.length})`);
check(
  ahCrafts.every((r) => Number.isFinite(r.outCraftsPerHour) && r.outCraftsPerHour > 0 && Number.isFinite(r.profitPerHour) && Number.isFinite(r.tp.unitsPerHour)),
  'AH-sold crafts have finite sales rates and profit/h',
);

// ---- books: a combine's batch takes the order slots of its order legs (it used to take none)
const books = computeBookCombines(ctx);
const ordered = books.filter((r) => r.tp.batchQty > 0 && (r.plan?.orderUnits.length ?? 0) > 0);
console.log(`\nbook combines: ${books.length}, ${ordered.length} with a batch and order legs`);
check(
  ordered.length > 0 && ordered.every((r) => (r.tp.slots ?? 0) >= 1 && r.tp.slots === slotsFor(r.tp.batchQty, r.plan!.orderUnits)),
  `book combines with order legs take their order slots (${ordered.filter((r) => (r.tp.slots ?? 0) >= 1).length} of ${ordered.length} take ≥1)`,
);

// ---- npc
const npc = computeNpcFlips(ctx);
console.log(`\nnpc flips: ${npc.filter((r) => r.direction === 'bz2npc').length} bz→npc, ${npc.filter((r) => r.direction === 'npc2bz').length} npc→bz`);
check(npc.every((r) => r.profit > 0 && Number.isFinite(r.profitPerHour)), 'npc flips finite and profitable');

// ---- catalog v2
const copper = catalog.shops.filter((o) => o.currency === 'SKYBLOCK_COPPER' && snap.products[o.output]).length;
console.log(`\ncatalog v2: ${catalog.shops.length} shop offers, ${copper} copper -> bazaar, ${Object.values(catalog.items).filter((i) => i.shard).length} shards`);
check(copper >= 7, `≥7 copper offers resolve to bazaar products (got ${copper})`);
const sharp = catalog.bookRule('ENCHANTMENT_SHARPNESS');
check(sharp?.maxLevel === 5 && sharp.verified, `bookRule(ENCHANTMENT_SHARPNESS) = ${JSON.stringify(sharp)}`);

const spikes = flips.filter((r) => r.risk.flags.includes('PRICE_SPIKE')).length;
console.log(`\nPRICE_SPIKE flags (info, needs history): ${spikes}`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll sanity checks passed.');
