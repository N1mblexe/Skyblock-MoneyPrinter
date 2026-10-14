// npm run sanity [-- --offline] : end-to-end check of the domain layer against the real bazaar + generated catalog.
// --offline reads the cached bazaar ($BAZAAR_CACHE_DIR or .cache/bazaar.json) instead of fetching it.
import { existsSync, readFileSync } from 'node:fs';
import { fetchBazaar } from '../src/api/bazaarClient.ts';
import { toSnapshot, validateRaw } from '../src/api/normalize.ts';
import { catalogFromFile } from '../src/data/catalog.ts';
import { computeCrafts } from '../src/domain/craft.ts';
import { computeFlips } from '../src/domain/flip.ts';
import { computeNpcFlips } from '../src/domain/npc.ts';
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
console.log(`\ncrafts: ${crafts.length} bazaar-output recipes, ${priced.length} fully priced, ${priced.filter((r) => r.profit > 0).length} profitable`);
check(priced.length >= 380, `≥380 priceable recipes (legacy tool matched 322) — got ${priced.length}`);
check(crafts.every((r) => Number.isFinite(r.cost) && Number.isFinite(r.value) && (r.margin === null || Number.isFinite(r.margin))), 'no NaN/Infinity in craft rows');
const topCraft = priced.filter((r) => r.risk.level !== 'suspect').sort((a, b) => b.profitPerHour - a.profitPerHour).slice(0, 5);
for (const r of topCraft) console.log(`  ${r.name.padEnd(32)} cost ${Math.round(r.cost).toLocaleString('en').padStart(12)} value ${Math.round(r.value).toLocaleString('en').padStart(12)} ${Math.round(r.profitPerHour).toLocaleString('en')}/h`);

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
