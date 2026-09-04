// src/proxy-web/url-resolver.ts
// 重写 HTML 中的 URL，将外部引用转换为 /proxy/<原始URL>
// 不重写：data:, javascript:, #, mailto:, tel: 等非网络协议

export interface RewriteContext {
  currentOrigin: string; // 例如 https://example.com
}

export function rewriteUrl(original: string, ctx: RewriteContext): string {
  if (!original) return original;

  // 不动：data URI, javascript:, 锚点, mailto, tel
  if (
    original.startsWith('data:') ||
    original.startsWith('javascript:') ||
    original.startsWith('#') ||
    original.startsWith('mailto:') ||
    original.startsWith('tel:')
  ) {
    return original;
  }

  // 协议相对 URL //cdn.com/x → https://cdn.com/x
  if (original.startsWith('//')) {
    return `/proxy/https:${original}`;
  }

  // 绝对 http(s) URL
  if (/^https?:\/\//.test(original)) {
    return `/proxy/${original}`;
  }

  // 相对路径：补全 currentOrigin
  // "/about.html" → "https://example.com/about.html"
  // "page.html"  → "https://example.com/page.html"
  const slash = original.startsWith('/') ? '' : '/';
  return `/proxy/${ctx.currentOrigin}${slash}${original}`;
}