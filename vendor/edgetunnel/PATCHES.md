# 我们对 edgetunnel vendor 的补丁

## b3d1fb3 (历史，commit 已落 main)

- 命名补丁：常量/变量从英文转中文（CamelCase）
  - `WS_READY_STATE_OPEN` → `WS就绪状态打开`
  - `earlyDataHeader` → `早期数据头`
  - `processHeader` → `处理请求头`
  - 等 200+ 标识符
- 同步保留 proxyIP geo naming 补丁（cf.country/.asn 注入）

## 未来补丁规则

- 不再 cherry-pick 上游 commit
- 手动 fork 修改 = 整文件替换
- 每次替换必更新 README 顶部三行注释 + CHANGELOG