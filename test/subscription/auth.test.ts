// test/subscription/auth.test.ts
// /sub/* token 鉴权：token=MD5MD5(host+UUID)，与 vendor edgetunnel 订阅 token 同源
// 修复的安全洞：/sub/yonggekkk /sub/all 此前无鉴权，知道域名即可拉走含 UUID 的节点
import { describe, it, expect, vi, beforeEach } from 'vitest';

const etYaml = `proxies:\n  - name: et1\n    server: s1\n    port: 443\n    type: vless\n`;
const ykYaml = `proxies:\n  - name: yk1\n    server: s2\n    port: 443\n    type: trojan\n`;

vi.mock('../../vendor/edgetunnel/_worker.js', () => ({
  default: { fetch: vi.fn(async () => new Response(etYaml, { status: 200 })) },
}));
vi.mock('../../vendor/yonggekkk/_worker.js', () => ({
  default: { fetch: vi.fn(async () => new Response(ykYaml, { status: 200 })) },
}));

import { handleSubscription } from '../../src/subscription/handler';
import { md5md5 } from '../../src/subscription/md5';

const env = { UUID: 'test-uuid-0000' } as Env;
const ctx = { waitUntil: (_p: Promise<unknown>) => {} } as unknown as ExecutionContext;

describe('/sub token auth', () => {
  let goodToken: string;
  beforeEach(async () => {
    goodToken = await md5md5('x.test' + 'test-uuid-0000');
  });

  it('rejects missing token with 401', async () => {
    for (const p of ['/sub/edgetunnel', '/sub/yonggekkk', '/sub/all']) {
      const res = await handleSubscription(new Request(`https://x.test${p}`), env, ctx);
      expect(res.status, p).toBe(401);
    }
  });

  it('rejects wrong token with 401', async () => {
    const res = await handleSubscription(new Request('https://x.test/sub/all?token=deadbeef'), env, ctx);
    expect(res.status).toBe(401);
  });

  it('token bound to host: another host token rejected', async () => {
    const otherToken = await md5md5('evil.test' + 'test-uuid-0000');
    const res = await handleSubscription(new Request(`https://x.test/sub/all?token=${otherToken}`), env, ctx);
    expect(res.status).toBe(401);
  });

  it('accepts correct token on all three endpoints', async () => {
    for (const p of ['/sub/edgetunnel', '/sub/yonggekkk', '/sub/all']) {
      const res = await handleSubscription(new Request(`https://x.test${p}?token=${goodToken}`), env, ctx);
      expect(res.status, p).toBe(200);
    }
  });
});
