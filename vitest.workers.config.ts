// vitest.workers.config.ts
// 真 workers runtime 测试:HTMLRewriter text chunk / append 等 nodejs 里没有的 API。
// 跑法: npx vitest run -c vitest.workers.config.ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/workers-runtime/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.cfp.toml' },
      },
    },
  },
});
