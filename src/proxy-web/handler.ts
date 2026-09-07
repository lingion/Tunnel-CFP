// src/proxy-web/handler.ts
// /proxy/<encoded target url> 完整 HTML/CSS 重写代理
// HTML → 属性/样式/shim 全量重写;CSS → body 内 url()/@import 重写;其他 → 透传
import { createRewriter } from './rewriter';
import { rewriteCssUrls, rewriteJsUrls, resolveToAbsolute } from './url-resolver';
import { validateTargetUrl, SecurityError } from './security';
import type { WebProxyContext } from './types';

export async function handleWebProxy(request: Request, waitUntil?: (p: Promise<any>) => void): Promise<Response> {
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
  // 浏览器对 form GET / shim 拼接后的请求,query 会挂在 cfp 请求上;合入目标。
  // key 参数是本代理的用量闸凭证,绝不能转发给目标站
  if (url.search) {
    const merged = new URLSearchParams(url.search);
    merged.delete('key');
    const flat = merged.toString();
    if (flat) target += (target.includes('?') ? '&' : '?') + flat;
  }

  try {
    validateTargetUrl(target);
  } catch (e) {
    if (e instanceof SecurityError) {
      return new Response(`Security error: ${e.message}`, {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    throw e;
  }

  // 转发请求到目标:流式 body(duplex half,不缓冲)、超时、Cache API 旁路
  // caches 仅存在于 workers runtime;nodejs 测试环境降级为不缓存
  const hasCache = typeof caches !== 'undefined';
  const cache = hasCache ? caches.default : null;
  // 条件缓存:带 Cookie 的请求按会话个性化,一律 miss(防跨用户串号,审计口径)
  const cacheable = hasCache && request.method === 'GET' && !request.headers.get('Cookie') && isCacheableAsset(target);
  // cachePut 阻塞响应 = 缓存类资源(图片/字体/视频)TTFB = 全量下载(审计 Critical);
  // 改 waitUntil 后台写,响应立即回流。nodejs 测试无 ctx 时退同步(测试断言依赖)
  const defer = waitUntil ?? ((p: Promise<any>) => { void p; });
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
      // manual:跟随会丢 302 链上的 cookie 语义,且跨域 Location 会直连原站。
      // 由我们把 Location 重写成 /proxy/ 形态,浏览器自己跟
      redirect: 'manual',
      // 60s 罩整个 fetch 生命周期(headers+body)。30s 对慢速源站大文件会
      // 中途掐断 body;而 cleanResponseHeaders 已删 CL,截断不可检测(审计 F6)
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return errorPage(request, target, e as Error);
  }

  // 3xx → Location 重写交还浏览器(opaqueredirect 无 Location 时按透传)
  if (targetRes.status >= 300 && targetRes.status < 400) {
    return transformRedirect(targetRes, target);
  }

  const contentType = targetRes.headers.get('Content-Type') || '';
  // redirect: 'follow' 后,res.url 是最终 URL(可能和 target 不同,如 http→https / 302)
  const finalUrl = targetRes.url || target;

  // HTML → 全量重写
  if (contentType.includes('text/html')) {
    return transformHtml(targetRes, finalUrl);
  }

  // JS → 字符串字面量内的绝对 URL 重写(有界缓冲,防 128MB isolate 爆;
  // 无 Content-Length 时 chunked 常态,必须靠读流计数,不能信 !len 放行)
  if (isJsContentType(contentType)) {
    const body = await readBounded(targetRes, MAX_REWRITE_BYTES);
    if (body === null) {
      // 超限:重写不可行,透传剩余流(不缓冲)
      return passThroughWithRest(targetRes, finalUrl, body);
    }
    return transformJsBody(targetRes, finalUrl, body, cache, cacheable ? request : null, defer);
  }

  // CSS → 重写 body 内的 url()/@import(同 JS:有界缓冲)
  if (contentType.includes('text/css')) {
    const body = await readBounded(targetRes, MAX_REWRITE_BYTES);
    if (body === null) {
      return passThroughWithRest(targetRes, finalUrl, body);
    }
    const rewritten = rewriteCssUrls(body, cssCtx(finalUrl));
    const headers = cleanResponseHeaders(targetRes, new URL(finalUrl).host);
    const resp = new Response(rewritten, { status: targetRes.status, headers });
    if (cache && cacheable && targetRes.status === 200) {
      return cachePut(cache, request, resp, defer);
    }
    return resp;
  }

  // 其他资源(图片/字体/JS/JSON…)→ 透传
  const resp = passThrough(targetRes, new URL(finalUrl).host);
  if (cache && cacheable && targetRes.status === 200) {
    return cachePut(cache, request, resp, defer);
  }
  return resp;
}

/** 重写路径缓冲上限:V8 UTF-16 实占×2,128MB isolate 共享,5MB 字节上限合理 */
const MAX_REWRITE_BYTES = 5_000_000;

/**
 * 有界读 body:按字节计数,超过 cap 返回 null(流未被消费完)。
 * Content-Length 可缺失/可伪造 — 计数是唯一可信口径。
 */
async function readBounded(res: Response, cap: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * 超限降级:上游 body 已被 readBounded 取消,剩余内容拿不到 —
 * 按错误页处理(透传已不可能,流已断)。502 带 size 提示。
 */
function passThroughWithRest(_res: Response, finalUrl: string, _body: null): Response {
  void _res; void _body;
  return new Response(
    `Resource too large for proxy rewriting (>${MAX_REWRITE_BYTES} bytes): ${finalUrl}`,
    { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
}

function cssCtx(finalUrl: string): WebProxyContext {
  const u = new URL(finalUrl);
  return { currentOrigin: `${u.protocol}//${u.host}`, currentPath: u.pathname };
}

/** 可缓存判定:静态资源扩展名(HTML/JSON 不缓存 — 内容因会话/上下文而异) */
function isCacheableAsset(target: string, _hint?: string): boolean {
  try {
    const path = new URL(target).pathname;
    return /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3)$/i.test(path);
  } catch {
    return false;
  }
}

/**
 * 缓存写入:tee 一份进缓存,**后台写不阻塞响应**(await put 会让视频/字体
 * 的 TTFB = 全量下载时间,审计 Critical);另一份立即回流。
 * Set-Cookie 先剥(CF Cache 对带 Set-Cookie 的 put 静默拒绝,永远存不进去)。
 * request 引用 outside closure:tee 的 a 流消费发生在 waitUntil 窗口内。
 */
function cachePut(cache: Cache, request: Request, resp: Response, defer: (p: Promise<any>) => void): Response {
  if (!resp.body) return resp;
  const [a, b] = resp.body.tee();
  defer((async () => {
    try {
      const forCache = new Response(a, resp);
      forCache.headers.delete('Set-Cookie');
      // 代理是缓存唯一写者,由我们定策略:1h 边缘缓存
      if (!forCache.headers.has('Cache-Control')) {
        forCache.headers.set('Cache-Control', 'public, s-maxage=3600');
      }
      await cache.put(request, forCache);
    } catch {
      /* 缓存失败不影响主流程(a 流被弃,workers 无泄漏问题) */
    }
  })());
  return new Response(b, resp);
}

/** 优雅错误页:超时/DNS 失败/连接拒绝分语义 — 504 仅超时,DNS/拒连是 502(审计) */
function errorPage(request: Request, target: string, e: Error): Response {
  const timedOut = /abort|timeout/i.test(e.name + e.message);
  const status = timedOut ? 504 : 502;
  const reason = timedOut
    ? '60 秒内未收到响应,目标站可能不可达或过于缓慢。'
    : escapeHtml(e.message || '未知错误');
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>代理请求失败</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;background:#f6f7f9;color:#1f2328}
.card{max-width:520px;padding:40px;border-radius:12px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.06)}
h1{font-size:20px;margin:0 0 12px}code{background:#f0f2f4;padding:2px 6px;border-radius:4px;font-size:13px;word-break:break-all}
p{color:#57606a;font-size:14px;line-height:1.6}</style></head>
<body><div class="card"><h1>${timedOut ? '目标站点响应超时' : '代理请求失败'}</h1>
<p>目标:<code>${escapeHtml(target)}</code></p>
<p>${reason}</p>
<p><a href="javascript:history.back()">← 返回上一页</a></p></div></body></html>`;
  // HEAD 不得有 body(RFC 9110 §9.3.2)
  const body = request.method === 'HEAD' ? null : html;
  return new Response(body, {
    status,
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

  // rescue 用的 __proxy_last_host 改服务端 Set-Cookie(旧 JS document.cookie 写入
  // 无 HttpOnly,目标站 JS 可读可改 — 篡改成任意 host 就是 SSRF 跳板,审计 F3/F6)。
  // HttpOnly + Secure;rescue 侧仍按域名格式白名单校验(深度防御)
  const lastHost = targetUrl.hostname;
  if (!newHeaders.has('Set-Cookie')) {
    newHeaders.append(
      'Set-Cookie',
      `__proxy_last_host=${lastHost}; path=/; max-age=86400; SameSite=Lax; Secure; HttpOnly`,
    );
  }

  const rewriter = createRewriter(ctx);
  const transformed = rewriter.transform(baseInject);
  // no-transform:CF 边缘见此头会跳过自动 RUM beacon 注入(官方 FAQ 语义),
  // 否则注入的 cloudflareinsights 脚本外域直连 + 拖住 load 事件
  newHeaders.set('Cache-Control', 'no-transform');
  // HTMLRewriter.transform 不改变 body 长度无关性,但内容已变 → 必须不带 content-length
  return new Response(transformed.body, {
    status: targetRes.status,
    headers: newHeaders,
  });
}

/** 3xx 响应:重写 Location 为 /proxy/ 形态;无 Location 的按透传处理 */
function transformRedirect(targetRes: Response, target: string): Response {
  const loc = targetRes.headers.get('Location');
  const headers = cleanResponseHeaders(targetRes, new URL(target).host);
  if (loc) {
    const abs = resolveToAbsolute(loc, {
      currentOrigin: new URL(target).origin,
      currentPath: new URL(target).pathname,
    });
    headers.set('Location', `/proxy/${abs ?? loc}`);
  }
  return new Response(null, { status: targetRes.status, headers });
}

/** JS 内容判定:含常见 application/javascript 变体 */
function isJsContentType(ct: string): boolean {
  return /javascript|ecmascript|application\/jsx?\b/i.test(ct);
}

/** 重写 JS 文本中的字符串字面量 URL(body 已由 readBounded 有界读出) */
async function transformJsBody(
  targetRes: Response,
  finalUrl: string,
  js: string,
  cache: Cache | null,
  cacheKey: Request | null,
  defer: (p: Promise<any>) => void,
): Promise<Response> {
  const targetUrl = new URL(finalUrl);
  const ctx: WebProxyContext = {
    currentOrigin: `${targetUrl.protocol}//${targetUrl.host}`,
    currentPath: targetUrl.pathname,
  };
  const rewritten = rewriteJsUrls(js, ctx);
  const headers = cleanResponseHeaders(targetRes, targetUrl.host);
  const resp = new Response(rewritten, { status: targetRes.status, headers });
  if (cache && cacheKey && targetRes.status === 200) {
    return cachePut(cache, cacheKey, resp, defer);
  }
  return resp;
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
  // 透传 = body 原样(仍压缩):保 CE/CL。CL 保留使客户端可校验截断 +
  // CF Cache match 才能对 Range 出 206(视频 seek,审计 F7)
  const headers = cleanResponseHeaders(targetRes, targetHost, /* stripEncoding */ false);
  return new Response(targetRes.body, { status: targetRes.status, headers });
}

/**
 * 响应头清洗:CSP/XFO/嵌入限制剥离 + cookie 命名空间隔离 + 长度头修正。
 * stripEncoding=true(CSS/JS/HTML 重写路径):body 已被 Workers 解压+我们重写,
 * content-encoding/content-length 必须剥,否则浏览器按压缩流解码必炸。
 */
function cleanResponseHeaders(targetRes: Response, targetHost: string, stripEncoding = true): Headers {
  const newHeaders = new Headers(targetRes.headers);
  if (stripEncoding) {
    newHeaders.delete('Content-Encoding');
  }
  newHeaders.set('Access-Control-Allow-Origin', '*');
  // 去掉目标站点的 CSP/X-Frame-Options,否则代理页面被自身规则锁住
  newHeaders.delete('Content-Security-Policy');
  newHeaders.delete('Content-Security-Policy-Report-Only');
  newHeaders.delete('X-Frame-Options');
  // 跨域隔离头会让浏览器把代理页当跨源隔离文档处理,剥掉
  newHeaders.delete('Cross-Origin-Opener-Policy');
  newHeaders.delete('Cross-Origin-Embedder-Policy');
  newHeaders.delete('Cross-Origin-Resource-Policy');
  // HSTS/上报类策略头 pin 到 cfp 域=慢性污染+外呼泄漏,全部剥掉
  newHeaders.delete('Strict-Transport-Security');
  newHeaders.delete('Alt-Svc');
  newHeaders.delete('Alt-Used');
  newHeaders.delete('Report-To');
  newHeaders.delete('NEL');
  newHeaders.delete('Reporting-Endpoints');
  // 重写路径:内容长度必变,CL 必删。透传路径(stripEncoding=false,body 原样)
  // CL 有效 — 保留它:客户端可校验截断 + Cache Range 匹配出 206(视频 seek)
  if (stripEncoding) {
    newHeaders.delete('Content-Length');
  }
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
    // 剥 Domain(不匹配 cfp 域会被浏览器整条拒收)与 Path(cfp 域上不存在
    // 目标站路径,Path 限定会导致 cookie 永不回发);__Host- 前缀随原名剥除
    const attrs = rest.split(';').filter((a) => {
      const t = a.trim().toLowerCase();
      return !t.startsWith('domain=') && !t.startsWith('path=');
    });
    const isHostPrefix = /^__Host-/i.test(name);
    const body = isHostPrefix ? name.slice(7) : name;
    headers.append('Set-Cookie', `${COOKIE_PREFIX}${isHostPrefix ? 'h' : ''}${tag}_${body}=${attrs.join(';')}`);
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
      // __Host- 前缀先判(更长):tag 自身以 'h' 开头时 `__pw<tag>_` 是
      // `__pwh<tag>_` 的前缀,先判普通前缀会吞掉 host 类 cookie(还原成错名)
      const wantHostPrefix = `${COOKIE_PREFIX}h${tag}_`;
      const parts = v.split(/;\s*/).filter(Boolean);
      const restored = parts
        .map((p) => {
          const eq = p.indexOf('=');
          const name = eq > 0 ? p.slice(0, eq).trim() : p;
          if (name.startsWith(wantHostPrefix)) {
            return `__Host-${name.slice(wantHostPrefix.length)}${p.slice(eq)}`;
          }
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
      lower.startsWith('sec-fetch-') ||
      lower === 'cdn-loop' ||
      lower === 'content-length' ||
      lower === 'accept-encoding'
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
        // query 别丢:Referer 带目标站 query 时(站内跳转场景) stripping 会让
        // 部分站 referer 校验/统计断链
        out.set('referer', `${m[1]}://${m[2]}${m[3] || ''}${r.search}`);
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
