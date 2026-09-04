// src/subscription/geo.ts — geoip 真实国家归属命名
// 用户诉求：节点名显示 IP 的 geoip 真实地区（而非 vendor 把请求者国家写上去的假 CN）。
// 事实约束：CF edge IP 是 anycast，geoip 库给的是"注册国"（绝大多数 CF 段返回 CA=Cloudflare
// 注册地）——这是 geoip 数据库里该 IP 的权威答案，命名如实反映 geoip 结果。
// 机制：
//   1. 节点池 KV 缓存（POOL_TTL 内复用同一批 IP）——否则每次订阅刷新都重新随机抽样，
//      geoip 查询永远 miss 还会撞 ip-api 免费限流（45 req/min）
//   2. geoip 结果 KV 缓存（GEO_TTL）——同一 IP 短期不重复查询
//   3. 批量查询 ip-api.com/batch（100 IP/req，免费），失败回退 CIDR 区域桶名
import type { OptimizedNode } from './cidr';

const POOL_CACHE_KEY = 'sub:geo-pool:v1';
const GEO_CC_KEY = 'geoip:cc:v1';
const POOL_TTL = 6 * 3600; // 6h
const GEO_TTL = 24 * 3600; // 24h
const BATCH_SIZE = 100; // ip-api batch 上限

export type GeoNamedNode = OptimizedNode;

// 批量解析 IP → 2 字母国家码。fetchImpl 可注入（测试）；无 KV 时每次现查。
export async function resolveGeoCountries(
  ips: string[],
  env: Env,
  ctx: ExecutionContext,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ips.length === 0) return out;
  const unique = [...new Set(ips)];

  const kv = env.KV;
  let cache: Record<string, string> = {};
  if (kv) {
    try {
      cache = JSON.parse((await kv.get(GEO_CC_KEY)) || '{}') as Record<string, string>;
    } catch {
      cache = {};
    }
  }
  for (const ip of unique) {
    const cc = cache[ip];
    if (cc) out.set(ip, cc);
  }
  const missing = unique.filter((ip) => !out.has(ip));
  if (missing.length === 0) return out;

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetchImpl('http://ip-api.com/batch?fields=status,countryCode,query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!res.ok) continue;
      const rows = (await res.json()) as Array<{ status: string; countryCode: string; query: string }>;
      for (const r of rows) {
        if (r && r.status === 'success' && r.countryCode && r.query) {
          out.set(r.query, r.countryCode);
          cache[r.query] = r.countryCode;
        }
      }
    } catch {
      // 网络失败：这批回退区域桶名，不影响订阅可用性
    }
  }

  if (kv && Object.keys(cache).length > 0) {
    ctx.waitUntil(kv.put(GEO_CC_KEY, JSON.stringify(cache), { expirationTtl: GEO_TTL }));
  }
  return out;
}

// 把节点名改成 CF-{国家码}-{NN}（按国家分组重新编号）；查不到的 IP 保留原区域桶名
export function applyGeoNames(
  nodes: OptimizedNode[],
  geo: Map<string, string>,
): OptimizedNode[] {
  const counters = new Map<string, number>();
  return nodes.map((n) => {
    const cc = geo.get(n.server);
    if (!cc) return n; // 无 geo → 保留 CF-{REGION}-{N}
    const next = (counters.get(cc) ?? 0) + 1;
    counters.set(cc, next);
    return { ...n, name: `CF-${cc}-${String(next).padStart(2, '0')}` };
  });
}

// 主入口：节点池（KV 缓存稳定 IP 集）→ geoip 命名
export async function getGeoNamedNodes(
  env: Env,
  ctx: ExecutionContext,
  sni: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GeoNamedNode[]> {
  const { generateOptimizedNodes } = await import('./cidr');

  const kv = env.KV;
  let pool: GeoNamedNode[] | null = null;
  if (kv) {
    try {
      const raw = await kv.get(POOL_CACHE_KEY);
      if (raw) pool = JSON.parse(raw) as GeoNamedNode[];
    } catch {
      pool = null;
    }
  }
  if (!pool || !Array.isArray(pool) || pool.length === 0) {
    const fresh = generateOptimizedNodes({ uuid: env.UUID, sni });
    if (kv && fresh.length > 0) {
      ctx.waitUntil(kv.put(POOL_CACHE_KEY, JSON.stringify(fresh), { expirationTtl: POOL_TTL }));
    }
    pool = fresh;
  }

  const ips = pool.map((n) => n.server).filter(Boolean);
  const geo = await resolveGeoCountries(ips, env, ctx, fetchImpl);
  return applyGeoNames(pool, geo);
}
