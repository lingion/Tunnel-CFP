// src/index.ts — v3 router
// 路由分流：/api/* → gateway · /dns-query + /resolve → DoH · /proxy/* → Web Proxy · /proxy-ws/* → WS 桥 · /sub/* → Subscription · 其他 → edgetunnel
// vendored JS, 零修改委派; allowJs 解析默认导出, 类型由 Runtime 验证
import edgetunnel from "../vendor/edgetunnel/_worker.js";
import { handleGateway } from "./gateway/router";
import { handleDoh } from "./doh/handler";
import { handleWebProxy } from "./proxy-web/handler";
import { handleWsBridge } from "./proxy-web/ws-bridge";
import { handleSubscription } from "./subscription/handler";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleGateway(request, env, ctx);
    }
    if (url.pathname === "/dns-query" || url.pathname === "/resolve") {
      return handleDoh(request, ctx);
    }
    if (url.pathname.startsWith("/proxy/")) {
      return handleWebProxy(request);
    }
    if (url.pathname.startsWith("/proxy-ws/")) {
      return handleWsBridge(request);
    }
    if (url.pathname.startsWith("/sub/")) {
      return handleSubscription(request, env, ctx);
    }
    return edgetunnel.fetch(request, env, ctx);
  },
};