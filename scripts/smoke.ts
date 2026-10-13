// npm run smoke : build must exist (npm run build). Starts `vite preview`, drives the app in headless Chromium.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium, type Page } from 'playwright-core';

const PORT = 4173;
const BASE = `http://localhost:${PORT}/`;
const EXE = process.env.CHROME_PATH ?? `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`;

const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures.push(msg);
};

if (!existsSync('dist/index.html')) throw new Error('dist/ missing — run `npm run build` first');
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const cleanup = () => server.kill();
process.on('exit', cleanup);

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('preview server did not start');
}

const status = (page: Page) => page.getAttribute('[data-testid="status-pill"]', 'data-status');
const rows = (page: Page) => page.locator('main tbody tr[data-key], #app tbody tr[data-key]').count();

async function waitStatus(page: Page, want: string[], ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await status(page);
    if (s && want.includes(s)) return s;
    await page.waitForTimeout(250);
  }
  return status(page);
}

try {
  await waitForServer();
  const browser = await chromium.launch({ executablePath: EXE });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  // 1. live data
  await page.goto(BASE + '#/flip');
  const s1 = await waitStatus(page, ['live'], 20_000);
  check(s1 === 'live', `status reaches live (got ${s1})`);
  await page.waitForTimeout(1500);
  const flipRows = await rows(page);
  check(flipRows >= 20, `flip table has ≥20 rows (got ${flipRows})`);

  // 2. craft tab with filters at zero
  await page.click('[data-testid="tab-craft"]');
  await page.waitForTimeout(800);
  for (const input of await page.locator('#app input[type="number"][data-filter]').all()) await input.fill('0');
  await page.waitForTimeout(800);
  const craftRows = await rows(page);
  // ~400 priced recipes; with filters at 0 the view still hides unprofitable and suspect rows (~250 remain)
  check(craftRows >= 200, `craft table has ≥200 rows with filters at 0 (got ${craftRows})`);

  // 3. item detail from first flip row
  await page.click('[data-testid="tab-flip"]');
  await page.waitForTimeout(800);
  await page.locator('#app tbody tr[data-key]').first().click();
  await page.waitForTimeout(1200);
  check(page.url().includes('#/item/'), `row click opens item view (${page.url()})`);
  const bookLevels = await page.locator('[data-testid="order-book"] tbody tr').count();
  check(bookLevels >= 1, `item view shows order book levels (${bookLevels})`);
  check((await page.locator('[data-testid="price-chart"] svg, svg[data-testid="price-chart"]').count()) >= 1, 'item view shows a chart svg');

  // 4. language toggle
  await page.click('[data-testid="tab-flip"]');
  const trLabel = await page.textContent('[data-testid="tab-flip"]');
  await page.click('[data-testid="lang-en"]');
  await page.waitForTimeout(300);
  const enLabel = await page.textContent('[data-testid="tab-flip"]');
  check(!!trLabel && !!enLabel && trLabel !== enLabel, `EN toggle changes tab label ("${trLabel}" → "${enLabel}")`);

  // 5. reload: settings persist, cached snapshot shown first
  await page.reload();
  const enAfter = await page.textContent('[data-testid="tab-flip"]');
  check(enAfter === enLabel, `language persists across reload ("${enAfter}")`);
  const s2 = await waitStatus(page, ['live'], 20_000);
  check(s2 === 'live', `after reload status back to live (got ${s2})`);
  await page.click('[data-testid="lang-tr"]');

  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`);

  // 6. API blocked -> error, old data kept (network errors expected in console from here on)
  await page.route('**/api.hypixel.net/**', (r) => r.abort());
  await page.click('[data-testid="refresh-btn"]');
  const s3 = await waitStatus(page, ['error'], 20_000);
  check(s3 === 'error', `blocked API → status error (got ${s3})`);
  const keptRows = await rows(page);
  check(keptRows >= 1, `old data still shown after error (${keptRows} rows)`);
  await browser.close();
} catch (e) {
  failures.push(String(e));
  console.error(e);
} finally {
  cleanup();
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
