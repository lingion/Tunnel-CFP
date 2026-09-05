// src/proxy-web/security-bridge.ts
// WS 桥目标校验:与 HTTP 代理同级的 SSRF/回环防护

import { SELF_HOSTS } from './security';

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/;
const IPV6_HOST_REGEX = /^\[[0-9a-f:]+\]/i;

export function validateBridgeTarget(hostPort: string): void {
  const hostname = hostPort.startsWith('[')
    ? (hostPort.match(/^\[[^\]]+\]/)?.[0] ?? hostPort).toLowerCase()
    : hostPort.split(':')[0]!.toLowerCase();

  for (const self of SELF_HOSTS) {
    if (hostname === self || hostname.endsWith('.' + self)) {
      throw new Error('Self recursion detected');
    }
  }
  if (IPV4_REGEX.test(hostPort) || IPV6_HOST_REGEX.test(hostname) || IPV6_HOST_REGEX.test(hostPort)) {
    throw new Error('Direct IP access blocked');
  }
  // 云元数据端点按名拦截(IP 形式已被上面挡)
  if (hostname === 'metadata.google.internal' || hostname.endsWith('.internal')) {
    throw new Error('Internal hostname blocked');
  }
}
