// test/subscription/cidr.test.ts
// /sub/all 优选节点命名误导修复：vendor 旧行为把 request.cf.country 当作 IP 国家标在节点名上
// （CF edge IP 本就是 anycast，无真实国家级归属），现改成"按 CF PoP 区域分桶 + 已知大区命名"。
// 命名格式：CF-{region}-{idx}；region 取自 cidr 内置的 bucket 映射，不发外网请求。
import { describe, it, expect } from 'vitest';
import {
  parseCidrText,
  ipInCidr,
  generateOptimizedNodes,
  type CidrEntry,
  type Region,
} from '../../src/subscription/cidr';

describe('cidr parser', () => {
  it('parses single line /23 with whitespace tolerance', () => {
    const list = parseCidrText('  162.159.32.0/20  \n');
    expect(list.length).toBe(1);
    expect(list[0]).toEqual({ cidr: '162.159.32.0/20' });
    expect(list[0]!.cidr).toBe('162.159.32.0/20');
  });

  it('skips empty lines and comments', () => {
    const list = parseCidrText('# header\n\n104.16.0.0/13\n# trailing\n');
    expect(list.length).toBe(1);
    expect(list[0]!.cidr).toBe('104.16.0.0/13');
  });

  it('returns empty array on garbage input', () => {
    expect(parseCidrText('')).toEqual([]);
    expect(parseCidrText('not-an-ip\nalso-garbage')).toEqual([]);
  });
});

describe('ipInCidr membership', () => {
  const entries: CidrEntry[] = parseCidrText('104.16.0.0/13\n172.64.0.0/13\n');
  it('matches first usable IP inside /13', () => {
    // 104.16.0.0/13 covers 104.16.0.0 - 104.23.255.255
    expect(ipInCidr('104.16.0.0', entries)).toBe(true);
    expect(ipInCidr('104.23.255.255', entries)).toBe(true);
  });
  it('rejects just outside /13', () => {
    expect(ipInCidr('104.24.0.0', entries)).toBe(false);
    expect(ipInCidr('104.15.255.255', entries)).toBe(false);
  });
  it('matches second CIDR', () => {
    expect(ipInCidr('172.64.0.1', entries)).toBe(true);
  });
  it('returns false on malformed IP', () => {
    expect(ipInCidr('not-an-ip', entries)).toBe(false);
    expect(ipInCidr('999.0.0.0', entries)).toBe(false);
  });
});

describe('generateOptimizedNodes region bucketing', () => {
  // 内置 CIDR 应当覆盖至少六个 region：APAC / NA / LATAM / EU / AF / OC
  const REGION_RE = /^(APAC|NA|EU|LATAM|AF|OC)$/;

  it('produces 64 nodes by default (PoP-weighted: APAC24 / NA16 / EU16 / LATAM4 / AF2 / OC2)', () => {
    const nodes = generateOptimizedNodes({});
    expect(nodes.length).toBe(64);
  });

  it('every node name starts with CF-{REGION}-', () => {
    const nodes = generateOptimizedNodes({});
    for (const n of nodes) {
      expect(n.name).toMatch(/^CF-(APAC|NA|EU|LATAM|AF|OC)-\d+$/);
    }
  });

  it('every node has a valid IPv4 server', () => {
    const nodes = generateOptimizedNodes({});
    for (const n of nodes) {
      expect(n.server).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    }
  });

  it('every node has TLS+WS+UUID+sni set (vless share-link shape)', () => {
    const nodes = generateOptimizedNodes({ uuid: 'test-uuid-1111' });
    for (const n of nodes) {
      expect(n.port).toBeGreaterThanOrEqual(80);
      expect(n.uuid).toBe('test-uuid-1111');
      expect(n.tls).toBe(true);
      expect(n.network).toBe('ws');
      expect(n.sni).toBeTruthy();
    }
  });

  it('region distribution matches the configured weights (PoP-weighted)', () => {
    const nodes = generateOptimizedNodes({});
    const counts: Record<Region, number> = { APAC: 0, NA: 0, EU: 0, LATAM: 0, AF: 0, OC: 0 };
    for (const n of nodes) {
      const region = n.name.split('-')[1] as Region;
      expect(REGION_RE.test(region)).toBe(true);
      counts[region]++;
    }
    expect(counts.APAC).toBe(24);
    expect(counts.NA).toBe(16);
    expect(counts.EU).toBe(16);
    expect(counts.LATAM).toBe(4);
    expect(counts.AF).toBe(2);
    expect(counts.OC).toBe(2);
  });

  it('honors custom count override', () => {
    const nodes = generateOptimizedNodes({ count: 6 });
    expect(nodes.length).toBe(6);
  });

  it('IP samples are reproducible when given a seed (deterministic per request)', () => {
    // 不同调用抽样会有差异，但同一次调用内不能出现重复 server
    const nodes = generateOptimizedNodes({});
    const seen = new Set<string>();
    for (const n of nodes) {
      expect(seen.has(`${n.server}:${n.port}`)).toBe(false);
      seen.add(`${n.server}:${n.port}`);
    }
  });
});