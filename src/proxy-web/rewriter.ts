// src/proxy-web/rewriter.ts
// HTMLRewriter 引擎：重写 HTML 中的外链为 /proxy/<url>
import { rewriteUrl } from './url-resolver';
import type { WebProxyContext } from './types';

interface AttrRule {
  tag: string;
  attr: string;
}

const HTML_ATTR_RULES: AttrRule[] = [
  { tag: 'a', attr: 'href' },
  { tag: 'link', attr: 'href' },
  { tag: 'img', attr: 'src' },
  { tag: 'script', attr: 'src' },
  { tag: 'iframe', attr: 'src' },
  { tag: 'video', attr: 'src' },
  { tag: 'audio', attr: 'src' },
  { tag: 'source', attr: 'src' },
  { tag: 'form', attr: 'action' },
  { tag: 'use', attr: 'href' }, // SVG
];

export function createRewriter(ctx: WebProxyContext): HTMLRewriter {
  let rewriter = new HTMLRewriter();

  for (const { tag, attr } of HTML_ATTR_RULES) {
    rewriter = rewriter.on(`${tag}[${attr}]`, {
      element: (el: any) => {
        const v = el.getAttribute(attr);
        if (v) el.setAttribute(attr, rewriteUrl(v, ctx));
      },
    });
  }

  // meta http-equiv="refresh" 重定向
  rewriter = rewriter.on('meta[http-equiv="refresh"]', {
    element: (el: any) => {
      const content = el.getAttribute('content');
      if (content) {
        const m = content.match(/(\d+);\s*url=(.+)/i);
        if (m) {
          el.setAttribute('content', `${m[1]}; url=${rewriteUrl(m[2].trim(), ctx)}`);
        }
      }
    },
  });

  // <base href> 也需要更新，否则相对路径会用错的基准
  rewriter = rewriter.on('base[href]', {
    element: (el: any) => {
      const v = el.getAttribute('href');
      if (v) el.setAttribute('href', rewriteUrl(v, ctx));
    },
  });

  return rewriter;
}