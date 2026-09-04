// src/subscription/handler.ts — 实装
// 路由：
//   /sub/edgetunnel → vendor edgetunnel YAML
//   /sub/yonggekkk  → vendor yonggekkk YAML（通用格式）
//   /sub/all        → 两者合并
import { mergeSubscriptionPayloads } from './merge';
import { md5md5 } from './md5';

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
      const merged = mergeSubscriptionPayloads([etText, ykText]);
      return new Response(merged, { headers: yamlHeaders });
    }

    return new Response('Not Found', { status: 404 });
  } catch (e: any) {
    return new Response(`Subscription error: ${e.message}`, { status: 500 });
  }
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