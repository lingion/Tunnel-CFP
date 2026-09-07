// src/subscription/handler.ts — 实装
// 路由：
//   /sub/edgetunnel → 治理后的 base64 vless 列表（V2RayNG 形态）：剥假 CN + 注入 geoip 命名自研节点
//   /sub/yonggekkk  → vendor yonggekkk YAML（通用格式，原样）
//   /sub/all        → 治理后的 Clash YAML：剥假 CN + 注入 geoip 命名自研节点
import * as yaml from 'js-yaml';
import { mergeSubscriptionPayloads } from './merge';
import { getGeoNamedNodes } from './geo';
import { type OptimizedNode, CIDR_BUCKETS } from './cidr';
import { md5md5 } from './md5';
import { lookupCountriesCached, buildCidrMatcher } from './geoip';

// 自研 CF 段 → country code（实测映射）
// ip-api 看 CF anycast IP 会返 CA 等错值，必须本地绕过
const CF_BUCKET_TO_COUNTRY: Record<string, string> = {
  'APAC-HKG': 'HK',
  'NA-LAX': 'US',
  'NA-SEA': 'US',
};
import type { ProxyDef } from './types';

export async function handleSubscription(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // token 鉴权：token=MD5MD5(hostname+UUID)，与 vendor edgetunnel 订阅 token 同源。
  // 必须用 hostname（无端口）而非 host（含端口）：vendor 内部 line 41-42 取 url.hostname
  // 作 host 计算自己的订阅 TOKEN，handler 必须与 vendor 算法一致。
  // 生产 HTTPS:443 下 host === hostname（端口省略），不影响用户；本地 wrangler dev:8787 下
  // 必须统一 hostname 否则 handler 鉴权 vs vendor 内部鉴权 token 不一致。
  // 节点里的 UUID 本身就是连接凭证，订阅裸奔=泄露凭证。
  const token = url.searchParams.get('token');
  const expected = await md5md5(url.hostname + env.UUID);
  if (!token || token !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // 动态 import vendor（避免 SSR/Node 测试环境装载）
    const edgetunnelMod = await import('../../vendor/edgetunnel/_worker.js');
    const yonggekkkMod = await import('../../vendor/yonggekkk/_worker.js');
    const edgetunnel = edgetunnelMod.default;
    const yonggekkk = yonggekkkMod.default;

    // 每个 vendor 各自构造 URL（并发改同一 URL 会互相覆盖）
    const etUrl = new URL(request.url);
    const ykUrl = new URL(request.url);

    const [etText, ykText] = await Promise.all([
      fetchVendorYaml(edgetunnel, etUrl, request, env, ctx, 'edgetunnel'),
      fetchVendorYaml(yonggekkk, ykUrl, request, env, ctx, 'yonggekkk'),
    ]);

    const yamlHeaders = { 'Content-Type': 'text/yaml; charset=utf-8' };

    if (path === '/sub/edgetunnel') {
      // V2RayNG 链接：vendor base64 列表先走同一套治理（merge 规范化 → 剥假 CN），
      // 再反向导出 base64 vless 列表（保持客户端形态），追加实测落地 colo 命名自研节点
      const geoNodes = await getGeoNamedNodes(env, ctx, url.host);
      const optimizedYaml = optimizedNodesToYaml(geoNodes);
      const lookupCountry = await makeLookupCountry([etText, optimizedYaml], env, ctx);
      const merged = mergeSubscriptionPayloads([etText, optimizedYaml], lookupCountry);
      const cleaned = stripFakeCountryNodes(merged);
      const links = clashToVlessLinks(cleaned);
      return new Response(btoa(links), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (path === '/sub/yonggekkk') return new Response(ykText, { headers: yamlHeaders });
    if (path === '/sub/all') {
      // /sub/all：先合并，再对最终 YAML 过滤假国家段（vendor 输出可能是 base64 vless 列表，
      // 必须等 mergeSubscriptionPayloads 规范化成 Clash YAML 后才能按 name 过滤）
      const geoNodes = await getGeoNamedNodes(env, ctx, url.host);
      const optimizedYaml = optimizedNodesToYaml(geoNodes);
      const lookupCountry = await makeLookupCountry([etText, ykText, optimizedYaml], env, ctx);
      const merged = mergeSubscriptionPayloads([etText, ykText, optimizedYaml], lookupCountry);
      const cleaned = stripFakeCountryNodes(merged);
      return new Response(cleaned, { headers: yamlHeaders });
    }

    return new Response('Not Found', { status: 404 });
  } catch (e: any) {
    return new Response(`Subscription error: ${e.message}`, { status: 500 });
  }
}

// 把 vendor 输出里的"假国家"段过滤掉：
//   CF移动优选-CN-... · CF联通优选-CN-... · CF电信优选-CN-... · CF官方优选-CN-...
// vendor 把 request.cf.country + ASN 请求者的属性写到节点名上当"国家归属"——CF edge IP 是 anycast，
// 不存在国家级归属，是误导信息。
export const FAKE_COUNTRY_PREFIX_RE = /^CF(移动|联通|电信|官方)优选-/;

export function stripFakeCountryNodes(yamlText: string): string {
  const lines = yamlText.split('\n');
  const out: string[] = [];
  // 先扫一遍，拿到要剔除的 name
  const dropNames = new Set<string>();
  for (const l of lines) {
    const m = l.match(/^\s*-\s*name:\s*"?([^"#]+?)"?\s*(?:#.*)?$/);
    if (!m) continue;
    const rawName = m[1]!;
    if (FAKE_COUNTRY_PREFIX_RE.test(rawName)) {
      dropNames.add(rawName);
    }
  }
  // 逐行扫描：
  //   1) proxies 段：`- name: <dropName>` → 跳过整个 proxy 块（直到下一个 `- name:`）
  //   2) proxy-groups 段：`- <dropName>` 引用行 → 删除该行
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      // 顶层（即新 proxy 起头的 `- name:`）则结束跳过
      const isTopLevelProxyStart = /^\s*-\s+name:\s*/.test(line);
      if (isTopLevelProxyStart) skipping = false;
      else continue;
    }
    const m = line.match(/^\s*-\s*name:\s*"?([^"]+?)"?\s*(?:#.*)?$/);
    if (m) {
      const name = m[1]!;
      if (dropNames.has(name)) {
        skipping = true;
        continue;
      }
    }
    // proxy-groups 里的引用行：`      - 节点名`（无 `name:` 键）
    const ref = line.match(/^\s+-\s+("?)(.+?)\1\s*$/);
    if (ref && dropNames.has(ref[2]!)) continue;
    out.push(line);
  }
  return out.join('\n');
}

// 治理后的 Clash YAML → base64 vless 列表（/sub/edgetunnel 形态，V2RayNG 订阅直接吃）
// 只导出 vless 节点（cfp 协议族仅 vless）
function clashToVlessLinks(yamlText: string): string {
  const parsed = (yaml.load(yamlText) as { proxies?: ProxyDef[] } | null) || {};
  const links: string[] = [];
  for (const p of parsed.proxies ?? []) {
    if (p.type !== 'vless') continue;
    const server = typeof p.server === 'string' ? p.server : '';
    const port = typeof p.port === 'number' ? p.port : NaN;
    if (!server || !Number.isFinite(port)) continue;
    const uuid = typeof p.uuid === 'string' ? p.uuid : '';
    const wsOpts = (p['ws-opts'] && typeof p['ws-opts'] === 'object' ? p['ws-opts'] : {}) as {
      path?: unknown; headers?: { Host?: unknown };
    };
    const host: string = (typeof p.sni === 'string' && p.sni) ||
      (typeof p['server-name'] === 'string' && p['server-name']) ||
      (typeof wsOpts.headers?.Host === 'string' && wsOpts.headers.Host) || server;
    const wsPath = typeof wsOpts.path === 'string' && wsOpts.path ? wsOpts.path : '/';
    const fp = typeof p['client-fingerprint'] === 'string' && p['client-fingerprint']
      ? p['client-fingerprint'] : 'chrome';
    const params = new URLSearchParams({
      security: 'tls',
      type: 'ws',
      host,
      sni: host,
      path: wsPath,
      encryption: 'none',
      fp,
    });
    links.push(`vless://${uuid}@${server}:${port}?${params.toString()}#${encodeURIComponent(p.name)}`);
  }
  return links.join('\n');
}

// 把 vendor 输出规范化一次，提取所有 IPv4/IPv6 server 字符串
// 仅查 IP 形态的 server；hostname（example.com）下沉到 🌐其他（避免每次触发 DNS 查询）
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function collectIpsFromYamlTexts(texts: string[]): string[] {
  const ips = new Set<string>();
  for (const t of texts) {
    if (!t || !t.trim()) continue;
    let parsed: any;
    try {
      parsed = yaml.load(t);
    } catch {
      continue;
    }
    const proxies = parsed?.proxies;
    if (!Array.isArray(proxies)) continue;
    for (const p of proxies) {
      const s = typeof p?.server === 'string' ? p.server : '';
      if (!s) continue;
      if (IPV4_RE.test(s) || (s.includes(':') && IPV6_RE.test(s))) ips.add(s);
    }
  }
  return [...ips];
}

// 从多份 yaml 文本提取 IP → 本地 CIDR + KV 缓存 + ip-api batch → 返回 (ip) => cc 闭包
// hostname 节点、geoip 失败、cache miss 一律返回 null（落到 🌐其他 兜底）
async function makeLookupCountry(
  yamlTexts: string[],
  env: Env,
  ctx: ExecutionContext,
): Promise<(ip: string) => string | null> {
  const ips = collectIpsFromYamlTexts(yamlTexts);
  if (ips.length === 0) return () => null;
  const cidrMatcher = buildCidrMatcher(CIDR_BUCKETS, CF_BUCKET_TO_COUNTRY);
  const map = await lookupCountriesCached(ips, env, ctx, cidrMatcher);
  return (ip) => map.get(ip) ?? null;
}

// 自研 CF-{REGION}-{N} 节点 → 形如 vendor /sub mixed 输出的 vless:// 行（便于走 mergeSubscriptionPayloads）
function optimizedNodesToYaml(nodes: OptimizedNode[]): string {
  const lines: string[] = [];
  for (const n of nodes) {
    const pathEnc = encodeURIComponent(n['ws-opts'].path);
    const params = [
      `security=tls`,
      `type=${n.network}`,
      `host=${encodeURIComponent(n['ws-opts'].headers.Host)}`,
      `fp=${n['client-fingerprint']}`,
      `sni=${encodeURIComponent(n.sni)}`,
      `path=${pathEnc}`,
      `encryption=none`,
    ].join('&');
    const link = `vless://${n.uuid}@${n.server}:${n.port}?${params}#${encodeURIComponent(n.name)}`;
    lines.push(link);
  }
  return lines.join('\n');
}

async function fetchVendorYaml(
  vendor: { fetch: (req: Request, env: any, ctx: ExecutionContext) => Promise<Response> },
  subUrl: URL,
  originalRequest: Request,
  env: Env,
  ctx: ExecutionContext,
  name: string
): Promise<string> {
  const userID = env.UUID;

  // 传给 vendor 的请求：固定 UA 为 "CF-Workers-SUB" 触发本地生成（避免 vendor 走远端 subconverter）
  // target=mixed 强制 edgetunnel 走本地 VLESS 节点生成分支
  const headers = new Headers(originalRequest.headers);
  headers.set('User-Agent', 'CF-Workers-SUB');

  // 内部 vendor fetch 强制 HTTPS：edgetunnel vendor 在收到 http:// 时会返 301 跳 https，
  // 内部 fetch 不跟 redirect 会抛 "Vendor edgetunnel returned 301"。
  // 真实生产=https+本地 wrangler dev=http 都必须走 https:// vendor,不能跟 incoming protocol。
  subUrl.protocol = 'https:';

  if (name === 'edgetunnel') {
    // edgetunnel: /sub?token=MD5MD5(host+userID)&target=mixed
    subUrl.pathname = '/sub';
    const token = await md5md5(subUrl.hostname + userID);
    subUrl.searchParams.set('token', token);
    subUrl.searchParams.set('target', 'mixed');
  } else if (name === 'yonggekkk') {
    // yonggekkk: /${userID}/cl 返回 Clash base64
    subUrl.pathname = `/${userID}/cl`;
  }

  const subReq = new Request(subUrl.toString(), { method: 'GET', headers, cf: originalRequest.cf });
  // yonggekkk vendor 读小写 env.uuid（_worker.js:63 `userID = env.uuid || userID`），
  // wrangler 绑定的是大写 UUID —— 不补小写视图会回退 vendor 硬编码 UUID，/${userID}/cl 永不命中
  const vendorEnv = name === 'yonggekkk' ? { ...env, uuid: userID } : env;
  const res = await vendor.fetch(subReq, vendorEnv, ctx);
  if (!res.ok) {
    throw new Error(`Vendor ${name} returned ${res.status}`);
  }
  return await res.text();
}