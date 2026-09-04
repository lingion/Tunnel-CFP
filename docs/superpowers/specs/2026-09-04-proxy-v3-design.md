# Spec v3 — cfp Worker "协议最全 + 功能最丰富" 全面升级

**Date**: 2026-09-04
**Owner**: lingion
**Status**: APPROVED → 进入 PLAN 阶段
**Replaces**: v2 (2026-09-04-proxy-design.md) — v2 的 Agent 出站 API / VLESS 隧道 / 节点订阅 全部继承并保留
**Deployment**: 全新 CF Worker `cfp`（与原 `proxy` worker 共用 account 07401407fe88e9e8ce61d54ea0e385f3，但 UUID / KV / secrets 全部独立）

---

## Objective（核心目标）

把 cfp.lingion04.workers.dev 改造成**"协议最多最全 + 功能最丰富 + 全部我们自己 vendor 自己改"** 的代理中枢。**不再依赖上游**，两个 vendor 项目（edgetunnel + yonggekkk）全部 clone 下来当我们自己的代码自己 commit 自己 tag。

**用户**：lingion 本人（手机 + 电脑 + 终端 + Agent）

**成功标志**（验收清单）：
- 手机 Clash 订阅能用 ✅（v2 已有，保留）
- 电脑 Clash 订阅能用 ✅（v2 已有，保留）
- Agent `fetch` 出站 API 能用 ✅（v2 已有，保留）
- **新增**：终端 `curl` 能用（DoH + HTTP 代理）
- **新增**：浏览器直接 URL `/proxy/<url>` 访问任意网站，**HTML 完整重写**
- **新增**：DoH 双栈端点，浏览器/系统可配 `https://cfp.lingion04.workers.dev/dns-query` 作为加密 DNS
- **新增**：vendor 双轨（edgetunnel + yonggekkk），订阅 YAML 同时输出两套节点
- **新增**：vendor 文件改动我们自己 commit，**永久脱离上游锁死**

---

## 核心架构决策（v3 关键变更）

### ADR-1: vendor = 我们自己的代码（用户最终决策）

**Decision**：
- `vendor/edgetunnel/` = 我们自己的代码，**完全脱钩 upstream**
- `vendor/yonggekkk/` = 我们自己的代码，**完全脱钩 upstream**
- 不做 submodule（submodule 还有 remote 引用，违背"纯自己"原则）
- **初始化流程**（一次性）：
  1. `git clone --depth 1 https://github.com/cmliu/edgetunnel vendor/edgetunnel-tmp`
  2. `rm -rf vendor/edgetunnel-tmp/.git` + `mv vendor/edgetunnel-tmp/* vendor/edgetunnel/`
  3. **首次 commit**：把所有 vendor 文件以"vendor: import edgetunnel"作为第一次 commit
  4. yonggekkk 同理 + 一次性 deobfuscate
- **从此以后**：vendor 没有 origin，没有 upstream，**纯我们自己的 git 历史**
- vendor 改动直接 commit 到我们 repo，tag 我们自己的版本号（如 `vendor-edgetunnel-v3.1.0`）
- **不留任何 upstream 来源记录**——彻底脱钩，git 历史不写来源注释
- **yonggekkk 代码混淆怎么办**：deobuscate 后变成可维护代码，混淆版本不 commit 到我们 repo（避免污染历史）

**Reason**：用户原话 "就纯我自己仓库 出问题我再去自己修"——vendor 完全脱钩，无外部依赖

### ADR-2: vendor 双轨并行（edgetunnel + yonggekkk）

**Decision**：
- `src/index.ts` 同时 import 两个 vendor，**根据路径分流**
- `/sub/edgetunnel` 走 edgetunnel 的 YAML 生成
- `/sub/yonggekkk` 走 yonggekkk 的 YAML 生成
- `/sub/all` = 两家 YAML 合并输出（用户一份订阅拿全协议）
- 工作量分配：edgetunnel 主线，yonggekkk 备线（Reality/ECH）

**Reason**：edgetunnel 不支持 Reality，yonggekkk 支持 Reality 但代码混淆；双 vendor = 拿全协议 + 高可用

### ADR-3: Web Proxy 选 W3（完整 HTML 重写）

**Decision**：
- `/proxy/<url>` 路径，HTML 走 HTMLRewriter 引擎重写
- 所有静态资源（CSS/JS/图片）走 Worker 转发，浏览器感知不到差异
- CORS 全开（`*`），无 ADMIN 认证

**Reason**：用户明确拒绝插件方案（"为什么要登录？为什么要插件？"），W3 是纯 URL 直访

### ADR-4: DoH 不带 ECS

**Decision**：DoH 响应剥掉 EDNS Client Subnet 子网信息
**Reason**：GFW 利用 ECS 做精准污染

### ADR-5: 不实现 HTTP CONNECT 代理（明确告知）

**Decision**：`curl -x cfp.lingion04.workers.dev:443 https://google.com` **不实现**
**Reason**：CF Worker 是事件驱动 HTTP handler，不支持 TCP listener
**替代**：W3 `/proxy/<url>` 模式 + DoH = 浏览器/终端全场景覆盖（除 L4 CONNECT）

---

## 三个核心功能

### Feature 1: vendor 双轨（最大工作量）

#### 1.1 初始化两个 vendor（纯我们自己的代码）

```
~/proxy/vendor/
├── edgetunnel/                    # 我们自己的代码（首次 commit 来自 cmliu/edgetunnel 一次性 clone）
│   ├── _worker.js                 # 当前 fb32122 版（已 b3d1fb3 命名补丁）
│   ├── PATCHES.md                 # 我们做的补丁说明
│   ├── README.md                  # 我们自己的 vendor 说明
│   └── CHANGELOG.md               # 我们自己的版本日志
└── yonggekkk/                     # 我们自己的代码（首次 commit 来自 yonggekkk 一次性 clone + deob）
    ├── _worker.js                 # deobfuscated 版（直接是首次 commit）
    ├── PATCHES.md
    ├── README.md
    └── CHANGELOG.md
```

#### 1.2 yonggekkk deobfuscate 工作流

**输入**：`Vless_workers_pages/_worker.js`（混淆 hex 字符串）
**输出**：可读可改的 JS

**步骤**：
1. 用 `webcrack` / `javascript-deobfuscator` npm 工具自动 deob
2. 手工重命名关键函数（`a0G` → `obfuscatedDecode`, `a0cl` → `antiDebugCheck` 等）
3. 提取 VLESS 协议主路径、TLS 处理、Reality 握手代码
4. 单元测试：拿混淆版和 deob 版各跑一遍，对比输出
5. 替换原 `_worker.js` 为 deob 版本

**工期**：1 - 2 天（首次）

#### 1.3 vendor 集成到 Worker

`src/index.ts` 改造：

```typescript
import edgetunnel from "../vendor/edgetunnel/_worker.js";
import yonggekkk from "../vendor/yonggekkk/_worker.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // 1. Agent API（v2 已有）
    if (url.pathname.startsWith("/api/")) {
      return handleGateway(request, env, ctx);
    }
    
    // 2. DoH（v3 新增）
    if (url.pathname === "/dns-query" || url.pathname === "/resolve") {
      return handleDoh(request, env);
    }
    
    // 3. Web Proxy（v3 新增）
    if (url.pathname.startsWith("/proxy/")) {
      return handleWebProxy(request, env);
    }
    
    // 4. 订阅分流
    if (url.pathname.startsWith("/sub/")) {
      return handleSubscription(request, env);
    }
    
    // 5. vendor tunnel（兜底）
    return edgetunnel.fetch(request, env, ctx);
  }
};
```

#### 1.4 双 vendor 订阅生成

订阅 YAML 同时输出两家的节点：
- edgetunnel 16 个节点（已有 b3d1fb3 命名：CF移动优选-SG-318981 等）
- yonggekkk 16 个节点（Reality + ECH 协议）

合计 32 个节点，单订阅吃全部协议。

#### 1.5 验收
- [ ] `vendor/edgetunnel/` 和 `vendor/yonggekkk/` 都是普通 git 目录，**无 submodule 引用**
- [ ] 两个 vendor 都无 `.git/` 子目录、无 remote、纯我们 git 历史的一部分
- [ ] 两个 vendor 都能独立 deploy 测试
- [ ] `/sub/all` 输出 32 个节点
- [ ] b3d1fb3 edgetunnel 命名补丁保留
- [ ] yonggekkk deobfuscated 代码可读 + 可改
- [ ] 没有任何 FORKED_FROM.md / 来源记录文件（彻底脱钩）

---

### Feature 2: DoH 双栈端点

#### 2.1 RFC 8484 路径 `/dns-query`

**两种请求方法都支持**：
- `POST /dns-query` body = DNS wireformat binary，Content-Type = `application/dns-message`
- `GET /dns-query?dns=<base64url>` DNS 消息 base64url 编码

**响应**：
- Content-Type: `application/dns-message`
- body = DNS wireformat 响应
- Cache-Control: `max-age=30`（缓存 30 秒）

**后端**：Worker `fetch('https://cloudflare-dns.com/dns-query', { method, headers, body })` 转发

#### 2.2 JSON API 路径 `/resolve`

```
GET /resolve?name=example.com&type=A
```

**响应 JSON**：
```json
{
  "Status": 0,
  "Answer": [
    {"name": "example.com.", "type": 1, "TTL": 300, "data": "93.184.216.34"}
  ]
}
```

**支持的 type**：A / AAAA / CNAME / MX / TXT / NS

**实现依赖**：`dns-packet` npm 包（4KB gzipped）做 wireformat ↔ JSON

#### 2.3 缓存策略

Worker Cache API：
- Key: `doh:${queryHex}`（query 的二进制 hex）
- TTL: 30 秒
- Cache API 比 KV 快 10x，够用

#### 2.4 验收
- [ ] `curl -H "accept: application/dns-message" --data-binary @query.bin https://cfp.lingion04.workers.dev/dns-query` 返回 DNS 响应
- [ ] `curl "https://cfp.lingion04.workers.dev/dns-query?dns=$(echo -n '...' | base64)"` 返回 DNS 响应
- [ ] `curl https://cfp.lingion04.workers.dev/resolve?name=google.com&type=A` 返回 JSON
- [ ] 浏览器设置 DoH server 为 `https://cfp.lingion04.workers.dev/dns-query` 后能解析域名
- [ ] 相同 query 30s 内第二次走 Cache
- [ ] 单元测试：12+ cases（A/AAAA/CNAME/MX/TXT/NS/错误查询）

---

### Feature 3: Web Proxy (W3 完整 HTML 重写)

#### 3.1 路径设计

**`GET https://cfp.lingion04.workers.dev/proxy/<url>`**

- `<url>` = 目标完整 URL（明文 + URL encoded）
- 例：`https://cfp.lingion04.workers.dev/proxy/https://example.com`
- 例：`https://cfp.lingion04.workers.dev/proxy/https://en.wikipedia.org/wiki/Cloudflare`

#### 3.2 HTMLRewriter 规则

```typescript
new HTMLRewriter()
  // 链接
  .on("a[href]", { element: e => e.setAttribute("href", rewriteUrl(e.getAttribute("href"), ctx)) })
  .on("link[href]", { element: e => e.setAttribute("href", rewriteUrl(e.getAttribute("href"), ctx)) })
  // 媒体
  .on("img[src]", { element: e => e.setAttribute("src", rewriteUrl(e.getAttribute("src"), ctx)) })
  .on("video[src]", { element: e => e.setAttribute("src", rewriteUrl(e.getAttribute("src"), ctx)) })
  .on("audio[src]", { element: e => e.setAttribute("src", rewriteUrl(e.getAttribute("src"), ctx)) })
  .on("source[src]", { element: e => e.setAttribute("src", rewriteUrl(e.getAttribute("src"), ctx)) })
  // 脚本
  .on("script[src]", { element: e => e.setAttribute("src", rewriteUrl(e.getAttribute("src"), ctx)) })
  // 表单
  .on("form[action]", { element: e => e.setAttribute("action", rewriteUrl(e.getAttribute("action"), ctx)) })
  // meta refresh
  .on("meta[http-equiv='refresh']", { element: e => {
      const content = e.getAttribute("content") || "";
      const m = content.match(/(\d+);\s*url=(.+)/i);
      if (m) e.setAttribute("content", `${m[1]}; url=${rewriteUrl(m[2], ctx)}`);
    }})
  .transform(response.body);
```

#### 3.3 URL 重写规则

| 输入 | 输出 |
|---|---|
| `https://example.com/foo` | `/proxy/https://example.com/foo` |
| `/foo`（相对路径） | `/proxy/<currentOrigin>/foo` |
| `//cdn.example.com/foo`（protocol-relative） | `/proxy/https://cdn.example.com/foo` |
| `data:image/png;base64,...` | 不动 |
| `javascript:void(0)` | 不动 |
| `#anchor` | 不动 |
| `mailto:x@y` | 不动 |
| `tel:+1234` | 不动 |

#### 3.4 静态资源透传

非 HTML 请求（CSS/JS/图片/字体）：
- Worker `fetch(targetUrl)`
- 透传响应体（不解析内容）
- 改写头：CORS 头加上，去掉 CSP `frame-ancestors` 等限制

#### 3.5 安全 / 反滥用

- **递归防护**：`if (targetUrl.startsWith('https://cfp.lingion04.workers.dev')) return 400;`
- **SSRF 防护**：禁止 IP 直连（`http://169.254.169.254/` 等内部地址）
- **限速**：CF 平台 Rate Limiting rules，60 req/min/IP（v3 不实现，v4 再加）
- **CORS**：`Access-Control-Allow-Origin: *`
- **超时**：30 秒
- **大小限制**：响应体 ≤ 50MB（CF Worker 限制）

#### 3.6 验收
- [ ] `https://cfp.lingion04.workers.dev/proxy/https://example.com` 返回 example.com 主页 HTML
- [ ] 主页里所有 `src=` `href=` 都被改写为 `/proxy/...`
- [ ] 浏览器完整渲染（CSS/JS/图片全部能加载）
- [ ] 相对路径 `/about.html` 正确解析
- [ ] protocol-relative `//cdn.example.com/...` 正确重写
- [ ] 主页里外链 `<a href="https://other.com">` 仍然指向原站
- [ ] 递归访问 `cfp.lingion04.workers.dev/proxy/cfp.lingion04.workers.dev/...` 返回 400
- [ ] 单元测试：20+ cases（各种 URL 形式 + Content-Type 分支）

---

## 项目结构（v3 增量）

```
proxy/
├── src/
│   ├── gateway/                  # v2 已有
│   │   ├── auth.ts
│   │   ├── proxy.ts
│   │   └── router.ts
│   ├── doh/                      # ← v3 新增
│   │   ├── rfc8484.ts
│   │   ├── json-api.ts
│   │   ├── cache.ts
│   │   └── types.ts
│   ├── proxy-web/                # ← v3 新增
│   │   ├── handler.ts
│   │   ├── rewriter.ts
│   │   ├── url-resolver.ts
│   │   ├── security.ts
│   │   └── types.ts
│   ├── subscription/             # ← v3 新增（双 vendor 订阅合并）
│   │   ├── generator.ts
│   │   ├── merge.ts
│   │   └── types.ts
│   └── index.ts                  # 路由总入口（v3 改造）
├── tests/
│   ├── gateway/                  # v2 已有
│   ├── doh/                      # ← v3 新增
│   ├── proxy-web/                # ← v3 新增
│   └── subscription/             # ← v3 新增
├── vendor/                       # ← v3 完全脱钩 upstream
│   ├── edgetunnel/               # 我们自己的代码（首次 commit 来自 cmliu/edgetunnel 一次性 clone）
│   │   ├── _worker.js            # 当前 fb32122 版（已 b3d1fb3 命名补丁）
│   │   ├── PATCHES.md            # 我们的补丁说明
│   │   ├── README.md
│   │   └── CHANGELOG.md
│   └── yonggekkk/                # 我们自己的代码（首次 commit 来自 yonggekkk 一次性 clone + deob）
│       ├── _worker.js            # deobfuscated 版
│       ├── PATCHES.md
│       ├── README.md
│       └── CHANGELOG.md
└── docs/superpowers/
    └── specs/
        ├── 2026-09-04-proxy-design.md       # v2
        └── 2026-09-04-proxy-v3-design.md    # ← v3 当前
```

---

## Tech Stack

| 层 | 技术 | 备注 |
|---|---|---|
| Worker runtime | TypeScript + @cloudflare/workers-types | v2 已在用 |
| HTML 重写 | CF 原生 `HTMLRewriter` API | 不引入第三方 parser |
| DNS 解析 | `dns-packet` npm 包 | 4KB gzipped |
| HTTP 客户端 | 原生 `fetch()` | 无 |
| Deob 工具 | `webcrack` / `javascript-deobfuscator` npm | yonggekkk 一次性 |
| 配置 | `wrangler.toml` + KV | 已有 |
| 测试 | vitest + @cloudflare/vitest-pool-workers | 21 个测试已有 |

---

## Commands

```bash
# Build
cd ~/proxy && npm run build

# Test
cd ~/proxy && NODE_OPTIONS="--max-old-space-size=8192" npm test

# Deploy
cd ~/proxy && npx wrangler deploy -c wrangler.toml

# Logs
cd ~/proxy && npx wrangler tail

# Vendor 已经脱钩 upstream——直接 commit 到主项目
# 不需要 git pull / fetch

# Deob yonggekkk (一次性，初始化时跑)
cd ~/proxy/vendor/yonggekkk && npx webcrack _worker.js -o _worker.deob.js

# Create subscription token
cd ~/proxy && openssl rand -hex 16
```

---

## Boundaries

### Always do
- 跑 vitest 通过才能 commit
- 写新代码前先看 spec 找对应章节
- 新增依赖必须 npm 加 `--registry=https://registry.npmmirror.com`
- vendor 改动 commit 到对应 vendor 目录（不污染主项目）

### Ask first
- 改 wrangler.toml 的 KV namespace ID
- 改 CF secret（用 `wrangler secret put`）
- vendor 大改（deob、协议升级）前必须先 spec/PR review

### Never do
- 提交 CF API token / ADMIN password / SUBSCRIBE token 到 git
- 跑 `wrangler dev` 占着终端
- 直接覆盖 `_worker.js` 而不经过 PR review
- 跳过 vendor 自己的 CHANGELOG.md

---

## Success Criteria（v3 验收清单）

### 必须满足（MUST）
- [ ] `vendor/edgetunnel/` 和 `vendor/yonggekkk/` 都是普通 git 目录，无 submodule 引用、无 remote
- [ ] yonggekkk 代码已 deobfuscated，README 写明我们怎么改的
- [ ] `/sub/all` 输出 32 个节点（edgetunnel 16 + yonggekkk 16）
- [ ] DoH `/dns-query` POST/GET 都通，Content-Type 正确
- [ ] DoH `/resolve?name=&type=` 返回合法 JSON
- [ ] DoH 30s 内同 query 走 Cache
- [ ] Web Proxy `/proxy/https://example.com` 浏览器能完整渲染
- [ ] Web Proxy 主页里 `src=` `href=` 全部改写
- [ ] Web Proxy 递归访问返回 400
- [ ] Web Proxy CORS 头齐全
- [ ] 21 个 v2 测试仍然全绿
- [ ] 新增 60+ 单元测试（DoH + Web Proxy + Subscription）

### Nice to have
- [ ] Web Proxy CSS 内的 url() 也重写
- [ ] Web Proxy POST 表单提交
- [ ] Web Proxy 限速 60 req/min/IP
- [ ] DoH 支持 ECS opt-out 开关

---

## 不做什么（明确排除）

- ❌ `curl -x` 形式的 HTTP CONNECT 代理（CF Worker 不支持 L4）
- ❌ Hysteria2 / TUIC / WireGuard（CF Worker 不支持 UDP）
- ❌ SOCKS5（CF Worker 不支持 TCP listener）
- ❌ EDNS Client Subnet
- ❌ SPA 的 JS 动态 URL 重写
- ❌ 流量分析 / 访问记录

---

## 工期估算

| 任务 | 工作量 |
|---|---|
| **Feature 1**: clone 两个 vendor + edgetunnel 命名补丁保留 | 0.5 天 |
| **Feature 1**: yonggekkk deobfuscate | 1 - 2 天 |
| **Feature 1**: 双 vendor 订阅合并（src/subscription/） | 0.5 天 |
| **Feature 1**: src/index.ts 路由分流 | 0.5 天 |
| **Feature 2**: DoH `/dns-query` + `/resolve` + Cache | 0.5 - 1 天 |
| **Feature 3**: Web Proxy url-resolver + rewriter + handler + security | 3 - 4 天 |
| 测试 + 文档 + 部署 | 1 天 |
| **合计** | **7 - 9.5 天** |

---

## Open Questions（用户已确认全部默认）

~~1. vendor 来源记录：~~ ❌ **不保留**（彻底脱钩，不留任何 FORKED_FROM.md 痕迹）
2. **DoH 默认上游**：`cloudflare-dns.com`
3. **Web Proxy 限速**：不加（CF 平台层免费额度内不限制）
4. **yonggekkk 协议保留**：Reality / VLESS-WS / Trojan-WS / SS 全保留

---

## 下一步

**用户批准后** → 进入 PLAN 阶段（用 writing-plans skill）：
- `tasks/plan.md` = 总体计划
- `tasks/todo.md` = TDD 任务列表

每个 task 严格按 TDD：写测试 → 跑挂 → 实现 → 跑过 → commit。

---

**用户审批动作**：回复 `approved` 或具体修改意见。
