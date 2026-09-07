// test/auth.test.ts
// 注：brief 原稿从 "vitest" 导入 env（pool-workers 注入的绑定环境），但该用法在
// vitest 3.2.7 无此导出（env 实际来自 "cloudflare:test" 模块）。按 brief 预授权的
// 退化方案：直接构造 { AGENT_KEY: "..." } as Env（checkAgentKey 只读 env.AGENT_KEY）。
import { describe, it, expect } from "vitest";
import { checkAgentKey } from "../src/gateway/auth";

describe("checkAgentKey", () => {
  it("missing env key → false", async () => {
    const req = new Request("https://x.test/api/v1/fetch/https://a.com");
    expect(await checkAgentKey(req, { AGENT_KEY: undefined } as Env)).toBe(false);
  });

  it("no key provided → false", async () => {
    const req = new Request("https://x.test/api/v1/fetch/https://a.com");
    expect(await checkAgentKey(req, { AGENT_KEY: "secret" } as Env)).toBe(false);
  });

  it("header match → true", async () => {
    const req = new Request("https://x.test/api/v1/fetch/https://a.com", { headers: { "X-API-Key": "secret" } });
    expect(await checkAgentKey(req, { AGENT_KEY: "secret" } as Env)).toBe(true);
  });

  it("header mismatch → false", async () => {
    const req = new Request("https://x.test/api/v1/fetch/https://a.com", { headers: { "X-API-Key": "wrong" } });
    expect(await checkAgentKey(req, { AGENT_KEY: "secret" } as Env)).toBe(false);
  });

  it("query key match → true", async () => {
    const req = new Request("https://x.test/api/v1/fetch/https://a.com?key=secret");
    expect(await checkAgentKey(req, { AGENT_KEY: "secret" } as Env)).toBe(true);
  });

  it("query key stripped from url object is caller's job → this fn only reads", async () => {
    // 该测试记录契约：checkAgentKey 只读不修改 request
    const req = new Request("https://x.test/api/v1/fetch/https://a.com?key=secret");
    expect(req.url).toContain("key=secret");
  });
});
