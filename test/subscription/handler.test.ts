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
import { md5md5 } from '../../src/subscription/md5';

const TEST_UUID = 'test-uuid-1234';
async function tokenFor(host: string): Promise<string> {
  return md5md5(host + TEST_UUID);
}

describe('handleSubscription integration', () => {
  const env = { UUID: TEST_UUID } as Env;
  const ctx = { waitUntil: (_p: Promise<unknown>) => {} } as unknown as ExecutionContext;

  it('/sub/edgetunnel returns vendor A YAML', async () => {
    const res = await handleSubscription(new Request(`https://x.test/sub/edgetunnel?token=${await tokenFor('x.test')}`), env, ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('et1');
    expect(text).not.toContain('yk1');
    expect(res.headers.get('Content-Type')).toContain('text/yaml');
  });

  it('/sub/yonggekkk returns vendor B YAML', async () => {
    const res = await handleSubscription(new Request(`https://x.test/sub/yonggekkk?token=${await tokenFor('x.test')}`), env, ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('yk1');
    expect(text).not.toContain('et1');
  });

  it('/sub/all merges both vendors with deduplicated AUTO proxies', async () => {
    const res = await handleSubscription(new Request(`https://x.test/sub/all?token=${await tokenFor('x.test')}`), env, ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('et1');
    expect(text).toContain('yk1');
    expect(text).toContain('AUTO');
  });

  it('/sub/unknown returns 404', async () => {
    const res = await handleSubscription(new Request(`https://x.test/sub/unknown?token=${await tokenFor('x.test')}`), env, ctx);
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
    const res = await handleSub2(new Request(`https://x.test/sub/edgetunnel?token=${await tokenFor('x.test')}`), env, { waitUntil: () => {} } as unknown as ExecutionContext);
    expect(res.status).toBe(500);
  });
});
// 回归：yonggekkk vendor 读小写 env.uuid；不传小写视图则回退硬编码 UUID，/${userID}/cl 分支永不命中
describe('vendor env casing (yonggekkk lowercase uuid)', () => {
  it('passes lowercase uuid view to yonggekkk vendor', async () => {
    vi.resetModules();
    const seenEnvs: any[] = [];
    vi.doMock('../../vendor/edgetunnel/_worker.js', () => ({
      default: { fetch: vi.fn(async () => new Response('proxies: []', { status: 200 })) },
    }));
    vi.doMock('../../vendor/yonggekkk/_worker.js', () => ({
      default: {
        fetch: vi.fn(async (_req: Request, env: any) => {
          seenEnvs.push(env);
          return new Response('proxies:\n- name: yknode', { status: 200 });
        }),
      },
    }));
    const { handleSubscription } = await import('../../src/subscription/handler');
    const env = { UUID: 'b88ab8fa-392c-44b3-9343-612c11814708' } as unknown as Env;
    const ctx2 = { waitUntil: () => {} } as unknown as ExecutionContext;
    const res = await handleSubscription(new Request(`https://x.test/sub/yonggekkk?token=${await md5md5('x.test' + env.UUID)}`), env, ctx2);
    expect(res.status).toBe(200);
    expect(seenEnvs.length).toBe(1);
    expect(seenEnvs[0].uuid).toBe('b88ab8fa-392c-44b3-9343-612c11814708');
    expect(seenEnvs[0].UUID).toBe('b88ab8fa-392c-44b3-9343-612c11814708');
  });

  it('requests the vendor path with the real UUID (not vendor hardcoded)', async () => {
    vi.resetModules();
    const seenPaths: string[] = [];
    vi.doMock('../../vendor/edgetunnel/_worker.js', () => ({
      default: { fetch: vi.fn(async () => new Response('proxies: []', { status: 200 })) },
    }));
    vi.doMock('../../vendor/yonggekkk/_worker.js', () => ({
      default: {
        fetch: vi.fn(async (req: Request) => {
          seenPaths.push(new URL(req.url).pathname);
          return new Response('proxies:\n- name: yknode', { status: 200 });
        }),
      },
    }));
    const { handleSubscription } = await import('../../src/subscription/handler');
    const env = { UUID: 'b88ab8fa-392c-44b3-9343-612c11814708' } as unknown as Env;
    const ctx2 = { waitUntil: () => {} } as unknown as ExecutionContext;
    await handleSubscription(new Request(`https://x.test/sub/yonggekkk?token=${await md5md5('x.test' + env.UUID)}`), env, ctx2);
    expect(seenPaths[0]).toBe('/b88ab8fa-392c-44b3-9343-612c11814708/cl');
  });
});
