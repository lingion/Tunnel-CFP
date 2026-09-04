# proxy

单 Cloudflare Worker：`/api/*` 走自建 gateway（Agent 转发 + 鉴权 + 流式直通），其余路径委派给 vendored edgetunnel（VLESS 节点 + 面板 + 订阅）。

- 线上地址：`https://proxy.qdp.qzz.io`（custom domain）
- Worker 名：`proxy`
- 入口：`src/index.ts`；gateway 源码：`src/gateway/`；vendored 上游：`vendor/edgetunnel/_worker.js`

## 部署

前置：`~/.cloudflare-token` 存放有效的 CLOUDFLARE_API_TOKEN。

```bash
# 1. KV namespace（首次部署执行一次；已创建则跳过）
export CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare-token)
npx wrangler kv namespace create KV
# 把输出 id 填入 wrangler.toml 的 kv_namespaces[0].id

# 2. typecheck + 全测试
npx tsc --noEmit && npx vitest run

# 3. 部署（routes 已在 wrangler.toml：proxy.qdp.qzz.io custom domain）
npx wrangler deploy

# 4. 注入 secrets（值在 ~/.proxy-secrets.env，本地 600 权限）
source ~/.proxy-secrets.env
echo "$ADMIN"     | npx wrangler secret put ADMIN
echo "$AGENT_KEY" | npx wrangler secret put AGENT_KEY
```

部署验收（spec 成功标准 1/2）：

```bash
curl -s https://proxy.qdp.qzz.io/api/v1/health
# {"status":"ok","colo":"...","ts":...}

curl -s -o /dev/null -w "%{http_code}\n" https://proxy.qdp.qzz.io/api/v1/fetch/https://example.com   # 401
curl -s -o /dev/null -w "%{http_code}\n" -H "X-API-Key: $AGENT_KEY" \
  https://proxy.qdp.qzz.io/api/v1/fetch/https://example.com                                          # 200
```

## Agent 调用示例

所有 gateway 端点带 `X-API-Key` 头（或 `?key=` query），key 即 `~/.proxy-secrets.env` 里的 `AGENT_KEY`。

转发任意 URL（路径后直接拼目标 URL，query 原样透传）：

```bash
curl -H "X-API-Key: $AGENT_KEY" https://proxy.qdp.qzz.io/api/v1/fetch/https://example.com
curl -N -H "X-API-Key: $AGENT_KEY" "https://proxy.qdp.qzz.io/api/v1/fetch/https://httpbin.org/drip?duration=3&numbytes=3"
```

Claude Code 环境变量法（把 ANTHROPIC_BASE_URL 指到本地反向代理时，同款思路用 fetch 端点转发 Anthropic API）：

```bash
export ANTHROPIC_BASE_URL="https://proxy.qdp.qzz.io/api/v1/fetch/https://api.anthropic.com"
export ANTHROPIC_AUTH_TOKEN="<你的上游token>"
# 客户端请求 https://api.anthropic.com/v1/messages
# → 经 https://proxy.qdp.qzz.io/api/v1/fetch/https://api.anthropic.com/v1/messages 转发，流式直通
```

服务自述：`GET /api/v1`（无鉴权）返回 endpoints 列表；`GET /api/v1/health` 返回健康状态。

## 客户端订阅

edgetunnel 面板与订阅在 tunnel 侧（非 `/api/*` 路径）：

1. 浏览器打开 `https://proxy.qdp.qzz.io/login`，输入面板密码（`~/.proxy-secrets.env` 的 `ADMIN`）。
2. 面板内生成/复制订阅链接（形如 `https://proxy.qdp.qzz.io/sub?token=...`）。
3. 客户端（Clash / Shadowrocket / v2rayN 等）添加订阅 URL 即可；`target=clash` 等参数用法以面板生成为准。

手工添加 VLESS 节点（订阅不可用时的兜底）：

- 地址：`proxy.qdp.qzz.io`
- 端口：`443`
- 传输：WebSocket（ws），TLS 开启
- UUID：见 `wrangler.toml` `[vars] UUID`
- ws 路径与其它参数以面板生成的节点配置为准

## vendor 升级流程

edgetunnel 上游更新时，替换 vendored 文件并保持委派方式不变：

1. 从上游仓库（cmliu/edgetunnel）取最新 `_worker.js`，覆盖 `vendor/edgetunnel/_worker.js`。
2. 在文件头部更新注释：上游版本号/commit 与替换日期（vendored JS 零修改，除头部注释外不做任何改动）。
3. `npx tsc --noEmit && npx vitest run` 全绿后 `npx wrangler deploy`。
4. 线上冒烟四项（health / 401 / 200 / `/` 返回 tunnel 页）确认 tunnel 侧未被破坏。

注意：上游的 DO（Durable Object）导出不被本项目使用——`wrangler.toml` 不声明 DO 段，若升级后校验报 DO 相关错误，确认 `_worker.js` 中 DO 类未被入口要求即可。
