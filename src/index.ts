// src/index.ts — v3 router
// 路由分流：/api/* → gateway · /dns-query + /resolve → DoH · /proxy/* → Web Proxy · /proxy-ws/* → WS 桥 · /sub/* → Subscription · 其他 → edgetunnel
// vendored JS, 零修改委派; allowJs 解析默认导出, 类型由 Runtime 验证
import edgetunnel from "../vendor/edgetunnel/_worker.js";
import { handleGateway } from "./gateway/router";
import { handleDoh } from "./doh/handler";
import { handleWebProxy } from "./proxy-web/handler";
import { handleWsBridge } from "./proxy-web/ws-bridge";
import { checkProxyAuth } from "./proxy-web/auth";
import { rescueNavigation } from "./proxy-web/rescue";
import { handleSubscription } from "./subscription/handler";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 全局兜底:任何 handler 抛未捕获异常 → 与伪装页同形态的 500 JSON(不泄栈,
    // 不留 Worker Exception 页给扫描器);ctx 未消费,保留全部 waitUntil 能力
    // console.error 最小诊断通道:进 Workers Logs(sampling 0.1 下 90% 丢失,
    // 但 tail 实时可见);只记错误类型与消息,绝不记 URL/query(订阅 token、
    // ?key= 凭证会随 invocation log 进 CF 留存)
    return routeRequest(request, env, ctx).catch((e: unknown) => {
      console.error(`[cfp-500] ${e instanceof Error ? `${e.name}: ${e.message}` : String(e).slice(0, 120)}`.slice(0, 200));
      return new Response(JSON.stringify({ error: "internal" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    });
  },
};

async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleGateway(request, env, ctx);
    }
    if (url.pathname === "/dns-query" || url.pathname === "/resolve") {
      return handleDoh(request, ctx);
    }
    if (url.pathname.startsWith("/proxy/")) {
      const denied = checkProxyAuth(request, env);
      if (denied) return denied;
      // ctx.waitUntil:cachePut 后台写不阻塞响应(流式/视频 TTFB 修复)
      return handleWebProxy(request, (p) => ctx.waitUntil(p));
    }
    if (url.pathname.startsWith("/proxy-ws/")) {
      const denied = checkProxyAuth(request, env);
      if (denied) return denied;
      return handleWsBridge(request);
    }
    if (url.pathname.startsWith("/sub/")) {
      return handleSubscription(request, env, ctx);
    }
    // 兜底优先级:代理页 JS location 赋值导航救援 > edgetunnel(面板/VLESS)
    // JS 里 location.href="/x" 会打到 cfp 域 /x;Referer 指向 /proxy/ 页时 302 救回
    const rescued = rescueNavigation(request);
    if (rescued) return rescued;
    return edgetunnel.fetch(request, env, ctx);
}