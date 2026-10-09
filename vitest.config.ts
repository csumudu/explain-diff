import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/unit/**/*.test.ts', 'test/harnesses/**/*.test.ts'], testTimeout: 20000 },
});
