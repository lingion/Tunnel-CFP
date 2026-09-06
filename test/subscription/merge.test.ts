// test/subscription/merge.test.ts
import { describe, it, expect } from 'vitest';
import { mergeYaml } from '../../src/subscription/merge';

describe('merge subscription YAML', () => {
  it('combines two YAMLs preserving proxies; vendor proxy-groups/rules dropped (cfp 标准接管)', () => {
    const yamlA = `
proxies:
  - name: "a1"
    server: s1
    port: 443
    type: vless
  - name: "a2"
    server: s3
    port: 443
    type: vless
proxy-groups:
  - name: "G1"
    type: select
    proxies:
      - a1
      - a2
rules:
  - "MATCH,G1"
`;
    const yamlB = `
proxies:
  - name: "b1"
    server: s2
    port: 443
    type: vless
proxy-groups:
  - name: "G1"
    type: select
    proxies:
      - b1
  - name: "G2"
    type: url-test
    proxies:
      - b1
rules:
  - "DOMAIN,example.com,G2"
`;
    const merged = mergeYaml([yamlA, yamlB]);

    // All 3 proxies present
    expect(merged).toContain('a1');
    expect(merged).toContain('a2');
    expect(merged).toContain('b1');

    // vendor 自带的 G1/G2 必须全部消失
    expect(merged).not.toMatch(/^\s*-?\s*name:\s*G1\s*$/m);
    expect(merged).not.toMatch(/^\s*-?\s*name:\s*G2\s*$/m);

    // vendor 自带 rules 也丢（cfpRules 接管）
    expect(merged).not.toContain('MATCH,G1');
    expect(merged).not.toContain('DOMAIN,example.com,G2');
  });

  it('handles empty input', () => {
    const merged = mergeYaml([]);
    expect(merged).toContain('proxies');
    expect(merged).toContain('proxy-groups');
  });

  it('handles YAML with missing sections', () => {
    const yaml = `
proxies:
  - name: "only"
    server: s1
    port: 443
    type: vless
`;
    const merged = mergeYaml([yaml]);
    expect(merged).toContain('only');
  });

  it('deduplicates proxies when same name appears twice', () => {
    const yamlA = `
proxies:
  - name: "dup"
    server: s1
    port: 443
    type: vless
`;
    const yamlB = `
proxies:
  - name: "dup"
    server: s2
    port: 443
    type: vless
`;
    const merged = mergeYaml([yamlA, yamlB]);
    // Both dup entries present (no name dedup at proxy level — last write wins is acceptable)
    expect(merged).toContain('dup');
  });
});
// 回归：/sub/all 曾输出 39B 空壳 —— 两家输入实际是 base64 vless:// 列表与 Clash YAML，
// mergeYaml 只认 yaml.load 出的 proxies 键，对 base64 输入永远产出空 proxies
describe('subscription normalization (vless URI list -> Clash config)', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  const vlessList = [
    'vless://12345678-1234-4123-8123-123456789abc@104.17.125.64:2087?security=tls&type=ws&host=cfp.example.test&fp=chrome&sni=cfp.example.test&path=%2F&encryption=none#CF%E8%8A%82%E7%82%B9A',
    'vless://12345678-1234-4123-8123-123456789abc@www.visa.com.sg:80?type=ws&host=cfp.example.test&path=%2F%3Fed%3D2560&encryption=none#CF%E8%8A%82%E7%82%B9B',
  ].join('\n');

  it('normalizes base64 vless list into proxies', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([b64(vlessList), '']);
    const parsed: any = (await import('js-yaml')).load(out);
    // vless 2 = 2（已删 trojan 孪生，2026-09）
    expect(parsed.proxies.length).toBe(2);
    const p1 = parsed.proxies[0];
    expect(p1.name).toBe('CF节点A');
    expect(p1.type).toBe('vless');
    expect(p1.server).toBe('104.17.125.64');
    expect(p1.port).toBe(2087);
    expect(p1.uuid).toBe('12345678-1234-4123-8123-123456789abc');
    expect(p1.tls).toBe(true);
    expect(p1.network).toBe('ws');
    expect(p1['ws-opts'].headers.Host).toBe('cfp.example.test');
    const p2 = parsed.proxies.find((p: any) => p.name === 'CF节点B');
    expect(p2.tls).toBe(false);
    expect(p2.port).toBe(80);
    expect(p2['ws-opts'].path).toBe('/?ed=2560');
  });

  it('merges vless list plus Clash YAML together', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const clashYaml = `proxies:\n  - name: et1\n    server: s1\n    port: 443\n    type: vless\n`;
    const out = mergeSubscriptionPayloads([b64(vlessList), clashYaml]);
    const parsed: any = (await import('js-yaml')).load(out);
    const names = parsed.proxies.map((p: any) => p.name);
    expect(names).toContain('CF节点A');
    expect(names).toContain('et1');
  });

  it('still merges plain Clash YAMLs (legacy behavior intact)', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const a = 'proxies:\n  - name: a1\n    server: s1\n    port: 443\n    type: vless\n';
    const b = 'proxies:\n  - name: b1\n    server: s2\n    port: 443\n    type: vless\n';
    const out = mergeSubscriptionPayloads([a, b]);
    const parsed: any = (await import('js-yaml')).load(out);
    expect(parsed.proxies.map((p: any) => p.name).sort()).toEqual(['a1', 'b1']);
  });

  it('produces a usable default selector group over merged proxies', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([b64(vlessList)]);
    const parsed: any = (await import('js-yaml')).load(out);
    expect(parsed['proxy-groups'].length).toBeGreaterThan(0);
    const selector = parsed['proxy-groups'].find((g: any) => g.type === 'select');
    // PROXY 含 4 件套 + 全部节点名（vless 2 = 2 节点）
    // 期望 6 = [Auto, Fallback, DIRECT, 手动选择] 4 件套 + 2 nodes
    expect(selector.proxies.length).toBe(6);
    expect(parsed.rules.length).toBeGreaterThan(0);
  });
});

// cfp 标准分组（A1 = Clash-Butler 风格 PROXY/Auto/Fallback/手动选择）
// vendor 自带的 proxy-groups 全部丢弃，cfp 统一接管分组命名
// 不按节点名称分地区组 —— 名称骗不了用户；geoip/IP 探测另行接入（待方案落地）
describe('cfp standard proxy-groups (A1)', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  it('replaces vendor proxy-groups with PROXY/Auto/Fallback/Manual chain', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    // yonggekkk vendor 自带 3 组中文组
    const vendorYaml = `
proxies:
  - name: HK_yonggekkk_1
    server: 1.2.3.4
    port: 443
    type: vless
proxy-groups:
  - name: 负载均衡
    type: load-balance
    url: http://www.gstatic.com/generate_204
    interval: 300
    proxies: [HK_yonggekkk_1]
  - name: 自动选择
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    proxies: [HK_yonggekkk_1]
  - name: 🌍选择代理
    type: select
    proxies: [负载均衡, 自动选择, DIRECT, HK_yonggekkk_1]
`;
    const out = mergeSubscriptionPayloads([vendorYaml]);
    const parsed: any = (await import('js-yaml')).load(out);

    // vendor 中文组必须全部消失
    const names = parsed['proxy-groups'].map((g: any) => g.name);
    expect(names).not.toContain('负载均衡');
    expect(names).not.toContain('自动选择');
    expect(names).not.toContain('🌍选择代理');

    // cfp 标准 4 件套 + 入口 PROXY 必须在
    expect(names).toContain('PROXY');
    expect(names).toContain('Auto');
    expect(names).toContain('Fallback');
    expect(names).toContain('手动选择');
  });

  it('PROXY is select type and contains Auto/Fallback/DIRECT/Manual', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([b64('vless://x@1.2.3.4:443?encryption=none#nodeA')]);
    const parsed: any = (await import('js-yaml')).load(out);
    const proxy = parsed['proxy-groups'].find((g: any) => g.name === 'PROXY');
    expect(proxy.type).toBe('select');
    expect(proxy.proxies).toContain('Auto');
    expect(proxy.proxies).toContain('Fallback');
    expect(proxy.proxies).toContain('DIRECT');
    expect(proxy.proxies).toContain('手动选择');
  });

  it('Auto is url-test, Fallback is fallback, Manual is select', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([b64('vless://x@1.2.3.4:443?encryption=none#nodeA')]);
    const parsed: any = (await import('js-yaml')).load(out);
    const auto = parsed['proxy-groups'].find((g: any) => g.name === 'Auto');
    expect(auto.type).toBe('url-test');
    expect(auto.url).toBe('http://www.gstatic.com/generate_204');
    const fb = parsed['proxy-groups'].find((g: any) => g.name === 'Fallback');
    expect(fb.type).toBe('fallback');
    const manual = parsed['proxy-groups'].find((g: any) => g.name === '手动选择');
    expect(manual.type).toBe('select');
  });

  it('all nodes hang on Auto/Fallback/Manual (no name-based region bucketing)', async () => {
    // cfp 不按节点名前缀分地区组（CF-HKG-/🇭🇰 等命名都不可信）。
    // 地区分组等探测方案落地再接。当前所有节点统一挂 Auto/Fallback/手动选择 三组。
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const vlessList = [
      'vless://u@hkg1.example:443?encryption=none#CF-HKG-1',
      'vless://u@us1.example:443?encryption=none#CF-LAX-1',
      'vless://u@a:443?encryption=none#random_node',
    ].join('\n');
    const out = mergeSubscriptionPayloads([b64(vlessList)]);
    const parsed: any = (await import('js-yaml')).load(out);

    const names = parsed['proxy-groups'].map((g: any) => g.name);
    // 旧"按节点名称分桶"的 HK/US/JP/SG/TW/🌐其他 一律不再发射
    expect(names).not.toContain('HK');
    expect(names).not.toContain('US');
    expect(names).not.toContain('JP');
    expect(names).not.toContain('SG');
    expect(names).not.toContain('TW');
    expect(names).not.toContain('🌐其他');

    // 4 件套各自的 proxies 包含所有节点
    const auto = parsed['proxy-groups'].find((g: any) => g.name === 'Auto');
    expect(auto.proxies).toContain('CF-HKG-1');
    expect(auto.proxies).toContain('CF-LAX-1');
    expect(auto.proxies).toContain('random_node');

    const fb = parsed['proxy-groups'].find((g: any) => g.name === 'Fallback');
    expect(fb.proxies).toContain('CF-HKG-1');
    expect(fb.proxies).toContain('CF-LAX-1');
    expect(fb.proxies).toContain('random_node');

    const manual = parsed['proxy-groups'].find((g: any) => g.name === '手动选择');
    expect(manual.proxies).toContain('CF-HKG-1');
    expect(manual.proxies).toContain('CF-LAX-1');
    expect(manual.proxies).toContain('random_node');
  });

  it('rules preserve GEOIP,CN,DIRECT + MATCH,PROXY defaults', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([b64('vless://u@a:443?encryption=none#n')]);
    const parsed: any = (await import('js-yaml')).load(out);
    expect(parsed.rules).toContain('GEOIP,CN,DIRECT');
    expect(parsed.rules).toContain('MATCH,PROXY');
  });

  it('cfp self-named nodes bucket by APAC-HKG/NA-LAX/NA-SEA prefix into url-test region groups', async () => {
    // cfp 自研命名（cidr.ts 实测 colo 落地）= 信任源，按命名分地区组安全
    // vendor 命名（CF-HKG-/🇭🇰/自由名）= 不可信，不进地区组（统一挂 Auto/Fallback/手动选择）
    const clashYaml = [
      'proxies:',
      '  - {name: "APAC-HKG-01", server: 104.16.144.1, port: 443, type: vless}',
      '  - {name: "APAC-HKG-02", server: 104.16.144.2, port: 443, type: vless}',
      '  - {name: "NA-LAX-01", server: 8.35.211.1, port: 443, type: vless}',
      '  - {name: "NA-SEA-01", server: 104.26.0.1, port: 443, type: vless}',
      '  - {name: "CF-HKG-vendor", server: 1.2.3.4, port: 443, type: vless}',
      '  - {name: "random_node", server: 5.6.7.8, port: 443, type: vless}',
    ].join('\n');
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([clashYaml]);
    const parsed: any = (await import('js-yaml')).load(out);
    const groups: any[] = parsed['proxy-groups'];
    const names = groups.map((g) => g.name);

    // 3 个地区组都在
    expect(names).toContain('APAC-HKG');
    expect(names).toContain('NA-LAX');
    expect(names).toContain('NA-SEA');

    // 各自只装自研节点
    const hkg = groups.find((g) => g.name === 'APAC-HKG');
    expect(hkg.type).toBe('url-test');
    expect(hkg.url).toBe('http://www.gstatic.com/generate_204');
    expect(hkg.proxies).toEqual(['APAC-HKG-01', 'APAC-HKG-02']);
    const lax = groups.find((g) => g.name === 'NA-LAX');
    expect(lax.proxies).toEqual(['NA-LAX-01']);
    const sea = groups.find((g) => g.name === 'NA-SEA');
    expect(sea.proxies).toEqual(['NA-SEA-01']);

    // vendor 命名节点绝不能漏进地区组（安全护栏）
    for (const g of [hkg, lax, sea]) {
      expect(g.proxies).not.toContain('CF-HKG-vendor');
      expect(g.proxies).not.toContain('random_node');
    }

    // 但 vendor/未识别节点仍进 Auto/Fallback/手动选择（统一兜底）
    const auto = groups.find((g) => g.name === 'Auto');
    expect(auto.proxies).toContain('CF-HKG-vendor');
    expect(auto.proxies).toContain('random_node');
  });

  it('region groups omitted when no cfp self-named nodes present', async () => {
    // 只有 vendor/自由命名节点 → 4 件套独占，无地区组
    const clashYaml = [
      'proxies:',
      '  - {name: "CF-HKG-vendor", server: 1.2.3.4, port: 443, type: vless}',
      '  - {name: "random_node", server: 5.6.7.8, port: 443, type: vless}',
    ].join('\n');
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([clashYaml]);
    const parsed: any = (await import('js-yaml')).load(out);
    const names = parsed['proxy-groups'].map((g: any) => g.name);
    expect(names).not.toContain('APAC-HKG');
    expect(names).not.toContain('NA-LAX');
    expect(names).not.toContain('NA-SEA');
  });
});
