import { describe, it, expect } from "vitest";
import { handleGateway } from "../src/gateway/router";

const baseEnv = { AGENT_KEY: "k9", KV: {} as KVNamespace } as Env;

function req(method: string, path: string, init?: RequestInit) {
  return new Request(`https://p.test${path}`, { method, ...init });
}

describe("handleGateway routing", () => {
  it("GET /api/v1/health → 200 免鉴权", async () => {
    const res = await handleGateway(req("GET", "/api/v1/health"), baseEnv, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.status).toBe("ok");
  });

  it("GET /api/v1/ → 200 免鉴权 service info", async () => {
    const res = await handleGateway(req("GET", "/api/v1/"), baseEnv, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.service).toBe("proxy-gateway");
  });

  it("GET /api/v1/unknown → 404 统一错误体", async () => {
    const res = await handleGateway(req("GET", "/api/v1/unknown"), baseEnv, {} as ExecutionContext);
    expect(res.status).toBe(404);
    const j: any = await res.json();
    expect(j.error.code).toBe("NOT_FOUND");
  });

  it("fetch without key → 401 UNAUTHORIZED", async () => {
    const res = await handleGateway(req("GET", "/api/v1/fetch/https://a.com"), baseEnv, {} as ExecutionContext);
    expect(res.status).toBe(401);
    const j: any = await res.json();
    expect(j.error.code).toBe("UNAUTHORIZED");
  });

  it("fetch bad target → 400 BAD_TARGET", async () => {
    const res = await handleGateway(
      req("GET", "/api/v1/fetch/garbage", { headers: { "X-API-Key": "k9" } }),
      baseEnv, {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error.code).toBe("BAD_TARGET");
  });

  it("fetch wrong method target-only paths (no url) → 400", async () => {
    const res = await handleGateway(
      req("GET", "/api/v1/fetch/", { headers: { "X-API-Key": "k9" } }),
      baseEnv, {} as ExecutionContext
    );
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(j.error.code).toBe("BAD_TARGET");
  });
});
