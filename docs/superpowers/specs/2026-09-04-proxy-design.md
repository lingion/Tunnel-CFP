# Spec: Proxy — Cloudflare 边缘三合一代理

日期：2026-09-04 · 状态：待用户审阅

## Objective

一个项目名（Proxy），两个 Worker，覆盖四块需求：

| # | 需求 | 承载 | 方案 |
|---|------|------|------|
| ① | AI Agent 出站 API（访问被墙/匿名目标） | `proxy-gateway` Worker | 自研薄层，~100 行 |
| ② | 加密隧道自用（VLESS/VMess/Trojan + 客户端） | `proxy-tunnel` Worker | 复用 cmliu/edgetunnel 2.1（44.9k★，源码已验证） |
| ③ | Hysteria2 | — | ❌ 平台不可行（Workers 无 UDP/QUIC 监听），排除出本项目 |
| ④ | 代理 HTTPS 网站 | ①+② 分摊 | Agent 走 ①的 `/fetch`；浏览器走 ②隧道。不做 HTML 重写式网页反代（ymyuuu 型），无人消费该形态 |

核心用户：lingion 本人 + 其 AI Agent（Claude Code、bot）。
成功标准见文末。

## 平台硬边界（已查证）

- Workers 入站仅 HTTP/WS，出站 `fetcher.connect()`（TCP）。UDP/QUIC 不可行 → Hysteria2、QUIC 族协议永久排除。
- Workers `fetch()` 出站原生流式（`response.body` 直通），SSE/chunked 天然保留——网关不缓冲。
- edgetunnel 的 TCP 出站已用 `request.fetcher.connect()`，含 ProxyIP 反代与 socks5/http/sstp 链式代理。

## Architecture

```
                          Cloudflare (zone: qdp.qzz.io)
  ┌──────────────────────────────────────────────────────────┐
  │  proxy.qdp.qzz.io                                        │
  │   ├─ route /api/*      → proxy-gateway Worker (自研)      │
  │   └─ route /*          → proxy-tunnel Worker (edgetunnel) │
  └──────────────────────────────────────────────────────────┘
        │                                  │
   Agent / curl                    VLESS/VMess/Trojan 客户端
   (X-API-Key)                     (Shadowrocket/v2rayN/Clash)
        │                                  │
        └────────► 任意公网目标 ◄───────────┘
```

**两个独立 Worker，路径分流靠 Workers Routes（同 zone 下更具体的 route 优先命中）。**
不采用单 Worker 包壳 edgetunnel：其 `_worker.js` 6630 行且高频更新（封混淆、加功能），包壳=每次上游更新手工合并，维护成本不可接受。双 Worker 则 tunnel 侧换版本=直接换 `_worker.js`，零合并。

### proxy-tunnel（复用）

- 源：github.com/cmliu/edgetunnel，`_worker.js` 以 pinned commit 存入本仓 `tunnel/_worker.js`（GPL-2.0，个人使用不分发，LICENSE 注明来源与版本）。
- 绑定：KV namespace（面板配置）、secret `ADMIN`（面板密码）、var/secret `UUID`（节点认证）。
- 能力（源码已验证）：VLESS/VMess/Trojan/SS(含 v2ray-plugin) over WS+TLS；`/admin` 可视面板；订阅自动生成（Clash/Sing-box/Surge 混淆转换）；ProxyIP/链式代理；伪装页。
- 客户端侧域名：同域即可（订阅里节点=当前 host），可选再加优选域名后议。

### proxy-gateway（自研，v1 范围）

**API 契约**（对外只有这三个端点，错误统一 `{ error: { code, message } }`）：

```
BASE  https://proxy.qdp.qzz.io/api/v1
AUTH  头 X-API-Key: <key>（部署时 wrangler secret 注入 AGENT_KEY）
      缺失/不符 → 401 {"error":{"code":"UNAUTHORIZED",...}}（恒定延迟比较）

# 1. 直通代理（主端点，全方法）
<any method> /api/v1/fetch/<目标URL路径部分>?<目标query>
  例: POST /api/v1/fetch/https://api.target.com/v1/chat?stream=true
      GET  /api/v1/fetch/https://example.com/
  - method、body 原样转发
  - 请求头转发，剔除: host, cf-*, x-forwarded-*, x-api-key, content-length(重算)
  - 其余 query 原样附到目标 URL（?key 若走 query 鉴权则剥离）
  - 响应：status/头/体全透传，body 流式直通（SSE/大文件不缓冲）
  - redirect: manual —— 3xx 与 Location 原样返回，是否跟随由 Agent 自己定
  - 目标 URL 非法/非 http(s) → 400 BAD_TARGET

# 2. 健康检查（免鉴权）
GET /api/v1/health → { status:"ok", colo, ts }

# 3. 根信息（免鉴权，Agent 探测用）
GET /api/v1/ → { service:"proxy-gateway", version, endpoints:[...] }
```

**明确不做（v1）**：WebSocket 透传、TCP 桥接（Durable Object）、JSON 包装式 API、目标黑白名单、限流。v2 按实际需要再加——当前唯一消费者是自己的 Agent，先跑通最小面。

### 仓库结构（~/proxy）

```
proxy/
├── docs/superpowers/specs/      ← 本文档
├── gateway/
│   ├── src/index.ts             ← Worker 入口 + 路由
│   ├── src/lib/proxy.ts         ← 直通核心（头过滤/URL 拼装/流式转发）
│   ├── src/lib/auth.ts          ← 恒定延迟 key 校验
│   ├── test/*.test.ts           ← vitest-pool-workers 单测
│   ├── wrangler.toml            ← name=proxy-gateway, routes=/api/*
│   └── tsconfig.json
├── tunnel/
│   ├── _worker.js               ← pinned 上游副本（含来源/commit 注释）
│   └── wrangler.toml            ← name=proxy-tunnel, route=/*, KV/ADMIN/UUID
└── README.md                    ← 部署 + Agent 调用示例
```

（现有根目录骨架的 wrangler.toml/tsconfig/package.json 系误铺的 DO 版雏形，实现阶段迁入 gateway/ 并去掉 BridgeDO——v1 无 DO。）

## Commands

```
gateway 本地:   cd gateway && npx wrangler dev
gateway 测试:   cd gateway && npx vitest run
gateway 部署:   cd gateway && npx wrangler deploy
gateway 密钥:   npx wrangler secret put AGENT_KEY
tunnel 部署:    cd tunnel && npx wrangler deploy
tunnel 密钥:    npx wrangler secret put ADMIN；UUID 走 vars 或 secret
路由绑定:       wrangler.toml routes 段 + DNS 记录（worker route），部署即生效
```

## Code Style（gateway）

TypeScript strict，无框架，纯 Workers 原生 API。示例：

```ts
export async function forward(req: Request, target: URL): Promise<Response> {
  const headers = sanitizeRequestHeaders(req.headers);
  const res = await fetch(target, {
    method: req.method, headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    redirect: "manual",
  });
  return new Response(res.body, res); // 流式直通，不 await body
}
```

命名：文件 kebab-case，导出函数 camelCase，常量 UPPER_SNAKE。错误一律 `jsonError(status, code, message)` 单一出口。

## Testing Strategy

- 框架：`@cloudflare/vitest-pool-workers`（真 Workers 运行时，非 mock fetch）。
- 位置：`gateway/test/`。
- 必测：头过滤白/黑名单、URL 拼装（query 合并、坏 URL 400）、缺 key 401、GET 带 body 拒绝、流式直通（分片到达不合并）、错误体形状统一。
- 部署后冒烟：curl health / 无 key 401 / 经 /fetch 拉一个真实站点首字节。
- 不做 e2e 客户端自动化；隧道验证=真机 Shadowrocket 连一次。

## Boundaries

- **Always**：提交前 vitest 全绿；tunnel/_worker.js 头部保留上游 commit 指纹；secret 只走 `wrangler secret put`，禁入 git。
- **Ask first**：改 API 契约（加端点/改路径）；换/升 edgetunnel pinned 版本；动 zone 的 DNS/routes。
- **Never**：把 AGENT_KEY/ADMIN/UUID 写进任何文件；给 edgetunnel 上游提带个人信息的 PR；在 gateway 缓冲响应体。

## Success Criteria（完成定义）

1. `proxy.qdp.qzz.io/api/v1/health` 公网 200。
2. 无 key 请求 `/fetch/*` → 401；带 key 经 `/fetch/https://<真实站点>` 拿到 200 且 SSE/流式站点首字节 < 直连无明显劣化（体感级即可，不压测）。
3. edgetunnel `/admin` 可登录，能生成订阅；真机客户端用该节点访问被墙站点成功。
4. gateway vitest 全绿。
5. README 含 Agent 调用示例（curl 一条 + Claude Code 配置一条）。

## Out of Scope（明确不做）

- Hysteria2/QUIC 族（平台不可行）。日后要 Hy2 → 单独 VPS 方案，另立项目。
- 多用户/计费/限流/面板化 gateway——个人工具。
- 网页 HTML 重写式浏览器反代。
- Workers 之外的部署形态（Docker/VPS）。
