import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 600 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/domain/**'] },
  },
});
