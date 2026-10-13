// npm run sanity : live end-to-end check of the domain layer against the real bazaar + generated catalog.
import { readFileSync } from 'node:fs';
import { fetchBazaar } from '../src/api/bazaarClient.ts';
import { toSnapshot } from '../src/api/normalize.ts';
import { catalogFromFile } from '../src/data/catalog.ts';
import { computeCrafts } from '../src/domain/craft.ts';
import { computeFlips } from '../src/domain/flip.ts';
import { computeNpcFlips } from '../src/domain/npc.ts';
import { median } from '../src/domain/stats.ts';
import { defaultSettings } from '../src/state/appState.ts';
import type { CalcCtx, CatalogFile } from '../src/types/contracts.ts';

const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
};

const raw = await fetchBazaar();
const snap = toSnapshot(raw, Date.now(), 'live');
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

const spikes = flips.filter((r) => r.risk.flags.includes('PRICE_SPIKE')).length;
console.log(`\nPRICE_SPIKE flags (info, needs history): ${spikes}`);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll sanity checks passed.');
