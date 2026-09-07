# 我们对 yonggekkk vendor 的补丁

## v0.1.0（首次 commit）

- 直接取 readable 版本 `_worker明.js`（无 obfuscation 痕迹），无需 deobfuscate
- 计划 Step 5「手工重命名」跳过：变量名已经是人类可读（`vlessOverWSHandler`, `processcloudflareHeader`, `makeReadableWebSocketStream` 等）
- 计划 Step 6「混淆版 vs deob 版一致性测试」跳过：使用 readable 版本而非 deob 重构版