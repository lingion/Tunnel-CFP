// src/proxy-web/security-bridge.ts
// WS 桥目标校验:与 HTTP 代理同级的 SSRF/回环防护
// 与 web 侧共用 validateResolvedHost(解析后 hostname 口径),消除两层规则漂移

import { validateResolvedHost } from './security';

export function validateBridgeTarget(hostPort: string): void {
  const hostname = hostPort.startsWith('[')
    ? (hostPort.match(/^\[[^\]]+\]/)?.[0] ?? hostPort).toLowerCase()
    : hostPort.split(':')[0]!.toLowerCase();

  // 整数/十六进制 IPv4 传入 URL 解析器已规约为点分十进制;这里 host 形态
  // 可能是 127.1 这类短形式 — 交给解析口径统一拦截(补 URL 归一)
  try {
    validateResolvedHost(new URL(`http://${hostPort}`).hostname);
  } catch (e) {
    throw e instanceof Error && e.name === 'SecurityError'
      ? e
      : new Error('Invalid bridge host');
  }
}
