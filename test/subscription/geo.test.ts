// test/subscription/geo.test.ts
// geoip 真实国家归属命名：ip-api.com batch 查询 + KV 缓存 + 节点池稳定化
import { describe, it, expect, vi } from 'vitest';
import { applyGeoNames, resolveGeoCountries, getGeoNamedNodes } from '../../src/subscription/geo';
import { generateOptimizedNodes, type OptimizedNode } from '../../src/subscription/cidr';

function fakeKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  const puts: Array<[string, string]> = [];
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => {
      m.set(k, v);
      puts.push([k, v]);
    },
    puts,
  } as unknown as KVNamespace & { puts: Array<[string, string]> };
}

function ctxWithWaits() {
  const waits: Array<Promise<unknown>> = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
  return { ctx, waits };
}

function nodesFor(): OptimizedNode[] {
  return generateOptimizedNodes({ uuid: 'u1', sni: 'x.test', count: 8 });
}

describe('applyGeoNames', () => {
  it('renames nodes to CF-{CC}-{NN} grouped by country with renumbering', () => {
    const nodes: OptimizedNode[] = [
      { ...nodesFor()[0]!, name: 'CF-APAC-01', server: '1.1.1.1' },
      { ...nodesFor()[1]!, name: 'CF-APAC-02', server: '2.2.2.2' },
      { ...nodesFor()[2]!, name: 'CF-NA-01', server: '3.3.3.3' },
    ];
    const geo = new Map([['1.1.1.1', 'CA'], ['3.3.3.3', 'GB']]);
    const named = applyGeoNames(nodes, geo);
    // 2.2.2.2 无 geo → 回退保留原 region 桶名（编号不重排）
    expect(named.map((n) => n.name)).toEqual(['CF-CA-01', 'CF-APAC-02', 'CF-GB-01']);
  });

  it('keeps nodes without geo on region fallback and pads indices', () => {
    const nodes: OptimizedNode[] = [
      { ...nodesFor()[0]!, name: 'CF-EU-01', server: 'a' },
      { ...nodesFor()[1]!, name: 'CF-EU-02', server: 'b' },
    ];
    const named = applyGeoNames(nodes, new Map());
    expect(named.map((n) => n.name)).toEqual(['CF-EU-01', 'CF-EU-02']);
  });
});

describe('resolveGeoCountries', () => {
  it('returns KV-cached countries without fetching', async () => {
    const kv = fakeKV({ 'geoip:cc:v1': JSON.stringify({ '1.1.1.1': 'CA' }) });
    const env = { UUID: 'u', KV: kv } as unknown as Env;
    const { ctx } = ctxWithWaits();
    const fetchImpl = vi.fn();
    const geo = await resolveGeoCountries(['1.1.1.1'], env, ctx, fetchImpl as unknown as typeof fetch);
    expect(geo.get('1.1.1.1')).toBe('CA');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches missing IPs via ip-api batch and writes back to KV', async () => {
    const kv = fakeKV();
    const env = { UUID: 'u', KV: kv } as unknown as Env;
    const { ctx, waits } = ctxWithWaits();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const ips = JSON.parse(init!.body as string) as string[];
      return new Response(
        JSON.stringify(ips.map((ip) => ({ status: 'success', countryCode: ip === '2.2.2.2' ? 'GB' : 'CA', query: ip }))),
        { status: 200 },
      );
    });
    const geo = await resolveGeoCountries(['1.1.1.1', '2.2.2.2'], env, ctx, fetchImpl as unknown as typeof fetch);
    expect(geo.get('1.1.1.1')).toBe('CA');
    expect(geo.get('2.2.2.2')).toBe('GB');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await Promise.all(waits);
    expect(kv.puts.length).toBe(1);
    const stored = JSON.parse(kv.puts[0]![1]);
    expect(stored['1.1.1.1']).toBe('CA');
  });

  it('survives fetch failure and returns only cached entries', async () => {
    const env = { UUID: 'u' } as unknown as Env; // 无 KV
    const { ctx } = ctxWithWaits();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const geo = await resolveGeoCountries(['9.9.9.9'], env, ctx, fetchImpl as unknown as typeof fetch);
    expect(geo.size).toBe(0);
  });

  it('chunks batches at 100 IPs', async () => {
    const env = { UUID: 'u' } as unknown as Env;
    const { ctx } = ctxWithWaits();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const ips = JSON.parse(init!.body as string) as string[];
      return new Response(JSON.stringify(ips.map((ip) => ({ status: 'success', countryCode: 'CA', query: ip }))), { status: 200 });
    });
    const ips = Array.from({ length: 250 }, (_, i) => `10.0.${Math.floor(i / 256) % 256}.${i % 256}`);
    await resolveGeoCountries(ips, env, ctx, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('getGeoNamedNodes (pool with KV cache)', () => {
  it('generates geo-named nodes and caches them; second call hits cache without fetch', async () => {
    const kv = fakeKV();
    const env = { UUID: 'u1', KV: kv } as unknown as Env;
    const { ctx, waits } = ctxWithWaits();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const ips = JSON.parse(init!.body as string) as string[];
      return new Response(JSON.stringify(ips.map((ip) => ({ status: 'success', countryCode: 'CA', query: ip }))), { status: 200 });
    });

    const first = await getGeoNamedNodes(env, ctx, 'x.test', fetchImpl as unknown as typeof fetch);
    await Promise.all(waits);
    expect(first.length).toBe(64);
    expect(first.every((n) => /^CF-CA-\d{2}$/.test(n.name))).toBe(true);

    const second = await getGeoNamedNodes(env, ctx, 'x.test', fetchImpl as unknown as typeof fetch);
    expect(second).toEqual(first);
    // 第二次：geo 无 missing（池缓存命中不触发 geo 查询）
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('works without KV (cache skipped, still geo-named)', async () => {
    const env = { UUID: 'u1' } as unknown as Env;
    const { ctx } = ctxWithWaits();
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }));
    const nodes = await getGeoNamedNodes(env, ctx, 'x.test', fetchImpl as unknown as typeof fetch);
    expect(nodes.length).toBe(64);
    expect(nodes.every((n) => /^CF-(APAC|NA|EU|LATAM|AF|OC)-\d{2}$/.test(n.name))).toBe(true);
  });
});
