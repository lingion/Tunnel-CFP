import { describe, it, expect, vi } from "vitest";
import { sanitizeRequestHeaders, buildTargetUrl, forward, BadTargetError } from "../src/gateway/proxy";

describe("sanitizeRequestHeaders", () => {
  it("strips host, cf-*, x-forwarded-*, content-length, accept-encoding; passes x-api-key through (upstream credential)", () => {
    const h = new Headers({
      "Host": "proxy.example.com",
      "CF-Connecting-IP": "1.2.3.4",
      "X-Forwarded-For": "1.2.3.4",
      "X-Api-Key": "secret",
      "Content-Length": "5",
      "Accept-Encoding": "gzip",
      "Authorization": "Bearer tk",
      "Content-Type": "application/json",
    });
    const out = sanitizeRequestHeaders(h);
    expect(out.get("host")).toBeNull();
    expect(out.get("cf-connecting-ip")).toBeNull();
    expect(out.get("x-forwarded-for")).toBeNull();
    expect(out.get("x-api-key")).toBe("secret"); // 上游 API 凭据透传项，不再剔除
    expect(out.get("content-length")).toBeNull();
    expect(out.get("accept-encoding")).toBeNull();
    expect(out.get("authorization")).toBe("Bearer tk");
    expect(out.get("content-type")).toBe("application/json");
  });

  it("redacts headers whose value equals an entry in redactValues (gateway key leak guard)", () => {
    const h = new Headers({
      "X-Api-Key": "gwkey",
      "Authorization": "Bearer up",
    });
    const out = sanitizeRequestHeaders(h, ["gwkey"]);
    expect(out.get("x-api-key")).toBeNull(); // 网关鉴权值 → 值级擦除
    expect(out.get("authorization")).toBe("Bearer up"); // 真正的上游凭据照传
  });

  it("ignores empty strings in redactValues (no accidental header drops)", () => {
    const h = new Headers({
      "X-Api-Key": "upstream-key",
      "Authorization": "Bearer up",
    });
    const out = sanitizeRequestHeaders(h, [""]);
    expect(out.get("x-api-key")).toBe("upstream-key");
    expect(out.get("authorization")).toBe("Bearer up");
  });

  it("behaves as before when redactValues omitted (default = no redaction)", () => {
    const h = new Headers({
      "X-Api-Key": "secret",
      "Authorization": "Bearer tk",
    });
    const out = sanitizeRequestHeaders(h);
    expect(out.get("x-api-key")).toBe("secret");
    expect(out.get("authorization")).toBe("Bearer tk");
  });
});

describe("buildTargetUrl", () => {
  it("joins path + incoming query, strips key", () => {
    const url = buildTargetUrl(
      "/https://api.target.com/v1/chat?stream=true",
      "https://proxy.example.com/api/v1/fetch/https%3A%2F%2Fapi.target.com%2Fv1%2Fchat?stream=true&key=k"
    );
    expect(url.toString()).toBe("https://api.target.com/v1/chat?stream=true");
  });

  it("passes through plain-encoded target", () => {
    const url = buildTargetUrl("/https://example.com/a", "https://p.test/api/v1/fetch/https://example.com/a");
    expect(url.toString()).toBe("https://example.com/a");
  });

  it("rejects non-http scheme", () => {
    expect(() => buildTargetUrl("/ftp://x.com", "https://p.test/api/v1/fetch/ftp://x.com")).toThrow(BadTargetError);
  });

  it("rejects garbage", () => {
    expect(() => buildTargetUrl("/not a url", "https://p.test/api/v1/fetch/not a url")).toThrow(BadTargetError);
  });
});

describe("forward", () => {
  it("streams body through without buffering, manual redirect", async () => {
    const target = new URL("https://upstream.test/data");
    const upstreamBody = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("chunk1")); c.close(); },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    // inject（workers-types 下该赋值本就不报错，brief 的 @ts-expect-error 指令未生效，tsc TS2578，故移除）
    globalThis.fetch = fetchMock;
    const req = new Request("https://p.test/api/v1/fetch/https://upstream.test/data", {
      method: "POST", body: "hello",
    });
    const res = await forward(req, target);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]![1]; // noUncheckedIndexedAccess 需非空断言
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBeTruthy(); // request.body 直传，非字符串化
    // 响应体未消费 → 仍可读 = 未缓冲
    expect(res.body).toBeInstanceOf(ReadableStream);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("chunk1");
  });
});
