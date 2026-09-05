<p align="center">
  <a href="https://github.com/lingion/Tunnel-CFP/stargazers"><img src="https://img.shields.io/github/stars/lingion/Tunnel-CFP?style=for-the-badge&logo=github&color=FFD700" alt="Stars"></a>
  <a href="https://github.com/lingion/Tunnel-CFP/network/members"><img src="https://img.shields.io/github/forks/lingion/Tunnel-CFP?style=for-the-badge&logo=github&color=8B5CF6" alt="Forks"></a>
  <a href="https://github.com/lingion/Tunnel-CFP/issues"><img src="https://img.shields.io/github/issues/lingion/Tunnel-CFP?style=for-the-badge&logo=github&color=EF4444" alt="Issues"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/lingion/Tunnel-CFP?style=for-the-badge&logo=github&color=10B981" alt="License"></a>
  <br>
  <a href="https://github.com/lingion/Tunnel-CFP/commits/main"><img src="https://img.shields.io/github/last-commit/lingion/Tunnel-CFP?style=flat-square" alt="Last commit"></a>
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="CF Workers">
  <img src="https://img.shields.io/badge/lang-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TS">
  <a href="README.md"><img src="https://img.shields.io/badge/README-English-0078D4?style=flat-square" alt="English"></a>
</p>

<h1 align="center">Tunnel-CFP</h1>

<p align="center">
  一个 Cloudflare Worker,一套自托管的网络工具箱。<br>
  网页抓取代理 · WebSocket 桥 · DoH 服务器 · 订阅端点 · 管理面板。
</p>

---

**中文** | [English](README.md)

> **下载或使用本项目前,请先阅读[免责声明](#免责声明)。**

## Tunnel-CFP 是什么?

Tunnel-CFP 是一个 TypeScript Worker,部署在你自己的 Cloudflare 账号里。一个路由器后面挂了几套互相独立的网络工具:

- **网页抓取代理** — `/proxy/<url编码的目标>` 经 Worker 抓取页面,重写 HTML/CSS/JS 里的 URL 让资源照常加载,按目标站点隔离 Cookie,并拦截 SSRF 尝试(含整数/十六进制/八进制 IPv4 编码——统一在 `new URL()` 解析后的 hostname 上校验)。
- **WebSocket 桥** — `/proxy-ws/<编码的ws地址>` 把客户端 WebSocket 桥接到源站 TCP 连接,强制 RFC 6455 客户端掩码、帧大小上限、逐连接串行写入。
- **DoH 服务器** — `/dns-query` 和 `/resolve` 提供 DNS-over-HTTPS 查询(RFC 8484 wire format + JSON API)。
- **订阅端点** — `/sub/*` 输出 Clash YAML 或 base64 链接列表,内容由 vendored 引擎和内置节点池合并而来,带缓存、归一化和 token 鉴权。
- **管理面板与隧道核心** — 其余路径全部交给 vendored 的 [edgetunnel](https://github.com/cmliu/edgetunnel) 引擎处理。

这是一个自托管的开发工具。所有配置、密钥、运行数据都在你自己的 Cloudflare 账号里,项目作者接触不到你的任何流量。

## 适合谁?

| 你想… | 用这个 |
|---|---|
| 让脚本或 Agent 抓取并重写第三方页面,Cookie 按站点保留 | `/proxy/*` — ✓ |
| 给只有 WebSocket 的客户端一个 TCP 背书的套接字端点 | `/proxy-ws/*` — ✓ |
| 不经过第三方解析器做 DoH 查询 | `/dns-query` — ✓ |
| 在自己的 Worker 上输出 Clash/V2Ray 格式配置列表 | `/sub/*` — ✓ |
| 给陌生人跑一个公开中继 | ✗ — 请设置 `PROXY_KEY`,保持私有 |

## 免责声明

本项目仅供**学习、研究与技术交流**使用,是一个基于 Cloudflare Workers 平台的通用网络编程工具集。

下载、部署或使用本项目,即表示你已知悉并同意:

1. **合法使用由你自行负责。** 使用者必须遵守所在国家/地区的法律法规,以及部署平台(包括 Cloudflare 服务条款)的相关规定;因使用目的需要的授权由使用者自行取得。
2. **不用于任何非法用途。** 严禁将本项目用于违反适用法律的任何活动,包括但不限于:在法律禁止的场景下规避网络访问控制、未授权访问计算机系统、传播违法信息、侵犯知识产权、破坏网络服务等。作者不支持、不认可、不鼓励任何此类用途。
3. **不提供任何担保。** 本项目按"现状"提供,不附带任何明示或默示的保证。对使用或滥用本项目导致的任何直接或间接损失、数据丢失、服务封禁、账号终止或法律后果,作者与贡献者不承担责任。
4. **流量内容与作者无关。** 部署实例转发的全部流量由部署者及其用户产生,项目作者无法接触、不存储、不监控任何实例的流量。
5. **研究或测试完成后,建议自行删除部署。**

如不同意以上条款,请勿下载或使用本项目。

## 环境要求

- Cloudflare 账号(免费版够用)
- Node.js ≥ 18 + npm
- 具有 Workers 和 KV 权限的 `CLOUDFLARE_API_TOKEN`

## 快速开始

### 1. 克隆与安装

```bash
git clone https://github.com/lingion/Tunnel-CFP.git
cd Tunnel-CFP
npm install
```

### 2. 创建 KV namespace

```bash
npx wrangler kv namespace create KV
# 把打印出来的 namespace id 填进 wrangler.cfp.toml → kv_namespaces[0].id
```

### 3. 配置 `wrangler.cfp.toml`

最小改动——所有必须替换的位置都在文件里标了:

```toml
name = "cfp"                      # 你的 Worker 名

# 可选:自定义域名。去掉注释、改成你的 hostname。
# { pattern = "your-domain.example.com", custom_domain = true }

[[kv_namespaces]]
binding = "KV"                    # 必须叫 "KV" —— vendored 引擎硬编码读 env.KV
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"

[vars]
UUID = "00000000-0000-4000-8000-000000000000"  # ← 换成你自己的 UUIDv4(节点凭证)
# PROXY_KEY = "一串长随机字符"                    # 可选:给 /proxy* 加 key/Cookie 闸
```

### 4. 校验并部署

```bash
npx tsc --noEmit                              # 类型检查
npx vitest run                                # 单元测试(173 个)
npx vitest run -c vitest.workers.config.ts    # workers-runtime 测试(59 个,miniflare)
npx wrangler deploy -c wrangler.cfp.toml
```

### 5. 设置 secrets

```bash
echo "<key>"   | npx wrangler secret put KEY   -c wrangler.cfp.toml   # vendored edgetunnel 的 KEY
echo "<admin>" | npx wrangler secret put ADMIN -c wrangler.cfp.toml   # 管理面板密码
```

### 6. 烟雾测试

```bash
# 健康检查(无需鉴权)
curl "https://<你的worker域名>/api/v1/health"
# → {"status":"ok","colo":"...","ts":...}

# DoH JSON API
curl "https://<你的worker域名>/resolve?name=example.com&type=A"
```

订阅地址带 token 鉴权。你部署实例的 token 是 `MD5MD5(<你的域名> + <UUID>)`——和 vendored 管理面板 `/sub` 链接里显示的是同一个值。MD5MD5 的构造是 `md5(md5hex(s).substring(7, 27))`。

## 路由

| 路径 | 功能 |
|---|---|
| `/proxy/<编码url>` | 网页抓取代理(URL 重写、Cookie 隔离、SSRF 防护) |
| `/proxy-ws/<编码ws地址>` | WebSocket 桥(RFC 6455 客户端掩码) |
| `/api/v1/fetch/<目标url>` | Agent 网关:JSON 抓取 API(`X-API-Key` 或 `?key=`) |
| `/api/v1/health` | 健康检查(无需鉴权) |
| `/sub/edgetunnel?token=...` | base64 链接列表订阅 |
| `/sub/all?token=...` | Clash YAML 订阅(多源合并) |
| `/sub/yonggekkk` | 备用 vendor 订阅(原样) |
| `/dns-query`、`/resolve` | DoH 端点(RFC 8484 + JSON) |
| `/*` | vendored 管理面板 + WebSocket 隧道 |

## 安全模型

- **订阅端点 token 鉴权** — UUID 本身就是凭证,订阅端点从不响应未鉴权请求。
- **SSRF 防护跑在解析后的 hostname 上** — 自递归(`src/proxy-web/security.ts` 的 `SELF_HOSTS`)、任意编码的点分 IPv4、IPv6 字面量、`localhost`、内网 TLD(`.internal`/`.local`/`.home.arpa`)统一在 `new URL()` 归一后拒绝,整数/十六进制/八进制编码钻不过去。
- **WS 桥加固** — 每个客户端帧用新的随机掩码,帧上限 16 MB,握手缓冲上限 64 KB,对源站写入逐连接串行化。
- **可选 `PROXY_KEY`** — 在 `[vars]` 里配置后,`/proxy*` 必须带 `?key=` 或 Cookie,恒定时间比较。
- **Agent 网关** — 转发前剥离 `X-API-Key`,你的 key 不会泄给目标站。

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Cloudflare Workers(TypeScript) |
| HTML 重写 | `HTMLRewriter`(流式,无 DOM) |
| 测试 | Vitest + miniflare(workers pool)—— 232 个测试 |
| Vendor | [edgetunnel](https://github.com/cmliu/edgetunnel)(GPL-2.0)、[yonggekkk/Cloudflare-vless-trojan](https://github.com/yonggekkk/Cloudflare-vless-trojan) |

## 仓库结构

```
src/index.ts                 入口:路由分发
├── src/gateway/             Agent 网关(/api/*)
│   ├── router.ts            /api/v1/fetch + health
│   ├── auth.ts              X-API-Key 校验
│   └── proxy.ts             有界 fetch 转发
├── src/proxy-web/           网页代理
│   ├── handler.ts           /proxy 处理、条件缓存、超时
│   ├── rewriter.ts          HTMLRewriter 属性/CSS URL 重写
│   ├── ws-bridge.ts         RFC 6455 帧编解码 + TCP 泵
│   ├── security.ts          SSRF 防护(解析后 hostname 校验)
│   ├── url-resolver.ts      属性解码 + 路径保留
│   ├── rescue.ts            JS 导航 Referer 救援(302)
│   └── auth.ts              PROXY_KEY 闸(恒定时间比较)
├── src/subscription/        订阅端点
│   ├── handler.ts           /sub/* 路由 + 列表归一化
│   ├── cidr.ts              CF CIDR 池 → 节点生成
│   ├── geo.ts               6h KV 稳定池
│   ├── merge.ts             多源合并
│   ├── md5.ts / sha224.ts   加密原语(CF 运行时缺 MD5/SHA-224)
│   └── types.ts
├── src/doh/                 DoH RFC 8484 + JSON API
└── vendor/                  未修改的上游代码(见 THIRD_PARTY_NOTICES.md)
    ├── edgetunnel/_worker.js
    └── yonggekkk/_worker.js
```

`vendor/` 只读:更新就是替换文件、更新头部的 pinned commit。其余一切——归一化、节点池稳定、SSRF、WS 加固——都在 `src/`,且有测试覆盖。

## 更新 vendored 引擎

1. 下载新的上游 `_worker.js`。
2. 替换 vendor 文件。保留来源头注释,更新 pinned commit / 版本行。
3. 跑 `npx tsc --noEmit && npx vitest run`——全绿再部署。

## 仓库规则

`lingion/Tunnel-CFP` 是本项目唯一上游。镜像和 fork 不作为主入口。

## 当前限制

- Worker 没有常驻进程:缓存按 colo 隔离,KV 节点池刷新是尽力而为。
- 网页代理不执行 JavaScript:靠客户端渲染的 SPA 站点经 `/proxy/*` 打不开正常样子。
- WebSocket 桥要求源站接受未鉴权的 upgrade;带 Cookie 鉴权的端点由客户端自行处理。
- 订阅依赖 vendored 引擎的响应格式,上游改格式就需要升 vendor。

## 致谢

本项目依赖两个上游项目——许可证与 pinned 版本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md):

- **[cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)**(GPL-2.0)—— 隧道核心、管理面板、订阅机制
- **[yonggekkk/Cloudflare-vless-trojan](https://github.com/yonggekkk/Cloudflare-vless-trojan)** —— 备用订阅格式

以及 [cmliu/CF-CIDR.txt](https://github.com/cmliu/CF-CIDR.txt) —— 节点池使用的 Cloudflare CIDR 快照。

## 参与贡献

PR 接收地址 <https://github.com/lingion/Tunnel-CFP>。提交即表示同意你的贡献以 GPL-2.0 授权。

## License

GNU General Public License v2.0,见 [LICENSE](./LICENSE)。

允许使用、修改、再分发,前提是衍生作品同样以 GPL-2.0 授权并保留版权声明。不提供任何担保。vendored 组件沿用各自许可证,见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
