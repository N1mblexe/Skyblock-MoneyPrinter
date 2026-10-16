// Browser smoke test. Usage: `npm run build && npm run smoke` (add `-- --live` to hit the real Hypixel API).
//
// Default (fixture) mode is hermetic: every request outside the preview server is stubbed or aborted
// (context.route), and the expected numbers are computed at startup from the same fixtures with the domain code
// (computeFlips, computeCrafts, allocate, ...) and default settings, so no threshold here is hand-picked.
//   bazaar   -> tests/fixtures/smoke/bazaar.json.gz (lastUpdated = now on every request)
//   auctions -> tests/fixtures/ah-page.json (page 0, totalPages 1; the app scans it as AH scan v3, so Kat runs)
//   election -> tests/fixtures/election.json
//   Google Fonts CSS -> empty stylesheet; anything else external -> aborted and reported.
// Suites: desktop 1280x800 (everything), mobile 390x844 (shell + routes + cards), error path (API down, manual load).
// --live: no stubbing, reduced checks (status, routes, flip rows, palette, language, mobile shell).
// Any console error or uncaught page error fails the run. Exit code 0 = all checks passed (or SKIP: no browser).
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Route as PwRoute } from 'playwright-core';
import { scanAuctions, type RawAhPage } from '../src/api/auctions.ts';
import { toSnapshot, validateRaw } from '../src/api/normalize.ts';
import { catalogFromFile, validateCatalogFile } from '../src/data/catalog.ts';
import { computeBookCombines } from '../src/domain/books.ts';
import { computeAhFlips } from '../src/domain/ahFlips.ts';
import { computeBitsRows } from '../src/domain/bits.ts';
import { bestPerLadder, computeChains } from '../src/domain/chains.ts';
import { computeKatFlips } from '../src/domain/kat.ts';
import { AHFLIP_SCHEMA, filterAhFlips, type AhFlipQuery } from '../src/ui/views/ahflip/model.ts';
import { BITS_SCHEMA, filterBitsRows, type BitsQuery } from '../src/ui/views/bits/model.ts';
import { filterKat, KAT_SCHEMA, type KatQuery } from '../src/ui/views/kat/model.ts';
import { computeCrafts } from '../src/domain/craft.ts';
import { computeFlips } from '../src/domain/flip.ts';
import { computeNpcFlips } from '../src/domain/npc.ts';
import { allocate, toOpportunities } from '../src/domain/optimizer.ts';
import { matchesQuery, resolveUserInput } from '../src/domain/search.ts';
import { computeShopRows } from '../src/domain/shops.ts';
import { defaultSettings } from '../src/state/appState.ts';
import type { CalcCtx, FlipRow, Settings } from '../src/types/contracts.ts';
import { CHAIN_SCHEMA, filterChains, filterCrafts, SCHEMA as CRAFT_SCHEMA, type ChainQuery, type KindFilter, type MarketFilter } from '../src/ui/views/craft/helpers.ts';
import { filterFlips, filterShops, FLIP_SCHEMA as NPC_FLIP_SCHEMA, SHOP_SCHEMA, SEGMENTS, type FlipFilters, type ShopFilters } from '../src/ui/views/npc/npcData.ts';
import { filterKinds, PLAN_SCHEMA, planOptions, type PlanQuery } from '../src/ui/views/plan/model.ts';
import { fmtCoins } from '../src/ui/format.ts';
import { findBrowser, freePort, loadSmokeFixtures, ROOT, sleep, startServer, withNow } from './lib/browser.ts';

const LIVE = process.argv.includes('--live');
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const ROUTES = ['overview', 'flip', 'books', 'ahflip', 'craft', 'forge', 'fusion', 'npc', 'kat', 'bits', 'plan', 'sell', 'trades', 'watch'] as const;
const ITEM = 'ENCHANTED_GOLD';
const FLIP_Q = 'enchanted';
const T = 15_000;

// ---------------------------------------------------------------- reporting

const failures: string[] = [];
let passes = 0;
function check(ok: boolean, msg: string): boolean {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (ok) passes++;
  else failures.push(msg);
  return ok;
}
const errText = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0]! : String(e));
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    check(false, `${name}: ${errText(e)}`);
  }
}

// ---------------------------------------------------------------- fixtures + expected values (domain code)

const fx = (p: string) => join(ROOT, p);
const FIXTURES = LIVE ? null : loadSmokeFixtures();
const BAZAAR_TEXT = FIXTURES?.bazaar ?? '';
const AH_PAGE: RawAhPage | null = FIXTURES?.ahPage ?? null;
const ELECTION_TEXT = FIXTURES?.election ?? '';

/** Schema defaults as the view's query state decodes them with an empty URL and no stored prefs. */
function defaults<V>(schema: Record<string, { def: unknown }>): V {
  return Object.fromEntries(Object.entries(schema).map(([k, f]) => [k, f.def && typeof f.def === 'object' ? { ...f.def } : f.def])) as V;
}

interface Expected {
  ctx: CalcCtx;
  flipRows: FlipRow[];
  flipDefault: number;
  flipQ: number;
  /** Craft page: shown / all craft recipes; Forge page: shown / all forge recipes */
  craftTotal: number;
  craftAll: number;
  forgeTotal: number;
  craftForge: number;
  chainTotal: number;
  chainDefault: number;
  ahFlipTotal: number;
  ahFlipDefault: number;
  katTotal: number;
  katDefault: number;
  /** with suspect rows shown (the fixture's thin pet markets are all suspect) */
  katSuspect: number;
  bitsTotal: number;
  bitsDefault: number;
  npc: Record<(typeof SEGMENTS)[number], number>;
  planPph: { base: string; big: string; baseN: number; bigN: number; positions: number };
  paletteId: string | null;
  mayor: string | null;
}

const BIG_CAPITAL = 1e9;

async function computeExpected(): Promise<Expected> {
  const raw = validateRaw(JSON.parse(withNow(BAZAAR_TEXT)));
  const snap = toSnapshot(raw, Date.now(), 'live');
  const catalog = catalogFromFile(validateCatalogFile(JSON.parse(readFileSync(fx('public/data/catalog.json'), 'utf8'))));
  const ah = await scanAuctions(async () => AH_PAGE!, () => {});
  const settings: Settings = { ...defaultSettings };
  // history has < RISK.spikeMinPoints points during the run, which assessRisk treats like no stats
  const ctx: CalcCtx = { snap, catalog, settings, stats: () => null, ah: (id) => ah.lowestBin[id] ?? null };

  // flip view defaults (FLIP_SCHEMA in src/ui/views/flip/flipView.ts, not importable here: it pulls in CSS):
  // minVol 10,000/week, minMargin 1 %, risk 'all', suspect rows hidden while settings.hideSuspicious
  const flipRows = computeFlips(ctx);
  const flipPass = (r: FlipRow) => r.weekVol >= 10_000 && r.margin >= 0.01 && !(settings.hideSuspicious && r.risk.level === 'suspect');
  const flipDefault = flipRows.filter(flipPass).length;
  const flipQ = flipRows.filter((r) => flipPass(r) && matchesQuery(catalog, r.id, FLIP_Q)).length;

  const crafts = computeCrafts(ctx);
  const cq = defaults<{ q: string; minVol: number | null; minMargin: number | null; minPph: number | null; kind: string; market: string; unpriced: boolean; suspect: boolean }>(CRAFT_SCHEMA);
  const craftCount = (kind: KindFilter) =>
    filterCrafts(
      crafts,
      { q: cq.q, minVol: cq.minVol, minMargin: cq.minMargin, minPph: cq.minPph, kind, market: cq.market as MarketFilter, showUnpriced: cq.unpriced, hideSuspect: settings.hideSuspicious && !cq.suspect },
      catalog,
    ).rows.length;

  // chains tab defaults: best move per ladder, min 2 steps, min margin 1 %, suspect hidden while hideSuspicious
  const chains = computeChains(ctx);
  const chq = defaults<ChainQuery>(CHAIN_SCHEMA);
  const chainDefault = filterChains(
    chains,
    { q: chq.q, only: chq.best ? bestPerLadder(chains) : null, minSteps: chq.minSteps, minMargin: chq.minMargin, minPph: chq.minPph, showUnpriced: chq.unpriced, hideSuspect: settings.hideSuspicious && !chq.suspect },
    catalog,
  ).rows.length;

  // AH flips page defaults, on the fixture scan (the fixture mayor is not Derpy)
  const ahFlips = computeAhFlips(ah, catalog);
  const afq = defaults<AhFlipQuery>(AHFLIP_SCHEMA);
  const ahFlipDefault = filterAhFlips(
    ahFlips,
    { q: afq.q, minProfit: afq.minProfit, minMargin: afq.minMargin, minCount: afq.minCount, pets: afq.pets, hideSuspect: settings.hideSuspicious && !afq.suspect },
    catalog,
  ).rows.length;

  // Kat page defaults: no skip items, Taming 60 (no rows dropped), both bands, min profit 100k, unpriced and suspect hidden
  const katAll = computeKatFlips(ctx, { skip: 'none' });
  const kq = defaults<KatQuery>(KAT_SCHEMA);
  const katCount = (suspect: boolean) =>
    filterKat(
      katAll,
      {
        q: kq.q,
        minProfit: kq.minProfit,
        maxCapital: kq.maxCapital,
        maxHours: kq.maxHours,
        taming: kq.taming,
        band: kq.band === 'any' || kq.band === 'max' ? kq.band : 'both',
        showUnpriced: kq.unpriced,
        hideSuspect: settings.hideSuspicious && !suspect,
      },
      catalog,
    ).rows.length;
  const katDefault = katCount(kq.suspect);
  const katSuspect = katCount(true);

  // Bits page defaults: New Player rank (x1, nothing stored), every source, untradeable / unpriced and suspect hidden
  const bits = computeBitsRows(ctx, { multiplier: 1 }).rows;
  const bq = defaults<BitsQuery>(BITS_SCHEMA);
  const bitsDefault = filterBitsRows(bits, { q: bq.q, minCpb: bq.minCpb, src: bq.src, unsold: bq.unsold, hideSuspect: settings.hideSuspicious && !bq.suspect }, catalog).rows.length;

  const npcAll = computeNpcFlips(ctx);
  const ff = defaults<FlipFilters>(NPC_FLIP_SCHEMA);
  const sf = defaults<ShopFilters>(SHOP_SCHEMA);
  const npc = {
    bz2npc: filterFlips(npcAll, 'bz2npc', ff, { snap, catalog, settings }).rows.length,
    npc2bz: filterFlips(npcAll, 'npc2bz', ff, { snap, catalog, settings }).rows.length,
    shops: filterShops(computeShopRows(ctx), sf, catalog, settings.hideSuspicious).rows.length,
  };

  const opps = toOpportunities({ flips: flipRows, crafts, chains, books: computeBookCombines(ctx), npc: npcAll, kat: katAll }, settings);
  const pq = defaults<PlanQuery>(PLAN_SCHEMA);
  const plan = (capital: number) => allocate(filterKinds(opps, pq), planOptions(pq, { ...settings, capital }));
  const base = plan(settings.capital);
  const big = plan(BIG_CAPITAL);

  const election = JSON.parse(ELECTION_TEXT) as { mayor?: { name?: string } };
  return {
    ctx,
    flipRows,
    flipDefault,
    flipQ,
    craftTotal: crafts.filter((r) => r.recipe.kind === 'craft').length,
    craftAll: craftCount('craft'),
    forgeTotal: crafts.filter((r) => r.recipe.kind === 'forge').length,
    craftForge: craftCount('forge'),
    chainTotal: chains.length,
    chainDefault,
    ahFlipTotal: ahFlips.length,
    ahFlipDefault,
    katTotal: katAll.length,
    katDefault,
    katSuspect,
    bitsTotal: bits.length,
    bitsDefault,
    npc,
    planPph: { base: fmtCoins(base.profitPerHour), big: fmtCoins(big.profitPerHour), baseN: base.profitPerHour, bigN: big.profitPerHour, positions: base.allocations.length },
    paletteId: resolveUserInput(catalog, 'enchanted gold', new Set(Object.keys(snap.products))),
    mayor: election.mayor?.name ?? null,
  };
}

// ---------------------------------------------------------------- browser env (routes + error collection)

interface Env {
  label: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
  /** URLs we aborted on purpose ("Failed to load resource" for them is expected) */
  aborted: Set<string>;
  unexpected: string[];
  bazaar: { mode: 'serve' | 'abort'; text: string };
  hits: Record<'bazaar' | 'auctions' | 'election', number>;
}

let BASE = '';

async function openEnv(browser: Browser, label: string, viewport: { width: number; height: number }, bazaarMode: 'serve' | 'abort' = 'serve'): Promise<Env> {
  const context = await browser.newContext({ viewport, acceptDownloads: true, locale: 'en-US', serviceWorkers: 'block' });
  const env: Env = {
    label,
    context,
    page: null as unknown as Page,
    errors: [],
    aborted: new Set(),
    unexpected: [],
    bazaar: { mode: bazaarMode, text: BAZAAR_TEXT },
    hits: { bazaar: 0, auctions: 0, election: 0 },
  };
  if (!LIVE) await context.route('**/*', (route) => handleRoute(env, route));
  const page = await context.newPage();
  page.setDefaultTimeout(T);
  env.page = page;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location().url;
    if (m.text().startsWith('Failed to load resource') && env.aborted.has(url)) return;
    env.errors.push(`console.error: ${m.text()}${url ? ` (${url})` : ''}`);
  });
  page.on('pageerror', (e) => env.errors.push(`pageerror: ${errText(e)}`));
  page.on('crash', () => env.errors.push('page crashed'));
  return env;
}

function abort(env: Env, route: PwRoute, url: string): Promise<void> {
  env.aborted.add(url);
  return route.abort('failed');
}

async function handleRoute(env: Env, route: PwRoute): Promise<void> {
  const url = route.request().url();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return route.continue();
  }
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
  const json = (body: string) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
  if (u.hostname === 'api.hypixel.net') {
    if (u.pathname === '/v2/skyblock/bazaar') {
      env.hits.bazaar++;
      if (env.bazaar.mode === 'abort') return abort(env, route, url);
      return json(withNow(env.bazaar.text));
    }
    if (u.pathname === '/v2/skyblock/auctions') {
      env.hits.auctions++;
      const page = Number(u.searchParams.get('page') ?? 0);
      if (page !== 0) return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"success":false}' });
      return json(JSON.stringify(AH_PAGE));
    }
    if (u.pathname === '/v2/resources/skyblock/election') {
      env.hits.election++;
      return json(ELECTION_TEXT);
    }
  }
  if (u.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  if (u.hostname !== 'fonts.gstatic.com') env.unexpected.push(url);
  return abort(env, route, url);
}

async function closeEnv(env: Env): Promise<void> {
  check(env.errors.length === 0, `[${env.label}] no console errors / page errors${env.errors.length ? `: ${env.errors.slice(0, 6).join(' | ')}` : ''}`);
  if (!LIVE) check(env.unexpected.length === 0, `[${env.label}] no unexpected external requests${env.unexpected.length ? `: ${[...new Set(env.unexpected)].slice(0, 5).join(', ')}` : ''}`);
  await env.context.close();
}

// ---------------------------------------------------------------- page helpers

const tid = (id: string) => `[data-testid="${id}"]`;
const ints = (s: string | null | undefined): number[] => (s?.match(/\d[\d.,   ]*/g) ?? []).map((x) => Number(x.replace(/\D/g, '')));
const hash = (page: Page) => new URL(page.url()).hash;
const query = (page: Page) => new URLSearchParams(hash(page).split('?')[1] ?? '');

/** Poll fn until ok(value) or timeout; returns the last value. */
async function until<V>(fn: () => Promise<V>, ok: (v: V) => boolean, ms = T): Promise<V> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(100);
    v = await fn();
  }
  return v;
}

const statusOf = (page: Page) => page.getAttribute(tid('status-pill'), 'data-status');
const textOf = async (l: Locator) => ((await l.count()) ? ((await l.first().textContent()) ?? '').trim() : '');

/** Hash navigation inside the running app (no reload). */
async function go(page: Page, h: string): Promise<void> {
  await page.evaluate((x) => (location.hash = x), h);
  await page.waitForFunction((x) => location.hash.startsWith(x.split('?')[0]!), h);
}

async function h1Text(page: Page): Promise<string> {
  const h1 = page.locator('#view h1').first();
  await h1.waitFor({ state: 'attached', timeout: T });
  return until(
    async () => ((await h1.textContent()) ?? '').trim(),
    (s) => s.length > 0,
  );
}

/** Wait until the count text under `sel` holds `n` (as one of its integers). */
async function countIs(page: Page, sel: string, n: number, ms = T): Promise<number[]> {
  return until(
    async () => ints(await textOf(page.locator(sel))),
    (xs) => xs.includes(n),
    ms,
  );
}

async function isOpen(page: Page, sel: string): Promise<boolean> {
  return page
    .locator(sel)
    .first()
    .evaluate((el) => (el as HTMLDialogElement).open === true || el.hasAttribute('open'))
    .catch(() => false);
}

async function waitLive(page: Page, ms = 20_000): Promise<string | null> {
  return until(() => statusOf(page), (s) => s === 'live', ms);
}

// ---------------------------------------------------------------- suites

async function routesSuite(env: Env, mobile: boolean): Promise<void> {
  const { page, label } = env;
  for (const id of ROUTES) {
    await step(`[${label}] #/${id}`, async () => {
      await go(page, `#/${id}`);
      const h = await h1Text(page);
      check(h.length > 0, `[${label}] #/${id} shows its h1 ("${h}")`);
      if (!mobile) {
        const cur = await page.locator(`${tid('sidebar')} [aria-current="page"]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
        check(cur.length === 1 && cur[0] === `tab-${id}`, `[${label}] sidebar aria-current is tab-${id} (${cur.join(',') || 'none'})`);
      }
    });
  }
  await step(`[${label}] #/item/${ITEM}`, async () => {
    await go(page, `#/item/${ITEM}`);
    const name = await until(() => textOf(page.locator(tid('item-name'))), (s) => /enchanted gold/i.test(s));
    check(/enchanted gold/i.test(name), `[${label}] #/item/${ITEM} shows its h1 ("${name}")`);
    const book = await until(() => page.locator(`${tid('order-book')} tbody tr`).count(), (n) => n > 0);
    check(book > 0, `[${label}] item page shows order book levels (${book})`);
    if (!mobile) {
      const cur = await page.locator(`${tid('sidebar')} [aria-current="page"]`).count();
      check(cur === 0, `[${label}] item route highlights no sidebar link (${cur})`);
    }
  });
}

async function desktopSuite(browser: Browser, exp: Expected): Promise<void> {
  const env = await openEnv(browser, 'desktop', DESKTOP);
  const { page } = env;
  const L = '[desktop]';
  await page.goto(BASE + '#/overview');

  await step(`${L} initial load`, async () => {
    const s = await waitLive(page);
    check(s === 'live', `${L} status reaches live (got ${s})`);
    const mayor = await until(() => textOf(page.locator(tid('mayor-chip'))), (t) => !!exp.mayor && t.includes(exp.mayor));
    check(!!exp.mayor && mayor.includes(exp.mayor), `${L} mayor chip shows the fixture mayor "${exp.mayor}" ("${mayor}")`);
  });

  await step(`${L} AH status`, async () => {
    const ah = page.locator(tid('ah-status'));
    const state = await until(() => ah.getAttribute('data-state'), (s) => s === 'idle', 30_000);
    const text = await textOf(ah);
    check(
      state === 'idle' && (await ah.isVisible()) && /^AH \d+ ?(sn|dk|sa|gün|s|m|h|d)$/.test(text),
      `${L} AH chip shows the scan age after the scan ("${text}", state ${state}, auctions requests ${env.hits.auctions})`,
    );
  });

  await routesSuite(env, false);

  await step(`${L} palette`, async () => {
    await go(page, '#/overview');
    await h1Text(page);
    await page.keyboard.press('/');
    const input = page.locator('.kit-palette-input');
    await input.waitFor({ state: 'visible', timeout: T });
    await input.fill('enchanted gold');
    const first = await until(() => textOf(page.locator('.kp-opt .kp-hint')), (s) => s === exp.paletteId);
    check(first === exp.paletteId, `${L} palette ranks ${exp.paletteId} first for "enchanted gold" (${first})`);
    await page.keyboard.press('Enter');
    const h = await until(async () => hash(page), (x) => x === `#/item/${exp.paletteId}`);
    check(h === `#/item/${exp.paletteId}`, `${L} palette Enter opens the item page (${h})`);
    check(!(await page.locator('.kit-palette-input').isVisible()), `${L} palette closes after Enter`);
  });

  await step(`${L} shortcuts dialog`, async () => {
    await h1Text(page);
    await page.locator('#view h1').first().focus();
    await page.keyboard.press('?');
    const open = await until(() => isOpen(page, tid('shortcuts-dialog')), (x) => x);
    const rows = await page.locator(`${tid('shortcuts-dialog')} ${tid('shortcuts')} tr`).count();
    check(open && rows > 0, `${L} "?" opens the shortcuts dialog (${rows} rows)`);
    await page.keyboard.press('Escape');
    const stillOpen = await until(() => isOpen(page, tid('shortcuts-dialog')), (x) => !x);
    check(!stillOpen, `${L} Escape closes the shortcuts dialog`);
  });

  await flipSuite(env, exp);
  await craftSuite(env, exp);
  await npcSuite(env, exp);
  await fusionSuite(env, exp);
  await settingsSuite(env, exp);
  await watchSuite(env, exp);
  await closeEnv(env);
}

async function flipSuite(env: Env, exp: Expected): Promise<void> {
  const { page } = env;
  const L = '[desktop]';
  const count = tid('flip-count');
  const search = `${tid('flip-view')} input[data-filter="q"]`;

  await step(`${L} flip count`, async () => {
    await go(page, '#/flip');
    const n = await countIs(page, count, exp.flipDefault);
    check(n.includes(exp.flipDefault), `${L} flip count matches the domain (${exp.flipDefault} of ${exp.flipRows.length} flips pass the default filters; UI ${n.join('/')})`);
    const rows = await page.locator(`${tid('flip-view')} tbody tr[data-key]`).count();
    check(rows >= Math.min(exp.flipDefault, 10), `${L} flip table renders rows (${rows} in the DOM)`);
  });

  await step(`${L} flip filter -> URL`, async () => {
    await page.fill(search, FLIP_Q);
    const q = await until(async () => query(page).get('q'), (v) => v === FLIP_Q);
    check(q === FLIP_Q, `${L} search filter writes q=${FLIP_Q} to the URL (${hash(page)})`);
    const n = await countIs(page, count, exp.flipQ);
    check(n.includes(exp.flipQ), `${L} filtered flip count matches the domain (${exp.flipQ}; UI ${n.join('/')})`);
  });

  await step(`${L} flip filter survives reload`, async () => {
    await page.reload();
    await h1Text(page);
    check(query(page).get('q') === FLIP_Q, `${L} URL keeps q after reload (${hash(page)})`);
    const v = await until(() => page.inputValue(search), (x) => x === FLIP_Q);
    check(v === FLIP_Q, `${L} search box restored from the URL ("${v}")`);
    const n = await countIs(page, count, exp.flipQ, 25_000);
    check(n.includes(exp.flipQ), `${L} filtered count after reload (${exp.flipQ}; UI ${n.join('/')})`);
    await page.fill(search, '');
    const back = await countIs(page, count, exp.flipDefault);
    const noQ = await until(async () => query(page).has('q'), (x) => !x);
    check(back.includes(exp.flipDefault) && !noQ, `${L} clearing the filter restores the full list and drops q from the URL (${hash(page)})`);
  });

  await step(`${L} flip row -> detail panel`, async () => {
    const row = page.locator(`${tid('flip-view')} tbody tr[data-key]`).first();
    const key = await row.getAttribute('data-key');
    await row.locator('td.num').last().click();
    const panel = page.locator(`.kit-panel .flip-dp[data-id="${key}"]`);
    await panel.waitFor({ state: 'visible', timeout: T });
    check(await panel.isVisible(), `${L} row click opens the detail panel for ${key}`);
    check(hash(page).startsWith('#/flip'), `${L} row click stays on #/flip (${hash(page)})`);
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden', timeout: T }).catch(() => {});
    check(!(await panel.isVisible()), `${L} Escape closes the detail panel`);
  });

  await step(`${L} flip CSV export`, async () => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: T }), page.click(`${tid('flip-view')} [data-tool="csv"]`)]);
    const name = dl.suggestedFilename();
    const lines = readFileSync(await dl.path(), 'utf8').split('\r\n').filter((l) => l.length > 0);
    check(/^flips-\d{8}-\d{4}\.csv$/.test(name), `${L} CSV export fires a download (${name})`);
    check(lines.length - 1 === exp.flipDefault, `${L} CSV has one line per shown flip (${lines.length - 1}, expected ${exp.flipDefault})`);
  });
}

async function craftSuite(env: Env, exp: Expected): Promise<void> {
  const { page } = env;
  const L = '[desktop]';
  const counts = async () => ints(await textOf(page.locator('.craft-count')));
  await step(`${L} forge page`, async () => {
    // an old #/craft?kind=forge link opens the Forge page
    await go(page, '#/craft?kind=forge');
    const h1 = await until(() => h1Text(page), (x) => x === 'Forge');
    const n = await until(counts, (xs) => xs.includes(exp.craftForge) && xs.includes(exp.forgeTotal));
    check(
      h1 === 'Forge' && n.includes(exp.craftForge) && n.includes(exp.forgeTotal),
      `${L} #/craft?kind=forge opens the Forge page with the domain count (${exp.craftForge} of ${exp.forgeTotal}; UI ${n.join('/')}, h1 "${h1}")`,
    );
    const rows = await page.locator('.craft-table tbody tr[data-key]').count();
    check(rows === exp.craftForge, `${L} forge table rows = domain count (${rows})`);
    await go(page, '#/craft');
    const all = await until(counts, (xs) => xs.includes(exp.craftAll) && xs.includes(exp.craftTotal));
    check(all.includes(exp.craftAll) && all.includes(exp.craftTotal), `${L} Craft page shows the domain count (${exp.craftAll} of ${exp.craftTotal}; UI ${all.join('/')})`);
  });
  await step(`${L} AH flips page`, async () => {
    await go(page, '#/ahflip');
    const n = await until(async () => ints(await textOf(page.locator(tid('ahflip-count')))), (xs) => xs.includes(exp.ahFlipDefault) && xs.includes(exp.ahFlipTotal));
    check(
      n.includes(exp.ahFlipDefault) && n.includes(exp.ahFlipTotal),
      `${L} AH flips page shows the domain count (${exp.ahFlipDefault} of ${exp.ahFlipTotal}; UI ${n.join('/')})`,
    );
  });
  await step(`${L} Kat upgrades page`, async () => {
    await go(page, '#/kat');
    const n = await until(async () => ints(await textOf(page.locator(tid('kat-count')))), (xs) => xs.includes(exp.katDefault) && xs.includes(exp.katTotal));
    check(
      n.includes(exp.katDefault) && n.includes(exp.katTotal),
      `${L} Kat page shows the domain count (${exp.katDefault} of ${exp.katTotal} upgrades; UI ${n.join('/')})`,
    );
    // past the AH-off / no-scan / old-scan / catalog gates: the table (or its empty text), not a blocked notice
    const blocked = await page.locator('.kat-view .kat-state').isVisible();
    const rows = await page.locator('.kat-view tbody tr[data-key]').count();
    check(
      !blocked && (await page.locator(tid('kat-count')).isVisible()) && (rows === exp.katDefault || (exp.katDefault > 50 && rows > 0)),
      `${L} Kat table renders, not a blocked state (${rows} rows in the DOM, domain ${exp.katDefault})`,
    );
    await go(page, '#/kat?suspect=1');
    const s = await until(async () => ints(await textOf(page.locator(tid('kat-count')))), (xs) => xs[0] === exp.katSuspect);
    const sRows = await until(() => page.locator('.kat-view tbody tr[data-key]').count(), (x) => x === exp.katSuspect);
    check(s[0] === exp.katSuspect && sRows === exp.katSuspect, `${L} Kat suspect toggle from the URL shows ${exp.katSuspect} rows (UI ${s.join('/')}, ${sRows} in the DOM)`);
    if (sRows > 0) {
      await page.locator('.kat-view tbody tr[data-key]').first().locator('td.num').last().click();
      const steps = await until(() => page.locator('.kat-detail .kat-steps > li').count(), (x) => x > 0);
      check(steps > 0, `${L} Kat row opens its upgrade steps (${steps})`);
      await page.keyboard.press('Escape');
    }
  });
  await step(`${L} Bits shop page`, async () => {
    await go(page, '#/bits');
    const n = await until(async () => ints(await textOf(page.locator(tid('bits-count')))), (xs) => xs.includes(exp.bitsDefault) && xs.includes(exp.bitsTotal));
    check(
      exp.bitsTotal > 0 && n.includes(exp.bitsDefault) && n.includes(exp.bitsTotal),
      `${L} Bits page shows the domain count (${exp.bitsDefault} of ${exp.bitsTotal} items; UI ${n.join('/')})`,
    );
  });
  await step(`${L} craft chains tab`, async () => {
    await go(page, '#/craft');
    await page.click(tid('craft-tab-chains'));
    const h = await until(async () => hash(page), (x) => x.startsWith('#/craft?view=chains'));
    const n = await until(async () => ints(await textOf(page.locator(tid('chain-count')))), (xs) => xs.includes(exp.chainDefault) && xs.includes(exp.chainTotal));
    check(
      h.startsWith('#/craft?view=chains') && n.includes(exp.chainDefault) && n.includes(exp.chainTotal),
      `${L} Chains tab shows the domain count (${exp.chainDefault} of ${exp.chainTotal} moves; UI ${n.join('/')}, ${h})`,
    );
    await page.locator('.chains-view tbody tr[data-key]').first().locator('td.num').last().click();
    const steps = await until(() => page.locator('.chain-detail .chain-ladder tbody tr').count(), (x) => x >= 3);
    check(steps >= 3, `${L} chain row opens its ladder (${steps} tiers)`);
    await page.keyboard.press('Escape');
  });
}

async function npcSuite(env: Env, exp: Expected): Promise<void> {
  const { page } = env;
  const L = '[desktop]';
  await step(`${L} npc segments`, async () => {
    await go(page, '#/npc');
    await h1Text(page);
    for (const seg of SEGMENTS) {
      await page.click(`${tid('npc-seg')} button[data-seg="${seg}"]`);
      const box = seg === 'shops' ? tid('npc-shops') : tid('npc-flips');
      const other = seg === 'shops' ? tid('npc-flips') : tid('npc-shops');
      const n = await countIs(page, `${box} .npc-count`, exp.npc[seg]);
      const shown = await page.locator(box).isVisible();
      const hidden = !(await page.locator(other).isVisible());
      const pressed = await page.getAttribute(`${tid('npc-seg')} button[data-seg="${seg}"]`, 'aria-pressed');
      check(shown && hidden && n.includes(exp.npc[seg]), `${L} npc segment ${seg} renders with the domain row count (${exp.npc[seg]}; UI ${n.join('/')}; pressed=${pressed})`);
      if (seg === 'shops') {
        const rows = await page.locator(`${box} tbody tr[data-key]`).count();
        check(
          exp.npc.shops > 0 ? rows > 0 : rows === 0,
          `${L} shops table rows ${exp.npc.shops > 0 ? 'present' : 'absent'} as the catalog implies (${rows} DOM rows, domain ${exp.npc.shops})`,
        );
      }
      const dir = await until(async () => query(page).get('dir'), (d) => (seg === 'bz2npc' ? d === null : d === seg));
      check(seg === 'bz2npc' ? dir === null : dir === seg, `${L} npc segment ${seg} is reflected in the URL (${hash(page)})`);
    }
    await page.click(`${tid('npc-seg')} button[data-seg="bz2npc"]`);
  });
}

async function fusionSuite(env: Env, exp: Expected): Promise<void> {
  const { page } = env;
  const L = '[desktop]';
  const rows = page.locator('.fu-list > li.fu-row');
  await step(`${L} fusion add`, async () => {
    await go(page, '#/fusion');
    await h1Text(page);
    const n0 = await rows.count();
    await page.click('.fu-add');
    const n1 = await until(() => rows.count(), (n) => n === n0 + 1);
    check(n1 === n0 + 1, `${L} fusion "add" adds a recipe row (${n0} -> ${n1})`);
  });
  await step(`${L} fusion import`, async () => {
    const n0 = await rows.count();
    const shards = Object.values(exp.ctx.catalog.items)
      .filter((i) => i.shard && exp.ctx.snap.products[i.id])
      .slice(0, 3)
      .map((i) => i.id);
    const [a = 'SHARD_A', b = 'SHARD_B', out = 'SHARD_C'] = shards;
    const json = JSON.stringify([
      { a, qa: 5, b, qb: 5, out, qo: 1 },
      { a: b, qa: 2, b: out, qb: 3, out: a, qo: 1 },
    ]);
    await page.click('.fu-import');
    const ta = page.locator(tid('fusion-import-text'));
    await ta.waitFor({ state: 'visible', timeout: T });
    await ta.fill(json);
    await page.click(tid('fusion-import-go'));
    const n1 = await until(() => rows.count(), (n) => n === n0 + 2);
    check(n1 === n0 + 2, `${L} fusion JSON import via the drawer adds 2 recipes (${n0} -> ${n1})`);
    check(!(await ta.isVisible()), `${L} import drawer closes after import`);
    const cnt = await until(async () => ints(await textOf(page.locator('.fu-count'))), (xs) => xs.includes(n1));
    check(cnt.includes(n1), `${L} fusion count text follows (${cnt.join('/')})`);
  });
}

async function settingsSuite(env: Env, exp: Expected): Promise<void> {
  const { page } = env;
  const L = '[desktop]';
  const pph = tid('plan-pph');
  const drawer = tid('settings-drawer');
  await step(`${L} settings: capital -> planner`, async () => {
    await go(page, '#/plan');
    await h1Text(page);
    const before = await until(() => textOf(page.locator(pph)), (s) => s === exp.planPph.base);
    check(before === exp.planPph.base, `${L} planner profit/hour matches the domain at the default capital (${exp.planPph.base}; UI "${before}")`);
    const pos = ints(await textOf(page.locator(tid('plan-positions'))));
    check(pos[0] === exp.planPph.positions, `${L} planner positions match the domain (${exp.planPph.positions}; UI ${pos.join('/')})`);
    await page.click(tid('settings-btn'));
    const open = await until(() => isOpen(page, drawer), (x) => x);
    check(open, `${L} settings button opens the drawer`);
    await page.fill(`${drawer} [name="capital"]`, '1b');
    await page.press(`${drawer} [name="capital"]`, 'Tab');
    const after = await until(() => textOf(page.locator(pph)), (s) => s === exp.planPph.big);
    check(
      exp.planPph.bigN !== exp.planPph.baseN && after === exp.planPph.big && after !== before,
      `${L} capital 1b changes planner profit/hour to the domain value (${before} -> ${after}; expected ${exp.planPph.big})`,
    );
    await page.fill(`${drawer} [name="capital"]`, '5m');
    await page.press(`${drawer} [name="capital"]`, 'Tab');
    const reset = await until(() => textOf(page.locator(pph)), (s) => s === exp.planPph.base);
    check(reset === exp.planPph.base, `${L} capital back to 5m restores profit/hour (${reset})`);
  });

  await step(`${L} settings: theme`, async () => {
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? 'auto');
    const t0 = await theme();
    await page.click(`${drawer} ${tid('set-theme-light')}`);
    const t1 = await until(theme, (x) => x === 'light');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.click(`${drawer} ${tid('set-theme-dark')}`);
    const t2 = await until(theme, (x) => x === 'dark');
    const bg2 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(t0 === 'dark' && t1 === 'light' && t2 === 'dark', `${L} theme toggle sets <html data-theme> (${t0} -> ${t1} -> ${t2})`);
    check(bg !== bg2, `${L} theme toggle changes the page background (${bg} vs ${bg2})`);
  });

  await step(`${L} settings: density`, async () => {
    const dens = () => page.evaluate(() => document.documentElement.dataset.density ?? '');
    await page.click(`${drawer} ${tid('set-density-compact')}`);
    const d1 = await until(dens, (x) => x === 'compact');
    await page.click(`${drawer} ${tid('set-density-comfortable')}`);
    const d2 = await until(dens, (x) => x === 'comfortable');
    check(d1 === 'compact' && d2 === 'comfortable', `${L} density switch sets <html data-density> (${d1} -> ${d2})`);
  });

  await step(`${L} settings: language`, async () => {
    const en = await h1Text(page);
    await page.click(`${drawer} ${tid('set-lang-tr')}`);
    const tr = await until(() => h1Text(page), (x) => x !== en);
    const pressed = await page.getAttribute(tid('lang-tr'), 'aria-pressed');
    const htmlLang = await page.getAttribute('html', 'lang');
    check(tr !== en && pressed === 'true' && htmlLang === 'tr', `${L} TR switch changes the h1 ("${en}" -> "${tr}", top-bar TR pressed=${pressed}, html lang=${htmlLang})`);
    await page.click(`${drawer} ${tid('set-lang-en')}`);
    const back = await until(() => h1Text(page), (x) => x === en);
    check(back === en, `${L} EN switch restores the h1 ("${back}")`);
    await page.keyboard.press('Escape');
    const stillOpen = await until(() => isOpen(page, drawer), (x) => !x);
    check(!stillOpen, `${L} Escape closes the settings drawer`);
  });
}

async function watchSuite(env: Env, exp: Expected): Promise<void> {
  const { page } = env;
  const L = '[desktop]';
  let target = '';
  await step(`${L} watch: star from flip row`, async () => {
    await go(page, '#/flip');
    await countIs(page, tid('flip-count'), exp.flipDefault);
    const keys = await page.locator(`${tid('flip-view')} tbody tr[data-key]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-key')!));
    // a product with ask >= 10, so an integer threshold fits between the current ask and the halved one
    target = keys.find((k) => (exp.ctx.snap.products[k]?.ask ?? 0) >= 10) ?? keys[0]!;
    const btn = page.locator(`${tid('flip-view')} tbody tr[data-key="${target}"] [data-action="watch"]`);
    await btn.click();
    const pressed = await until(() => btn.getAttribute('aria-pressed'), (x) => x === 'true');
    const badge = await until(() => textOf(page.locator(`${tid('tab-watch')} .sb-badge`)), (x) => x === '1');
    check(pressed === 'true' && badge === '1', `${L} ★ on the flip row watches ${target} (pressed=${pressed}, nav badge "${badge}")`);
  });

  await step(`${L} watch: list + alert rule`, async () => {
    const ask = exp.ctx.snap.products[target]?.ask ?? 0;
    const threshold = Math.floor(ask * 0.75);
    await go(page, '#/watch');
    await h1Text(page);
    const row = page.locator(`${tid('watch-table')} [data-key="${target}"]`);
    await row.waitFor({ state: 'visible', timeout: T });
    check(await row.isVisible(), `${L} watch list shows ${target}`);
    await row.locator('[data-action="alert"]').click();
    const rule = page.locator(`${tid('watch-rules')} section[data-id="${target}"] [data-rule]`).first();
    await rule.waitFor({ state: 'visible', timeout: T });
    await rule.locator('[data-f="metric"]').selectOption('ask');
    await rule.locator('[data-f="op"]').selectOption('lt');
    await rule.locator('[data-f="value"]').fill(String(threshold));
    await rule.locator('[data-f="value"]').press('Tab');
    const stored = await until(
      () =>
        page.evaluate(
          (id) => (JSON.parse(localStorage.getItem('bazaarMasasi.alerts') ?? '[]') as { id: string; value: number; op: string }[]).find((r) => r.id === id) ?? null,
          target,
        ),
      (r) => r?.value === threshold && r.op === 'lt',
    );
    check(stored?.value === threshold && stored.op === 'lt', `${L} alert rule "${target} ask < ${threshold}" saved (ask now ${ask})`);
    check((await rule.locator('.wr-met').count()) === 0, `${L} rule is not met at the current ask`);
  });

  await step(`${L} watch: alert fires on new prices`, async () => {
    type RawP = { buy_summary: { pricePerUnit: number }[]; sell_summary: { pricePerUnit: number }[]; quick_status: { buyPrice: number; sellPrice: number } };
    const raw = JSON.parse(BAZAAR_TEXT) as { products: Record<string, RawP> };
    const p = raw.products[target]!;
    const half = (x: number) => Math.round(x * 5) / 10;
    for (const o of p.buy_summary) o.pricePerUnit = half(o.pricePerUnit);
    for (const o of p.sell_summary) o.pricePerUnit = half(o.pricePerUnit);
    p.quick_status.buyPrice /= 2;
    p.quick_status.sellPrice /= 2;
    env.bazaar.text = JSON.stringify(raw);
    const logRows = page.locator(`${tid('watch-log')} [data-key]`);
    const before = await logRows.count();
    const hits = env.hits.bazaar;
    await page.click(tid('refresh-btn'));
    const name = exp.ctx.catalog.name(target);
    const toast = page.locator('.kit-toast-warn', { hasText: name }).first();
    await toast.waitFor({ state: 'visible', timeout: T });
    check(await toast.isVisible(), `${L} refresh with halved prices shows an alert toast for ${name} (bazaar requests ${hits} -> ${env.hits.bazaar})`);
    const after = await until(() => logRows.count(), (n) => n > before);
    check(after > before, `${L} alert log gets an entry (${before} -> ${after})`);
    const met = await until(() => page.locator(`${tid('watch-rules')} section[data-id="${target}"] .wr-met`).count(), (n) => n > 0);
    check(met > 0, `${L} rule shows as met after the price drop`);
    env.bazaar.text = BAZAAR_TEXT;
  });
}

async function mobileSuite(browser: Browser, exp: Expected | null): Promise<void> {
  const env = await openEnv(browser, 'mobile', MOBILE);
  const { page } = env;
  const L = '[mobile]';
  await page.goto(BASE + '#/overview');
  await step(`${L} shell`, async () => {
    const s = await waitLive(page, LIVE ? 30_000 : 20_000);
    check(s === 'live', `${L} status reaches live (got ${s})`);
    const layout = await page.getAttribute('.app', 'data-layout');
    const more = await page.locator(tid('nav-more')).isVisible();
    const prim = await Promise.all(['overview', 'flip', 'craft', 'watch'].map((id) => page.locator(tid(`tab-${id}`)).isVisible()));
    const sec = await Promise.all(['books', 'npc', 'fusion', 'plan'].map((id) => page.locator(tid(`tab-${id}`)).isVisible()));
    check(
      layout === 'mobile' && more && prim.every(Boolean) && !sec.some(Boolean),
      `${L} bottom nav shows the primary links + More (layout=${layout}, more=${more}, primary=${prim.join(',')}, secondary=${sec.join(',')})`,
    );
    const box = await page.locator(tid('sidebar')).boundingBox();
    check(!!box && box.y + box.height >= MOBILE.height - 2 && box.y > MOBILE.height / 2, `${L} nav is docked at the bottom (${box ? `y=${box.y}, h=${box.height}` : 'no box'})`);
  });

  await step(`${L} More sheet`, async () => {
    await page.click(tid('nav-more'));
    const open = await until(() => isOpen(page, tid('more-sheet')), (x) => x);
    const links = await page.locator(`${tid('more-sheet')} [data-testid^="more-"]`).count();
    check(open && links >= 4, `${L} More opens the sheet (${links} entries)`);
    await page.click(tid('more-npc'));
    const h = await until(async () => hash(page), (x) => x.startsWith('#/npc'));
    const closed = await until(() => isOpen(page, tid('more-sheet')), (x) => !x);
    const h1 = await h1Text(page);
    const cls = await until(() => page.locator(tid('nav-more')).getAttribute('class'), (c) => !!c && c.includes('has-current'));
    check(h.startsWith('#/npc') && !closed && h1.length > 0, `${L} More -> NPC navigates and closes the sheet (${h}, "${h1}")`);
    check(!!cls && cls.includes('has-current'), `${L} More button marks the current secondary page (class "${cls}")`);
    await page.click(tid('nav-more'));
    await until(() => isOpen(page, tid('more-sheet')), (x) => x);
    await page.click(tid('more-settings'));
    const drawer = await until(() => isOpen(page, tid('settings-drawer')), (x) => x);
    check(drawer && !(await isOpen(page, tid('more-sheet'))), `${L} More -> Settings opens the settings drawer`);
    await page.keyboard.press('Escape');
    await until(() => isOpen(page, tid('settings-drawer')), (x) => !x);
  });

  await routesSuite(env, true);

  await step(`${L} flip cards`, async () => {
    await go(page, '#/flip');
    if (exp) {
      const n = await countIs(page, tid('flip-count'), exp.flipDefault);
      check(n.includes(exp.flipDefault), `${L} flip count matches the domain (${exp.flipDefault}; UI ${n.join('/')})`);
    }
    const cards = page.locator(`${tid('flip-view')} li.kcard[data-key]`);
    const n = await until(() => cards.count(), (x) => x > 0);
    check(n > 0, `${L} flip list renders as cards (${n})`);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(scroll <= 1, `${L} no horizontal page scroll on #/flip (${scroll}px)`);
    const key = await cards.first().getAttribute('data-key');
    await cards.first().locator('.kcard-kv').click();
    const panel = page.locator(`.kit-panel .flip-dp[data-id="${key}"]`);
    await panel.waitFor({ state: 'visible', timeout: T });
    const mode = await page.locator('.kit-panel', { has: page.locator(`.flip-dp[data-id="${key}"]`) }).getAttribute('data-mode');
    check((await panel.isVisible()) && mode === 'overlay', `${L} card tap opens the detail panel as an overlay (mode ${mode})`);
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden', timeout: T }).catch(() => {});
    check(!(await panel.isVisible()), `${L} Escape closes the detail panel`);
  });

  await step(`${L} palette button`, async () => {
    await page.click(tid('palette-btn'));
    const input = page.locator('.kit-palette-input');
    await input.waitFor({ state: 'visible', timeout: T });
    await input.fill('enchanted gold');
    await until(async () => textOf(page.locator('.kp-opt .kp-hint')), (s) => s.length > 0);
    await page.keyboard.press('Enter');
    const h = await until(async () => hash(page), (x) => x.startsWith('#/item/'));
    check(h === `#/item/${exp?.paletteId ?? ITEM}`, `${L} palette button -> "enchanted gold" -> Enter opens the item (${h})`);
  });
  await closeEnv(env);
}

async function errorSuite(browser: Browser, exp: Expected): Promise<void> {
  const env = await openEnv(browser, 'error-path', DESKTOP, 'abort');
  const { page } = env;
  const L = '[error-path]';
  await page.goto(BASE + '#/flip');
  await step(`${L} API down`, async () => {
    const s = await until(() => statusOf(page), (x) => x === 'error', 25_000);
    check(s === 'error', `${L} aborted bazaar request -> status error (got ${s}, ${env.hits.bazaar} request(s))`);
    const panel = page.locator(`.manual-inline ${tid('manual-load')}`);
    const open = await until(() => panel.evaluate((el) => (el as HTMLDetailsElement).open).catch(() => false), (x) => x);
    check(open && (await panel.isVisible()), `${L} manual-load panel opens inline`);
  });
  await step(`${L} manual paste`, async () => {
    await page.locator(`.manual-inline ${tid('manual-load')} .paste`).evaluate((el, text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, BAZAAR_TEXT);
    const s = await until(() => statusOf(page), (x) => x === 'manual');
    check(s === 'manual', `${L} pasted fixture JSON loads (status ${s})`);
    const msg = await textOf(page.locator(`${tid('manual-load')} .msg.ok`));
    check(msg.length > 0, `${L} manual-load reports success ("${msg}")`);
    const n = await countIs(page, tid('flip-count'), exp.flipDefault);
    check(n.includes(exp.flipDefault), `${L} flip table fills from the pasted data (${exp.flipDefault}; UI ${n.join('/')})`);
  });
  await closeEnv(env);
}

async function liveSuite(browser: Browser): Promise<void> {
  const env = await openEnv(browser, 'live', DESKTOP);
  const { page } = env;
  const L = '[live]';
  await page.goto(BASE + '#/flip');
  await step(`${L} data`, async () => {
    const s = await waitLive(page, 30_000);
    check(s === 'live', `${L} status reaches live (got ${s})`);
    const n = await until(async () => ints(await textOf(page.locator(tid('flip-count'))))[0] ?? 0, (x) => x > 0);
    check(n > 0, `${L} flip count > 0 (${n})`);
  });
  await routesSuite(env, false);
  await step(`${L} language`, async () => {
    await go(page, '#/flip');
    const en = await h1Text(page);
    await page.click(tid('lang-tr'));
    const tr = await until(() => h1Text(page), (x) => x !== en);
    check(tr !== en, `${L} TR toggle changes the h1 ("${en}" -> "${tr}")`);
    await page.click(tid('lang-en'));
  });
  await closeEnv(env);
}

// ---------------------------------------------------------------- main

const exe = findBrowser();
if (!exe) {
  console.log('SKIP  smoke: no Chromium found (set CHROME_PATH, or install one with `npx playwright install chromium-headless-shell`).');
  process.exit(0);
}
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/ missing: run `npm run build` first');
  process.exit(1);
}

let server: ChildProcess | null = null;
const cleanup = () => server?.kill();
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const t0 = Date.now();
try {
  const exp = LIVE ? null : await computeExpected();
  if (exp) {
    console.log(
      `info  expected (fixture, default settings): flips ${exp.flipDefault}/${exp.flipRows.length}, q=${FLIP_Q} ${exp.flipQ}, ` +
        `crafts ${exp.craftAll} of ${exp.craftTotal}, forges ${exp.craftForge} of ${exp.forgeTotal}, chains ${exp.chainDefault} of ${exp.chainTotal}, AH flips ${exp.ahFlipDefault} of ${exp.ahFlipTotal}, Kat ${exp.katDefault} of ${exp.katTotal} (${exp.katSuspect} with suspect), bits ${exp.bitsDefault} of ${exp.bitsTotal}, npc bz2npc ${exp.npc.bz2npc} npc2bz ${exp.npc.npc2bz} shops ${exp.npc.shops}, ` +
        `plan ${exp.planPph.base} -> ${exp.planPph.big} at 1b (${exp.planPph.positions} positions)`,
    );
  }
  const port = await freePort();
  server = await startServer(port);
  BASE = `http://127.0.0.1:${port}/`;
  console.log(`info  ${LIVE ? 'LIVE' : 'fixture'} mode, browser ${exe}, server ${BASE}`);
  const browser = await chromium.launch({ executablePath: exe });
  try {
    if (LIVE) {
      await liveSuite(browser);
      await mobileSuite(browser, null);
    } else {
      await desktopSuite(browser, exp!);
      await mobileSuite(browser, exp);
      await errorSuite(browser, exp!);
    }
  } finally {
    await browser.close();
  }
} catch (e) {
  check(false, `smoke run aborted: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
} finally {
  cleanup();
}

console.log(`\n${passes} passed, ${failures.length} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (failures.length) {
  console.error(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('All smoke checks passed.');
