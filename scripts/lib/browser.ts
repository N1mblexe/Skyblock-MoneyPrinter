// Shared harness for the browser scripts (scripts/smoke.ts, scripts/screenshots.ts, scripts/bench.ts): Chromium
// lookup, a `vite preview` server on a free port, the smoke fixtures that stand in for the Hypixel API, and the
// calc contexts src/state/derived.ts builds from them.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { emptySalesState, ingestPage, salesInfo, summarize, validateEnded } from '../../src/api/ahSales.ts';
import type { RawAhPage } from '../../src/api/auctions.ts';
import { createMarketCore } from '../../src/domain/market.ts';
import type { AhSalesSnapshot, AhSnapshot, CalcCtx, Catalog, Settings, Snapshot } from '../../src/types/contracts.ts';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- browser lookup

/** Chromium from CHROME_PATH, playwright-core's bundled path or Playwright's browser cache; null if none exists. */
export function findBrowser(): string | null {
  const cands: string[] = [];
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);
  try {
    cands.push(chromium.executablePath());
  } catch {
    /* no bundled path */
  }
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const dirs = (p: string) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const d of dirs(cache)) cands.push(join(cache, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
  for (const d of dirs(cache)) for (const sub of dirs(join(cache, d))) if (sub.startsWith('chrome-linux')) cands.push(join(cache, d, sub, 'chrome'));
  if (process.env.CHROME_PATH && !existsSync(process.env.CHROME_PATH)) console.warn(`CHROME_PATH=${process.env.CHROME_PATH} does not exist; looking elsewhere`);
  return cands.find((p) => p && existsSync(p)) ?? null;
}

// ---------------------------------------------------------------- server

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** `vite preview` of dist/ on 127.0.0.1:port; resolves once it answers. */
export async function startServer(port: number): Promise<ChildProcess> {
  const server = spawn(join(ROOT, 'node_modules', '.bin', 'vite'), ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) return server;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  server.kill();
  throw new Error('preview server did not start');
}

// ---------------------------------------------------------------- fixtures

export interface SmokeFixtures {
  /** raw /v2/skyblock/bazaar body */
  bazaar: string;
  /** one auctions page, as the only page */
  ahPage: RawAhPage;
  /** raw /v2/resources/skyblock/election body */
  election: string;
  /** raw /v2/skyblock/auctions_ended body (serve with endedNow: the poller skips a lastUpdated it has seen) */
  ahEnded: string;
}

export function loadSmokeFixtures(): SmokeFixtures {
  const fx = (p: string) => join(ROOT, p);
  return {
    bazaar: gunzipSync(readFileSync(fx('tests/fixtures/smoke/bazaar.json.gz'))).toString('utf8'),
    ahPage: { ...(JSON.parse(readFileSync(fx('tests/fixtures/ah-page.json'), 'utf8')) as RawAhPage), page: 0, totalPages: 1 },
    election: readFileSync(fx('tests/fixtures/election.json'), 'utf8'),
    ahEnded: readFileSync(fx('tests/fixtures/ah-ended.json'), 'utf8'),
  };
}

/** Bazaar body with lastUpdated = now (the poller only emits a snapshot when lastUpdated changes). */
export const withNow = (text: string) => text.replace(/"lastUpdated":\s*\d+/, `"lastUpdated":${Date.now()}`);

/**
 * auctions_ended body moved to `now`: lastUpdated = now and every sale as much later, as Hypixel would serve it. A
 * repeat poll then brings the same auction ids within the poller's dedupe window (so the store keeps one copy of
 * each sale), and the sales never age out of AH_SALES.windowMs however old the fixture gets.
 */
export function endedNow(text: string, now = Date.now()): string {
  const page = JSON.parse(text) as { lastUpdated: number; auctions: { timestamp: number }[] };
  const shift = now - page.lastUpdated;
  return JSON.stringify({ ...page, lastUpdated: now, auctions: page.auctions.map((a) => ({ ...a, timestamp: a.timestamp + shift })) });
}

/**
 * The AH sales summary the app holds after its first poll of the fixture `auctions_ended` body (served with
 * endedNow): one response, so the coverage is AH_SALES.windowSpanMs, below AH_SALES.minCoverageHours, and no
 * measured sales rate or median is used yet. `info` is what the Settings → Data sales box reads (the store's size).
 */
export function fixtureSales(ahEnded: string, now = Date.now()): { summary: AhSalesSnapshot | null; info: ReturnType<typeof salesInfo> } {
  const s = emptySalesState();
  ingestPage(s, validateEnded(JSON.parse(endedNow(ahEnded, now))));
  return { summary: summarize(s, now), info: salesInfo(s) };
}

export interface DerivedCtxInput {
  snap: Snapshot;
  catalog: Catalog;
  settings: Settings;
  ah: AhSnapshot | null;
  sales: AhSalesSnapshot | null;
  derpy: boolean;
}

/**
 * The contexts src/state/derived.ts hands the strategies, built the same way: one market core over the AH part
 * (the scan and the sales feed, both left out while settings.ahEnabled is off); `trade` is what flips, books, NPC
 * flips and fusion get (the core, no AH accessors), `full` is calcCtx() (crafts, chains, shops, Kat, bits, the
 * planner's capacities). No price history: a short run records fewer than RISK.spikeMinPoints /
 * CONSERVATIVE.minPoints points, which risk, conservatism and the planner's volume trend all treat like none.
 */
export function derivedCtx(i: DerivedCtxInput): { trade: CalcCtx; full: CalcCtx } {
  const plain: CalcCtx = { snap: i.snap, catalog: i.catalog, settings: i.settings, stats: () => null, market: () => null, derpy: i.derpy };
  const ah = i.settings.ahEnabled ? i.ah : null;
  const sales = i.settings.ahEnabled ? i.sales : null;
  const acc: Pick<CalcCtx, 'ah' | 'ahSales'> = {
    ah: ah ? (id) => ah.lowestBin[id] ?? null : undefined,
    ahSales: sales ? (id) => sales.byId[id] ?? null : undefined,
  };
  const trade: CalcCtx = { ...plain, core: createMarketCore({ ...plain, ...acc }) };
  return { trade, full: { ...trade, ...acc } };
}
