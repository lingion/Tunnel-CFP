// test/subscription/geo.test.ts
// 节点池稳定化:KV 缓存复用同一批 IP;geoip 命名层已退役(答案=注册国,与实测落地 colo 矛盾)
import { describe, it, expect, vi } from 'vitest';
import { getGeoNamedNodes } from '../../src/subscription/geo';

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

describe('getGeoNamedNodes (pool stabilization)', () => {
  it('generates 64 colo-named nodes on first call; second call hits pool cache', async () => {
    const kv = fakeKV();
    const env = { UUID: 'u1', KV: kv } as unknown as Env;
    const { ctx, waits } = ctxWithWaits();

    const first = await getGeoNamedNodes(env, ctx, 'x.test');
    await Promise.all(waits);
    expect(first.length).toBe(64);
    expect(first.every((n) => /^(APAC-HKG|NA-LAX|NA-SEA)-\d{2}$/.test(n.name))).toBe(true);
    expect(kv.puts.length).toBe(1);

    const second = await getGeoNamedNodes(env, ctx, 'x.test');
    expect(second).toEqual(first);
  });

  it('works without KV (cache skipped, still 64 colo-named)', async () => {
    const env = { UUID: 'u1' } as unknown as Env;
    const { ctx } = ctxWithWaits();
    const nodes = await getGeoNamedNodes(env, ctx, 'x.test');
    expect(nodes.length).toBe(64);
    expect(nodes.every((n) => /^(APAC-HKG|NA-LAX|NA-SEA)-\d{2}$/.test(n.name))).toBe(true);
  });

  it('restores cached pool even if uuid differs (stable naming across requests)', async () => {
    const kv = fakeKV();
    const envA = { UUID: 'u1', KV: kv } as unknown as Env;
    const { ctx, waits } = ctxWithWaits();
    const first = await getGeoNamedNodes(envA, ctx, 'x.test');
    await Promise.all(waits);
    const envB = { UUID: 'other', KV: kv } as unknown as Env;
    const second = await getGeoNamedNodes(envB, ctx, 'x.test');
    expect(second.map((n) => n.server)).toEqual(first.map((n) => n.server));
  });
});
