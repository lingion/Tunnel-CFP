// src/proxy-web/handler.ts
// /proxy/<encoded target url> 完整 HTML/CSS 重写代理
// HTML → 属性/样式/shim 全量重写;CSS → body 内 url()/@import 重写;其他 → 透传
import { createRewriter } from './rewriter';
import { rewriteCssUrls } from './url-resolver';
import { validateTargetUrl, SecurityError } from './security';
import type { WebProxyContext } from './types';

export async function handleWebProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // path = /proxy/<encoded target url> (URI-encoded)
  const encoded = url.pathname.slice('/proxy/'.length);
  if (!encoded) {
    return new Response('Missing target URL after /proxy/', { status: 400 });
  }

  let target: string;
  try {
    target = decodeURIComponent(encoded);
  } catch {
    return new Response('Invalid URL encoding', { status: 400 });
  }

  try {
    validateTargetUrl(target);
  } catch (e) {
    if (e instanceof SecurityError) {
      return new Response(`Security error: ${e.message}`, { status: 400 });
    }
    throw e;
  }

  // 转发请求到目标,透传 method/headers/body
  const targetRes = await fetch(target, {
    method: request.method,
    headers: sanitizeOutgoingHeaders(request.headers, target),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.clone().arrayBuffer(),
    redirect: 'follow',
  });

  const contentType = targetRes.headers.get('Content-Type') || '';
  // redirect: 'follow' 后,res.url 是最终 URL(可能和 target 不同,如 http→https / 302)
  const finalUrl = targetRes.url || target;

  // HTML → 全量重写
  if (contentType.includes('text/html')) {
    return transformHtml(targetRes, finalUrl);
  }

  // CSS → 重写 body 内的 url()/@import
  if (contentType.includes('text/css')) {
    return transformCss(targetRes, finalUrl);
  }

  // 其他资源(图片/字体/JS/JSON…)→ 透传
  return passThrough(targetRes);
}

async function transformHtml(targetRes: Response, finalUrl: string): Promise<Response> {
  const targetUrl = new URL(finalUrl);
  const ctx: WebProxyContext = {
    currentOrigin: `${targetUrl.protocol}//${targetUrl.host}`,
  };

  const newHeaders = cleanResponseHeaders(targetRes);

  // 注入 shim 配置(目标站 origin),供运行时解析相对 URL
  const baseInject = new HTMLRewriter().on('head', {
    element(el: any) {
      el.prepend(
        `<script>window.__PROXY_BASE__ = ${JSON.stringify(ctx.currentOrigin)};</script>`,
        { html: true },
      );
    },
  }).transform(targetRes);

  const rewriter = createRewriter(ctx);
  const transformed = rewriter.transform(baseInject);
  // HTMLRewriter.transform 不改变 body 长度无关性,但内容已变 → 必须不带 content-length
  return new Response(transformed.body, {
    status: targetRes.status,
    headers: newHeaders,
  });
}

async function transformCss(targetRes: Response, finalUrl: string): Promise<Response> {
  const targetUrl = new URL(finalUrl);
  const ctx: WebProxyContext = {
    currentOrigin: `${targetUrl.protocol}//${targetUrl.host}`,
  };
  const css = await targetRes.text();
  const rewritten = rewriteCssUrls(css, ctx);
  const newHeaders = cleanResponseHeaders(targetRes);
  newHeaders.delete('Content-Length');
  return new Response(rewritten, {
    status: targetRes.status,
    headers: newHeaders,
  });
}

function passThrough(targetRes: Response): Response {
  return new Response(targetRes.body, {
    status: targetRes.status,
    headers: cleanResponseHeaders(targetRes),
  });
}

/** 响应头清洗:CSP/XFO/嵌入限制剥离 + cookie 命名空间隔离 + 长度头修正 */
function cleanResponseHeaders(targetRes: Response): Headers {
  const newHeaders = new Headers(targetRes.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  // 去掉目标站点的 CSP/X-Frame-Options,否则代理页面被自身规则锁住
  newHeaders.delete('Content-Security-Policy');
  newHeaders.delete('Content-Security-Policy-Report-Only');
  newHeaders.delete('X-Frame-Options');
  // 跨域隔离头会让浏览器把代理页当跨源隔离文档处理,剥掉
  newHeaders.delete('Cross-Origin-Opener-Policy');
  newHeaders.delete('Cross-Origin-Embedder-Policy');
  newHeaders.delete('Cross-Origin-Resource-Policy');
  // 内容被重写后长度必变;透传时 body 虽原样但 Workers 会自动处理,保留会与实际不符
  newHeaders.delete('Content-Length');
  isolateCookies(newHeaders);
  return newHeaders;
}

/**
 * Cookie 隔离:多个目标站的 Set-Cookie 都打到 cfp 域名会互相覆盖。
 * 按 cookie 名 + 目标站 host 哈希加前缀,请求发回时还原(handler 的 sanitizeOutgoingHeaders 反向处理)。
 */
const COOKIE_PREFIX = '__pw_';

function isolateCookies(headers: Headers): void {
  // Workers Headers 支持 getSetCookie (多人 cookie);旧类型没标,走 any 取
  const h = headers as any;
  const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
  if (setCookies.length === 0) return;
  headers.delete('Set-Cookie');
  for (const sc of setCookies) {
    const eq = sc.indexOf('=');
    if (eq <= 0) continue;
    const name = sc.slice(0, eq).trim();
    const rest = sc.slice(eq + 1);
    // Path/Domain 保持,名字加前缀
    headers.append('Set-Cookie', `${COOKIE_PREFIX}${name}=${rest}`);
  }
}

function unisolateCookies(headers: Headers, targetHost: string): Headers {
  const out = new Headers();
  for (const [k, v] of headers.entries()) {
    const lower = k.toLowerCase();
    if (lower === 'cookie') {
      // 把 __pw_<name> 还原成 <name> 发给目标站
      const parts = v.split(/;\s*/).filter(Boolean);
      const restored = parts.map((p) => {
        const eq = p.indexOf('=');
        const name = eq > 0 ? p.slice(0, eq).trim() : p;
        if (name.startsWith(COOKIE_PREFIX)) {
          return `${name.slice(COOKIE_PREFIX.length)}${p.slice(eq)}`;
        }
        return p;
      });
      out.set(k, restored.join('; '));
      continue;
    }
    out.set(k, v);
  }
  return out;
}

function sanitizeOutgoingHeaders(headers: Headers, target: string): Headers {
  const targetHost = new URL(target).host;
  const out = unisolateCookies(headers, targetHost);
  for (const [k, v] of Array.from(out.entries())) {
    const lower = k.toLowerCase();
    // 去掉代理相关头,避免跳回原站
    if (
      lower === 'host' ||
      lower.startsWith('cf-') ||
      lower.startsWith('x-forwarded-') ||
      lower === 'content-length'
    ) {
      out.delete(k);
      continue;
    }
  }
  // Referer/Origin 指向 cfp 会让部分站 CSRF 拒绝;改写成目标站语境
  const referer = out.get('referer');
  if (referer) {
    try {
      const r = new URL(referer);
      const m = r.pathname.match(/^\/proxy\/(https?):\/\/([^/]+)(.*)$/i) || r.pathname.match(/^\/proxy\/(https?):([^/]+)(.*)$/i);
      if (r.host === new URL(target).host && r.pathname.startsWith('/proxy/')) {
        const inner = decodeURIComponent(r.pathname.slice('/proxy/'.length)) + r.search;
        out.set('referer', inner);
      } else if (m) {
        const inner = `${m[1]}://${m[2]}${m[3] || ''}`;
        out.set('referer', inner);
      }
    } catch { /* 保原值 */ }
  }
  const origin = out.get('origin');
  if (origin && origin.includes(new URL(target).protocol === 'https:' ? '' : '')) {
    // Origin 只有在目标站做 CORS/CSRF 校验时才重要;代理语境下映射为目标站 origin
    try {
      out.set('origin', new URL(target).origin);
    } catch { /* 保原值 */ }
  }
  return out;
}
