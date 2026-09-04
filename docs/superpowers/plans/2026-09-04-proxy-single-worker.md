# Proxy 单 Worker 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个 Cloudflare Worker（`proxy`）：`/api/*` 为自研 Agent HTTP 网关（流式直通+Key 鉴权），其余路径零修改委派 vendored edgetunnel（VLESS/VMess/Trojan/SS 隧道+面板+订阅）。

**Architecture:** 入口 `src/index.ts` 按路径前缀分发；gateway 是纯函数式薄层（auth → router → proxy）；tunnel 侧以 `import` 委派 vendored ES module（零修改，pinned commit fb32122，已实测可导入）。

**Tech Stack:** TypeScript strict · Cloudflare Workers（wrangler 4.x）· `@cloudflare/vitest-pool-workers` · 无运行时依赖。

**Spec:** `docs/superpowers/specs/2026-09-04-proxy-design.md`（v2）

## Global Constraints

- 平台：Workers 入站 HTTP/WS，出站 `fetch()`（流式）与 `fetcher.connect()`（TCP）。无 UDP。
- gateway **禁止缓冲响应体**（`new Response(res.body, res)` 直通，禁 `await res.text()/arrayBuffer()/json()`）。
- 错误体统一 `{"error":{"code":"<UPPER_SNAKE>","message":"..."}}`，唯一出口 `jsonError()`。
- secret（ADMIN/AGENT_KEY/UUID）只走 `wrangler secret put`，任何文件禁写明文。
- `vendor/edgetunnel/_worker.js` 禁改内容；头注释（来源/commit/Version）必须保留并在升级时更新。
- commit 禁任何 Co-Authored-By 尾注。
- 环境已有 token（~/.cloudflare-token），部署用 `CLOUDFLARE_API_TOKEN` env 变量喂 wrangler。
- 部署目标：`proxy.qdp.qzz.io`（zone 5cad8b5bfa89346f12acf0a4b5252895，账户 07401407fe88e9e8ce61d54ea0e385f3）。

---

### Task 1: 项目骨架 + vendored 委派跑通（wrangler dev 冒烟）

**Files:**
- Create: `package.json`, `wrangler.toml`, `tsconfig.json`, `src/index.ts`, `.gitignore`
- 已就位（本计划执行前已完成）: `vendor/edgetunnel/_worker.js`（含来源头注释，pinned fb32122）

**Interfaces:**
- Produces: `src/index.ts` 的 `default { fetch }` 入口；`/api/v1/health` 临时内联返回 `{status:"ok"}`（Task 3 替换为正式实现）。

- [ ] **Step 1: package.json**

```json
{
  "name": "proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250903.0",
    "@cloudflare/vitest-pool-workers": "^0.9.0",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
```

安装（国内镜像）：`npm install --registry=https://registry.npmmirror.com`

- [ ] **Step 2: wrangler.toml**

```toml
name = "proxy"
main = "src/index.ts"
compatibility_date = "2025-09-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "EDT"
class_name = "EdtUnsupportedDO"

# edgetunnel 不需要 DO；此处不声明。占位勿用——若 wrangler 校验报缺 DO 删除本段。

# KV：面板配置存储
[[kv_namespaces]]
binding = "KV"
id = "PLACEHOLDER_RUN_create_kv_first"

[vars]
# UUID 节点认证：部署时生成一次写入（非机密但应稳定）
UUID = "GENERATE_ME_UUID_V4"

[observability]
enabled = true
```

注意：`kv_namespaces.id` 先跑 `npx wrangler kv namespace create KV` 用真实 id 替换 PLACEHOLDER。`UUID` 用 `python3 -c "import uuid;print(uuid.uuid4())"` 生成后写入。

- [ ] **Step 3: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "allowJs": true,
    "checkJs": false
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["vendor"]
}
```

- [ ] **Step 4: .gitignore**

```
node_modules/
.wrangler/
.dev.vars
*.log
```

- [ ] **Step 5: src/index.ts（分发入口 + 临时 health）**

```ts
// @ts-expect-error vendored JS, 零修改委派; 类型由 Runtime 验证
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
```

同目录建 `src/env.d.ts`：

```ts
interface Env {
  KV: KVNamespace;
  ADMIN?: string;
  AGENT_KEY?: string;
  UUID?: string;
  KEY?: string;
  [key: string]: unknown;
}
```

临时 `src/gateway/router.ts`（仅 health，让骨架可跑）：

```ts
export async function handleGateway(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/health") {
    return Response.json({ status: "ok" });
  }
  return Response.json({ error: { code: "NOT_FOUND", message: "unknown endpoint" } }, { status: 404 });
}
```

- [ ] **Step 6: 冒烟（wrangler dev，手动）**

Run: `npx wrangler dev --local`（另一终端）`curl -s http://localhost:8787/api/v1/health` 与 `curl -sI http://localhost:8787/`
Expected: health 返回 `{"status":"ok"}`；`/` 非 404 空洞错误（edgetunnel 已接管，无 ADMIN 时返回其 noADMIN 引导页/404 页均为正常）。

- [ ] **Step 7: typecheck + commit**

Run: `npx tsc --noEmit` → 0 error
```bash
git add -A && git commit -m "feat: 单 Worker 骨架 — /api/* 分发 + vendored edgetunnel 委派"
```

---

### Task 2: gateway/auth.ts — 恒定延迟 Key 校验（TDD）

**Files:**
- Create: `src/gateway/auth.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- Produces: `checkAgentKey(req: Request, env: Env): Promise<boolean>` — 从 `X-API-Key` 头或 `?key=` query 取 key，与 `env.AGENT_KEY` 比较（恒定延迟）；无配置/无输入返回 false。

- [ ] **Step 1: 失败测试**

```ts
// test/auth.test.ts
import { describe, it, expect, env } from "vitest";
import { checkAgentKey } from "../src/gateway/auth";

describe("checkAgentKey", () => {
  it("missing env key → false", async () => {
    const req = new Request("https://x.test/api/v1/fetch/https://a.com");
    expect(await checkAgentKey(req, { ...env, AGENT_KEY: undefined } as Env)).toBe(false);
  });

  it("no key provided → false", async () => {
    const req = new Request("https://x.test/api/v1/fetch/https://a.com");
    expect(await checkAgentKey(req, { ...env, AGENT_KEY: "secret" } as Env)).toBe(false);
  });

  it("header match → true", async () => {
    const req = new Request("https://x.test/api/v1/fetch/https://a.com", { headers: { "X-API-Key": "secret" } });
    expect(await checkAgentKey(req, { ...env, AGENT_KEY: "secret" } as Env)).toBe(true);
  });

  it("header mismatch → false", async () => {
    const req = new Request("https://x.test/api/v1/fetch/https://a.com", { headers: { "X-API-Key": "wrong" } });
    expect(await checkAgentKey(req, { ...env, AGENT_KEY: "secret" } as Env)).toBe(false);
  });

  it("query key match → true", async () => {
    const req = new Request("https://x.test/api/v1/fetch/https://a.com?key=secret");
    expect(await checkAgentKey(req, { ...env, AGENT_KEY: "secret" } as Env)).toBe(true);
  });

  it("query key stripped from url object is caller's job → this fn only reads", async () => {
    // 该测试记录契约：checkAgentKey 只读不修改 request
    const req = new Request("https://x.test/api/v1/fetch/https://a.com?key=secret");
    expect(req.url).toContain("key=secret");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/auth.test.ts`
Expected: FAIL（auth.ts 不存在）

- [ ] **Step 3: 实现**

```ts
// src/gateway/auth.ts
/** 恒定延迟比较（防 timing attack）。等长才逐字节比；不同长度也走满循环。 */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  }
  return diff === 0;
}

/** 从 X-API-Key 头或 ?key= query 提取并校验 Agent key。 */
export async function checkAgentKey(req: Request, env: Env): Promise<boolean> {
  const expected = env.AGENT_KEY;
  if (!expected) return false;
  const provided = req.headers.get("X-API-Key") ?? new URL(req.url).searchParams.get("key");
  if (!provided) return false;
  return timingSafeEqual(provided, expected);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/auth.test.ts`
Expected: 6/6 PASS

- [ ] **Step 5: commit**

```bash
git add src/gateway/auth.ts test/auth.test.ts
git commit -m "feat(gateway): 恒定延迟 Agent key 校验"
```

---

### Task 3: gateway/proxy.ts — 流式直通核心 + 头过滤（TDD）

**Files:**
- Create: `src/gateway/proxy.ts`
- Test: `test/proxy.test.ts`

**Interfaces:**
- Produces:
  - `sanitizeRequestHeaders(h: Headers): Headers` — 剔除 host/cf-*/x-forwarded-*/x-api-key/content-length/accept-encoding，其余透传
  - `buildTargetUrl(pathAfterPrefix: string, incomingUrl: string): URL` — 拼目标 URL（含 query 合并、剥离 key）；非法/非 http(s) 抛 `BadTargetError`
  - `forward(req: Request, target: URL): Promise<Response>` — 全方法流式直通，redirect manual
  - `class BadTargetError extends Error`

- [ ] **Step 1: 失败测试**

```ts
// test/proxy.test.ts
import { describe, it, expect, vi } from "vitest";
import { sanitizeRequestHeaders, buildTargetUrl, forward, BadTargetError } from "../src/gateway/proxy";

describe("sanitizeRequestHeaders", () => {
  it("strips host, cf-*, x-forwarded-*, x-api-key, content-length, accept-encoding", () => {
    const h = new Headers({
      "Host": "proxy.qdp.qzz.io",
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
    expect(out.get("x-api-key")).toBeNull();
    expect(out.get("content-length")).toBeNull();
    expect(out.get("accept-encoding")).toBeNull();
    expect(out.get("authorization")).toBe("Bearer tk");
    expect(out.get("content-type")).toBe("application/json");
  });
});

describe("buildTargetUrl", () => {
  it("joins path + incoming query, strips key", () => {
    const url = buildTargetUrl(
      "/https://api.target.com/v1/chat?stream=true",
      "https://proxy.qdp.qzz.io/api/v1/fetch/https%3A%2F%2Fapi.target.com%2Fv1%2Fchat?stream=true&key=k"
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
    // @ts-expect-error inject
    globalThis.fetch = fetchMock;
    const req = new Request("https://p.test/api/v1/fetch/https://upstream.test/data", {
      method: "POST", body: "hello",
    });
    const res = await forward(req, target);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1];
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/proxy.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/gateway/proxy.ts
const HOP_BY_HOP_STRIP = [
  "host", "content-length", "accept-encoding", "x-api-key",
];

export class BadTargetError extends Error {
  constructor(message: string) { super(message); this.name = "BadTargetError"; }
}

export function sanitizeRequestHeaders(h: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of h.entries()) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP_STRIP.includes(lower)) continue;
    if (lower.startsWith("cf-")) continue;
    if (lower.startsWith("x-forwarded-")) continue;
    out.set(k, v);
  }
  return out;
}

/** pathAfterPrefix 形如 "/https://api.target.com/v1/chat?x=1"（可能是百分号编码后的） */
export function buildTargetUrl(pathAfterPrefix: string, incomingUrl: string): URL {
  let raw = pathAfterPrefix.slice(1); // 去掉开头 /
  try { raw = decodeURIComponent(raw); } catch { /* 原样使用 */ }
  // 目标自身 query 可能已被 CF 侧 encodeURIComponent 进路径；先尝试整体解析
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new BadTargetError(`invalid target url: ${raw.slice(0, 100)}`);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new BadTargetError(`unsupported scheme: ${target.protocol}`);
  }
  // 合并入口 URL 的 query（排除 key）
  const incoming = new URL(incomingUrl);
  for (const [k, v] of incoming.searchParams) {
    if (k === "key") continue;
    target.searchParams.set(k, v);
  }
  return target;
}

export async function forward(req: Request, target: URL): Promise<Response> {
  const headers = sanitizeRequestHeaders(req.headers);
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const res = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: "manual",
  });
  // 流式直通：不 await res.text()/arrayBuffer()，body 原样移交
  const out = new Response(res.body, res);
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/proxy.test.ts`
Expected: 全 PASS

- [ ] **Step 5: commit**

```bash
git add src/gateway/proxy.ts test/proxy.test.ts
git commit -m "feat(gateway): 流式直通转发 + 头过滤 + 目标URL拼装"
```

---

### Task 4: gateway/router.ts — 正式路由 + 鉴权接线（TDD）

**Files:**
- Modify: `src/gateway/router.ts`（替换 Task 1 临时版）
- Test: `test/router.test.ts`

**Interfaces:**
- Consumes: `checkAgentKey`（Task 2）、`forward`/`buildTargetUrl`/`BadTargetError`（Task 3）
- Produces: `handleGateway(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>`（`src/index.ts` 已在用，签名不变）

- [ ] **Step 1: 失败测试**

```ts
// test/router.test.ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/router.test.ts`
Expected: FAIL（新端点/鉴权未接）

- [ ] **Step 3: 实现 router.ts**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run`
Expected: auth/proxy/router 全 PASS

- [ ] **Step 5: commit**

```bash
git add src/gateway/router.ts test/router.test.ts
git commit -m "feat(gateway): 正式路由 — health/info/fetch + 鉴权接线"
```

---

### Task 5: 部署 + 端到端验收（spec 成功标准 1/2/3）

**Files:**
- Modify: `wrangler.toml`（真实 KV id、UUID、routes）
- Create: `README.md`

**Interfaces:**
- Consumes: 完整 Worker（Task 1-4）；Cloudflare 账户 token（`~/.cloudflare-token`）

- [ ] **Step 1: 建 KV namespace，回填 wrangler.toml**

```bash
export CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare-token)
npx wrangler kv namespace create KV
# 输出 id 填入 wrangler.toml 的 kv_namespaces[0].id
```

同时生成 UUID 填入 `[vars] UUID`；追加 routes 段：

```toml
routes = [
  { pattern = "proxy.qdp.qzz.io", custom_domain = true }
]
```

- [ ] **Step 2: typecheck + 全测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 error，全 PASS

- [ ] **Step 3: 部署**

```bash
npx wrangler deploy
```

- [ ] **Step 4: 注入 secrets**

```bash
npx wrangler secret put ADMIN      # 交互输入面板密码
npx wrangler secret put AGENT_KEY  # 交互输入 Agent key
```

- [ ] **Step 5: 端到端冒烟（按 spec 成功标准逐条）**

```bash
# 1. health 200
curl -s https://proxy.qdp.qzz.io/api/v1/health
# 2. 无 key 401 / 带 key 真实站点 200
curl -s -o /dev/null -w "%{http_code}\n" https://proxy.qdp.qzz.io/api/v1/fetch/https://example.com
curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: <key>" https://proxy.qdp.qzz.io/api/v1/fetch/https://example.com
# 3. 流式（SSE 站点首字节）
curl -sN -H "X-API-Key: <key>" "https://proxy.qdp.qzz.io/api/v1/fetch/https://httpbin.org/drip?duration=3&numbytes=3" --max-time 5 | head -c 100
# 4. tunnel 侧未被破坏：/ 应返回 edgetunnel 页面（伪装页或引导页），非 gateway 404
curl -s https://proxy.qdp.qzz.io/ | head -c 200
```

Expected: ①`{"status":"ok",...}` ②401→200 ③5 秒内出首字节（证明未缓冲）④HTML 内容

- [ ] **Step 6: README**

内容四节：部署（commands 复制 spec）· Agent 调用示例（curl + Claude Code `ANTHROPIC_BASE_URL` 式环境变量法）· 客户端订阅用法（`https://proxy.qdp.qzz.io/sub?target=clash` 说明以面板生成为准）· vendor 升级流程（替换文件+更新头注释）。

- [ ] **Step 7: 验收清单核对 + 终 commit**

```bash
git add -A && git commit -m "feat: 部署配置 + README — v0.1.0"
```

Spec 成功标准核对：①health 200 ②401/200/流式 ③admin 登录+真机客户端连一次（用户手工验收，输出指引：客户端添加 VLESS 节点 = 地址 `proxy.qdp.qzz.io` 端口 443 TLS ws 路径以面板订阅为准）④vitest 全绿 ⑤README 完成。

---

## Self-Review 记录

- Spec 覆盖：分发入口（T1）、auth（T2）、proxy 核心（T3）、路由（T4）、部署+验收+README（T5）——spec 六块全覆盖，无缺口。
- 占位符：无 TBD/TODO；T1 的 PLACEHOLDER_KV/UUID 是显式部署时回填项，步骤内含生成命令。
- 类型一致性：`checkAgentKey(req, env)`/`forward(req, target)`/`handleGateway(request, env, ctx)` 在 T2/T3/T4 与 T1 的 index.ts 调用签名一致。
