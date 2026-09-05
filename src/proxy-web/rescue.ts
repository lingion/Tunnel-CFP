// src/proxy-web/rescue.ts
// 导航救援:JS 里 location.href = "/path" 这类相对赋值无法在 shim 层拦截
// (赋值语法不可钩),浏览器会直接请求 cfp 域的 /path → 原本 404。
// 此处按 Referer(指向 cfp 域/proxy/https://目标站/…)推断来源目标站,
// 302 把浏览器带回到 /proxy/形态 — 一次额外跳转,换 SPA 站内 JS 导航全通。

import { validateTargetUrl, SELF_HOSTS } from './security';

/**
 * 判定一个"未代理形态"的请求是否能救援。
 * 返回 302 Response; null = 不适用(照常 404)。
 */
export function rescueNavigation(request: Request): Response | null {
  const url = new URL(request.url);

  // WS 升级请求不救援(edgetunnel 面板的 /connect WS 通道同源带 Referer,
  // 302 对 WS 握手 = 直接连不上;审计实锤劫持面)
  const upgrade = request.headers.get('Upgrade');
  if (upgrade && /websocket/i.test(upgrade)) return null;

  // 已知自有路径不动(router 层的 /api /sub /dns-query /proxy /proxy-ws 不会走到这)
  const referer = request.headers.get('Referer');
  if (!referer) return null;

  // Referer 必须指向任一自有域,且形态为 /proxy/<scheme>://<host><path>
  let refUrl: URL;
  try {
    refUrl = new URL(referer);
  } catch {
    return null;
  }
  const isSelf = SELF_HOSTS.some(
    (h) => refUrl.hostname === h || refUrl.hostname.endsWith('.' + h),
  );
  if (!isSelf) return null;

  const m = refUrl.pathname.match(/^\/proxy\/(https?):\/\/([^/?#]+)(.*)$/i);
  // 浏览器同源导航的 Referer 默认只送 origin(strict-origin-when-cross-origin),
  // 无 /proxy/ 路径信息 → 从 shim 维护的 __proxy_last_host cookie 取上次目标站
  let targetOrigin: string;
  if (m) {
    targetOrigin = `${m[1]}://${m[2]}`;
  } else {
    // 无 /proxy/ 形态 Referer(如 edgetunnel 面板自身路径)时,只有显式带
    // cookie 才救 — 面板 fetch 场景 Referer 同源自带,旧 cookie 存留会把
    // 面板 API 全部 302 打进代理(审计实锤),这里靠 upgrade 拦截 + 收紧放行
    const cookie = request.headers.get('Cookie') ?? '';
    const cm = cookie.match(/(?:^|;\s*)__proxy_last_host=([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
    if (!cm) return null;
    targetOrigin = `https://${cm[1]}`;
  }
  const rescueTarget = `${targetOrigin}${url.pathname}${url.search}`;

  try {
    validateTargetUrl(rescueTarget);
  } catch {
    return null;
  }

  // 透传 PROXY_KEY query(cookie 通道自动随域) — 启用 key 时否则救援 302 落到 401
  const key = url.searchParams.get('key');
  const location = `/proxy/${rescueTarget}${key ? `?key=${encodeURIComponent(key)}` : ''}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
    },
  });
}
