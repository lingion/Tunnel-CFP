// src/proxy-web/url-resolver.ts
// 重写 HTML/CSS 中的 URL 为 /proxy/<absolute-url>
// 解析一律用 new URL(value, base):相对路径/上级跳转/带 query 全部按浏览器语义处理
// 不重写:data:, javascript:, #, mailto:, tel: 等非网络协议

export interface RewriteContext {
  currentOrigin: string; // 例如 https://example.com
  /** 当前资源路径(页面或 CSS 文件自身),如 /articles/2024/post.html — 相对路径基准 */
  currentPath?: string;
}

const SKIP_PREFIX_RE = /^(data:|javascript:|mailto:|tel:|blob:|about:|#)/i;

/**
 * 把任意(相对/绝对/协议相对)URL 解析为绝对 URL。
 * 解析失败返回 null(调用方保原值)。
 */
export function resolveToAbsolute(original: string, ctx: RewriteContext): string | null {
  const base = ctx.currentPath
    ? `${ctx.currentOrigin}${ctx.currentPath}`
    : `${ctx.currentOrigin}/`;
  try {
    return new URL(original, base).href;
  } catch {
    return null;
  }
}

export function rewriteUrl(original: string, ctx: RewriteContext): string {
  if (!original) return original;

  if (SKIP_PREFIX_RE.test(original)) return original;

  // 已是本代理路径(嵌套重写防御):保持
  if (original.startsWith('/proxy/') || original.startsWith('/proxy-ws/')) return original;

  // 协议相对 //cdn.com/x → new URL('//cdn.com/x', base) 需要补协议
  let toResolve = original;
  if (original.startsWith('//')) {
    toResolve = `https:${original}`;
  }

  const abs = resolveToAbsolute(toResolve, ctx);
  if (!abs) return original;
  return `/proxy/${abs}`;
}

/**
 * 解析 srcset 属性值:"url1 2x, url2 100w"
 * data: URL 内部含逗号(base64),用占位符保护后按逗号切。
 */
export function parseSrcset(value: string): Array<{ url: string; descriptor: string | null }> {
  const parts: Array<{ url: string; descriptor: string | null }> = [];
  const stash: string[] = [];
  const protectedValue = value.replace(/data:[^\s,]*(?:,[^\s,]*)*/g, (m) => {
    stash.push(m);
    return `\u0000${stash.length - 1}\u0000`;
  });
  for (const token of protectedValue.split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\S+)(?:\s+(.+))?$/);
    if (!m) continue;
    // 恢复占位符
    const unstash = (t: string) => t.replace(/\u0000(\d+)\u0000/g, (_s, i: string) => stash[Number(i)] ?? '');
    const url = unstash(m[1]!);
    const desc = m[2] ? unstash(m[2]) : undefined;
    parts.push({ url, descriptor: desc ?? null });
  }
  return parts;
}

export function serializeSrcset(parts: Array<{ url: string; descriptor: string | null }>): string {
  return parts.map((p) => (p.descriptor ? `${p.url} ${p.descriptor}` : p.url)).join(', ');
}

/** 重写整个 srcset 属性值 */
export function rewriteSrcset(value: string, ctx: RewriteContext): string {
  const parts = parseSrcset(value);
  if (parts.length === 0) return value;
  return serializeSrcset(parts.map((p) => ({ ...p, url: rewriteUrl(p.url, ctx) })));
}

/**
 * 重写 CSS 文本中的 url(...) 与 @import。
 * 相对路径以 CSS 文件自身 URL 为基准(currentPath)。
 * 保真策略:只替换参数部分,引号/空白原样保留。
 */
export function rewriteCssUrls(css: string, ctx: RewriteContext): string {
  // url() — 带引号/不带引号
  let out = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _q, raw: string) => {
    const rewritten = rewriteCssValue(raw, ctx);
    return rewritten === raw ? match : `url(${rewritten})`;
  });
  // @import "..." — url() 形式已被上面覆盖
  out = out.replace(/@import\s+(['"])([^'"]+)\1/g, (match, _q, raw: string) => {
    const rewritten = rewriteCssValue(raw, ctx);
    return rewritten === raw ? match : `@import ${rewritten}`;
  });
  return out;
}

function rewriteCssValue(raw: string, ctx: RewriteContext): string {
  const v = raw.trim();
  // 不动 data:、fragment、空的
  if (!v || v.startsWith('data:') || v.startsWith('#')) return raw;
  const abs = resolveToAbsolute(v.startsWith('//') ? `https:${v}` : v, ctx);
  if (!abs) return raw;
  return `"${`/proxy/${abs}`}"`;
}

/** 这些 host 是 XML/JSON-LD 命名空间声明,不是可执行资源,重写会破坏语义 */
const JS_URL_HOST_DENYLIST = [
  'www.w3.org',
  'w3.org',
  'purl.org',
  'schema.org',
  'xmlns.mozilla.org',
  'ns.adobe.com',
];

/**
 * 重写 JS 文本中字符串字面量内的绝对 URL。
 * 策略:只碰引号(" ' `)内以 https?:// 开头、以同款引号结束的完整字符串,
 * 不做 AST 解析(Workers 上不现实),不碰代码位置的 / 分隔正则。
 * 重写后放回同款引号内,语义保持字符串。
 */
export function rewriteJsUrls(js: string, ctx: RewriteContext): string {
  // 模板串/单双引号统一处理:匹配 "..." '...' `...` 内部整体为 http(s) URL 的
  return js.replace(/(['"`])(https?:\/\/[^'"`\\]+?)\1/g, (match, quote: string, url: string) => {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return match;
    }
    for (const d of JS_URL_HOST_DENYLIST) {
      if (host === d || host.endsWith('.' + d)) return match;
    }
    const abs = resolveToAbsolute(url, ctx);
    if (!abs) return match;
    return `${quote}/proxy/${abs}${quote}`;
  });
}
