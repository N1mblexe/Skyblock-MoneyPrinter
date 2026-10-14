import { defineConfig } from 'vitest/config';

export default defineConfig({
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
