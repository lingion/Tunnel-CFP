// src/gateway/router.ts
import { checkAgentKey } from "./auth";
import { forward, buildTargetUrl, BadTargetError } from "./proxy";

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function handleGateway(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/v1/health") {
    return Response.json({ status: "ok", colo: (request as any).cf?.colo ?? null, ts: Date.now() });
  }
  if (path === "/api/v1" || path === "/api/v1/") {
    return Response.json({
      service: "proxy-gateway",
      version: "0.1.0",
      endpoints: ["/api/v1/fetch/<target-url>", "/api/v1/health"],
    });
  }

  if (path === "/api/v1/fetch" || path.startsWith("/api/v1/fetch/")) {
    if (!(await checkAgentKey(request, env))) {
      return jsonError(401, "UNAUTHORIZED", "missing or invalid X-API-Key (or ?key=)");
    }
    const pathAfter = path.slice("/api/v1/fetch".length); // "/https://..." or ""
    if (!pathAfter || pathAfter === "/") {
      return jsonError(400, "BAD_TARGET", "target url required after /fetch/");
    }
    let target: URL;
    try {
      target = buildTargetUrl(pathAfter, request.url);
    } catch (e) {
      if (e instanceof BadTargetError) return jsonError(400, "BAD_TARGET", e.message);
      throw e;
    }
    return forward(request, target);
  }

  return jsonError(404, "NOT_FOUND", `unknown gateway endpoint: ${path}`);
}
