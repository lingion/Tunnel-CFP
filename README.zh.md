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

Tunnel-CFP 是一个 TypeScript Worker,部署在你自己的 Cloudflare 账号里。一个路由器后面挂了几套互相独立的工具:

| 路径 | 功能 |
|---|---|
| `/proxy/<编码url>` | 经 Worker 抓取页面,重写 HTML/CSS/JS 资源 URL,按目标站点隔离 Cookie,拦截 SSRF |
| `/proxy-ws/<编码ws地址>` | 把浏览器 WebSocket 桥接到源站 TCP 连接 |
| `/api/v1/fetch/<目标>` | 给脚本和 Agent 用的 JSON 抓取 API(`X-API-Key` 鉴权) |
| `/sub/*` | 输出 Clash YAML / base64 配置列表,带 token 鉴权 |
| `/dns-query`、`/resolve` | DNS-over-HTTPS(RFC 8484 wire format + JSON API) |
| `/*` | 管理面板与 WebSocket 隧道(vendored edgetunnel 引擎) |

隧道核心是 **vendored 的未修改上游代码**(见[致谢](#致谢))。下面[本项目做了什么](#本项目做了什么)一节描述的全部内容,都是 `src/` 里的原创代码——围绕那个核心做管理、加固和运维。

这是自托管开发工具。配置、密钥、全部运行数据都在你自己的 Cloudflare 账号里,项目作者接触不到任何部署实例。

## 网页代理的工作原理

`/proxy/` 是一条流式的「抓取-重写」流水线,不是静态镜像:

1. **解析并校验目标。** 目标 URL 先过 `new URL()`,校验跑在**解析后的 hostname** 上,不是原始字符串。这堵住了经典 SSRF 绕过:`http://2130706433/`、`http://0x7f000001/`、`http://0177.0.0.1/`、`http://127.1/` 这类写法在 URL 解析器里全部归一成 `127.0.0.1`,字面量正则对它们漏判。同样被拒绝的还有:一切点分 IPv4、IPv6 字面量、`localhost`、内网 TLD(`.internal`/`.local`/`.home.arpa`),以及对 `SELF_HOSTS` 的自递归。
2. **带硬超时抓取。** 源站请求挂 `AbortSignal.timeout(60s)`。超时回 504 页,其他失败回 502。
3. **按内容类型流式重写。** HTML 走 `HTMLRewriter`——流式重写器,不建 DOM,元素边过边改。覆盖的情形:`href`/`src`/`srcset`/`action` 和 `srcdoc` iframe(srcdoc 内容是实体编码的,先解码再重写)、`<style>` 内联文本的 O(n) 缓冲式 CSS `url()` 重写、`<script>` 文本(带模板字面量保护)。重写器同时剥离 Cloudflare RUM 统计脚本,并加 `Cache-Control: no-transform` 防止边缘重新注入。
4. **一切缓冲有上限。** 可重写 body 走按字节计数的读取器,上限 5 MB,超限直接原样流式透传。WS 桥帧上限 16 MB、握手缓冲上限 64 KB。内存里没有无界累积。
5. **条件缓存。** 只缓存可缓存类型、只 GET、只无 Cookie 请求,且用 `ctx.waitUntil` 延迟写入——写缓存前剥掉 `Set-Cookie`。响应本身永不被缓存写入拖慢,带鉴权的响应永不进缓存。
6. **保住协议语义。** `Content-Encoding` 和 `Content-Length` 原样透传,`Range` 请求(视频拖进度条)拿到真实的 206 响应。HEAD 请求的超时处理不带 body(HEAD 本就不允许有 body)。

「导航救援」是让这东西在浏览器里真正可用的小部件:单页站点里 `location.href = "/some/path"` 这种赋值会让导航逃出代理。当一个同源导航带着指向 `/proxy/` 的 Referer 进来,Worker 回一个 302,把路径映射回被代理的源站。被代理的页面还会把最近的目标站点写进 `HttpOnly` Cookie(服务端写入,不注入 JS),所以连只有 origin 的 Referer 也能救。

## WebSocket 桥的工作原理

`/proxy-ws/` 终结浏览器 WebSocket,用 `cloudflare:sockets` 向源站开一条原始 TCP 连接,双向泵字节。难点在浏览器侧,实现逐条照着 RFC 6455 写:

- **客户端掩码是强制的(RFC 6455 §5.1)。** 每个发往源站的帧都带掩码位和 `crypto.getRandomValues` 生成的新掩码键,payload 逐字节 XOR。长度类别(7-bit / 16-bit / 64-bit)按规范编码;text、binary、ping、pong、close 操作码原样保留。
- **续帧重组。** 分片消息(opcode `0x0`)先缓冲再整条分发;控制帧夹在文本消息分片中间属于协议违例,以 close code 1002 断开。
- **Ping/pong 走协议。** 源站的应用层 ping 在同一条连接上回 pong。源站关闭时,桥干净地关掉客户端套接字(code 1000),不留悬挂连接。
- **写入串行化。** 源站侧套接字只有一条 promise 链式 writer,客户端侧并发读不会把写操作插进帧中间。
- **失败可诊断。** `wrangler tail` 在镜像网络下不可用(tail 的 WebSocket 连不上),桥把异常名和消息写进 WebSocket close reason(截断到 120 字节),任何 WebSocket 客户端都看得到。

## 本项目做了什么

vendored 引擎提供了隧道核心和管理面板。以下内容为本仓库原创。这是一份相对上游的事实清单,不是功能广告——每一项存在的理由都是一个具体的缺口或缺陷。

**订阅治理(`src/subscription/`)**

- **多源合并与归一化。** `/sub/all` 拉取两个 vendored 引擎的输出加一个内置节点池,自动识别载荷格式(base64 链接列表 vs Clash YAML),统一归一成一份 Clash 文档,按节点名去重。
- **假国家节点剥离。** vendored 引擎把请求者的 `cf.country` + ASN 写进节点名(如 `CF移动优选-CN-…`)。anycast 边缘 IP 没有国家级归属——这个标签是误导,而且同一批 IP 在不同请求者眼里叫不同名字。`stripFakeCountryNodes` 把这些代理及其 Trojan 孪生从 proxies 段和所有 proxy-group 引用里移除。
- **稳定命名的节点池。** `cidr.ts` 从 Cloudflare 公开 CIDR 空间抽样,按**实测落地 colo** 分桶(桶映射来自真实家宽的 `curl --resolve` + `/cdn-cgi/trace` 探测,不是 geoip 猜测——geoip 回答的是注册国,对 CF 段几乎全错),节点命名为 `{大区}-{机房}-{序号}`。`geo.ts` 把池子在 KV 里缓存 6 小时,客户端的测速结果在两次订阅刷新之间保持有效。
- **订阅 token 鉴权。** 订阅端点只应答 `MD5MD5(host + UUID)`。MD5 和截断式双重 MD5 都在本地实现,因为 Workers 运行时的 `crypto.subtle` 不提供 MD5。

**网页代理加固(`src/proxy-web/`)**

- **解析后 hostname 的 SSRF 校验**,如上所述——常见设计里的字符串字面量检查能被 IPv4 替代编码绕过。
- **Cookie 隔离与还原。** 目标站点的 Cookie 加按站点前缀的命名空间,两个站点读不到彼此的 Cookie;`__Host-` 和 `__Secure-` 前缀 Cookie 还原时保留其必需属性。
- **处处有界内存**(5 MB 重写上限、延迟缓存写入、16 MB WS 帧)。
- **`PROXY_KEY` 恒定时间比较。** 鉴权闸用「长度检查 + XOR 累积」而不是 `===`,`?key=` 和 `Cookie` 两条路径都支持。
- **JS 导航救援**(见上),上游面板没有这个能力。

**Agent 网关(`src/gateway/`)**

- 给脚本和 Agent 用的小型 JSON 抓取 API:`GET /api/v1/fetch/<目标url>`,`X-API-Key` 鉴权,健康检查端点,hop-by-hop 头剥离,`cf-*`/`x-forwarded-*` 移除,以及值级擦除——转发前把 API key 从请求里剥掉,不泄给目标站。

**测试套件**

- 232 个测试,两个 Vitest 池(173 Node + 59 workers-runtime/miniflare),覆盖 SSRF 编码、WS 帧编解码(掩码位、全部长度类别、续帧、操作码保留)、订阅合并/剥离、DoH wire format 往返、导航救援。帧编解码测试存在的原因:原实现零覆盖,掩码位要求是对照 RFC 逐条验证的。

## 能力边界

直说,省得在生产里才发现:

- **网页代理不执行 JavaScript。** 靠客户端渲染的站点(多数 SPA)经 `/proxy/*` 打不开正常样子。静态站和服务端渲染的站没问题。
- **匿名性不是这个系统的属性。** Worker 的出口 IP 是 Cloudflare 共享地址;第三方看到 Cloudflare 而不是你——但 Cloudflare 看得到一切,部署实例的运营者也看得到一切。把它当中继,别当匿名工具。
- **Worker 运行时限制持久化。** 没有常驻进程:页面缓存按 colo 隔离,KV 是最终一致,节点池刷新尽力而为。
- **订阅输出依赖 vendored 引擎的响应格式。** 上游改格式,`/sub/*` 就挂,得等 vendor 升级。
- **WS 桥要求可掩码、未鉴权的源站。** 带 Cookie 鉴权的端点由客户端自行处理。
- **ECH(加密 ClientHello)和后量子 TLS 不在范围内。** 边缘用部署域名的证书终结 TLS,Worker 栈改变不了边缘协商什么。
- **不适合高吞吐中继。** Workers 免费额度(每天 10 万请求)和 CPU 限制决定了这是个人工具体量。重中继用途会烧完配额,连累同一 Worker 上的其他路径。

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

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Cloudflare Workers(TypeScript) |
| HTML 重写 | `HTMLRewriter`(流式,无 DOM) |
| 套接字 | `cloudflare:sockets` TCP + WebSocketPair |
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

`vendor/` 只读:更新就是替换文件、更新头部的 pinned commit。其余一切都在 `src/`,且有测试覆盖。

## 更新 vendored 引擎

1. 下载新的上游 `_worker.js`。
2. 替换 vendor 文件。保留来源头注释,更新 pinned commit / 版本行。
3. 跑 `npx tsc --noEmit && npx vitest run`——全绿再部署。

## 仓库规则

`lingion/Tunnel-CFP` 是本项目唯一上游。镜像和 fork 不作为主入口。

## 免责声明

本项目仅供**学习、研究与技术交流**使用,是一个基于 Cloudflare Workers 平台的通用网络编程工具集。

下载、部署或使用本项目,即表示你已知悉并同意:

1. **合法使用由你自行负责。** 使用者必须遵守所在国家/地区的法律法规,以及部署平台(包括 Cloudflare 服务条款)的相关规定;因使用目的需要的授权由使用者自行取得。
2. **不用于任何非法用途。** 严禁将本项目用于违反适用法律的任何活动,包括但不限于:在法律禁止的场景下规避网络访问控制、未授权访问计算机系统、传播违法信息、侵犯知识产权、破坏网络服务等。作者不支持、不认可、不鼓励任何此类用途。
3. **不提供任何担保。** 本项目按"现状"提供,不附带任何明示或默示的保证。对使用或滥用本项目导致的任何直接或间接损失、数据丢失、服务封禁、账号终止或法律后果,作者与贡献者不承担责任。
4. **流量内容与作者无关。** 部署实例转发的全部流量由部署者及其用户产生,项目作者无法接触、不存储、不监控任何实例的流量。
5. **研究或测试完成后,建议自行删除部署。**

如不同意以上条款,请勿下载或使用本项目。

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
