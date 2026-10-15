// Installable-app check: build with the GitHub Pages base first (`GITHUB_PAGES=1 npm run build`), then
// `npm run pwa:check`. Serves dist/ under /Skyblock-MoneyPrinter/, loads the app once (live Hypixel API, no request
// routing: Playwright bypasses service workers when routing is on), stops the server and reloads: the service worker
// must serve the whole app. Exit code 0 = all checks passed.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser, freePort, ROOT, sleep } from './lib/browser.ts';

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failed++;
};

const exe = findBrowser();
if (!exe) {
  console.log('SKIP  no Chromium found');
  process.exit(0);
}
const port = await freePort();
const server = spawn(join(ROOT, 'node_modules', '.bin', 'vite'), ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, GITHUB_PAGES: '1' },
});
const base = `http://127.0.0.1:${port}/Skyblock-MoneyPrinter/`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {
    /* not up yet */
  }
  await sleep(100);
}
const browser = await chromium.launch({ executablePath: exe });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '#/flip');
  await page.locator('[data-testid="flip-view"] tbody tr[data-key]').first().waitFor({ timeout: 45_000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await sleep(1500);

  const manifest = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
  check(manifest.name === 'Bazaar Desk' && manifest.start_url === './' && manifest.icons.length >= 3, `manifest served (${manifest.name}, ${manifest.icons.length} icons)`);
  const cached = await page.evaluate(async () => {
    const urls = (await Promise.all((await caches.keys()).map(async (k) => (await (await caches.open(k)).keys()).map((r) => r.url)))).flat();
    return { n: urls.length, catalog: urls.some((u) => u.endsWith('data/catalog.json')), hypixel: urls.some((u) => u.includes('hypixel')) };
  });
  check(cached.n >= 8 && cached.catalog, `precache holds the build and the catalog (${cached.n} files)`);
  check(!cached.hypixel, 'no Hypixel API response is cached');

  server.kill(); // the site is unreachable from here on: only the service worker can serve it
  await sleep(500);
  await page.reload();
  const rows = await page
    .locator('[data-testid="flip-view"] tbody tr[data-key]')
    .first()
    .waitFor({ timeout: 20_000 })
    .then(() => page.locator('[data-testid="flip-view"] tbody tr[data-key]').count())
    .catch(() => 0);
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  check(rows > 0 && controlled, `reload with the server down: the service worker serves the app (${rows} flip rows)`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? `\n${failed} failed` : '\nAll PWA checks passed.');
process.exit(failed ? 1 : 0);
