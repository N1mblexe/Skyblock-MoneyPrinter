// App icons for the PWA manifest: renders public/icons/icon.svg to PNG with Chromium (playwright-core).
// Usage: `npm run icons` (writes public/icons/icon-{180,192,512}.png and icon-maskable-512.png; commit them).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser, ROOT } from './lib/browser.ts';

const DIR = join(ROOT, 'public', 'icons');
const svg = readFileSync(join(DIR, 'icon.svg'), 'utf8');
const exe = findBrowser();
if (!exe) {
  console.error('No Chromium found: set CHROME_PATH or install a Playwright browser.');
  process.exit(1);
}
const browser = await chromium.launch({ executablePath: exe });
try {
  const page = await browser.newPage();
  // plain icons: the rounded tile on a transparent background; maskable: full-bleed background, tile in the safe zone
  const shots: [string, number, boolean][] = [
    ['icon-180.png', 180, false],
    ['icon-192.png', 192, false],
    ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true],
  ];
  for (const [file, size, maskable] of shots) {
    await page.setViewportSize({ width: size, height: size });
    const inner = maskable ? Math.round(size * 0.72) : size;
    await page.setContent(
      `<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700&display=block"></head>` +
        `<body style="margin:0;display:grid;place-items:center;width:${size}px;height:${size}px;background:${maskable ? '#0f1715' : 'transparent'}">` +
        `<div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`,
      { waitUntil: 'networkidle' },
    );
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(DIR, file), omitBackground: !maskable });
    console.log(`wrote public/icons/${file}`);
  }
} finally {
  await browser.close();
}
