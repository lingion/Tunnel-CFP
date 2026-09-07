// src/proxy-web/security.ts
// 防护：
//   1. 自递归（防止 /proxy/cfp... 无限循环）
//   2. 直连 IP / 内网段 / 云元数据(防 SSRF 到 169.254.169.254 / 127.0.0.1 等)
//   3. 协议白名单（仅 http/https）
//
// 校验口径:必须基于 new URL() **解析后的 hostname**,不能基于原始字符串字面量 —
// http://2130706433/ http://0x7f000001/ http://0177.0.0.1/ http://127.1/ 这类
// 整数/十六进制/八进制/短形式 IPv4 会被 URL 解析器规约成点分十进制,
// 字面量正则对它们全部漏判(审计实锤),而 fetch 实际打的就是解析后的 host。

// 自递归黑名单:部署后把你的自定义域 + workers.dev 域都加进来
// (/proxy/ 指向自己会形成回环,worker 会自食流量)
export const SELF_HOSTS = ['your-worker.your-subdomain.workers.dev'];

export class SecurityError extends Error {
  constructor(public reason: string) {
    super(reason);
    this.name = 'SecurityError';
  }
}

/** hostname 是否为 IPv4 点分十进制(含每段 0-255 校验;0x/0 前缀变体在解析后已是十进制) */
function isDottedQuad(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * host(解析后)是否属内网/保留/环回段。
 * RFC 1918 + loopback + link-local + 0.0.0.0/8 + CGNAT 100.64/10 + benchmark 198.18/15。
 */
function isPrivateIPv4(hostname: string): boolean {
  if (!isDottedQuad(hostname)) return false;
  const [a, b] = hostname.split('.').map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, loopback
  if (a === 169 && b === 254) return true; // link-local (含 169.254.169.254 云元数据)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  return false;
}

/**
 * 对**解析后的 hostname**做 SSRF 防护(供 HTTP 代理与 WS 桥共用)。
 * 注意:传入前先用 new URL() 解析 — 整数/十六进制 IPv4 传入 URL 构造器后
 * .hostname 已是点分十进制,这里统一按最终形态判定。
 */
export function validateResolvedHost(hostname: string): void {
  const h = hostname.toLowerCase().replace(/\.$/, ''); // FQDN 尾点归一

  for (const self of SELF_HOSTS) {
    if (h === self || h.endsWith('.' + self)) {
      throw new SecurityError('Self recursion detected');
    }
  }

  // IPv6 字面量(含 IPv4-mapped [::ffff:127.0.0.1])
  if (/^\[[0-9a-f:]+\]$/i.test(h)) {
    throw new SecurityError('Direct IP access blocked');
  }

  if (isDottedQuad(h)) {
    // 任何形态的 IPv4 直连一律拒绝(含公网 IP — 代理语义按域名走)
    throw new SecurityError('Direct IP access blocked');
  }

  // 云元数据 / 内网域名(bridge 与 web 两层此前口径不一)
  if (h === 'localhost' || h.endsWith('.localhost')) {
    throw new SecurityError('Localhost blocked');
  }
  if (h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.home.arpa')) {
    throw new SecurityError('Internal hostname blocked');
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

  // 全部基于解析后的 hostname(整数/十六进制/八进制 IPv4 在这里已是点分十进制)
  validateResolvedHost(url.hostname);
}
