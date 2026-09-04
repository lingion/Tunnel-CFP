// src/subscription/handler.ts — 实装
// 路由：
//   /sub/edgetunnel → vendor edgetunnel YAML
//   /sub/yonggekkk  → vendor yonggekkk YAML（通用格式）
//   /sub/all        → 两者合并
import { mergeYaml } from './merge';

export async function handleSubscription(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    // 动态 import vendor（避免 SSR/Node 测试环境装载）
    const edgetunnelMod = await import('../../vendor/edgetunnel/_worker.js');
    const yonggekkkMod = await import('../../vendor/yonggekkk/_worker.js');
    const edgetunnel = edgetunnelMod.default;
    const yonggekkk = yonggekkkMod.default;

    // 构造 vendor 用的子请求：移除 /sub/* 路径，让 vendor 走自己的订阅路径
    const subUrl = new URL(request.url);
    subUrl.pathname = '/sub';

    const [etText, ykText] = await Promise.all([
      fetchVendorYaml(edgetunnel, subUrl, request, env, 'edgetunnel'),
      fetchVendorYaml(yonggekkk, subUrl, request, env, 'yonggekkk'),
    ]);

    const yamlHeaders = { 'Content-Type': 'text/yaml; charset=utf-8' };

    if (path === '/sub/edgetunnel') return new Response(etText, { headers: yamlHeaders });
    if (path === '/sub/yonggekkk') return new Response(ykText, { headers: yamlHeaders });
    if (path === '/sub/all') {
      const merged = mergeYaml([etText, ykText]);
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
  name: string
): Promise<string> {
  const subReq = new Request(subUrl.toString(), originalRequest);
  const res = await vendor.fetch(subReq, env, {} as ExecutionContext);
  if (!res.ok) {
    throw new Error(`Vendor ${name} returned ${res.status}`);
  }
  return await res.text();
}