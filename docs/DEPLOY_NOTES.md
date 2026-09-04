# cfp Worker 部署记录

## 部署时间
2026-09-04

## Worker 身份
- 名称：`cfp`
- URL：https://cfp.lingion04.workers.dev
- Version ID：`cd867e52-5c6c-4dfc-8516-b0445fa6abac`

## 资源
- Account ID：`07401407fe88e9e8ce61d54ea0e385f3`
- KV namespace：`e724e1591a33423ea603114a42f65984` (binding `cfp_KV`)
- UUID：`b88ab8fa-392c-44b3-9343-612c11814708`

## Secrets
本地备份：`~/.proxy-cfp-secrets.env`（chmod 600）
- `CFP_KEY` — vendor edgetunnel 用
- `CFP_AGENT_KEY` — Agent API 鉴权
- `ADMIN`（= `lingion`）— 管理操作

## 部署命令
```bash
export CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare-token)
cd ~/proxy-v3
npx wrangler secret put ADMIN -c wrangler.cfp.toml
npx wrangler secret put KEY -c wrangler.cfp.toml
npx wrangler secret put AGENT_KEY -c wrangler.cfp.toml
npx wrangler deploy -c wrangler.cfp.toml
```

## 端到端验证
- 部署成功（CF API 确认 Worker live + observability enabled）
- 本地网络访问 https://cfp.lingion04.workers.dev 被防火墙拦截（与 example.com / workers.dev 一致，非部署问题）
- 76 个 vitest 测试全绿（v3 router 6 + DoH 15 + Web Proxy 25 + Subscription 9 + 原 v2 21）
- TypeScript typecheck 0 errors

## 验证清单（待非防火墙环境执行）
- [ ] `GET https://cfp.lingion04.workers.dev/api/v1/health` → 200 JSON `{status: "ok"}`
- [ ] `GET https://cfp.lingion04.workers.dev/dns-query?dns=<base64url-no-pad>` → 200 application/dns-message
- [ ] `GET https://cfp.lingion04.workers.dev/resolve?name=example.com&type=A` → 200 application/dns-json
- [ ] `GET https://cfp.lingion04.workers.dev/sub/all` → 200 text/yaml（双 vendor 合并）
- [ ] `GET https://cfp.lingion04.workers.dev/proxy/<encoded-target>` → 200 text/html 重写

## 资源大小
- Bundle: 702.46 KiB raw / 138.86 KiB gzipped
- Vendored JS 占比: edgetunnel 321KB + yonggekkk 72KB

## 后续事项
- 用户环境若防火墙解封，执行验证清单
- 若需自定义域名，需在 CF Dashboard 添加 + 配置 routes
- Vendor 升级时手动 fork 替换（vendor 完全脱钩 upstream）