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

  // 已是本代理路径(嵌套重写防御):**仅当 URL 解析后打到本代理域**才算,
  // 目标站自己的 /proxy/* 路径(不少站点有)误判会整站资源 404(审计实锤)
  if (original.startsWith('/proxy/') || original.startsWith('/proxy-ws/')) {
    try {
      const abs = resolveToAbsolute(original, ctx);
      // /proxy/https://... 形态:new URL 后 pathname 含目标站 URL,host 仍是 cfp —
      // 绝对 cfp URL 走浏览器相对解析必然落回本域;真正要防的是目标站撞路径
      if (abs && /^\/proxy(-ws)?\/(https?|ws|wss):\/\//i.test(new URL(abs).pathname + '')) {
        return original;
      }
    } catch { /* fallthrough:按普通路径处理 */ }
    // 相对形态且解析不到代理自指 → 视为目标站自有路径,正常重写
  }

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
  // url() — 带引号/不带引号;@namespace 的 url() 是命名空间声明,豁免
  let out = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _q, raw: string, offset: number) => {
    // @namespace url(...) 是命名空间声明,重写会破坏语义 — 向前看同语句关键词
    const lookback = css.slice(Math.max(0, offset - 40), offset);
    if (/@namespace\s*$/i.test(lookback)) return match;
    const rewritten = rewriteCssValue(raw, ctx);
    return rewritten === raw ? match : `url(${rewritten})`;
  });
  // @import "..." — url() 形式已被上面覆盖
  out = out.replace(/@import\s+(['"])([^'"]+)\1/g, (match, _q, raw: string) => {
    const rewritten = rewriteCssValue(raw, ctx);
    return rewritten === raw ? match : `@import ${rewritten}`;
  });
  // image-set("a.png" 1x, "b.png" 2x) / -webkit-image-set():引号内裸字符串(全局)
  out = out.replace(/(image-set\()[^)]*\)/gi, (block: string) => {
    return block.replace(/(['"])([^'"]+)\1/g, (m, q: string, raw: string) => {
      const rewritten = rewriteCssValue(raw, ctx);
      return rewritten === raw ? m : `${q}${rewritten}${q}`;
    });
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
 *
 * 排除(审计实锤):
 * - 含 ${...} 的模板串:new URL() 会把 {} 编码成 %7B%7D,运行时插值被破坏
 * - 转义引号边界:字符类含 \\ 会使匹配在转义处截断,反斜杠被吞改变语句结构
 */
export function rewriteJsUrls(js: string, ctx: RewriteContext): string {
  return js.replace(/(['"`])(https?:\/\/[^'"`\\]*?)\1/g, (match, quote: string, url: string) => {
    // 模板串插值 / 转义序列:重写必破坏语义,整段跳过
    if (quote === '`' && (url.includes('${') || url.includes('\\'))) return match;
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

/**
 * 重写 iframe srcdoc 内嵌 HTML:它以父页面为上下文,相对 URL 会打到 cfp 域 404。
 * srcdoc 值是 HTML-escaped 文本;HTMLRewriter setAttribute 会再转义,这里处理
 * 原始语义文本。策略:属性级 src/href/poster/data + css url() + JS 字符串 URL。
 *
 * 关键事实(本轮实测): getAttribute('srcdoc') 返回 **entity-encoded 原始字节**(`&quot;` 保持字面不还原),
 * 引号 URL 正则配不到 → 先解码实体再重写;setAttribute 侧自动重新转义,无需手工 escape。
 */
export function decodeHtmlEntitiesInAttr(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#39|#x27);/g, (_, e: string) => {
    const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'" };
    return map[e] ?? _;
  });
}

export function rewriteSrcdocHtml(html: string, ctx: RewriteContext): string {
  let out = decodeHtmlEntitiesInAttr(html);
  out = out.replace(/\s(src|href|poster|data)=(["'])([^"']+)\2/gi, (m, attr: string, q: string, val: string) => {
    const r = rewriteUrl(val, ctx);
    return r === val ? m : ` ${attr}=${q}${r}${q}`;
  });
  out = rewriteCssUrls(out, ctx);
  out = rewriteJsUrls(out, ctx);
  return out;
}
