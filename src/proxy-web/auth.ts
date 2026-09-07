// src/proxy-web/auth.ts
// /proxy 与 /proxy-ws 的可选用量闸:
// wrangler [vars] PROXY_KEY=<secret> 配置后,所有代理请求必须带
//   ?key=<PROXY_KEY> 或 Cookie: __proxy_key=<PROXY_KEY>
// 未配置 = 开放(个人自用场景);配置 = 拒绝无凭证请求,防被当公开代理滥用。
// 注意:CF Worker 的 fetch handler 拿不到 [vars] 之外的动态配置,由 router 传入。

export function checkProxyAuth(request: Request, env: { PROXY_KEY?: string }): Response | null {
  const key = env.PROXY_KEY;
  if (!key) return null; // 未启用

  // 恒定时间比较:长度先泄(len 差异本身可见),逐字节 XOR 累积,
  // 短路退出即 timing oracle(workers 网络抖动可淹没,但成本为零顺手修)
  const safeEqual = (a: string, b: string): boolean => {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  };

  const url = new URL(request.url);
  const qk = url.searchParams.get('key');
  if (qk && safeEqual(qk, key)) return null;

  const cookie = request.headers.get('Cookie') ?? '';
  for (const part of cookie.split(/;\s*/)) {
    if (part.startsWith('__proxy_key=') && safeEqual(part.slice('__proxy_key='.length), key)) return null;
  }

  return new Response('Proxy requires auth key', { status: 401 });
}
