// src/subscription/geo.ts — 节点池稳定化（KV 缓存）
// 命名演进：最初用 geoip 库国家码命名（ip-api batch），但 2026-09-04 家宽实测证明
// geoip 答案=IP 注册国（CF 段几乎全 CA），与真实落地 colo（HKG/SEA/LAX）直接矛盾——
// geoip 层会把正确命名改错，已退役。cidr.ts 按实测落地 colo 命名，本文件只负责
// 节点池稳定化：6h KV 缓存复用同一批 IP，避免每次订阅刷新重新随机抽样
// （节点 IP 天天变 → 客户端测速缓存作废 → 体验差）。
import type { OptimizedNode } from './cidr';

const POOL_CACHE_KEY = 'sub:pool:v3'; // v3=大区-机房 命名(v2 无大区字段,旧池不兼容)
const POOL_TTL = 6 * 3600; // 6h

export type GeoNamedNode = OptimizedNode;

// 主入口：节点池（KV 缓存稳定 IP 集），命名来自 cidr.ts 的实测 colo 桶
export async function getGeoNamedNodes(
  env: Env,
  ctx: ExecutionContext,
  sni: string,
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
  return pool;
}
