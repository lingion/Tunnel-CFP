// src/proxy-web/security.ts
// 防护：
//   1. 自递归（防止 /proxy/cfp... 无限循环）
//   2. 直连 IP（防 SSRF 到 169.254.169.254 / 127.0.0.1 等）
//   3. 协议白名单（仅 http/https）

export const SELF_HOST = 'cfp.lingion04.workers.dev';
const IPV4_REGEX = /^https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
const IPV6_HOST_REGEX = /^\[[0-9a-f:]+\]/i;

export class SecurityError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = 'SecurityError';
  }
}

export function validateTargetUrl(target: string): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new SecurityError('Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SecurityError(`Unsupported protocol: ${url.protocol}`);
  }

  if (url.hostname === SELF_HOST || url.hostname.endsWith('.' + SELF_HOST)) {
    throw new SecurityError('Self recursion detected');
  }

  if (IPV4_REGEX.test(target) || IPV6_HOST_REGEX.test(url.hostname)) {
    throw new SecurityError('Direct IP access blocked');
  }
}