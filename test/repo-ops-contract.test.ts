// 仓库运维契约测试(2026-10-31 workflow ops-deploy 维度, critical 确认项)
// 锁死: package.json 不得存在"不带 -c 的 wrangler deploy"——
// 裸 wrangler deploy 读默认 wrangler.toml(name="proxy"),本机线上确有同名
// proxy Worker(proxy.qdp.qzz.io,真实 KV 314b6030…),占位符 KV id 会覆盖它
// 并清掉它的远程 vars,一次手滑 = 打挂另一个服务。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

describe('运维契约', () => {
  it('scripts 里不存在不带 -c 的 wrangler deploy', () => {
    const offenders = Object.entries(pkg.scripts || {}).filter(
      ([, cmd]) => /\bwrangler\s+deploy\b/.test(String(cmd)) && !/-c[\s=]/.test(String(cmd))
    );
    expect(offenders, `裸 wrangler deploy 会部署到错误的 Worker proxy: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it('deploy:cfp 脚本必须显式指向 cfp 配置', () => {
    expect(pkg.scripts['deploy:cfp']).toMatch(/wrangler deploy -c wrangler\.cfp\.toml/);
  });

  it('默认 wrangler.toml 的 name 是 proxy(模板线),绝不等于 cfp——防呆第二道', () => {
    const toml = readFileSync(join(__dirname, '../wrangler.toml'), 'utf8');
    expect(toml).toMatch(/^name\s*=\s*"proxy"/m);
  });
});
