// src/subscription/handler.ts — 实装
// 路由：
//   /sub/edgetunnel → vendor edgetunnel YAML（保留所有 vendor 输出，含假 CN 段）
//   /sub/yonggekkk  → vendor yonggekkk YAML（通用格式）
//   /sub/all        → vendor 输出过滤掉"假国家"段（CF移动优选-CN-… 等）+ 注入自研 CF-{REGION}-…
import { mergeSubscriptionPayloads } from './merge';
import { generateOptimizedNodes, type OptimizedNode } from './cidr';
import { md5md5 } from './md5';
import type { ProxyDef } from './types';

export async function handleSubscription(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // token 鉴权：token=MD5MD5(host+UUID)，与 vendor edgetunnel 订阅 token 同源。
  // 节点里的 UUID 本身就是连接凭证，订阅裸奔=泄露凭证。
  const token = url.searchParams.get('token');
  const expected = await md5md5(url.host + env.UUID);
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

    if (path === '/sub/edgetunnel') return new Response(etText, { headers: yamlHeaders });
    if (path === '/sub/yonggekkk') return new Response(ykText, { headers: yamlHeaders });
    if (path === '/sub/all') {
      // /sub/all：先合并，再对最终 YAML 过滤假国家段（vendor 输出可能是 base64 vless 列表，
      // 必须等 mergeSubscriptionPayloads 规范化成 Clash YAML 后才能按 name 过滤）
      const optimizedYaml = optimizedNodesToYaml(generateOptimizedNodes({
        uuid: env.UUID,
        sni: url.host,
      }));
      const merged = mergeSubscriptionPayloads([etText, ykText, optimizedYaml]);
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
// 不存在国家级归属，是误导信息。同时去掉对应的 Trojan 孪生（同名 + ·Trojan）
export const FAKE_COUNTRY_PREFIX_RE = /^CF(移动|联通|电信|官方)优选-/;
const TROJAN_TWIN_SUFFIX = '·Trojan';

export function stripFakeCountryNodes(yamlText: string): string {
  const lines = yamlText.split('\n');
  const out: string[] = [];
  // 先扫一遍，拿到要剔除的 name（vless + 孪生 trojan）
  const dropNames = new Set<string>();
  for (const l of lines) {
    const m = l.match(/^\s*-\s*name:\s*"?([^"#]+?)"?\s*(?:#.*)?$/);
    if (!m) continue;
    const rawName = m[1]!;
    if (FAKE_COUNTRY_PREFIX_RE.test(rawName)) {
      dropNames.add(rawName);
      // 孪生节点名是 `<原名>·Trojan`
      if (rawName.endsWith(TROJAN_TWIN_SUFFIX)) {
        dropNames.add(rawName.slice(0, -TROJAN_TWIN_SUFFIX.length));
      } else {
        dropNames.add(`${rawName}${TROJAN_TWIN_SUFFIX}`);
      }
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

  if (name === 'edgetunnel') {
    // edgetunnel: /sub?token=MD5MD5(host+userID)&target=mixed
    subUrl.pathname = '/sub';
    const token = await md5md5(subUrl.host + userID);
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