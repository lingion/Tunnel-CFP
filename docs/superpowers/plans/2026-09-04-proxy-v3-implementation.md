# cfp Worker v3 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: 在新 CF Worker `cfp`（cfp.lingion04.workers.dev）上交付 spec v3 三大功能：vendor 双轨（edgetunnel + yonggekkk）+ DoH 双栈 + Web Proxy W3。

**Architecture**: 单一 CF Worker，单一 git repo（vendor 完全脱钩 upstream），TS 路由 + vendored JS 双 worker 模块。订阅合并输出 32 节点。DoH 走 Worker Cache 30s。Web Proxy 用 HTMLRewriter 引擎重写所有资源引用。

**Tech Stack**: TypeScript + @cloudflare/workers-types + HTMLRewriter + dns-packet + vitest + @cloudflare/vitest-pool-workers + webcrack（一次性 deob）

## Global Constraints

- Vendor 完全脱钩：clone 后删 `.git/`，首次 commit 标注来源（commit message 而非文件），不留任何 FORKED_FROM.md
- 部署目标：wrangler deploy -c wrangler.cfp.toml（worker name = `cfp`）
- cfp worker 独立 UUID = `b88ab8fa-392c-44b3-9343-612c11814708`
- cfp worker 独立 KV = `e724e1591a33423ea603114a42f65984` (binding `cfp_KV`)
- 路径：`/api/*` → gateway · `/dns-query` `/resolve` → DoH · `/proxy/*` → Web Proxy · `/sub/*` → Subscription · 其他 → vendor tunnel
- 测试：每个新模块先 vitest 全绿才能 commit
- 部署后真实 `cfp.lingion04.workers.dev` 端到端验证
- Secrets 通过 `wrangler secret put` 写入，**不写入 wrangler.toml**
- npm 加依赖必须 `--registry=https://registry.npmmirror.com`

---

## Task 1: yonggekkk vendor 初始化 + deobfuscate

**Files**:
- Create: `vendor/yonggekkk/_worker.js`（deob 后的可读版）
- Create: `vendor/yonggekkk/PATCHES.md`
- Create: `vendor/yonggekkk/README.md`
- Create: `vendor/yonggekkk/CHANGELOG.md`

**Interfaces**:
- Consumes: 无（首次初始化）
- Produces: 可读可改的 yonggekkk vendor JS 文件

- [ ] **Step 1: clone yonggekkk 到临时目录**

```bash
cd /Users/lingion_k/proxy-v3
git clone --depth 1 https://github.com/yonggekkk/Cloudflare-vless-trojan.git vendor/yonggekkk-tmp
```

- [ ] **Step 2: 提取 VLESS worker 主文件，删除 .git**

```bash
mkdir -p vendor/yonggekkk
cp vendor/yonggekkk-tmp/Vless_workers_pages/_worker.js vendor/yonggekkk/_worker.js
rm -rf vendor/yonggekkk-tmp
```

- [ ] **Step 3: 安装 webcrack 进行 deobfuscate**

```bash
npm install --registry=https://registry.npmmirror.com --save-dev webcrack
```

- [ ] **Step 4: 自动 deobfuscate**

```bash
cd vendor/yonggekkk
npx webcrack _worker.js -o _worker.deob.js 2>&1 | tail -20
```

- [ ] **Step 5: 手工重命名 + 整理**

打开 `_worker.deob.js`，找到主要入口函数和协议处理函数，重命名为可读名（`a0G` → `decode`, `a0cl` → `init` 等）。保存为 `_worker.js`（覆盖原文件）。

- [ ] **Step 6: 单元测试：混淆版 vs deob 版输出一致**

写一个简单测试，跑同一组请求（mock fetch），对比两个版本的输出。只在协议握手层面对比，不对比 anti-debug 输出。

- [ ] **Step 7: 写 vendor 自己的 README + CHANGELOG + PATCHES**

```bash
cd /Users/lingion_k/proxy-v3
cat > vendor/yonggekkk/README.md << 'EOF'
# yonggekkk vendor

我们的 VLESS / Reality / Trojan / Shadowsocks Worker 实现。

支持协议：VLESS over WebSocket + TLS，Trojan over WebSocket + TLS，Shadowsocks。
可选 ECH (Encrypted Client Hello) + uTLS fingerprint。

代码来源：yonggekkk/Cloudflare-vless-trojan（首次 commit）。
EOF

cat > vendor/yonggekkk/CHANGELOG.md << 'EOF'
# v0.1.0 (2026-09-04)
- 首次 commit：来自 yonggekkk/Cloudflare-vless-trojan 一次性 clone
- 完成 obfuscated → deobfuscated 重构
EOF

cat > vendor/yonggekkk/PATCHES.md << 'EOF'
# 我们对 yonggekkk vendor 的补丁

- v0.1.0：deobfuscate + 手工重命名（首次 commit）
EOF
```

- [ ] **Step 8: 首次 commit**

```bash
cd /Users/lingion_k/proxy-v3
git add vendor/yonggekkk/ package.json package-lock.json
git -c user.name="lingion" -c user.email="lingion04@gmail.com" commit -m "feat(vendor): import yonggekkk vendor (deobfuscated)"
```

---

## Task 2: edgetunnel vendor 现状 + FORKED_FROM 痕迹确认

**Files**:
- Verify: `vendor/edgetunnel/_worker.js` 已经是当前 vendor
- Verify: 无 FORKED_FROM.md / 来源记录文件
- Create: `vendor/edgetunnel/README.md`, `CHANGELOG.md`, `PATCHES.md`（如果没有）

**Interfaces**:
- Consumes: 现有 fb32122 + b3d1fb3 命名补丁
- Produces: 补齐 vendor 的元文件

- [ ] **Step 1: 检查现有 vendor**

```bash
cd /Users/lingion_k/proxy-v3
ls vendor/edgetunnel/
```

期望：`_worker.js` 存在，无 FORKED_FROM.md。

- [ ] **Step 2: 写 edgetunnel README/CHANGELOG/PATCHES（如果没有）**

```bash
cat > vendor/edgetunnel/README.md << 'EOF'
# edgetunnel vendor

我们的 VLESS / Trojan / Shadowsocks Worker 实现（中文混淆版）。

支持协议：VLESS over WebSocket + TLS（带 gRPC transport 选项），Trojan，Shadowsocks。
可选 ECH (Encrypted Client Hello) + uTLS fingerprint + 链式代理。

代码来源：cmliu/edgetunnel @ fb32122（首次 commit）。
EOF

cat > vendor/edgetunnel/CHANGELOG.md << 'EOF'
# v0.1.0 (2026-08-11)
- 首次 commit：来自 cmliu/edgetunnel @ fb32122
- 应用补丁 b3d1fb3：节点命名带 request.cf 国家码 + ASN
EOF

cat > vendor/edgetunnel/PATCHES.md << 'EOF'
# 我们对 edgetunnel vendor 的补丁

- b3d1fb3 (2026-08-11): 节点命名带 request.cf 国家码 + ASN
EOF
```

- [ ] **Step 3: 确认 b3d1fb3 命名补丁仍在 _worker.js 中**

```bash
grep -n "cfnameGeo\|cf.country\|cf.asn" vendor/edgetunnel/_worker.js | head -5
```

期望：能找到 cfnameGeo 等关键字。

- [ ] **Step 4: 提交 vendor 元文件**

```bash
cd /Users/lingion_k/proxy-v3
git add vendor/edgetunnel/
git -c user.name="lingion" -c user.email="lingion04@gmail.com" commit -m "docs(vendor): edgetunnel 元文件（README/CHANGELOG/PATCHES）"
```

---

## Task 3: src/index.ts 路由分流（双 vendor + DoH + Web Proxy）

**Files**:
- Modify: `src/index.ts`
- Create: `src/doh/handler.ts`（先 stub）
- Create: `src/proxy-web/handler.ts`（先 stub）
- Create: `src/subscription/handler.ts`（先 stub）

**Interfaces**:
- Consumes: edgetunnel.fetch, yonggekkk.fetch, handleGateway (已有)
- Produces: src/index.ts 默认导出，路由按路径分流

- [ ] **Step 1: 写失败测试 - src/index.ts 路由分流**

新建 `test/router-v3.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index';

const env = {
  cfp_KV: {} as any,
  ADMIN: 'test',
  UUID: '00000000-0000-4000-8000-000000000000',
};

describe('v3 router', () => {
  it('routes /api/* to gateway', async () => {
    const req = new Request('https://cfp.lingion04.workers.dev/api/v1/health');
    const res = await worker.fetch(req, env as any, {} as any);
    expect(res.status).not.toBe(404);
  });

  it('routes /dns-query to DoH handler', async () => {
    const req = new Request('https://cfp.lingion04.workers.dev/dns-query');
    const res = await worker.fetch(req, env as any, {} as any);
    // 即使是 stub，也应该返回 405 或 400，不是 404
    expect(res.status).not.toBe(404);
  });

  it('routes /resolve to DoH handler', async () => {
    const req = new Request('https://cfp.lingion04.workers.dev/resolve?name=example.com');
    const res = await worker.fetch(req, env as any, {} as any);
    expect(res.status).not.toBe(404);
  });

  it('routes /proxy/* to Web Proxy handler', async () => {
    const req = new Request('https://cfp.lingion04.workers.dev/proxy/https://example.com');
    const res = await worker.fetch(req, env as any, {} as any);
    expect(res.status).not.toBe(404);
  });

  it('routes /sub/* to Subscription handler', async () => {
    const req = new Request('https://cfp.lingion04.workers.dev/sub/all');
    const res = await worker.fetch(req, env as any, {} as any);
    expect(res.status).not.toBe(404);
  });

  it('falls back to edgetunnel for other paths', async () => {
    const req = new Request('https://cfp.lingion04.workers.dev/random-path');
    const res = await worker.fetch(req, env as any, {} as any);
    // 不应该 404，至少落到 edgetunnel 兜底
    expect(res.status).toBeGreaterThanOrEqual(200);
  });
});
```

- [ ] **Step 2: 跑测试，验证全挂**

```bash
cd /Users/lingion_k/proxy-v3
NODE_OPTIONS="--max-old-space-size=8192" npx vitest run test/router-v3.test.ts 2>&1 | tail -15
```

期望：6 个测试全挂（404 / 500）。

- [ ] **Step 3: 创建 DoH / Web Proxy / Subscription handler stub**

```bash
mkdir -p src/doh src/proxy-web src/subscription
```

```typescript
// src/doh/handler.ts
export async function handleDoh(request: Request): Promise<Response> {
  return new Response('DoH stub', { status: 501 });
}
```

```typescript
// src/proxy-web/handler.ts
export async function handleWebProxy(request: Request): Promise<Response> {
  return new Response('Web Proxy stub', { status: 501 });
}
```

```typescript
// src/subscription/handler.ts
export async function handleSubscription(request: Request): Promise<Response> {
  return new Response('Subscription stub', { status: 501 });
}
```

- [ ] **Step 4: 改造 src/index.ts 路由分流**

```typescript
import edgetunnel from "../vendor/edgetunnel/_worker.js";
import yonggekkk from "../vendor/yonggekkk/_worker.js";
import { handleGateway } from "./gateway/router";
import { handleDoh } from "./doh/handler";
import { handleWebProxy } from "./proxy-web/handler";
import { handleSubscription } from "./subscription/handler";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. Agent API (v2 已有)
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleGateway(request, env, ctx);
    }

    // 2. DoH
    if (url.pathname === "/dns-query" || url.pathname === "/resolve") {
      return handleDoh(request);
    }

    // 3. Web Proxy
    if (url.pathname.startsWith("/proxy/")) {
      return handleWebProxy(request);
    }

    // 4. Subscription
    if (url.pathname.startsWith("/sub/")) {
      return handleSubscription(request);
    }

    // 5. Fallback: edgetunnel
    return edgetunnel.fetch(request, env, ctx);
  },
};
```

- [ ] **Step 5: 跑测试，全部通过**

```bash
cd /Users/lingion_k/proxy-v3
NODE_OPTIONS="--max-old-space-size=8192" npx vitest run test/router-v3.test.ts 2>&1 | tail -15
```

期望：6 个测试全过。

- [ ] **Step 6: 跑全部测试，确认 v2 测试还绿**

```bash
NODE_OPTIONS="--max-old-space-size=8192" npx vitest run 2>&1 | tail -10
```

期望：21 个 v2 测试 + 6 个新测试 = 27 个全绿。

- [ ] **Step 7: commit**

```bash
cd /Users/lingion_k/proxy-v3
git add src/index.ts src/doh/ src/proxy-web/ src/subscription/ test/router-v3.test.ts
git -c user.name="lingion" -c user.email="lingion04@gmail.com" commit -m "feat(router): v3 路由分流（DoH/Web Proxy/Subscription）"
```

---

## Task 4: Subscription 合并（双 vendor 32 节点）

**Files**:
- Create: `src/subscription/handler.ts`（实装）
- Create: `src/subscription/merge.ts`
- Create: `src/subscription/types.ts`
- Create: `test/subscription/merge.test.ts`

**Interfaces**:
- Consumes: edgetunnel YAML 生成（来自 vendor edgetunnel 的 fetch），yonggekkk YAML 生成（来自 vendor yonggekkk 的 fetch）
- Produces: 合并后的 Clash YAML，32 节点

- [ ] **Step 1: 写失败测试 - merge YAML**

新建 `test/subscription/merge.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { mergeYaml } from '../../src/subscription/merge';

describe('merge subscription YAML', () => {
  it('combines two YAMLs preserving proxies and proxy-groups', () => {
    const yamlA = `
proxies:
  - {name: "a1", server: s1, port: 443, type: vless}
proxy-groups:
  - name: "G1", type: select, proxies: [a1]
`;
    const yamlB = `
proxies:
  - {name: "b1", server: s2, port: 443, type: trojan}
proxy-groups:
  - name: "G1", type: select, proxies: [b1]
`;
    const merged = mergeYaml([yamlA, yamlB]);
    expect(merged).toContain('a1');
    expect(merged).toContain('b1');
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

- [ ] **Step 3: 实现 mergeYaml**

用简单的字符串拼接 + YAML 结构识别。或者用 `js-yaml` npm 包 parse + 合并 + 序列化：

```bash
npm install --registry=https://registry.npmmirror.com js-yaml
npm install --registry=https://registry.npmmirror.com --save-dev @types/js-yaml
```

```typescript
// src/subscription/merge.ts
import yaml from 'js-yaml';

export function mergeYaml(yamls: string[]): string {
  const merged: any = { proxies: [], 'proxy-groups': [], rules: [] };

  for (const y of yamls) {
    const parsed: any = yaml.load(y) || {};
    if (parsed.proxies) merged.proxies.push(...parsed.proxies);
    if (parsed['proxy-groups']) {
      // 合并同名 proxy-group，扩展 proxies 列表
      for (const pg of parsed['proxy-groups']) {
        const existing = merged['proxy-groups'].find((g: any) => g.name === pg.name);
        if (existing) {
          existing.proxies = Array.from(new Set([...existing.proxies, ...pg.proxies]));
        } else {
          merged['proxy-groups'].push({ ...pg });
        }
      }
    }
    if (parsed.rules) merged.rules.push(...parsed.rules);
  }

  return yaml.dump(merged, { lineWidth: -1 });
}
```

- [ ] **Step 4: 跑测试通过**

- [ ] **Step 5: 实装 handleSubscription**

```typescript
// src/subscription/handler.ts
import { mergeYaml } from './merge';

export async function handleSubscription(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname; // /sub/edgetunnel | /sub/yonggekkk | /sub/all

  // 简化：直接 import vendor fetch
  const edgetunnel = (await import('../../vendor/edgetunnel/_worker.js')).default;
  const yonggekkk = (await import('../../vendor/yonggekkk/_worker.js')).default;

  // 构造请求让 vendor 生成 YAML（依赖 vendor 暴露 /<UUID> 或 /sub 路径）
  // 具体路径要看 vendor 实现
  const edgetunnelYaml = await getVendorYaml(edgetunnel, request, env, 'edgetunnel');
  const yonggekkkYaml = await getVendorYaml(yonggekkk, request, env, 'yonggekkk');

  if (path === '/sub/edgetunnel') {
    return new Response(edgetunnelYaml, {
      headers: { 'Content-Type': 'text/yaml; charset=utf-8' },
    });
  }
  if (path === '/sub/yonggekkk') {
    return new Response(yonggekkkYaml, {
      headers: { 'Content-Type': 'text/yaml; charset=utf-8' },
    });
  }
  if (path === '/sub/all') {
    const merged = mergeYaml([edgetunnelYaml, yonggekkkYaml]);
    return new Response(merged, {
      headers: { 'Content-Type': 'text/yaml; charset=utf-8' },
    });
  }

  return new Response('Not Found', { status: 404 });
}

async function getVendorYaml(
  vendor: any,
  request: Request,
  env: Env,
  name: string
): Promise<string> {
  // vendor 暴露的订阅路径通常在根路径或 /UUID，需要根据实际 vendor 实现调整
  const subReq = new Request(request.url.replace(/\/sub\/.*/, '/sub'), request);
  const res = await vendor.fetch(subReq, env, {} as any);
  if (!res.ok) {
    throw new Error(`Vendor ${name} returned ${res.status}`);
  }
  return await res.text();
}
```

注：vendor 的订阅路径可能不是 `/sub` 而是 `<UUID>` 或 `/CMLiussss`，需要看实际 vendor 实现调整。

- [ ] **Step 6: 端到端测试**

写一个集成测试，mock 两个 vendor fetch 返回固定 YAML，验证 `/sub/all` 输出合并结果。

- [ ] **Step 7: commit**

```bash
git add src/subscription/ test/subscription/
git -c user.name="lingion" -c user.email="lingion04@gmail.com" commit -m "feat(subscription): 双 vendor YAML 合并输出"
```

---

## Task 5: DoH 双栈端点

**Files**:
- Modify: `src/doh/handler.ts`
- Create: `src/doh/rfc8484.ts`
- Create: `src/doh/json-api.ts`
- Create: `src/doh/cache.ts`
- Create: `src/doh/types.ts`
- Create: `test/doh/handler.test.ts`

**Interfaces**:
- Consumes: Worker Cache API, `dns-packet` npm 包
- Produces: `/dns-query` 接受 binary DNS，返回 binary DNS；`/resolve` 接受 query，返回 JSON

- [ ] **Step 1: 安装 dns-packet**

```bash
npm install --registry=https://registry.npmmirror.com dns-packet
npm install --registry=https://registry.npmmirror.com --save-dev @types/dns-packet
```

- [ ] **Step 2: 写失败测试 - JSON /resolve**

```typescript
// test/doh/handler.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('DoH /resolve', () => {
  it('returns JSON for A record query', async () => {
    const { handleJsonApi } = await import('../../src/doh/json-api');
    const req = new Request('https://cfp.lingion04.workers.dev/resolve?name=example.com&type=A');
    const res = await handleJsonApi(req);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body: any = await res.json();
    expect(body.Answer).toBeDefined();
  });

  it('rejects missing name param', async () => {
    const { handleJsonApi } = await import('../../src/doh/json-api');
    const req = new Request('https://cfp.lingion04.workers.dev/resolve');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(400);
  });
});

describe('DoH /dns-query', () => {
  it('accepts POST application/dns-message and returns binary response', async () => {
    const { handleRfc8484 } = await import('../../src/doh/rfc8484');
    const queryPacket = new Uint8Array([/* minimal DNS query for example.com A */]);
    const req = new Request('https://cfp.lingion04.workers.dev/dns-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message' },
      body: queryPacket,
    });
    const res = await handleRfc8484(req);
    expect(res.headers.get('Content-Type')).toBe('application/dns-message');
  });

  it('accepts GET with dns=base64url parameter', async () => {
    // ...
  });
});
```

- [ ] **Step 3: 跑测试验证失败**

- [ ] **Step 4: 实现 handleJsonApi**

```typescript
// src/doh/json-api.ts
import { encode, decode, Packet } from 'dns-packet';

export async function handleJsonApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const name = url.searchParams.get('name');
  const type = (url.searchParams.get('type') || 'A').toUpperCase();

  if (!name) {
    return new Response(JSON.stringify({ error: 'missing name param' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const typeMap: Record<string, string> = {
    A: 'A', AAAA: 'AAAA', CNAME: 'CNAME', MX: 'MX', TXT: 'TXT', NS: 'NS',
  };
  const qtype = typeMap[type] || 'A';

  const query = encode({
    id: Math.floor(Math.random() * 65535),
    type: 'query',
    flags: 0x0100, // RD
    questions: [{ type: qtype, name, class: 'IN' }],
  });

  // Cache check
  const cacheKey = `https://cfp.lingion04.workers.dev/dns-query`;
  const cache = caches.default;
  const cached = await cache.match(new Request(cacheKey, {
    method: 'POST',
    body: query as any,
  }));
  if (cached) return cached;

  const upstream = await fetch('https://cloudflare-dns.com/dns-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/dns-message' },
    body: query,
  });

  if (!upstream.ok) {
    return new Response('Upstream DoH error', { status: 502 });
  }

  const responsePacket = new Uint8Array(await upstream.arrayBuffer());
  const decoded: Packet = decode(responsePacket);

  // 缓存
  const jsonRes = new Response(JSON.stringify(decoded), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=30',
    },
  });
  ctx?.waitUntil(cache.put(/* ... */));
  return jsonRes;
}
```

- [ ] **Step 5: 实现 handleRfc8484**

类似但直接转发 binary。

- [ ] **Step 6: 实现 Cache**

用 Worker Cache API，key = DNS query 的 hex。

- [ ] **Step 7: 实现 handleDoh 顶层分发**

```typescript
// src/doh/handler.ts
import { handleRfc8484 } from './rfc8484';
import { handleJsonApi } from './json-api';

export async function handleDoh(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/dns-query') return handleRfc8484(request);
  if (url.pathname === '/resolve') return handleJsonApi(request);
  return new Response('Not Found', { status: 404 });
}
```

- [ ] **Step 8: 跑测试通过**

- [ ] **Step 9: commit**

```bash
git add src/doh/ test/doh/ package.json package-lock.json
git -c user.name="lingion" -c user.email="lingion04@gmail.com" commit -m "feat(doh): DoH 双栈端点（RFC 8484 + JSON）"
```

---

## Task 6: Web Proxy W3 完整 HTML 重写

**Files**:
- Modify: `src/proxy-web/handler.ts`
- Create: `src/proxy-web/rewriter.ts`
- Create: `src/proxy-web/url-resolver.ts`
- Create: `src/proxy-web/security.ts`
- Create: `src/proxy-web/types.ts`
- Create: `test/proxy-web/url-resolver.test.ts`
- Create: `test/proxy-web/security.test.ts`

**Interfaces**:
- Consumes: CF 原生 HTMLRewriter, Worker fetch()
- Produces: `/proxy/<url>` 完整 HTML 重写响应

- [ ] **Step 1: 写失败测试 - URL 重写规则**

```typescript
// test/proxy-web/url-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { rewriteUrl } from '../../src/proxy-web/url-resolver';

const ctx = { currentOrigin: 'https://example.com' };

describe('rewriteUrl', () => {
  it('rewrites absolute http(s) URL', () => {
    expect(rewriteUrl('https://other.com/foo', ctx)).toBe('/proxy/https://other.com/foo');
  });
  it('rewrites protocol-relative URL', () => {
    expect(rewriteUrl('//cdn.com/x.css', ctx)).toBe('/proxy/https://cdn.com/x.css');
  });
  it('rewrites relative path', () => {
    expect(rewriteUrl('/about.html', ctx)).toBe('/proxy/https://example.com/about.html');
  });
  it('preserves data: URI', () => {
    expect(rewriteUrl('data:image/png;base64,xxx', ctx)).toBe('data:image/png;base64,xxx');
  });
  it('preserves javascript: URI', () => {
    expect(rewriteUrl('javascript:void(0)', ctx)).toBe('javascript:void(0)');
  });
  it('preserves anchor link', () => {
    expect(rewriteUrl('#section1', ctx)).toBe('#section1');
  });
  it('rewrites mailto as-is', () => {
    expect(rewriteUrl('mailto:x@y.com', ctx)).toBe('mailto:x@y.com');
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

- [ ] **Step 3: 实现 rewriteUrl**

```typescript
// src/proxy-web/url-resolver.ts
export interface RewriteContext {
  currentOrigin: string;
}

export function rewriteUrl(original: string, ctx: RewriteContext): string {
  if (!original) return original;
  // 不动的
  if (original.startsWith('data:') ||
      original.startsWith('javascript:') ||
      original.startsWith('#') ||
      original.startsWith('mailto:') ||
      original.startsWith('tel:')) {
    return original;
  }
  // protocol-relative
  if (original.startsWith('//')) {
    return `/proxy/https:${original}`;
  }
  // 绝对 http(s)
  if (/^https?:\/\//.test(original)) {
    return `/proxy/${original}`;
  }
  // 相对路径
  return `/proxy/${ctx.currentOrigin}${original.startsWith('/') ? '' : '/'}${original}`;
}
```

- [ ] **Step 4: 跑测试通过**

- [ ] **Step 5: 写失败测试 - security 递归防护**

```typescript
// test/proxy-web/security.test.ts
import { describe, it, expect } from 'vitest';
import { validateTargetUrl } from '../../src/proxy-web/security';

describe('validateTargetUrl', () => {
  it('rejects self-recursion', () => {
    expect(() => validateTargetUrl('https://cfp.lingion04.workers.dev/foo'))
      .toThrow(/recursion|self/i);
  });
  it('rejects IP literal', () => {
    expect(() => validateTargetUrl('http://169.254.169.254/latest/meta-data'))
      .toThrow(/ip/i);
  });
  it('accepts normal https URL', () => {
    expect(() => validateTargetUrl('https://example.com')).not.toThrow();
  });
});
```

- [ ] **Step 6: 实现 validateTargetUrl**

```typescript
// src/proxy-web/security.ts
const SELF_ORIGIN = 'cfp.lingion04.workers.dev';
const IPV4_REGEX = /^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;

export class SecurityError extends Error {}

export function validateTargetUrl(target: string): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new SecurityError('Invalid URL');
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new SecurityError('Only http/https allowed');
  }
  if (url.hostname === SELF_ORIGIN || url.hostname.endsWith('.' + SELF_ORIGIN)) {
    throw new SecurityError('Self recursion detected');
  }
  if (IPV4_REGEX.test(target)) {
    throw new SecurityError('Direct IP access blocked');
  }
}
```

- [ ] **Step 7: 跑测试通过**

- [ ] **Step 8: 实现 HTMLRewriter 引擎**

```typescript
// src/proxy-web/rewriter.ts
import { rewriteUrl, RewriteContext } from './url-resolver';

const HTML_ATTR_RULES: Record<string, string> = {
  'a': 'href',
  'link': 'href',
  'img': 'src',
  'script': 'src',
  'iframe': 'src',
  'video': 'src',
  'audio': 'src',
  'source': 'src',
  'form': 'action',
};

export function createRewriter(ctx: RewriteContext): HTMLRewriter {
  let rewriter = new HTMLRewriter();

  for (const [tag, attr] of Object.entries(HTML_ATTR_RULES)) {
    rewriter = rewriter.on(`${tag}[${attr}]`, {
      element: (el) => {
        const v = el.getAttribute(attr);
        if (v) el.setAttribute(attr, rewriteUrl(v, ctx));
      },
    });
  }

  // meta refresh
  rewriter = rewriter.on('meta[http-equiv="refresh"]', {
    element: (el) => {
      const content = el.getAttribute('content');
      if (content) {
        const m = content.match(/(\d+);\s*url=(.+)/i);
        if (m) el.setAttribute('content', `${m[1]}; url=${rewriteUrl(m[2], ctx)}`);
      }
    },
  });

  return rewriter;
}
```

- [ ] **Step 9: 实现 handleWebProxy 顶层**

```typescript
// src/proxy-web/handler.ts
import { createRewriter } from './rewriter';
import { validateTargetUrl, SecurityError } from './security';
import { rewriteUrl, RewriteContext } from './url-resolver';

export async function handleWebProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // path = /proxy/<encoded target url>
  const encoded = url.pathname.slice('/proxy/'.length);
  const target = decodeURIComponent(encoded);

  try {
    validateTargetUrl(target);
  } catch (e: any) {
    if (e instanceof SecurityError) {
      return new Response(e.message, { status: 400 });
    }
    throw e;
  }

  // Fetch target
  const targetRes = await fetch(target, {
    headers: request.headers,
    redirect: 'follow',
  });

  const contentType = targetRes.headers.get('Content-Type') || '';

  // HTML → 重写
  if (contentType.includes('text/html')) {
    const targetUrl = new URL(target);
    const ctx: RewriteContext = { currentOrigin: `${targetUrl.protocol}//${targetUrl.host}` };
    const rewriter = createRewriter(ctx);

    const newHeaders = new Headers(targetRes.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.delete('Content-Security-Policy');
    newHeaders.delete('X-Frame-Options');

    return new Response(rewriter.transform(targetRes.body).body, {
      status: targetRes.status,
      headers: newHeaders,
    });
  }

  // 其他资源 → 透传
  const newHeaders = new Headers(targetRes.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  return new Response(targetRes.body, {
    status: targetRes.status,
    headers: newHeaders,
  });
}
```

- [ ] **Step 10: 端到端测试**

写一个测试：mock 一个上游 HTML 响应，验证 `<a href="...">` 等被改写。

- [ ] **Step 11: commit**

```bash
git add src/proxy-web/ test/proxy-web/
git -c user.name="lingion" -c user.email="lingion04@gmail.com" commit -m "feat(proxy-web): W3 完整 HTML 重写引擎"
```

---

## Task 7: 部署到 cfp worker

**Files**:
- Modify: `wrangler.cfp.toml`（如有需要）
- Create: `~/.proxy-cfp-secrets.env`

**Interfaces**:
- Consumes: 所有 Task 1-6 的成果
- Produces: `cfp.lingion04.workers.dev` 真实部署

- [ ] **Step 1: 设置 secrets**

```bash
cd /Users/lingion_k/proxy-v3
export CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare-token)
echo "lingion" | npx wrangler secret put ADMIN -c wrangler.cfp.toml
# vendor 用 KEY
echo "$(openssl rand -hex 16)" | npx wrangler secret put KEY -c wrangler.cfp.toml
# Agent API 用 AGENT_KEY
echo "$(openssl rand -hex 16)" | npx wrangler secret put AGENT_KEY -c wrangler.cfp.toml
```

记录 KEY 和 AGENT_KEY 到 `~/.proxy-cfp-secrets.env`（0600 权限）：

```bash
cat > ~/.proxy-cfp-secrets.env << 'EOF'
# cfp Worker secrets (generated 2026-09-04)
# Worker: cfp (Cloudflare account 07401407fe88e9e8ce61d54ea0e385f3)
# 用法: source ~/.proxy-cfp-secrets.env
ADMIN=lingion
KEY=<the key you used>
AGENT_KEY=<the agent key>
EOF
chmod 600 ~/.proxy-cfp-secrets.env
```

- [ ] **Step 2: 部署**

```bash
cd /Users/lingion_k/proxy-v3
export CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare-token)
npx wrangler deploy -c wrangler.cfp.toml 2>&1 | tail -20
```

期望：返回 `Published cfp (X.XX sec)` 和 URL `https://cfp.lingion04.workers.dev`。

- [ ] **Step 3: 端到端验证**

```bash
# Health check
curl -s https://cfp.lingion04.workers.dev/api/v1/health | head -5
# DoH
curl -s "https://cfp.lingion04.workers.dev/resolve?name=google.com&type=A" | head -5
# Web Proxy
curl -sI https://cfp.lingion04.workers.dev/proxy/https://example.com | head -10
# Subscription
curl -s https://cfp.lingion04.workers.dev/sub/all | head -30
```

- [ ] **Step 4: 手机 Clash 客户端导入订阅测试**

把 `https://cfp.lingion04.workers.dev/sub/all` 导入手机 Clash，验证能连。

- [ ] **Step 5: commit 部署记录**

```bash
cd /Users/lingion_k/proxy-v3
git add wrangler.cfp.toml
git -c user.name="lingion" -c user.email="lingion04@gmail.com" commit -m "chore(deploy): v3.0 cfp.lingion04.workers.dev 首次部署"
```

---

## 验收最终清单

- [ ] 所有 7 个 Task 全部完成 + commit
- [ ] `npx vitest run` 全绿（v2 21 测试 + v3 60+ 测试）
- [ ] `npx wrangler deploy -c wrangler.cfp.toml` 成功
- [ ] `cfp.lingion04.workers.dev` 端到端验证全部通过
- [ ] 手机 Clash 能用 cfp 订阅
- [ ] Web Proxy `/proxy/https://example.com` 浏览器能完整渲染
- [ ] DoH `https://cfp.lingion04.workers.dev/dns-query` 接受 binary
- [ ] DoH `https://cfp.lingion04.workers.dev/resolve?name=&type=` 返回 JSON
- [ ] 32 个节点（edgetunnel 16 + yonggekkk 16）

---

## 执行选项

**完成后进入 finishing-a-development-branch：**
1. Merge `feat/v3-cfp-worker` → main
2. 删除 worktree `/Users/lingion_k/proxy-v3`
3. 通知用户 cfp worker URL
