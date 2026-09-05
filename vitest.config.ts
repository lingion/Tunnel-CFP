// vitest.config.ts
// 默认 nodejs pool:纯逻辑测试(security / url-resolver / subscription)。
// 真 HTMLRewriter 管线测试在 vitest.workers.config.ts(workers pool)。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/workers-runtime/**', 'node_modules/**'],
    pool: 'forks',
  },
});
