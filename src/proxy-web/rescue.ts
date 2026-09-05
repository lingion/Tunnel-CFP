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
    const cookie = request.headers.get('Cookie') ?? '';
    const cm = cookie.match(/(?:^|;\s*)__proxy_last_host=([^;]+)/);
    if (!cm) return null;
    targetOrigin = `https://${cm[1]!.trim()}`;
  }
  const rescueTarget = `${targetOrigin}${url.pathname}${url.search}`;

  try {
    validateTargetUrl(rescueTarget);
  } catch {
    return null;
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: `/proxy/${rescueTarget}`,
      'Cache-Control': 'no-store',
    },
  });
}
