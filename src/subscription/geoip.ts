// src/subscription/geoip.ts — vendor 节点真实 IP 归属查询
// 用于按 Google / 巴哈 / Google Play 实际看到的 country 分桶
// 链路：ip-api.com /batch（一次性 ≤100 IP）→ KV 缓存 6h → 返回 country code
// fallback：/batch 失败时降级为单 IP 查询（也是 ip-api.com /json/{ip}）
// CF 工具（request.cf.country）= 请求方国家，不是节点 IP 的国家，不能用
import type { ExecutionContext } from '@cloudflare/workers-types';

const CACHE_PREFIX = 'geoip:v1:'; // v1=ip-api /batch 协议；升级字段需 bump
const CACHE_TTL = 6 * 3600; // 6h（ip-api 数据更新周期）
const BATCH_ENDPOINT = 'http://ip-api.com/json/batch';
const SINGLE_ENDPOINT = (ip: string) => `http://ip-api.com/json/${encodeURIComponent(ip)}`;
const BATCH_SIZE = 100; // ip-api 硬上限

// ip-api /batch 响应项（只关心我们用到的字段）
interface IpApiResult {
  status: 'success' | 'fail';
  countryCode?: string;
  message?: string;
}

// 单 IP 查询（带 KV 缓存，6h）
export async function lookupCountryCached(
  ip: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<string | null> {
  const kv = env.KV;
  if (kv) {
    try {
      const hit = await kv.get(CACHE_PREFIX + ip);
      if (hit === '__null__') return null; // 显式 null 缓存（避免每次都打 ip-api）
      if (hit) return hit;
    } catch {
      // KV 失败不致命，继续走 ip-api
    }
  }
  const cc = await lookupCountry(ip);
  if (kv) {
    ctx.waitUntil(
      kv.put(CACHE_PREFIX + ip, cc ?? '__null__', { expirationTtl: CACHE_TTL }).catch(() => undefined),
    );
  }
  return cc;
}

// 批量查询（≤100 IP/批）：先 /batch，失败降级单 IP
// 返回 Map<ip, countryCode|null>
export async function lookupCountryBatch(ips: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ips.length === 0) return out;

  // 分批 100 IP
  for (let i = 0; i < ips.length; i += BATCH_SIZE) {
    const slice = ips.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(BATCH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slice.map((query) => ({ query, fields: ['status', 'countryCode', 'message'] }))),
      });
      if (!res.ok) throw new Error(`batch HTTP ${res.status}`);
      const arr = (await res.json()) as IpApiResult[];
      slice.forEach((ip, idx) => {
        const r = arr[idx];
        out.set(ip, r?.status === 'success' && r.countryCode ? r.countryCode : null);
      });
    } catch {
      // /batch 失败 → 降级为单 IP（每个 ip 独立 /json/{ip}）
      for (const ip of slice) {
        try {
          const cc = await lookupCountry(ip);
          out.set(ip, cc);
        } catch {
          out.set(ip, null);
        }
      }
    }
  }
  return out;
}

// 多个 IP 走缓存（miss 才打 ip-api，hit 走 KV）
export async function lookupCountriesCached(
  ips: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const missing: string[] = [];
  const kv = env.KV;

  // 1) 查 KV
  if (kv) {
    await Promise.all(ips.map(async (ip) => {
      try {
        const hit = await kv.get(CACHE_PREFIX + ip);
        if (hit === '__null__') out.set(ip, null);
        else if (hit) out.set(ip, hit);
        else missing.push(ip);
      } catch {
        missing.push(ip);
      }
    }));
  } else {
    missing.push(...ips);
  }

  if (missing.length === 0) return out;

  // 2) 批量查 ip-api（miss 走 /batch，hit 直接 KV）
  const fresh = await lookupCountryBatch(missing);
  for (const [ip, cc] of fresh) {
    out.set(ip, cc);
    if (kv) {
      ctx.waitUntil(
        kv.put(CACHE_PREFIX + ip, cc ?? '__null__', { expirationTtl: CACHE_TTL }).catch(() => undefined),
      );
    }
  }
  return out;
}

// 单 IP 查询（无缓存，ip-api /json/{ip}）
export async function lookupCountry(ip: string): Promise<string | null> {
  try {
    const res = await fetch(SINGLE_ENDPOINT(ip));
    if (!res.ok) return null;
    const r = (await res.json()) as IpApiResult;
    if (r.status === 'success' && r.countryCode) return r.countryCode;
    return null;
  } catch {
    return null;
  }
}

// country code (ISO 3166-1 alpha-2) → Clash 分组名
// 主分桶（用户高频使用 + 平台识别必须区分）
const PRIMARY_REGIONS: Record<string, string> = {
  TW: '🇹🇼 台湾', // 巴哈姆特
  HK: '🇭🇰 香港', // 部分 Google 服务
  JP: '🇯🇵 日本', // 日区 Play / 日区 App Store
  US: '🇺🇸 美国', // 兜底
  CN: '🇨🇳 中国大陆',
  KR: '🇰🇷 韩国',
  SG: '🇸🇬 新加坡',
};

// 次分桶（流量较大但非主要场景）
const SECONDARY_REGIONS: Record<string, string> = {
  GB: '🇬🇧 英国',
  DE: '🇩🇪 德国',
  FR: '🇫🇷 法国',
  AU: '🇦🇺 澳大利亚',
  CA: '🇨🇦 加拿大',
  IN: '🇮🇳 印度',
  TH: '🇹🇭 泰国',
  VN: '🇻🇳 越南',
  MY: '🇲🇾 马来西亚',
  PH: '🇵🇭 菲律宾',
  ID: '🇮🇩 印度尼西亚',
  BR: '🇧🇷 巴西',
  NL: '🇳🇱 荷兰',
  IT: '🇮🇹 意大利',
  ES: '🇪🇸 西班牙',
  SE: '🇸🇪 瑞典',
  NO: '🇳🇴 挪威',
  FI: '🇫🇮 芬兰',
  CH: '🇨🇭 瑞士',
  PL: '🇵🇱 波兰',
  RU: '🇷🇺 俄罗斯',
  TR: '🇹🇷 土耳其',
};

export function regionGroupName(cc: string): string | null {
  return PRIMARY_REGIONS[cc] ?? SECONDARY_REGIONS[cc] ?? null;
}