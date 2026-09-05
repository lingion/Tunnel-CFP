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
  // 浏览器对 form GET / shim 拼接后的请求,query 会挂在 cfp 请求上;合入目标
  if (url.search) {
    target += (target.includes('?') ? '&' : '?') + url.search.slice(1);
  }

  try {
    validateTargetUrl(target);
  } catch (e) {
    if (e instanceof SecurityError) {
      return new Response(`Security error: ${e.message}`, { status: 400 });
    }
    throw e;
  }

  // 转发请求到目标:流式 body(duplex half,不缓冲)、30s 超时、Cache API 旁路
  // caches 仅存在于 workers runtime;nodejs 测试环境降级为不缓存
  const hasCache = typeof caches !== 'undefined';
  const cache = hasCache ? caches.default : null;
  const cacheable = hasCache && request.method === 'GET' && isCacheableAsset(target);
  let cachedResponse: Response | undefined;
  if (cache && cacheable) {
    cachedResponse = await cache.match(request);
    if (cachedResponse) {
      const hit = new Response(cachedResponse.body, cachedResponse);
      hit.headers.set('X-Proxy-Cache', 'HIT');
      return hit;
    }
  }

  let targetRes: Response;
  try {
    targetRes = await fetch(target, {
      method: request.method,
      headers: sanitizeOutgoingHeaders(request.headers, target),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      // @ts-expect-error — workers types require manual duplex opt-in for streaming bodies
      duplex: 'half',
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return errorPage(target, e as Error);
  }

  const contentType = targetRes.headers.get('Content-Type') || '';
  // redirect: 'follow' 后,res.url 是最终 URL(可能和 target 不同,如 http→https / 302)
  const finalUrl = targetRes.url || target;

  // HTML → 全量重写
  if (contentType.includes('text/html')) {
    return transformHtml(targetRes, finalUrl);
  }

  // CSS → 重写 body 内的 url()/@import
  if (contentType.includes('text/css')) {
    const rewritten = await rewriteCssResponse(targetRes, finalUrl);
    const headers = cleanResponseHeaders(targetRes, new URL(finalUrl).host);
    headers.delete('Content-Length');
    const resp = new Response(rewritten, { status: targetRes.status, headers });
    if (cache && cacheable && targetRes.status === 200) {
      return await cachePut(cache, request, resp);
    }
    return resp;
  }

  // 其他资源(图片/字体/JS/JSON…)→ 透传
  const resp = passThrough(targetRes, new URL(finalUrl).host);
  if (cache && cacheable && targetRes.status === 200) {
    return await cachePut(cache, request, resp);
  }
  return resp;
}

/** 可缓存判定:静态资源扩展名(HTML 不缓存 — 内容因上下文而异) */
function isCacheableAsset(target: string, _hint?: string): boolean {
  try {
    const path = new URL(target).pathname;
    return /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|json|xml|txt)$/i.test(path);
  } catch {
    return false;
  }
}

/** 缓存透传响应:tee 一份进缓存,另一份照常返回(body 只能消费一次) */
async function cachePut(cache: Cache, request: Request, resp: Response): Promise<Response> {
  try {
    const [a, b] = resp.body ? resp.body.tee() : [null, null];
    const forCache = new Response(a, resp);
    // Cache API 尊重响应 Cache-Control;上游没给可缓存的 CC 时默认不存。
    // 代理是缓存唯一写者,由我们定策略:1h 边缘缓存
    if (!forCache.headers.has('Cache-Control')) {
      forCache.headers.set('Cache-Control', 'public, s-maxage=3600');
    }
    const cachedHit = await cache.put(request, forCache);
    return new Response(b, resp);
  } catch {
    return resp; // 缓存失败不影响主流程
  }
}

/** 优雅错误页:超时/DNS 失败/目标 5xx 不裸抛,给可读页面 */
function errorPage(target: string, e: Error): Response {
  const timedOut = e instanceof Error && /abort|timeout/i.test(e.name + e.message);
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>代理请求失败</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;background:#f6f7f9;color:#1f2328}
.card{max-width:520px;padding:40px;border-radius:12px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 12px}code{background:#f0f2f4;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
p{color:#57606a;font-size:14px;line-height:1.6}</style></head>
<body><div class="card"><h1>${timedOut ? '目标站点响应超时' : '代理请求失败'}</h1>
<p>目标:<code>${escapeHtml(target)}</code></p>
<p>${timedOut ? '30 秒内未收到响应,目标站可能不可达或过于缓慢。' : escapeHtml(e.message || '未知错误')}</p>
<p><a href="javascript:history.back()">← 返回上一页</a></p></div></body></html>`;
  return new Response(html, {
    status: 504,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

async function transformHtml(targetRes: Response, finalUrl: string): Promise<Response> {
  const targetUrl = new URL(finalUrl);
  const ctx: WebProxyContext = {
    currentOrigin: `${targetUrl.protocol}//${targetUrl.host}`,
    currentPath: targetUrl.pathname,
  };

  const newHeaders = cleanResponseHeaders(targetRes, targetUrl.host);

  // 注入 shim 配置(目标站 origin+path),供运行时解析相对 URL
  const baseInject = new HTMLRewriter().on('head', {
    element(el: any) {
      el.prepend(
        `<script>window.__PROXY_BASE__ = ${JSON.stringify(ctx.currentOrigin + ctx.currentPath)};</script>`,
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

/** 读取并重写 CSS 文本(相对路径以 CSS 文件自身为基准) */
async function rewriteCssResponse(targetRes: Response, finalUrl: string): Promise<string> {
  const targetUrl = new URL(finalUrl);
  const ctx: WebProxyContext = {
    currentOrigin: `${targetUrl.protocol}//${targetUrl.host}`,
    currentPath: targetUrl.pathname,
  };
  const css = await targetRes.text();
  return rewriteCssUrls(css, ctx);
}

function passThrough(targetRes: Response, targetHost: string): Response {
  return new Response(targetRes.body, {
    status: targetRes.status,
    headers: cleanResponseHeaders(targetRes, targetHost),
  });
}

/** 响应头清洗:CSP/XFO/嵌入限制剥离 + cookie 命名空间隔离 + 长度头修正 */
function cleanResponseHeaders(targetRes: Response, targetHost: string): Headers {
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
  isolateCookies(newHeaders, targetHost);
  return newHeaders;
}

/**
 * Cookie 隔离:多个目标站的 Set-Cookie 都打到 cfp 域名会互相覆盖,
 * 且 A 站的 cookie 会被 B 站请求带走(跨站泄漏)。
 * 命名 = __pw<hash(host)>_<name>:同名不同站不冲突;还原时只取匹配当前目标站的。
 */
const COOKIE_PREFIX = '__pw';
const COOKIE_HOSTLEN = 8;

function hostTag(host: string): string {
  // 非加密哈希即可(只用于命名空间区分,不是安全边界)
  let h = 0;
  for (let i = 0; i < host.length; i++) {
    h = (h * 31 + host.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36).padStart(COOKIE_HOSTLEN, '0').slice(0, COOKIE_HOSTLEN);
}

function isolateCookies(headers: Headers, targetHost: string): void {
  // Workers Headers 支持 getSetCookie (多值 cookie);旧类型没标,走 any 取
  const h = headers as any;
  const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
  if (setCookies.length === 0) return;
  const tag = hostTag(targetHost);
  headers.delete('Set-Cookie');
  for (const sc of setCookies) {
    const eq = sc.indexOf('=');
    if (eq <= 0) continue;
    const name = sc.slice(0, eq).trim();
    const rest = sc.slice(eq + 1);
    // Path/Domain 保持,名字加 host 标签前缀
    headers.append('Set-Cookie', `${COOKIE_PREFIX}${tag}_${name}=${rest}`);
  }
}

function unisolateCookies(headers: Headers, targetHost: string): Headers {
  const tag = hostTag(targetHost);
  const wantPrefix = `${COOKIE_PREFIX}${tag}_`;
  const out = new Headers();
  for (const [k, v] of headers.entries()) {
    const lower = k.toLowerCase();
    if (lower === 'cookie') {
      // 只还原当前目标站的 cookie;其他站的直接丢弃(防跨站携带)
      const parts = v.split(/;\s*/).filter(Boolean);
      const restored = parts
        .map((p) => {
          const eq = p.indexOf('=');
          const name = eq > 0 ? p.slice(0, eq).trim() : p;
          if (name.startsWith(wantPrefix)) {
            return `${name.slice(wantPrefix.length)}${p.slice(eq)}`;
          }
          return null;
        })
        .filter((x): x is string => x !== null);
      if (restored.length > 0) out.set(k, restored.join('; '));
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
      // Referer 是目标站页面经浏览器写入的,实际形态是
      // "https://cfp域/proxy/<完整url>"(浏览器会把整个 path+query 编码进 href,
      // URL 解析后 pathname 含 /proxy/https://...,query 挂尾)
      const m = r.pathname.match(/^\/proxy\/(https?):\/\/([^/?]+)(.*)$/i);
      if (m) {
        out.set('referer', `${m[1]}://${m[2]}${m[3] || ''}`);
      }
    } catch { /* 保原值 */ }
  }
  // Origin 映射为目标站 origin(目标站的 CORS/CSRF 校验需要看到它自己的域)
  try {
    const tOrigin = new URL(target).origin;
    const origin = out.get('origin');
    if (origin && origin !== tOrigin) out.set('origin', tOrigin);
  } catch { /* 保原值 */ }
  return out;
}
