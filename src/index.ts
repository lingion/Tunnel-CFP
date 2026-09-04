// vendored JS, 零修改委派; allowJs 解析默认导出, 类型由 Runtime 验证
import edgetunnel from "../vendor/edgetunnel/_worker.js";
import { handleGateway } from "./gateway/router";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleGateway(request, env, ctx);
    }
    return edgetunnel.fetch(request, env, ctx);
  },
};
