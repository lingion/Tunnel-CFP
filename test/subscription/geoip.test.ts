// test/subscription/geoip.test.ts
// vendor 节点真实 IP 归属查询（ip-api.com /batch + KV 缓存 24h）
// 用于按 Google/巴哈/Google Play 实际看到的 country 分桶
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@cloudflare/workers-types';

// In-memory KV 实现（测试）
class MemKV {
  store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async put(k: string, v: string, opts?: { expirationTtl?: number }) { this.store.set(k, v); }
}

describe('geoip country lookup', () => {
  it('returns country code for a single IP via ip-api.com', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('ip-api.com');
      expect(url).toContain('104.16.144.1');
      // /json/{ip} 返回单个对象（非数组）
      return new Response(JSON.stringify({ status: 'success', countryCode: 'HK', country: 'Hong Kong' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { lookupCountry } = await import('../../src/subscription/geoip');
    const cc = await lookupCountry('104.16.144.1');
    expect(cc).toBe('HK');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('returns null for failed lookup (status: fail)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'fail', message: 'private range' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { lookupCountry } = await import('../../src/subscription/geoip');
    const cc = await lookupCountry('192.168.1.1');
    expect(cc).toBeNull();
    vi.unstubAllGlobals();
  });

  it('caches country lookup in KV for 24h', async () => {
    const kv = new MemKV();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'success', countryCode: 'TW' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { KV: kv } as unknown as Env;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const { lookupCountryCached } = await import('../../src/subscription/geoip');
    const a = await lookupCountryCached('203.0.113.1', env, ctx);
    const b = await lookupCountryCached('203.0.113.1', env, ctx);
    expect(a).toBe('TW');
    expect(b).toBe('TW');
    // 第二次走 KV，不应再发 fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(kv.store.has('geoip:v1:203.0.113.1')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('batch lookupCountryBatch groups IPs (max 100 per /batch call)', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      // /batch 接受 JSON body [{query, fields}, ...]
      const body = JSON.parse(opts?.body as string);
      expect(body.length).toBeLessThanOrEqual(100);
      return new Response(JSON.stringify(body.map((b: any) => ({ status: 'success', countryCode: 'JP' }))), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { lookupCountryBatch } = await import('../../src/subscription/geoip');
    const ips = Array.from({ length: 250 }, (_, i) => `1.2.3.${i % 256}`);
    const result = await lookupCountryBatch(ips);
    // 250 IPs → 3 个 /batch 调用（100+100+50）
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 每个 IP 都拿到结果
    expect(result.size).toBe(250);
    expect(result.get('1.2.3.0')).toBe('JP');
    vi.unstubAllGlobals();
  });

  it('lookupCountryBatch falls back to per-IP on /batch failure', async () => {
    let batchCalled = 0;
    let singleCalled = 0;
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (opts?.body) {
        batchCalled++;
        return new Response('upstream error', { status: 500 });
      }
      singleCalled++;
      // /json/{ip} 单 IP 返回对象
      return new Response(JSON.stringify({ status: 'success', countryCode: 'KR' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { lookupCountryBatch } = await import('../../src/subscription/geoip');
    const result = await lookupCountryBatch(['1.1.1.1', '2.2.2.2']);
    expect(batchCalled).toBe(1);
    expect(singleCalled).toBe(2);
    expect(result.get('1.1.1.1')).toBe('KR');
    expect(result.get('2.2.2.2')).toBe('KR');
    vi.unstubAllGlobals();
  });

  it('lookupCountriesCached wraps each IP via lookupCountryCached', async () => {
    const kv = new MemKV();
    const fetchMock = vi.fn(async (_url: string, opts?: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : null;
      // 每个 IP 各自的国家码（按 IP 起始字节判定）
      const results = (body || []).map((q: any) => ({
        status: 'success',
        countryCode: q.query.startsWith('1.') ? 'TW' : 'JP',
      }));
      return new Response(JSON.stringify(results), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = { KV: kv } as unknown as Env;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const { lookupCountriesCached } = await import('../../src/subscription/geoip');
    const result = await lookupCountriesCached(['1.2.3.4', '5.6.7.8'], env, ctx);
    expect(result.get('1.2.3.4')).toBe('TW');
    expect(result.get('5.6.7.8')).toBe('JP');
    vi.unstubAllGlobals();
  });
});

describe('geoip country → Clash group name mapping', () => {
  it('maps common CCs to emoji + region name (TW/HK/JP/US/CN/KR/SG)', async () => {
    const { regionGroupName } = await import('../../src/subscription/geoip');
    expect(regionGroupName('TW')).toBe('🇹🇼 台湾');
    expect(regionGroupName('HK')).toBe('🇭🇰 香港');
    expect(regionGroupName('JP')).toBe('🇯🇵 日本');
    expect(regionGroupName('US')).toBe('🇺🇸 美国');
    expect(regionGroupName('CN')).toBe('🇨🇳 中国大陆');
    expect(regionGroupName('KR')).toBe('🇰🇷 韩国');
    expect(regionGroupName('SG')).toBe('🇸🇬 新加坡');
  });

  it('maps secondary CCs (GB/DE/FR/AU/CA/IN/TH/VN/MY/PH/ID/BR/NL/IT/ES/SE/NO/FI/CH/PL/RU/TR)', async () => {
    const { regionGroupName } = await import('../../src/subscription/geoip');
    expect(regionGroupName('GB')).toBe('🇬🇧 英国');
    expect(regionGroupName('DE')).toBe('🇩🇪 德国');
    expect(regionGroupName('FR')).toBe('🇫🇷 法国');
    expect(regionGroupName('AU')).toBe('🇦🇺 澳大利亚');
    expect(regionGroupName('CA')).toBe('🇨🇦 加拿大');
    expect(regionGroupName('IN')).toBe('🇮🇳 印度');
    expect(regionGroupName('TH')).toBe('🇹🇭 泰国');
    expect(regionGroupName('VN')).toBe('🇻🇳 越南');
    expect(regionGroupName('MY')).toBe('🇲🇾 马来西亚');
    expect(regionGroupName('PH')).toBe('🇵🇭 菲律宾');
    expect(regionGroupName('ID')).toBe('🇮🇩 印度尼西亚');
    expect(regionGroupName('BR')).toBe('🇧🇷 巴西');
    expect(regionGroupName('NL')).toBe('🇳🇱 荷兰');
    expect(regionGroupName('IT')).toBe('🇮🇹 意大利');
    expect(regionGroupName('ES')).toBe('🇪🇸 西班牙');
    expect(regionGroupName('SE')).toBe('🇸🇪 瑞典');
    expect(regionGroupName('NO')).toBe('🇳🇴 挪威');
    expect(regionGroupName('FI')).toBe('🇫🇮 芬兰');
    expect(regionGroupName('CH')).toBe('🇨🇭 瑞士');
    expect(regionGroupName('PL')).toBe('🇵🇱 波兰');
    expect(regionGroupName('RU')).toBe('🇷🇺 俄罗斯');
    expect(regionGroupName('TR')).toBe('🇹🇷 土耳其');
  });

  it('unknown CC returns null (caller falls back to 🌐其他 group)', async () => {
    const { regionGroupName } = await import('../../src/subscription/geoip');
    expect(regionGroupName('XX')).toBeNull();
    expect(regionGroupName('')).toBeNull();
  });
});