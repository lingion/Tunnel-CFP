// test/subscription/trojan.test.ts
import { describe, it, expect } from 'vitest';
import { mergeSubscriptionPayloads } from '../../src/subscription/merge';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const UUID = 'b88ab8fa-392c-44b3-9343-612c11814708';
// sha224(UUID)（Node crypto 计算，作为期望值锚点）
import { createHash } from 'node:crypto';
const TROJAN_PW = createHash('sha224').update(UUID).digest('hex');

const vlessList = [
  `vless://${UUID}@104.17.125.64:2087?security=tls&type=ws&host=cfp.example.test&fp=chrome&sni=cfp.example.test&path=%2F&encryption=none#CF%E8%8A%82%E7%82%B9A`,
  `vless://${UUID}@www.visa.com.sg:80?type=ws&host=cfp.example.test&path=%2F%3Fed%3D2560&encryption=none#CF%E8%8A%82%E7%82%B9B`,
].join('\n');

describe('trojan twin nodes generated from vless list', () => {
  it('emits trojan node with sha224 password per vless node', async () => {
    const out = mergeSubscriptionPayloads([b64(vlessList)]);
    const yaml = await import('js-yaml');
    const parsed: any = yaml.load(out);
    // vless 2 + trojan 2 = 4
    expect(parsed.proxies.length).toBe(4);
    const trojans = parsed.proxies.filter((p: any) => p.type === 'trojan');
    expect(trojans.length).toBe(2);
    expect(trojans[0].password).toBe(TROJAN_PW);
    expect(trojans[0].server).toBe('104.17.125.64');
    expect(trojans[0].port).toBe(2087);
    expect(trojans[0].sni).toBe('cfp.example.test');
    expect(trojans[0]['ws-opts'].path).toBe('/');
    expect(trojans[0]['ws-opts'].headers.Host).toBe('cfp.example.test');
    // 名字区分协议
    expect(trojans[0].name).toContain('Trojan');
  });

  it('group selector includes both vless and trojan names', async () => {
    const out = mergeSubscriptionPayloads([b64(vlessList)]);
    const yaml = await import('js-yaml');
    const parsed: any = yaml.load(out);
    const sel = parsed['proxy-groups'].find((g: any) => g.type === 'select');
    expect(sel.proxies.length).toBe(4);
  });

  it('plaintext trojan:// link also parses', async () => {
    const trojanLink = `trojan://${TROJAN_PW}@1.2.3.4:443?security=tls&type=ws&host=h.test&sni=h.test&path=%2Fenc#T节点`;
    const out = mergeSubscriptionPayloads([trojanLink]);
    const yaml = await import('js-yaml');
    const parsed: any = yaml.load(out);
    expect(parsed.proxies[0].type).toBe('trojan');
    expect(parsed.proxies[0].password).toBe(TROJAN_PW);
    expect(parsed.proxies[0].server).toBe('1.2.3.4');
  });
});
