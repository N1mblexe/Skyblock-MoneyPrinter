// Shared harness for the browser scripts (scripts/smoke.ts, scripts/screenshots.ts): Chromium lookup,
// a `vite preview` server on a free port, and the smoke fixtures that stand in for the Hypixel API.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import type { RawAhPage } from '../../src/api/auctions.ts';

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
  /** raw /v2/skyblock/auctions_ended body (serve with withNow: the poller skips a lastUpdated it has seen) */
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
