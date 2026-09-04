# Spec: Proxy — Cloudflare 边缘三合一代理（单 Worker）

日期：2026-09-04 · 状态：待用户审阅（v2：应用户要求由双 Worker 改为单 Worker）

## Objective

一个 Worker（`proxy`），两层能力，覆盖四块需求：

| # | 需求 | 承载 | 方案 |
|---|------|------|------|
| ① | AI Agent 出站 API（访问被墙/匿名目标） | `/api/*` 路径 | 自研薄层，~100 行 |
| ② | 加密隧道自用（VLESS/VMess/Trojan + 客户端） | 其余全部路径 | 复用 cmliu/edgetunnel 2.1（44.9k★，源码已验证） |
| ③ | Hysteria2 | — | ❌ 平台不可行（Workers 无 UDP/QUIC 监听），排除出本项目 |
| ④ | 代理 HTTPS 网站 | ①+② 分摊 | Agent 走 ①的 `/fetch`；浏览器走 ②隧道。不做 HTML 重写式网页反代 |

核心用户：lingion 本人 + 其 AI Agent（Claude Code、bot）。

## 平台硬边界（已查证）

- Workers 入站仅 HTTP/WS，出站 `fetcher.connect()`（TCP）。UDP/QUIC 不可行 → Hysteria2、QUIC 族协议永久排除。
- Workers `fetch()` 出站原生流式（`response.body` 直通），SSE/chunked 天然保留——网关不缓冲。
- edgetunnel 的 TCP 出站已用 `request.fetcher.connect()`，含 ProxyIP 反代与 socks5/http/sstp 链式代理。

## Architecture

```
                    Cloudflare (zone: qdp.qzz.io)
  ┌────────────────────────────────────────────────┐
  │  proxy.qdp.qzz.io/*  →  单 Worker: proxy        │
  │    ├─ /api/*   → gateway（自研前置分发层）        │
  │    └─ 其余     → edgetunnel._worker.js（import） │
  └────────────────────────────────────────────────┘
        │                                │
   Agent / curl                  VLESS/VMess/Trojan 客户端
   (X-API-Key)                   (Shadowrocket/v2rayN/Clash)
        │                                │
        └────────► 任意公网目标 ◄─────────┘
```

### 分发入口（src/index.ts）

```ts
import edgetunnel from "../vendor/edgetunnel/_worker.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleGateway(request, env, ctx);
    }
    return edgetunnel.fetch(request, env, ctx);
  },
};
```

**为什么 import 委派而非修改/复制代码**（源码已验证可行）：
- `_worker.js` 是标准 ES module（`export default { async fetch }`），可直接 import
- 零修改 → 上游更新 = 替换 vendored 文件，无合并成本
- edgetunnel 的路径路由（admin/sub/login/version）与 WS/gRPC 分发全部原样保留，唯一规则：`/api/*` 前缀归 gateway，永不落入 tunnel 侧
- 冲突排查（已做）：gateway 仅用 `/api/v1/*`；tunnel 侧无任何 `/api` 开头路径（grep 验证）；WS 升级不经过 `/api/*`；edgetunnel 的"非 admin POST 视为代理流量"逻辑因前置拦截不会误吞 gateway 请求

### gateway（自研，v1 范围）

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
  - 其余 query 原样附到目标 URL
  - 响应：status/头/体全透传，body 流式直通（SSE/大文件不缓冲）
  - redirect: manual —— 3xx 与 Location 原样返回，是否跟随由 Agent 自己定
  - 目标 URL 非法/非 http(s) → 400 BAD_TARGET

# 2. 健康检查（免鉴权）
GET /api/v1/health → { status:"ok", colo, ts }

# 3. 根信息（免鉴权，Agent 探测用）
GET /api/v1/ → { service:"proxy-gateway", version, endpoints:[...] }
```

**明确不做（v1）**：WebSocket 透传、TCP 桥接（Durable Object）、JSON 包装式 API、目标黑白名单、限流。v2 按实际需要再加——当前唯一消费者是自己的 Agent，先跑通最小面。

### tunnel 侧（复用，零修改）

- 源：github.com/cmliu/edgetunnel（GPL-2.0，个人使用不分发），`_worker.js` 以 pinned commit 存入 `vendor/edgetunnel/`（文件头注释保留来源 URL + commit hash + 上游 Version 字符串）。
- 绑定：KV namespace（面板配置）、secret `ADMIN`（面板密码）、var/secret `UUID`（节点认证）、secret `AGENT_KEY`（gateway 用）。
- 能力（源码已验证）：VLESS/VMess/Trojan/SS(含 v2ray-plugin) over WS+TLS；`/admin` 可视面板；订阅自动生成（Clash/Sing-box/Surge 转换）；ProxyIP/链式代理；伪装页。

### 仓库结构（~/proxy）

```
proxy/
├── docs/superpowers/specs/    ← 本文档
├── src/
│   ├── index.ts               ← 入口：/api/* 分发 → gateway | edgetunnel
│   ├── gateway/
│   │   ├── router.ts          ← /api/v1 路由 + 错误出口
│   │   ├── proxy.ts           ← 直通核心（头过滤/URL 拼装/流式转发）
│   │   └── auth.ts            ← 恒定延迟 key 校验
├── vendor/edgetunnel/
│   └── _worker.js             ← pinned 上游副本（零修改，头注释记来源）
├── test/
│   └── *.test.ts              ← vitest-pool-workers 单测
├── wrangler.toml              ← name=proxy, route=proxy.qdp.qzz.io/*, KV+secrets
├── tsconfig.json
├── package.json
└── README.md                  ← 部署 + Agent 调用 + 客户端订阅示例
```

（现有根目录 src/ 骨架的 DO 版雏形废弃重写——v1 无 Durable Object。）

## Commands

```
本地:     cd ~/proxy && npx wrangler dev
测试:     cd ~/proxy && npx vitest run
类型检查:  cd ~/proxy && npx tsc --noEmit
部署:     cd ~/proxy && npx wrangler deploy
secrets:  npx wrangler secret put ADMIN / AGENT_KEY（UUID 走 vars）
路由:     wrangler.toml routes + DNS，部署即生效
上游更新:  下载新版 _worker.js → 替换 vendor/edgetunnel/ → 更新头注释 commit → 测试 → 部署
```

## Code Style

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

命名：文件 kebab-case，导出函数 camelCase，常量 UPPER_SNAKE。错误一律 `jsonError(status, code, message)` 单一出口。gateway 代码与 vendored 文件物理隔离（src/ vs vendor/），禁止为迁就上游改 gateway，禁止改 vendor。

## Testing Strategy

- 框架：`@cloudflare/vitest-pool-workers`（真 Workers 运行时）。
- 位置：`test/`。
- 必测（gateway 侧）：分发（/api/* 进 gateway、/ 进 tunnel、/api 前缀边界）、头过滤、URL 拼装（query 合并、坏 URL 400）、缺 key 401、GET 带 body 拒绝、流式直通（分片到达不合并）、错误体形状统一。
- 部署后冒烟：curl health / 无 key 401 / 经 /fetch 拉真实站点首字节 / 浏览器打开 / 出 tunnel 伪装页。
- 不做 e2e 客户端自动化；隧道验证=真机 Shadowrocket 连一次。

## Boundaries

- **Always**：提交前 vitest 全绿；vendor/edgetunnel/_worker.js 头部保留上游来源+commit 指纹；secret 只走 `wrangler secret put`，禁入 git。
- **Ask first**：改 API 契约（加端点/改路径）；换/升 edgetunnel pinned 版本；动 zone 的 DNS/routes。
- **Never**：修改 vendor/ 下文件；把 AGENT_KEY/ADMIN/UUID 写进任何文件；给上游提带个人信息的 PR；在 gateway 缓冲响应体。

## Success Criteria（完成定义）

1. `proxy.qdp.qzz.io/api/v1/health` 公网 200。
2. 无 key 请求 `/fetch/*` → 401；带 key 经 `/fetch/https://<真实站点>` 拿到 200，流式站点首字节体感无明显劣化。
3. 同一 Worker 下隧道侧可用：`/admin` 可登录并生成订阅；真机客户端用该节点访问被墙站点成功；`/` 出伪装页证明分发未破坏 tunnel。
4. vitest 全绿（含分发边界测试）。
5. README 含 Agent 调用示例（curl 一条 + Claude Code 配置一条）+ 客户端订阅用法。

## Out of Scope（明确不做）

- Hysteria2/QUIC 族（平台不可行）。日后要 Hy2 → 单独 VPS 方案，另立项目。
- 多用户/计费/限流/面板化 gateway——个人工具。
- 网页 HTML 重写式浏览器反代。
- Workers 之外的部署形态（Docker/VPS）。

## 变更记录

- v2 (2026-09-04)：用户要求单 Worker。双 Worker 方案废弃；改为 import 委派分发（源码验证 _worker.js 为标准 ES module，零修改可导入，上游更新=文件替换）。
- v1 (2026-09-04)：初版（双 Worker + Workers Routes 分流）。
