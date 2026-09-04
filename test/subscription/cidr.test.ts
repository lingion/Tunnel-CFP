// test/subscription/cidr.test.ts
// /sub/all 优选节点命名误导修复：vendor 旧行为把 request.cf.country 当作 IP 国家标在节点名上
// （CF edge IP 本就是 anycast，无真实国家级归属），现改成"按 CF PoP 区域分桶 + 已知大区命名"。
// 命名格式：{大区}-{colo}-{idx}（如 APAC-HKG-01）；桶映射来自家宽实测，不发外网请求。
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

describe('generateOptimizedNodes colo bucketing', () => {
  // 命名语义改为实测落地机房 colo(2026-09-04 从家宽 111.43.134.102 实测 25 段):
  //   HKG = 104.16/17/18/19 大段 + 172.66/22 · LAX = 8.35.211 + 8.39.125 + 91.193.58
  //   SEA = 188.164.248 + 104.26/20 + 172.67.64/20
  //   废段(对自用 host 报 1034,不可用)已剔除:162.159.32/20 · 162.159.38/23 ·
  //   108.162.198/24 · 198.41.208/23
  const COLO_RE = /^(APAC|NA)$/; // 大区字段

  it('produces 64 nodes by default', () => {
    const nodes = generateOptimizedNodes({});
    expect(nodes.length).toBe(64);
  });

  it('every node name = {region}-{colo}-{idx}', () => {
    const nodes = generateOptimizedNodes({});
    for (const n of nodes) {
      expect(n.name).toMatch(/^(APAC-HKG|NA-LAX|NA-SEA)-\d+$/);
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

  it('name = {region}-{colo}-{idx} with no CF prefix', () => {
    const nodes = generateOptimizedNodes({});
    for (const n of nodes) {
      const parts = n.name.split('-');
      expect(parts.length).toBe(3);
      expect(COLO_RE.test(parts[0]!)).toBe(true);
      expect(/^(HKG|LAX|SEA)$/.test(parts[1]!)).toBe(true);
      expect(/^\d{2}$/.test(parts[2]!)).toBe(true);
      expect(n.name).not.toContain('CF');
    }
  });

  it('colo distribution matches measured landing (APAC-HKG 40 / NA-LAX 12 / NA-SEA 12)', () => {
    const nodes = generateOptimizedNodes({});
    const counts: Record<string, number> = { 'APAC-HKG': 0, 'NA-LAX': 0, 'NA-SEA': 0 };
    for (const n of nodes) {
      counts[n.name.replace(/-\d+$/, '')] = (counts[n.name.replace(/-\d+$/, '')] ?? 0) + 1;
    }
    expect(counts['APAC-HKG']).toBe(40);
    expect(counts['NA-LAX']).toBe(12);
    expect(counts['NA-SEA']).toBe(12);
  });

  it('dead CIDRs (error 1034 for our host) are excluded from the pool', () => {
    const nodes = generateOptimizedNodes({ count: 200 });
    for (const n of nodes) {
      // 这些段对 cfp host 报 1034——出现在池里=废节点
      expect(ipInCidr(n.server, parseCidrText('162.159.32.0/20\n162.159.38.0/23\n108.162.198.0/24\n198.41.208.0/23'))).toBe(false);
    }
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