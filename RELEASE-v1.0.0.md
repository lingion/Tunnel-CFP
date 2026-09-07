# Tunnel-CFP v1.0.0

> First public release: a single Cloudflare Worker that bundles VLESS tunnel, subscription aggregator with real-country bucketing, DoH (RFC8484 + JSON API), web proxy with WS bridge, and DNS-over-HTTPS.

## What's New

### Subscription — real-country bucketing

- Vendor `edgetunnel` produces CF anycast IPs whose registered country rarely matches where the IP physically terminates. We now classify each node by **IP geolocation** via `ip-api.com /batch` and a Workers KV cache (24h TTL).
- Two-tier grouping
    - Primary groups (🇨🇳 CN, 🇭🇰 HK, 🇯🇵 JP, 🇸🇬 SG, 🇹🇼 TW, 🇺🇸 US, 🇬🇧 GB) — fastest perceived routes
    - Secondary groups (DE / FR / IT / NL / SE / CA / BR / IN / KR / AU / RU / ZA / MX / ES / AE / TH / VN / MY / PH / ID / SA / TR) — 22 country buckets
- CF-segment local CIDR mapping (APAC-HKG, NA-LAX, NA-SEA) overrides ip-api's incorrect `CA` classification for CF anycast edges — verified with 50 IPs sampled from the vendor's CIDR list.
- 29 country groups are **always present** in the output; empty buckets use `type: select` so Clash never crashes on `url-test` / `fallback` against zero proxies.

### Web proxy

- Round 1-5: navigation rescue on 30x, BASE tag capture timing, JS string-URL rewriting, CF RUM beacon suppression, form.submit hooks, 302 semantics, header hygiene, usage gates, WS handshake validation.
- Round 6 adversarial audit fixes: SSRF allowlist parsing, WS bridge RFC compliance, bounded buffers, prefix-misclassification for cookie names, `waitUntil` cache cleanup.

### DoH

- RFC 8484 (Wire) and JSON API both pass conformance. GET and POST both supported, `ct` parameter negotiation, response body framing per RFC.

### Misc

- README rewritten in bilingual EN/中 with explicit capability boundaries and legal disclaimer.
- All internal identifiers sanitized before open-source.

## Fixes

- ip-api BATCH endpoint was being called with the legacy `json/batch` path — now uses the documented `/batch` route.
- geoip KV TTL set to 24h to stay within free-tier quota while still respecting upstream freshness.
- Trojan transport dropped — all output is now VLESS-only.
- 6 cookie-name prefix misclassifications resolved.
- `waitUntil` cache no longer leaks across unrelated requests.

## Known Limitations

- **TW / KR / SG / CN PRIMARY groups are physically empty** for the `edgetunnel` vendor — these regions don't terminate CF anycast at colo edges the vendor exposes. The groups are still emitted; users in those regions will fall back to 🌍 OTHER.
- Subscription aggregation requires 1 KV read per unique IP per 24h; first request to a new IP is ~250ms slower while geoip resolves.

## Verification

- Tests: 193 cases, 0 fail, 0 error
- Test files: 18 (subscription, proxy-web, doh, router, auth, proxy)
- Build: `wrangler 4.44.0`, compatibility date `2025-09-01`
- Deployed URL: `https://proxy.lingion04.workers.dev` (note: `workers.dev` is intermittently blocked — verify via mirror or your existing routes)
- Bundle: 775.53 KiB / gzip 160.39 KiB
- KV namespace: bound at deploy time

---

# Tunnel-CFP v1.0.0

> 首次公开 release：单一 Cloudflare Worker 集成 VLESS 隧道、按 IP 真实国家分桶的订阅聚合、DoH（RFC8484 + JSON API）、WS 桥 web 代理和 DNS-over-HTTPS。

## 新增功能

### 订阅 —— 按 IP 真实归属分桶

- vendor `edgetunnel` 输出的是 CF anycast IP，注册国家很少与物理落点一致。现在通过 `ip-api.com /batch` + Workers KV 缓存（24h TTL）按 IP 地理定位分类每个节点。
- 两级分组
  - 主要分组（🇨🇳 CN、🇭🇰 HK、🇯🇵 JP、🇸🇬 SG、🇹🇼 TW、🇺🇸 US、🇬🇧 GB）—— 最快感知路径
  - 次要分组（DE / FR / IT / NL / SE / CA / BR / IN / KR / AU / RU / ZA / MX / ES / AE / TH / VN / MY / PH / ID / SA / TR）—— 22 个国家桶
- CF 段本地 CIDR 映射（APAC-HKG、NA-LAX、NA-SEA）覆盖 ip-api 对 CF anycast 边缘错误归类为 `CA` 的问题 —— 用 vendor CIDR 列表采样的 50 个 IP 验证通过。
- 29 个国家分组**始终存在**；空桶用 `type: select`，避免 Clash 在零代理时 url-test / fallback 崩溃。

### Web 代理

- Round 1-5：30x 导航救援、BASE tag 捕获时序、JS 字符串 URL 重写、CF RUM beacon 抑制、form.submit 钩子、302 语义、头卫生、用量闸、WS 握手校验。
- Round 6 对抗审计修复：SSRF allowlist 解析、WS 桥 RFC 合规、有界缓冲、cookie 名前缀误判、`waitUntil` 缓存清理。

### DoH

- RFC 8484（Wire）和 JSON API 全部合规。GET 与 POST 均支持，`ct` 参数协商，响应 body framing 按 RFC。

### 其他

- README 改写为中英双语，明示能力范围与法律免责声明。
- 开源前所有内部标识符脱敏。

## 修复

- ip-api BATCH 接口原本走遗留 `json/batch` 路径 —— 改为文档化的 `/batch` 路由。
- geoip KV TTL 设为 24h，在免费层配额内同时尊重上游时效。
- Trojan 传输协议移除 —— 输出统一 VLESS-only。
- 6 处 cookie 名前缀误判已修复。
- `waitUntil` 缓存不再跨无关请求泄漏。

## 已知限制

- **TW / KR / SG / CN PRIMARY 分组对 `edgetunnel` vendor 物理为空**——这些区域 vendor 没有暴露 CF anycast colo 落点。分组仍会输出，这些区域的用户会回落到 🌍 OTHER。
- 订阅聚合每个唯一 IP 24h 需 1 次 KV 读；新 IP 首次请求解析 geoip 时慢约 250ms。

## 验证

- 测试：193 用例，0 失败，0 错误
- 测试文件：18（subscription、proxy-web、doh、router、auth、proxy）
- 构建：`wrangler 4.44.0`，compatibility date `2025-09-01`
- 部署 URL：`https://proxy.lingion04.workers.dev`（提示：`workers.dev` 在国内偶有阻断，请通过镜像或你已有路由验证）
- 包大小：775.53 KiB / gzip 160.39 KiB
- KV namespace：部署时绑定