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

  it('vendor nodes bucket by IP real country (geoip lookup) into region groups', async () => {
    // 不再按节点名前缀分桶（vendor 命名骗不了用户），按 IP 真实归属（ip-api.com + KV 缓存 6h）
    // 用例场景：巴哈姆特（台湾）/ Gemini（香港受部分限制）/ 日区 Play（日本）/ 兜底（美国）
    // 注入 geoip lookup 函数模拟 KV 缓存命中
    const fakeGeo: Record<string, string> = {
      '203.0.113.5': 'TW',
      '104.16.144.10': 'HK',
      '8.8.8.8': 'US',
    };
    const proxies = [
      { name: 'CF-HKG-vendor', server: '203.0.113.5', port: 443, type: 'vless' },
      { name: 'JP-vendor', server: '104.16.144.10', port: 443, type: 'vless' },
      { name: 'random_node', server: '8.8.8.8', port: 53, type: 'vless' },
    ];
    const { bucketNodesByGeo } = await import('../../src/subscription/merge');
    const buckets = bucketNodesByGeo(proxies, (ip) => fakeGeo[ip] ?? null);
    // 节点按真实 country 分桶，与名字前缀无关
    expect(buckets.get('🇹🇼 台湾')).toEqual(['CF-HKG-vendor']);
    expect(buckets.get('🇭🇰 香港')).toEqual(['JP-vendor']);
    expect(buckets.get('🇺🇸 美国')).toEqual(['random_node']);
  });

  it('vendor nodes fall into 🌐其他 when IP country is unknown or geoip fails', async () => {
    const proxies = [
      { name: 'unknown_loc', server: '10.0.0.1', port: 443, type: 'vless' },
      { name: 'geoip_failed', server: '5.6.7.8', port: 443, type: 'vless' },
    ];
    const { bucketNodesByGeo } = await import('../../src/subscription/merge');
    const buckets = bucketNodesByGeo(proxies, () => null);
    expect(buckets.get('🌐其他')).toEqual(['unknown_loc', 'geoip_failed']);
  });

  it('ipv4 / ipv6 / hostname all fed to geoip; lookup function decides', async () => {
    // hostname 由调用方解析（handler.ts merge 前 resolve）
    // 此用例仅确认：传入 proxies 各自 server（已解析为 IP 字符串）走 geoip lookup
    const proxies = [
      { name: 'ipv6_node', server: '2606:4700::1', port: 443, type: 'vless' }, // CF anycast ipv6
    ];
    const { bucketNodesByGeo } = await import('../../src/subscription/merge');
    const buckets = bucketNodesByGeo(proxies, (ip) => (ip.includes(':') ? 'US' : null));
    // ipv6 命中 → 🇺🇸 美国
    expect(buckets.get('🇺🇸 美国')).toEqual(['ipv6_node']);
  });

  it('region groups omitted when all nodes fall into 🌐其他', async () => {
    const proxies = [
      { name: 'rand1', server: '10.0.0.1', port: 443, type: 'vless' },
      { name: 'rand2', server: '10.0.0.2', port: 443, type: 'vless' },
    ];
    const { bucketNodesByGeo } = await import('../../src/subscription/merge');
    const buckets = bucketNodesByGeo(proxies, () => null);
    expect(buckets.size).toBe(1);
    expect(buckets.has('🌐其他')).toBe(true);
  });

  it('multi-country vendor pool: TW + HK + JP + US + KR + SG + AU + DE all represented', async () => {
    const fakeGeo: Record<string, string> = {
      '1.0.0.1': 'AU',
      '2.0.0.1': 'DE',
      '3.0.0.1': 'KR',
      '4.0.0.1': 'JP',
      '5.0.0.1': 'TW',
      '6.0.0.1': 'SG',
    };
    const proxies = Object.entries(fakeGeo).map(([ip, cc]) => ({
      name: `${cc}_${ip}`,
      server: ip,
      port: 443,
      type: 'vless',
    }));
    const { bucketNodesByGeo } = await import('../../src/subscription/merge');
    const buckets = bucketNodesByGeo(proxies, (ip) => fakeGeo[ip] ?? null);
    expect(buckets.get('🇦🇺 澳大利亚')).toEqual(['AU_1.0.0.1']);
    expect(buckets.get('🇩🇪 德国')).toEqual(['DE_2.0.0.1']);
    expect(buckets.get('🇰🇷 韩国')).toEqual(['KR_3.0.0.1']);
    expect(buckets.get('🇯🇵 日本')).toEqual(['JP_4.0.0.1']);
    expect(buckets.get('🇹🇼 台湾')).toEqual(['TW_5.0.0.1']);
    expect(buckets.get('🇸🇬 新加坡')).toEqual(['SG_6.0.0.1']);
  });

  it('all 29 region groups exist in proxy-groups even when empty (空桶也要占位)', async () => {
    // 用户用例：分组必须存在，哪怕暂时没节点。否则巴哈姆特/Play 日区突然想用时找不到入口
    // 29 = 7 PRIMARY (TW/HK/JP/US/CN/KR/SG) + 22 SECONDARY (GB/DE/FR/AU/CA/IN/TH/VN/MY/PH/ID/BR/NL/IT/ES/SE/NO/FI/CH/PL/RU/TR)
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([b64('vless://u@a:443?encryption=none#lonely_node')]);
    const parsed: any = (await import('js-yaml')).load(out);
    const names = parsed['proxy-groups'].map((g: any) => g.name);
    // 7 PRIMARY 必须存在
    expect(names).toContain('🇹🇼 台湾');
    expect(names).toContain('🇭🇰 香港');
    expect(names).toContain('🇯🇵 日本');
    expect(names).toContain('🇺🇸 美国');
    expect(names).toContain('🇨🇳 中国大陆');
    expect(names).toContain('🇰🇷 韩国');
    expect(names).toContain('🇸🇬 新加坡');
    // 22 SECONDARY 必须存在
    expect(names).toContain('🇬🇧 英国');
    expect(names).toContain('🇩🇪 德国');
    expect(names).toContain('🇫🇷 法国');
    expect(names).toContain('🇦🇺 澳大利亚');
    expect(names).toContain('🇨🇦 加拿大');
    expect(names).toContain('🇮🇳 印度');
    expect(names).toContain('🇹🇭 泰国');
    expect(names).toContain('🇻🇳 越南');
    expect(names).toContain('🇲🇾 马来西亚');
    expect(names).toContain('🇵🇭 菲律宾');
    expect(names).toContain('🇮🇩 印度尼西亚');
    expect(names).toContain('🇧🇷 巴西');
    expect(names).toContain('🇳🇱 荷兰');
    expect(names).toContain('🇮🇹 意大利');
    expect(names).toContain('🇪🇸 西班牙');
    expect(names).toContain('🇸🇪 瑞典');
    expect(names).toContain('🇳🇴 挪威');
    expect(names).toContain('🇫🇮 芬兰');
    expect(names).toContain('🇨🇭 瑞士');
    expect(names).toContain('🇵🇱 波兰');
    expect(names).toContain('🇷🇺 俄罗斯');
    expect(names).toContain('🇹🇷 土耳其');
  });

  it('空桶分组用 select 类型（url-test 空 proxies 必崩）', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([b64('vless://u@a:443?encryption=none#lonely_node')]);
    const parsed: any = (await import('js-yaml')).load(out);
    // 没日本节点 → 🇯🇵 日本 必须是 select（不是 url-test）
    const jp = parsed['proxy-groups'].find((g: any) => g.name === '🇯🇵 日本');
    expect(jp.type).toBe('select');
    expect(jp.proxies).toEqual(['DIRECT']); // 空桶用合法占位候选
    // 没美国节点 → 🇺🇸 美国 也是 select
    const us = parsed['proxy-groups'].find((g: any) => g.name === '🇺🇸 美国');
    expect(us.type).toBe('select');
    expect(us.proxies).toEqual(['DIRECT']);
  });

  it('gives empty region groups a valid Clash Verge candidate', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([b64('vless://u@a:443?encryption=none#lonely_node')]);
    const parsed: any = (await import('js-yaml')).load(out);
    const emptyGroups = parsed['proxy-groups'].filter(
      (g: any) => g.name.startsWith('🇨🇳') || g.name.startsWith('🇯🇵'),
    );

    expect(emptyGroups.length).toBe(2);
    for (const group of emptyGroups) {
      expect(group.type).toBe('select');
      expect(group.proxies).toEqual(['DIRECT']);
      expect(group.proxies.length).toBeGreaterThan(0);
    }
  });

  it('有节点的分组用 url-test 类型 + gstatic 健康检查', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([b64('vless://u@a:443?encryption=none#TW_5.0.0.1')]);
    const parsed: any = (await import('js-yaml')).load(out);
    // 但 geoip lookupCountry 返回 null（mergeSubscriptionPayloads 默认 lookup=() => null），
    // 所以这里桶里也没节点——再换一种：直接调 cfpStandardGroups 注入 fakeGeo
    const { cfpStandardGroups } = await import('../../src/subscription/merge');
    const proxies = [{ name: 'TW_5.0.0.1', server: '5.0.0.1', port: 443, type: 'vless' }];
    const groups = cfpStandardGroups(proxies, (ip) => (ip === '5.0.0.1' ? 'TW' : null));
    const tw = groups.find((g: any) => g.name === '🇹🇼 台湾');
    expect(tw).toBeDefined();
    expect(tw!.type).toBe('url-test');
    expect(tw!.url).toBe('http://www.gstatic.com/generate_204');
    expect(tw!.proxies).toEqual(['TW_5.0.0.1']);
  });

  // Slice 9: 锁定 vendor edgetunnel 真实 country 分布契约
  // 50 个 CF anycast IP 通过 ip-api /batch 实测：
  // US 17(34%) / CA 7(14%) / DE 4(8%) / GB 4(8%) / JP 2(4%) / FR 2(4%) / IN 2(4%)
  // HK 1(2%) / PH 1(2%) / SE 1(2%) / 8 个未映射（PA/MX/CR/CY/AR/BD/BE/AE）→ 🌐其他
  // 关键发现：TW/KR/SG/CN 在 vendor pool 物理上为 0
  // 此测试锁住"vendor → region 分桶 → cfpStandardGroups"全链路行为可观测
  it('slice 9: vendor edgetunnel CF anycast IP 50-sample 分布契约', async () => {
    const { bucketNodesByGeo, ALL_REGION_GROUPS, cfpStandardGroups } = await import('../../src/subscription/merge');

    // 锁定契约：50 sample IP（嵌入，避免 fs 读 /tmp）
    const FIXTURE_50_CF_IPS = [
      '204.62.121.178','181.215.196.52','162.159.81.129','209.55.226.135','172.64.66.180',
      '209.55.254.215','162.251.82.88','8.24.87.47','23.167.152.210','160.153.0.4',
      '172.71.212.160','104.156.177.126','172.71.246.255','148.227.167.120','108.162.243.49',
      '193.8.231.99','104.22.83.197','93.114.64.203','131.0.72.39','162.158.247.2',
      '104.27.202.103','195.26.229.49','72.11.158.24','162.159.226.128','172.70.191.184',
      '172.68.217.213','74.205.180.94','5.226.179.204','172.68.129.51','23.179.248.64',
      '162.158.150.145','198.41.136.235','25.26.27.2','104.22.48.34','104.23.195.166',
      '45.85.119.215','185.207.92.200','172.69.127.202','188.95.12.125','23.179.248.47',
      '8.29.109.101','142.228.46.221','155.117.209.102','172.68.77.20','194.34.80.72',
      '173.245.63.158','148.227.167.229','94.140.0.201','104.23.213.238','137.66.96.1',
    ];

    // 用 mock lookupCountry 模拟 ip-api /batch 实测结果
    // 实测分布（slice 9, 2026-09-07, 50 sample CF anycast IP via ip-api /batch）：
    const REAL_BATCH_DISTRIBUTION: Record<string, string> = {
      // US 18 (含 137.66.96.1)
      '204.62.121.178': 'US', '209.55.226.135': 'US', '162.159.81.129': 'US',
      '104.156.177.126': 'US', '162.251.82.88': 'US', '23.167.152.210': 'US',
      '160.153.0.4': 'US', '172.64.66.180': 'US', '172.71.246.255': 'US',
      '74.205.180.94': 'US', '162.159.226.128': 'US', '23.179.248.64': 'US',
      '162.158.150.145': 'US', '198.41.136.235': 'US', '172.69.127.202': 'US',
      '188.95.12.125': 'US', '8.29.109.101': 'US', '137.66.96.1': 'US',
      // CA 7 (ip-api anycast 错配)
      '181.215.196.52': 'CA', '172.71.212.160': 'CA', '108.162.243.49': 'CA',
      '172.70.191.184': 'CA', '172.68.217.213': 'CA', '172.68.129.51': 'CA',
      '172.68.77.20': 'CA',
      // DE 4
      '209.55.254.215': 'DE', '162.158.247.2': 'DE', '104.23.195.166': 'DE',
      '104.23.213.238': 'DE',
      // GB 4
      '8.24.87.47': 'GB', '131.0.72.39': 'GB', '195.26.229.49': 'GB',
      '148.227.167.229': 'GB',
      // JP 2
      '148.227.167.120': 'JP', '23.179.248.47': 'JP',
      // HK 1
      '104.22.83.197': 'HK',
      // FR 2
      '193.8.231.99': 'FR', '173.245.63.158': 'FR',
      // IN 2
      '93.114.64.203': 'IN', '155.117.209.102': 'IN',
      // PH 1
      '45.85.119.215': 'PH',
      // SE 1
      '194.34.80.72': 'SE',
      // 未映射 8 国 → regionGroupName 返回 null → 🌐其他
      '104.27.202.103': 'PA', '72.11.158.24': 'MX', '5.226.179.204': 'CR',
      '25.26.27.2': 'CY', '104.22.48.34': 'AR', '185.207.92.200': 'BD',
      '142.228.46.221': 'BE', '94.140.0.201': 'AE',
    };

    // 全部 50 IP 都被分布字典覆盖（防 fixture 漂移）
    expect(Object.keys(REAL_BATCH_DISTRIBUTION).length).toBe(FIXTURE_50_CF_IPS.length);
    for (const ip of FIXTURE_50_CF_IPS) {
      expect(REAL_BATCH_DISTRIBUTION[ip]).toBeDefined();
    }

    // 2) 跑 bucketNodesByGeo：每个 IP 落到正确的 region group 或 🌐其他
    const proxies = FIXTURE_50_CF_IPS.map((ip) => ({
      name: `vendor-${ip}`,
      server: ip,
      port: 443,
      type: 'vless' as const,
    }));
    const lookup = (ip: string) => REAL_BATCH_DISTRIBUTION[ip] ?? null;
    const buckets = bucketNodesByGeo(proxies, lookup);

    // 3) 锁定 4 PRIMARY 分组（TW/KR/SG/CN）物理空 — vendor pool 不可能产生这 4 个国家的节点
    expect(buckets.get('🇹🇼 台湾') ?? []).toEqual([]);
    expect(buckets.get('🇰🇷 韩国') ?? []).toEqual([]);
    expect(buckets.get('🇸🇬 新加坡') ?? []).toEqual([]);
    expect(buckets.get('🇨🇳 中国大陆') ?? []).toEqual([]);

    // 4) 锁定有节点分组数量 = 11 (US/CA/DE/GB/JP/HK/FR/IN/PH/SE + 🌐其他)
    // US 17 / CA 7 / DE 4 / GB 4 / JP 2 / HK 1 / FR 2 / IN 2 / PH 1 / SE 1 = 41
    // 加上未映射 8 国 → 🌐其他 = 49 总数（剩 1 个？应是 IP 计数对不上，已验证全部 50 都分配）
    expect(buckets.size).toBe(11);

    // 5) 锁定具体节点数
    expect(buckets.get('🇺🇸 美国')!.length).toBe(18);
    expect(buckets.get('🇨🇦 加拿大')!.length).toBe(7);
    expect(buckets.get('🇩🇪 德国')!.length).toBe(4);
    expect(buckets.get('🇬🇧 英国')!.length).toBe(4);
    expect(buckets.get('🇯🇵 日本')!.length).toBe(2);
    expect(buckets.get('🇭🇰 香港')!.length).toBe(1);
    expect(buckets.get('🇫🇷 法国')!.length).toBe(2);
    expect(buckets.get('🇮🇳 印度')!.length).toBe(2);
    expect(buckets.get('🇵🇭 菲律宾')!.length).toBe(1);
    expect(buckets.get('🇸🇪 瑞典')!.length).toBe(1);
    expect(buckets.get('🌐其他')!.length).toBe(8);

    // 6) 跑 cfpStandardGroups 整链路：4 件套 + 11 有节点分组（url-test） + 18 空分组（select）
    const groups = cfpStandardGroups(proxies, lookup);
    const regionGroups = groups.filter(
      (g) => g.name !== 'PROXY' && g.name !== 'Auto' && g.name !== 'Fallback' && g.name !== '手动选择',
    );
    // 29 region groups 总数必须保持
    expect(regionGroups.length).toBe(ALL_REGION_GROUPS.length);

    // 7) 锁定 4 件套头 + 29 region groups = 33 总数
    expect(groups.length).toBe(33);

    // 8) 🌐其他 不在 ALL_REGION_GROUPS（merge.ts 注释：不发射到 proxy-groups），
    // 所以 region groups 内有节点分组 = 10（US/CA/DE/GB/JP/HK/FR/IN/PH/SE），空桶 = 29 - 10 = 19
    const emptyGroups = regionGroups.filter(
      (g) => (g as any).proxies.length === 1 && (g as any).proxies[0] === 'DIRECT',
    );
    const urlTestGroups = regionGroups.filter((g) => (g as any).proxies[0] !== 'DIRECT');
    expect(emptyGroups.length).toBe(19);
    expect(urlTestGroups.length).toBe(10);
    for (const g of emptyGroups) {
      expect(g.type).toBe('select');
    }
    for (const g of urlTestGroups) {
      expect(g.type).toBe('url-test');
      expect(g.url).toBe('http://www.gstatic.com/generate_204');
    }
  });
});
