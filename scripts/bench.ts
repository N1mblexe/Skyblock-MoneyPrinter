// Usage: npm run bench [-- --runs N] [-- --report] [-- --json out.json]
// Times every compute function, toOpportunities and allocate on the smoke fixtures (full bazaar, the real catalog,
// the fixture AH page and sales feed) with default settings, on the contexts src/state/derived.ts builds (a fresh
// market core per run, as on a new snapshot), and prints the median of N runs. `--report` also prints the top flips,
// crafts, books and NPC flips, the plan's profit per hour (with and without the shared-market capacities), and a few
// model facts (book slots, AH-sold craft rates), so a change to the model can be compared before / after.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanAuctions } from '../src/api/auctions.ts';
import { toSnapshot, validateRaw } from '../src/api/normalize.ts';
import { catalogFromFile, validateCatalogFile } from '../src/data/catalog.ts';
import { computeAhFlips, computeGeorgeFlips, type AhFlipRow } from '../src/domain/ahFlips.ts';
import { computeBitsRows } from '../src/domain/bits.ts';
import { computeBookCombines } from '../src/domain/books.ts';
import { computeChains } from '../src/domain/chains.ts';
import { computeCrafts } from '../src/domain/craft.ts';
import { computeFlips } from '../src/domain/flip.ts';
import { computeKatFlips, KAT_DERIVED_SKIP } from '../src/domain/kat.ts';
import { computeNpcFlips } from '../src/domain/npc.ts';
import { allocate, resourceCaps, toOpportunities } from '../src/domain/optimizer.ts';
import { computeShopRows } from '../src/domain/shops.ts';
import { defaultSettings } from '../src/state/appState.ts';
import type { BookRow, CraftRow, Opportunity, Settings } from '../src/types/contracts.ts';
import { filterKinds, PLAN_SCHEMA, planOptions, type PlanQuery } from '../src/ui/views/plan/model.ts';
import { derivedCtx, fixtureSales, loadSmokeFixtures, ROOT, withNow } from './lib/browser.ts';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const RUNS = Math.max(1, Number(arg('--runs') ?? 7));
const REPORT = argv.includes('--report');
const JSON_OUT = arg('--json');

const fixtures = loadSmokeFixtures();
const snap = toSnapshot(validateRaw(JSON.parse(withNow(fixtures.bazaar))), Date.now(), 'live');
const catalog = catalogFromFile(validateCatalogFile(JSON.parse(readFileSync(join(ROOT, 'public/data/catalog.json'), 'utf8'))));
const ah = await scanAuctions(async () => fixtures.ahPage, () => {});
const sales = fixtureSales(fixtures.ahEnded).summary;
const settings: Settings = { ...defaultSettings };
/** The Plan page's defaults with an empty URL, as smoke computes them. */
const PQ = Object.fromEntries(Object.entries(PLAN_SCHEMA).map(([k, f]) => [k, (f as { def: unknown }).def])) as unknown as PlanQuery;
const runPlan = (opps: readonly Opportunity[], capital: number, caps?: Record<string, number>) =>
  allocate(filterKinds(opps, PQ), planOptions(PQ, { ...settings, capital }, caps));
/** Fresh contexts per run (a new market core), so per-context memos (quotes, risk, pricers) are rebuilt as on a new snapshot. */
const freshCtx = () => derivedCtx({ snap, catalog, settings, ah, sales, derpy: false });

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}
function time<T>(fn: () => T): { ms: number; out: T } {
  const t0 = performance.now();
  const out = fn();
  return { ms: performance.now() - t0, out };
}

/** each step with the context derived gives it: `trade` (bazaar and NPC only) or `full` (calcCtx()) */
type Ctxs = ReturnType<typeof freshCtx>;
const steps: Record<string, (c: Ctxs) => unknown> = {
  flips: (c) => computeFlips(c.trade),
  crafts: (c) => computeCrafts(c.full),
  chains: (c) => computeChains(c.full),
  books: (c) => computeBookCombines(c.trade),
  npc: (c) => computeNpcFlips(c.trade),
  shops: (c) => computeShopRows(c.full),
  kat: (c) => computeKatFlips(c.full, { skip: KAT_DERIVED_SKIP, taming: settings.taming }),
  bits: (c) => computeBitsRows(c.full),
  ahFlips: () => computeAhFlips(ah, catalog, { conservative: settings.conservative, share: settings.share, ...(sales ? { sales: (id: string) => sales.byId[id] ?? null } : {}) }),
  george: () => computeGeorgeFlips(ah, catalog, { cycleHours: settings.cycleHours }),
};

const samples: Record<string, number[]> = {};
const push = (k: string, ms: number) => (samples[k] ??= []).push(ms);
let last: Record<string, unknown> = {};
for (let run = 0; run < RUNS; run++) {
  const ctx = freshCtx();
  const t0 = performance.now();
  const outs: Record<string, unknown> = {};
  for (const [k, fn] of Object.entries(steps)) {
    const r = time(() => fn(ctx));
    push(k, r.ms);
    outs[k] = r.out;
  }
  const o = time(() => {
    const ahFlips = [...(outs.ahFlips as AhFlipRow[]), ...(outs.george as AhFlipRow[])];
    return toOpportunities({ flips: outs.flips, crafts: outs.crafts, chains: outs.chains, books: outs.books, npc: outs.npc, kat: outs.kat, ahFlips } as Parameters<
      typeof toOpportunities
    >[0]);
  });
  push('toOpportunities', o.ms);
  const c = time(() => resourceCaps(ctx.full, o.out));
  push('resourceCaps', c.ms);
  const a = time(() => runPlan(o.out, settings.capital, c.out));
  push('allocate', a.ms);
  push('total', performance.now() - t0);
  last = { ...outs, opps: o.out, caps: c.out };
}

const timings = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, Math.round(median(v) * 10) / 10]));
console.log(`bench: ${Object.keys(snap.products).length} products, ${catalog.recipes.length} recipes, median of ${RUNS} runs (ms)`);
for (const [k, v] of Object.entries(timings)) console.log(`  ${k.padEnd(16)} ${String(v).padStart(8)}`);

let report: unknown = null;
if (REPORT) {
  type Row = { id: string; profitPerHour: number };
  const top = (rows: Row[]) =>
    [...rows]
      .sort((x, y) => y.profitPerHour - x.profitPerHour)
      .slice(0, 10)
      .map((r) => ({ id: r.id, pph: Math.round(r.profitPerHour) }));
  const opps = last.opps as ReturnType<typeof toOpportunities>;
  const plan = (capital: number, withCaps = true) => {
    const p = runPlan(opps, capital, withCaps ? (last.caps as Record<string, number>) : undefined);
    return { pph: Math.round(p.profitPerHour), positions: p.allocations.length, slots: p.slotsUsed, capital: Math.round(p.capitalUsed) };
  };
  const books = last.books as BookRow[];
  const ahCrafts = (last.crafts as CraftRow[]).filter((r) => r.valueSource === 'ah' && r.unpriced.length === 0);
  report = {
    flips: top(last.flips as Row[]),
    crafts: top(last.crafts as Row[]),
    books: top(books),
    npc: top(last.npc as Row[]),
    // with the shared-market capacities (as the Plan page) and without them (what shared volume costs the plan)
    plan: { base: plan(settings.capital), big: plan(1e9), baseNoCaps: plan(settings.capital, false), bigNoCaps: plan(1e9, false) },
    opportunities: opps.length,
    facts: {
      booksWithSlots: `${books.filter((r) => (r.tp.slots ?? 0) > 0).length} of ${books.filter((r) => r.tp.batchQty > 0).length} with a batch`,
      ahSoldCrafts: `${ahCrafts.filter((r) => Number.isFinite(r.outCraftsPerHour)).length} of ${ahCrafts.length} with a finite rate`,
    },
  };
  console.log(JSON.stringify(report, null, 2));
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ timings, report }, null, 2));
