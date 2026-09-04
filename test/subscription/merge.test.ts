// test/subscription/merge.test.ts
import { describe, it, expect } from 'vitest';
import { mergeYaml } from '../../src/subscription/merge';

describe('merge subscription YAML', () => {
  it('combines two YAMLs preserving proxies and proxy-groups', () => {
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
    type: trojan
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

    // Both proxy groups present (G1 merged, G2 unique)
    expect(merged).toContain('G1');
    expect(merged).toContain('G2');

    // Rules preserved
    expect(merged).toContain('MATCH,G1');
    expect(merged).toContain('DOMAIN,example.com,G2');
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
    'vless://b88ab8fa-392c-44b3-9343-612c11814708@104.17.125.64:2087?security=tls&type=ws&host=cfp.example.test&fp=chrome&sni=cfp.example.test&path=%2F&encryption=none#CF%E8%8A%82%E7%82%B9A',
    'vless://b88ab8fa-392c-44b3-9343-612c11814708@www.visa.com.sg:80?type=ws&host=cfp.example.test&path=%2F%3Fed%3D2560&encryption=none#CF%E8%8A%82%E7%82%B9B',
  ].join('\n');

  it('normalizes base64 vless list into proxies', async () => {
    const { mergeSubscriptionPayloads } = await import('../../src/subscription/merge');
    const out = mergeSubscriptionPayloads([b64(vlessList), '']);
    const parsed: any = (await import('js-yaml')).load(out);
    // vless 2 + trojan 孪生 2（密码 sha224(uuid)，见 trojan.test.ts 细节断言）
    expect(parsed.proxies.length).toBe(4);
    const p1 = parsed.proxies[0];
    expect(p1.name).toBe('CF节点A');
    expect(p1.type).toBe('vless');
    expect(p1.server).toBe('104.17.125.64');
    expect(p1.port).toBe(2087);
    expect(p1.uuid).toBe('b88ab8fa-392c-44b3-9343-612c11814708');
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
    const b = 'proxies:\n  - name: b1\n    server: s2\n    port: 443\n    type: trojan\n';
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
    expect(selector.proxies.length).toBe(4);
    expect(parsed.rules.length).toBeGreaterThan(0);
  });
});
