// test/subscription/handler.test.ts
// 集成测试：mock 两个 vendor 的 fetch，验证 handleSubscription 输出
import { describe, it, expect, vi } from 'vitest';

const etYaml = `
proxies:
  - name: "et1"
    server: s1
    port: 443
    type: vless
proxy-groups:
  - name: "AUTO"
    type: url-test
    proxies:
      - et1
`;
const ykYaml = `
proxies:
  - name: "yk1"
    server: s2
    port: 443
    type: trojan
proxy-groups:
  - name: "AUTO"
    type: url-test
    proxies:
      - yk1
`;

vi.mock('../../vendor/edgetunnel/_worker.js', () => ({
  default: { fetch: vi.fn(async () => new Response(etYaml, { status: 200 })) },
}));
vi.mock('../../vendor/yonggekkk/_worker.js', () => ({
  default: { fetch: vi.fn(async () => new Response(ykYaml, { status: 200 })) },
}));

import { handleSubscription } from '../../src/subscription/handler';

describe('handleSubscription integration', () => {
  const env = {} as Env;

  it('/sub/edgetunnel returns vendor A YAML', async () => {
    const res = await handleSubscription(new Request('https://x.test/sub/edgetunnel'), env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('et1');
    expect(text).not.toContain('yk1');
    expect(res.headers.get('Content-Type')).toContain('text/yaml');
  });

  it('/sub/yonggekkk returns vendor B YAML', async () => {
    const res = await handleSubscription(new Request('https://x.test/sub/yonggekkk'), env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('yk1');
    expect(text).not.toContain('et1');
  });

  it('/sub/all merges both vendors with deduplicated AUTO proxies', async () => {
    const res = await handleSubscription(new Request('https://x.test/sub/all'), env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('et1');
    expect(text).toContain('yk1');
    expect(text).toContain('AUTO');
  });

  it('/sub/unknown returns 404', async () => {
    const res = await handleSubscription(new Request('https://x.test/sub/unknown'), env);
    expect(res.status).toBe(404);
  });

  it('vendor returning 500 propagates as 500', async () => {
    vi.resetModules();
    vi.doMock('../../vendor/edgetunnel/_worker.js', () => ({
      default: { fetch: vi.fn(async () => new Response('boom', { status: 500 })) },
    }));
    vi.doMock('../../vendor/yonggekkk/_worker.js', () => ({
      default: { fetch: vi.fn(async () => new Response(ykYaml, { status: 200 })) },
    }));
    const { handleSubscription: handleSub2 } = await import('../../src/subscription/handler');
    const res = await handleSub2(new Request('https://x.test/sub/edgetunnel'), env);
    expect(res.status).toBe(500);
  });
});