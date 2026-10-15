// README screenshots. Usage: `npm run build && npm run screenshots`.
//
// Serves dist/ with `vite preview` and answers the Hypixel API with the smoke fixtures (tests/fixtures/smoke, ah-page,
// election), so the shots are reproducible. Google Fonts load for real. The app runs in English with a small seeded
// watchlist; every page is visited in the dark and the light theme and the shots listed in USED are written to docs/images/<name>-<theme>.png.
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page, type Route } from 'playwright-core';
import { LS_SETTINGS, LS_WATCH } from '../src/config.ts';
import { findBrowser, freePort, loadSmokeFixtures, ROOT, sleep, startServer, withNow } from './lib/browser.ts';

const OUT = join(ROOT, 'docs', 'images');
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const WATCH = ['ENCHANTED_GOLD', 'BOOSTER_COOKIE', 'HOT_POTATO_BOOK', 'RECOMBOBULATOR_3000', 'ENCHANTED_DIAMOND'];
const T = 20_000;
type Theme = 'dark' | 'light';
/** The images README.md uses; every page is still visited, only these are written. */
const USED = new Set([
  'overview-dark', 'overview-light', 'flip-detail-dark', 'planner-dark', 'craft-dark', 'item-dark', 'watchlist-dark',
  'palette-light', 'mobile-overview-dark', 'mobile-flips-dark',
]);

const FIX = loadSmokeFixtures();

async function stub(route: Route): Promise<void> {
  const u = new URL(route.request().url());
  if (u.hostname === '127.0.0.1' || u.hostname.endsWith('googleapis.com') || u.hostname.endsWith('gstatic.com')) return route.continue();
  const json = (body: string, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
  if (u.hostname === 'api.hypixel.net') {
    if (u.pathname === '/v2/skyblock/bazaar') return json(withNow(FIX.bazaar));
    if (u.pathname === '/v2/skyblock/auctions') {
      return Number(u.searchParams.get('page') ?? 0) === 0 ? json(JSON.stringify(FIX.ahPage)) : json('{"success":false}', 404);
    }
    if (u.pathname === '/v2/resources/skyblock/election') return json(FIX.election);
  }
  return route.abort('failed');
}

async function openPage(browser: Browser, base: string, theme: Theme, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-US', serviceWorkers: 'block', colorScheme: theme });
  await context.route('**/*', stub);
  const now = Date.now();
  await context.addInitScript(
    ([lsSettings, lsWatch, theme, watch]) => {
      // only on the first load, so the app's own writes survive navigation
      if (localStorage.getItem(lsSettings)) return;
      localStorage.setItem(lsSettings, JSON.stringify({ lang: 'en', theme }));
      localStorage.setItem(lsWatch, JSON.stringify(watch));
    },
    [LS_SETTINGS, LS_WATCH, theme, WATCH.map((id, i) => ({ id, addedAt: now - i * 60_000 }))] as const,
  );
  const page = await context.newPage();
  page.setDefaultTimeout(T);
  await page.goto(base + '#/overview');
  await page.waitForFunction(() => document.querySelector('[data-testid="status-pill"]')?.getAttribute('data-status') === 'live', null, { timeout: T });
  return page;
}

/** Hash navigation, then wait for the view's h1, table rows to settle and fonts to load. */
async function go(page: Page, hash: string, ready = '#view h1'): Promise<void> {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.locator(ready).first().waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(600);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!USED.has(name)) return;
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`wrote ${file.slice(ROOT.length)}`);
}

async function desktop(browser: Browser, base: string, theme: Theme): Promise<void> {
  const page = await openPage(browser, base, theme, DESKTOP);
  await go(page, '#/overview');
  await shot(page, `overview-${theme}`);

  await go(page, '#/flip', '[data-testid="flip-view"] tbody tr[data-key]');
  await shot(page, `flips-${theme}`);
  await page.locator('[data-testid="flip-view"] tbody tr[data-key]').first().locator('td.num').last().click();
  await page.locator('.kit-panel .flip-dp').waitFor({ state: 'visible' });
  // the click scrolls the table sideways; bring the item column back into view
  await page.evaluate(() => document.querySelectorAll('#view *').forEach((el) => el.scrollLeft && (el.scrollLeft = 0)));
  await sleep(400);
  await shot(page, `flip-detail-${theme}`);
  await page.keyboard.press('Escape');

  await go(page, '#/craft', '.craft-table tbody tr[data-key]');
  await shot(page, `craft-${theme}`);
  await go(page, '#/books');
  await shot(page, `books-${theme}`);
  await go(page, '#/plan');
  await shot(page, `planner-${theme}`);
  await go(page, '#/watch');
  await shot(page, `watchlist-${theme}`);
  await go(page, '#/item/ENCHANTED_GOLD', '[data-testid="order-book"] tbody tr');
  await shot(page, `item-${theme}`);

  await go(page, '#/overview');
  await page.keyboard.press('/');
  const input = page.locator('.kit-palette-input');
  await input.waitFor({ state: 'visible' });
  await input.pressSequentially('enchanted', { delay: 20 });
  await page.locator('.kp-opt').first().waitFor({ state: 'visible' });
  await sleep(300);
  await shot(page, `palette-${theme}`);
  await page.context().close();
}

async function mobile(browser: Browser, base: string, theme: Theme): Promise<void> {
  const page = await openPage(browser, base, theme, MOBILE);
  await go(page, '#/overview');
  await shot(page, `mobile-overview-${theme}`);
  await go(page, '#/flip');
  await shot(page, `mobile-flips-${theme}`);
  await page.context().close();
}

const exe = findBrowser();
if (!exe) {
  console.error('No Chromium found: set CHROME_PATH or install a Playwright browser.');
  process.exit(1);
}
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/ is missing: run `npm run build` first.');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

let server: ChildProcess | null = null;
process.on('exit', () => server?.kill());
process.on('SIGINT', () => process.exit(130));

const port = await freePort();
server = await startServer(port);
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch({ executablePath: exe });
try {
  for (const theme of ['dark', 'light'] as const) {
    await desktop(browser, base, theme);
    await mobile(browser, base, theme);
  }
} finally {
  await browser.close();
  server.kill();
}
