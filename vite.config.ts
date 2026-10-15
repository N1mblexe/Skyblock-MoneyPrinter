import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Files under public/ (served as-is), relative and with '/' separators. */
function publicFiles(dir = 'public'): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? publicFiles(p) : [relative('public', p).replace(/\\/g, '/')];
  });
}

/**
 * Installable app: builds src/pwa/sw.ts as dist/sw.js and fills in its precache list (every built file, the page and
 * the public files) and a build version that changes whenever any of those files change.
 */
function pwaPlugin(): Plugin {
  return {
    name: 'bazaar-desk-pwa',
    apply: 'build',
    buildStart() {
      this.emitFile({ type: 'chunk', id: 'src/pwa/sw.ts', fileName: 'sw.js' });
    },
    generateBundle(_opts, bundle) {
      const sw = bundle['sw.js'];
      if (!sw || sw.type !== 'chunk') return this.error('sw.js was not built');
      const built = Object.keys(bundle).filter((f) => f !== 'sw.js' && !f.endsWith('.map') && f !== 'index.html');
      const files = ['./', ...built, ...publicFiles()].sort();
      const hash = createHash('sha256');
      for (const f of built) {
        const out = bundle[f]!;
        hash.update(f).update(out.type === 'chunk' ? out.code : typeof out.source === 'string' ? out.source : Buffer.from(out.source));
      }
      for (const f of publicFiles()) hash.update(f).update(readFileSync(join('public', f)));
      // the minifier may re-quote the placeholder string ('…', "…" or `…`): replace the whole literal
      const literal = /(['"`])__PRECACHE_LIST__\1/;
      if (!literal.test(sw.code)) return this.error('sw.js: precache placeholder not found');
      sw.code = sw.code.replace(literal, JSON.stringify(JSON.stringify(files))).replace('__BUILD_VERSION__', hash.digest('hex').slice(0, 12));
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the app from /<repo>/ (see .github/workflows/pages.yml)
  base: process.env.GITHUB_PAGES ? '/Skyblock-MoneyPrinter/' : '/',
  plugins: [pwaPlugin()],
  server: { port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 600 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/storage/**', 'src/state/**', 'src/api/**', 'src/ui/kit/**'],
      thresholds: {
        'src/domain/**': { lines: 95, branches: 90 },
        'src/{storage,state,api,ui/kit}/**': { lines: 85 },
      },
    },
  },
});
