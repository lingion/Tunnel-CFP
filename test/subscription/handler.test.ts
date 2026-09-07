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

  it('/sub/edgetunnel returns geo-treated base64 vless list (et1 kept, yk1 absent)', async () => {
    const res = await handleSubscription(new Request(`https://x.test/sub/edgetunnel?token=${await tokenFor('x.test')}`), env, ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(Buffer.from(text.trim(), 'base64').toString('utf8')).toContain('#et1');
    expect(Buffer.from(text.trim(), 'base64').toString('utf8')).not.toContain('yk1');
  });

  it('/sub/yonggekkk returns vendor B YAML', async () => {
    const res = await handleSubscription(new Request(`https://x.test/sub/yonggekkk?token=${await tokenFor('x.test')}`), env, ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('yk1');
    expect(text).not.toContain('et1');
  });

  it('/sub/all merges both vendors with cfp standard groups (vendor AUTO dropped, Auto emitted)', async () => {
    const res = await handleSubscription(new Request(`https://x.test/sub/all?token=${await tokenFor('x.test')}`), env, ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('et1');
    expect(text).toContain('yk1');
    // vendor 自带的 AUTO（url-test，引用 yk1）被丢弃
    expect(text).not.toMatch(/^\s*-?\s*name:\s*AUTO\s*$/m);
    // cfp 标准分组接管入口
    expect(text).toContain('PROXY');
    expect(text).toContain('Auto'); // cfp 标准 url-test group
    expect(text).toContain('Fallback');
    expect(text).toContain('手动选择');
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

describe('subscription request normalization', () => {
  it('uses hostname-only auth and HTTPS vendor requests when the incoming URL has a port', async () => {
    vi.resetModules();
    const seen: { edgetunnel?: URL; yonggekkk?: URL } = {};
    vi.doMock('../../vendor/edgetunnel/_worker.js', () => ({
      default: { fetch: vi.fn(async (req: Request) => {
        seen.edgetunnel = new URL(req.url);
        return new Response('proxies: []', { status: 200 });
      }) },
    }));
    vi.doMock('../../vendor/yonggekkk/_worker.js', () => ({
      default: { fetch: vi.fn(async (req: Request) => {
        seen.yonggekkk = new URL(req.url);
        return new Response('proxies: []', { status: 200 });
      }) },
    }));

    const { handleSubscription } = await import('../../src/subscription/handler');
    const env = { UUID: TEST_UUID } as unknown as Env;
    const ctx2 = { waitUntil: () => {} } as unknown as ExecutionContext;
    const token = await md5md5('x.test' + TEST_UUID);
    const res = await handleSubscription(
      new Request(`https://x.test:8787/sub/all?token=${token}`),
      env,
      ctx2,
    );

    expect(res.status).toBe(200);
    expect(seen.edgetunnel?.protocol).toBe('https:');
    expect(seen.edgetunnel?.searchParams.get('token')).toBe(token);
    expect(seen.yonggekkk?.protocol).toBe('https:');
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
    const env = { UUID: '12345678-1234-4123-8123-123456789abc' } as unknown as Env;
    const ctx2 = { waitUntil: () => {} } as unknown as ExecutionContext;
    const res = await handleSubscription(new Request(`https://x.test/sub/yonggekkk?token=${await md5md5('x.test' + env.UUID)}`), env, ctx2);
    expect(res.status).toBe(200);
    expect(seenEnvs.length).toBe(1);
    expect(seenEnvs[0].uuid).toBe('12345678-1234-4123-8123-123456789abc');
    expect(seenEnvs[0].UUID).toBe('12345678-1234-4123-8123-123456789abc');
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
    const env = { UUID: '12345678-1234-4123-8123-123456789abc' } as unknown as Env;
    const ctx2 = { waitUntil: () => {} } as unknown as ExecutionContext;
    await handleSubscription(new Request(`https://x.test/sub/yonggekkk?token=${await md5md5('x.test' + env.UUID)}`), env, ctx2);
    expect(seenPaths[0]).toBe('/12345678-1234-4123-8123-123456789abc/cl');
  });
});

// 回归：vendor 把 request.cf.country 写在节点名上当"国家"(CF移动优选-CN-XXXXX)，
// 但 CF edge IP 是 anycast 无国家级归属 → 误导。现 /sub/all 改为：
//   1. vendor 输出过滤掉带假国家标签的"CF移动优选/联通/电信/官方优选-CN-..."节点
//   2. 注入自研 64 个 CF-{REGION}-{N} 优选节点（区域按 CF PoP 数量加权）
const FAKE_CN_YAML_BASE64 = Buffer.from(
  [
    'vless://u1@s1:443?security=tls&type=ws#CF%E7%A7%BB%E5%8A%A8%E4%BC%98%E9%80%89-CN-1325251',
    'vless://u2@s2:443?security=tls&type=ws#CF_V1_www.visa.com_80',
  ].join('\n'),
  'utf8',
).toString('base64');

describe('/sub/all geo-honest nodes (fake-CN filtering + region-bucketed optimized nodes)', () => {
  const FAKE_CN_YAML = `
proxies:
  - name: "CF移动优选-CN-1325251"
    server: 104.19.151.76
    port: 2083
    type: vless
  - name: "CF_V1_www.visa.com_80"
    server: www.visa.com
    port: 80
    type: vless
  - name: "CF_V8_usa.visa.com_443"
    server: usa.visa.com
    port: 443
    type: vless
`;

  const setupVendors = () => {
    vi.resetModules();
    vi.doMock('../../vendor/edgetunnel/_worker.js', () => ({
      default: { fetch: vi.fn(async () => new Response(FAKE_CN_YAML, { status: 200 })) },
    }));
    vi.doMock('../../vendor/yonggekkk/_worker.js', () => ({
      default: { fetch: vi.fn(async () => new Response('proxies: []', { status: 200 })) },
    }));
    // 测试环境禁外网：geo fetch 失败 → 节点保留区域桶名（同时验证回退路径）
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('no network in tests'); }));
  };

it('filters fake-CN nodes and injects region-bucketed optimized nodes', async () => {
    setupVendors();
    const { handleSubscription } = await import('../../src/subscription/handler');
    const env = { UUID: TEST_UUID } as unknown as Env;
    const ctx2 = { waitUntil: () => {} } as unknown as ExecutionContext;
    const res = await handleSubscription(new Request(`https://x.test/sub/all?token=${await tokenFor('x.test')}`), env, ctx2);
    const text = await res.text();
    const parsed: any = (await import('js-yaml')).load(text);

    // 假国家节点全部消失（proxies 段）
    const names = parsed.proxies.map((p: any) => p.name);
    expect(names.some((n: string) => /CF(移动|联通|电信|官方)优选/.test(n))).toBe(false);

    // proxy-groups 引用行也不能残留（悬空引用会让 Clash 报错）
    expect(text).not.toMatch(/^\s*-\s*CF(移动|联通|电信|官方)优选/m);

    // 自研 region 节点出现
    const regionNodes = names.filter((n: string) => /^(APAC-HKG|NA-LAX|NA-SEA)-\d+$/.test(n));
    expect(regionNodes.length).toBeGreaterThan(0);
  });

  it('keeps domain-SNI nodes (visa series) intact', async () => {
    setupVendors();
    const { handleSubscription } = await import('../../src/subscription/handler');
    const env = { UUID: TEST_UUID } as unknown as Env;
    const ctx2 = { waitUntil: () => {} } as unknown as ExecutionContext;
    const res = await handleSubscription(new Request(`https://x.test/sub/all?token=${await tokenFor('x.test')}`), env, ctx2);
    const text = await res.text();
    const parsed: any = (await import('js-yaml')).load(text);
    const names = parsed.proxies.map((p: any) => p.name);
    const cfv = names.filter((n: string) => n.startsWith('CF_V'));
    expect(cfv.length).toBe(2);
  });
});

// 回归 2026-09-04：用户订阅的是 /sub/edgetunnel（V2RayNG），上一轮只治理了 /sub/all →
// 用户更新订阅"没变化"。现在 /sub/edgetunnel 也走 geo 命名节点池：
//   1. 输出仍为 base64 vless:// 列表（V2RayNG 形态）
//   2. 假 CN 节点剥除（vendor 原始输出含 CF移动优选-CN-*）
//   3. 节点名带 geoip 国家码（ip-api batch）——mock fetch 全返回 CA 验证命名生效
describe('/sub/edgetunnel geo treatment (V2RayNG base64 output)', () => {
  const setupGeoVendors = (fetchImpl: unknown) => {
    vi.resetModules();
    vi.doMock('../../vendor/edgetunnel/_worker.js', () => ({
      default: { fetch: vi.fn(async () => new Response(FAKE_CN_YAML_BASE64, { status: 200 })) },
    }));
    vi.doMock('../../vendor/yonggekkk/_worker.js', () => ({
      default: { fetch: vi.fn(async () => new Response('proxies: []', { status: 200 })) },
    }));
    vi.doMock('../../src/subscription/geo', async (orig) => {
      const mod = await orig<typeof import('../../src/subscription/geo')>();
      return { ...mod, defaultFetch: fetchImpl };
    });
  };

  it('returns base64 list of geo-named vless links without fake-CN nodes', async () => {
    setupGeoVendors(async () =>
      new Response(JSON.stringify([]), { status: 200 }));
    const { handleSubscription } = await import('../../src/subscription/handler');
    const env = { UUID: TEST_UUID } as unknown as Env;
    const ctx2 = { waitUntil: () => {} } as unknown as ExecutionContext;
    const res = await handleSubscription(new Request(`https://x.test/sub/edgetunnel?token=${await tokenFor('x.test')}`), env, ctx2);
    expect(res.status).toBe(200);
    const text = await res.text();
    const decoded = Buffer.from(text.trim(), 'base64').toString('utf8');
    const lines = decoded.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.startsWith('vless://'))).toBe(true);
    const names = lines.map((l) => decodeURIComponent(l.split('#')[1] ?? ''));
    // 假 CN 节点被剥掉
    expect(names.some((n) => /CF(移动|联通|电信|官方)优选/.test(n))).toBe(false);
    // 自研 geo 节点在（geo mock 空 → 回退区域桶名）
    expect(names.some((n) => /^(APAC-HKG|NA-LAX|NA-SEA)-\d+$/.test(n))).toBe(true);
  });
});

// geoip 集成：mock lookupCountriesCached 返回已知 country，
// 验证 /sub/all 输出含按 IP 真实 country 的地区分组（🇹🇼 台湾 / 🇭🇰 香港 / 🇯🇵 日本）
describe('/sub/all buckets vendor nodes by IP real country (geoip integration)', () => {
  const setupWithGeo = (geoByIp: Record<string, string | null>) => {
    vi.resetModules();
    // vendor 返回混合 IP 节点（覆盖 TW/HK/JP/US + 🌐其他）
    vi.doMock('../../vendor/edgetunnel/_worker.js', () => ({
      default: { fetch: vi.fn(async () => new Response(`
proxies:
  - name: "bah_node"
    server: 203.0.113.5
    port: 443
    type: vless
  - name: "gemini_node"
    server: 104.16.144.10
    port: 443
    type: vless
  - name: "play_jp"
    server: 1.0.0.1
    port: 443
    type: vless
  - name: "us_fallback"
    server: 8.8.8.8
    port: 53
    type: vless
  - name: "unknown_loc"
    server: 10.0.0.1
    port: 443
    type: vless
`, { status: 200 })) },
    }));
    vi.doMock('../../vendor/yonggekkk/_worker.js', () => ({
      default: { fetch: vi.fn(async () => new Response('proxies: []', { status: 200 })) },
    }));
    // mock lookupCountriesCached 直接返回固定字典（KV+ip-api 命中）
    vi.doMock('../../src/subscription/geoip', async (orig) => {
      const mod = await orig<typeof import('../../src/subscription/geoip')>();
      return {
        ...mod,
        lookupCountriesCached: async () => new Map(Object.entries(geoByIp)),
        lookupCountryCached: async (ip: string) => geoByIp[ip] ?? null,
      };
    });
  };

  it('emits 🇹🇼 台湾 / 🇭🇰 香港 / 🇯🇵 日本 / 🇺🇸 美国 groups from geoip lookup', async () => {
    setupWithGeo({
      '203.0.113.5': 'TW',
      '104.16.144.10': 'HK',
      '1.0.0.1': 'JP',
      '8.8.8.8': 'US',
      '10.0.0.1': null, // geoip 失败 → 🌐其他 兜底
    });
    const { handleSubscription } = await import('../../src/subscription/handler');
    const env = { UUID: TEST_UUID, KV: undefined } as unknown as Env;
    const ctx2 = { waitUntil: () => {} } as unknown as ExecutionContext;
    const res = await handleSubscription(new Request(`https://x.test/sub/all?token=${await tokenFor('x.test')}`), env, ctx2);
    const text = await res.text();
    const parsed: any = (await import('js-yaml')).load(text);
    const groupNames = parsed['proxy-groups'].map((g: any) => g.name);

    // 4 个 country 组都在
    expect(groupNames).toContain('🇹🇼 台湾');
    expect(groupNames).toContain('🇭🇰 香港');
    expect(groupNames).toContain('🇯🇵 日本');
    expect(groupNames).toContain('🇺🇸 美国');
    // 🌐其他 不发射（4 件套兜底含全部）
    expect(groupNames).not.toContain('🌐其他');

    // 各自只装对应 country 的节点
    const tw = parsed['proxy-groups'].find((g: any) => g.name === '🇹🇼 台湾');
    expect(tw.proxies).toContain('bah_node');
    expect(tw.type).toBe('url-test');
    const hk = parsed['proxy-groups'].find((g: any) => g.name === '🇭🇰 香港');
    expect(hk.proxies).toContain('gemini_node');
    const jp = parsed['proxy-groups'].find((g: any) => g.name === '🇯🇵 日本');
    expect(jp.proxies).toContain('play_jp');
    const us = parsed['proxy-groups'].find((g: any) => g.name === '🇺🇸 美国');
    expect(us.proxies).toContain('us_fallback');

    // 安全护栏：节点名跟 country 一致（如 `bah_node` 不漏进 🇯🇵 日本）
    for (const grp of [tw, hk, jp, us]) {
      expect(grp.proxies).not.toContain('unknown_loc');
    }
  });

  it('hostnames (non-IP server) are not geoip-queried; fall to 🌐其他 via bucketNodesByGeo; region groups still emitted as empty placeholders', async () => {
    setupWithGeo({}); // 空 geo = 全部 unknown
    vi.doMock('../../vendor/edgetunnel/_worker.js', () => ({
      default: { fetch: vi.fn(async () => new Response(`
proxies:
  - name: "host_node"
    server: example.com
    port: 443
    type: vless
`, { status: 200 })) },
    }));
    const { handleSubscription } = await import('../../src/subscription/handler');
    const env = { UUID: TEST_UUID, KV: undefined } as unknown as Env;
    const ctx2 = { waitUntil: () => {} } as unknown as ExecutionContext;
    const res = await handleSubscription(new Request(`https://x.test/sub/all?token=${await tokenFor('x.test')}`), env, ctx2);
    const text = await res.text();
    const parsed: any = (await import('js-yaml')).load(text);
    const groupNames = parsed['proxy-groups'].map((g: any) => g.name);
    // 用户用例："分组里面可以没有东西 但不能没有这个分组"
    // hostname → 🌐其他 fallback → 28 个地区分组依然占位发射
    expect(groupNames).toContain('🇹🇼 台湾');
    expect(groupNames).toContain('🇭🇰 香港');
    expect(groupNames).toContain('🇯🇵 日本');
    expect(groupNames).toContain('🇺🇸 美国');
    // 28 地区分组 + 4 件套（PROXY/Auto/Fallback/手动选择）+ 自研节点分组（如有）
    // 这里 hostname 不进地区桶，但 self-research 节点可能挂进来；故断言"至少 32"
    expect(groupNames.length).toBeGreaterThanOrEqual(32);
    // 4 件套 + 28 地区 必须齐全
    for (const required of ['PROXY', 'Auto', 'Fallback', '手动选择']) {
      expect(groupNames).toContain(required);
    }
    // host_node 仍进 4 件套
    const auto = parsed['proxy-groups'].find((g: any) => g.name === 'Auto');
    expect(auto.proxies).toContain('host_node');
    // 空 country 组用 select 类型（url-test 空 proxies 必崩）
    const tw = parsed['proxy-groups'].find((g: any) => g.name === '🇹🇼 台湾');
    expect(tw.type).toBe('select');
    expect(tw.proxies).toEqual([]);
  });

  it('geoip mock not invoked: cfp self-named nodes still get cidr-bucketed (cidr.ts fallback path)', async () => {
    // 自研节点（APAC-HKG-*）用 cidr.ts 命名挂入，不依赖 geoip
    // 这个测试保留 cidr.ts 路径的功能不变
    setupWithGeo({});
    const { handleSubscription } = await import('../../src/subscription/handler');
    const env = { UUID: TEST_UUID, KV: undefined } as unknown as Env;
    const ctx2 = { waitUntil: () => {} } as unknown as ExecutionContext;
    const res = await handleSubscription(new Request(`https://x.test/sub/all?token=${await tokenFor('x.test')}`), env, ctx2);
    const text = await res.text();
    const parsed: any = (await import('js-yaml')).load(text);
    const names = parsed.proxies.map((p: any) => p.name);
    // 自研节点（cidr.ts）依然存在
    expect(names.some((n: string) => /^(APAC-HKG|NA-LAX|NA-SEA)-\d+$/.test(n))).toBe(true);
  });
});
