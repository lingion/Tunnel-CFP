// src/proxy-web/rewriter.ts
// HTMLRewriter 引擎:重写 HTML 中的外链资源为 /proxy/<url>
// 覆盖:标准属性 / srcset / style属性 / <style>块 css / base / meta refresh+清除 meta CSP / 运行时 shim
import { rewriteUrl, rewriteSrcset, rewriteCssUrls } from './url-resolver';
import { SHIM_SCRIPT } from './inject-shim';
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
  { tag: 'video', attr: 'poster' },
  { tag: 'audio', attr: 'src' },
  { tag: 'source', attr: 'src' },
  { tag: 'track', attr: 'src' },
  { tag: 'embed', attr: 'src' },
  { tag: 'object', attr: 'data' },
  { tag: 'input', attr: 'src' },
  { tag: 'form', attr: 'action' },
  { tag: 'button', attr: 'formaction' },
  { tag: 'input', attr: 'formaction' },
  { tag: 'blockquote', attr: 'cite' },
  { tag: 'q', attr: 'cite' },
  { tag: 'del', attr: 'cite' },
  { tag: 'ins', attr: 'cite' },
  { tag: 'longdesc', attr: 'cite' },
  { tag: 'html', attr: 'manifest' },
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

  // srcset(img/source)— 响应式图片
  rewriter = rewriter.on('img[srcset], source[srcset]', {
    element: (el: any) => {
      const v = el.getAttribute('srcset');
      if (v) el.setAttribute('srcset', rewriteSrcset(v, ctx));
    },
  });

  // style 属性 — inline CSS 的 url()
  rewriter = rewriter.on('[style]', {
    element: (el: any) => {
      const v = el.getAttribute('style');
      if (v) el.setAttribute('style', rewriteCssUrls(v, ctx));
    },
  });

  // <style> 块 — 文本流里逐 chunk 重写 CSS url()/@import
  // text handler 收到的是流式分块,必须跨 chunk 缓冲:url( 可能在 chunk 边界断开
  {
    let cssBuf = '';
    let bufIsCss = false;
    rewriter = rewriter.on('style', {
      element() {
        cssBuf = '';
        bufIsCss = true;
      },
      text(t: any) {
        if (!bufIsCss) return;
        cssBuf += t.text;
        // 尾部可能是半截 url( → 留到下一 chunk;简单启发:保留最后一个未闭合 url(
        const lastOpen = cssBuf.lastIndexOf('url(');
        const lastClose = cssBuf.lastIndexOf(')');
        if (lastOpen > lastClose) {
          const safe = cssBuf.slice(0, lastOpen);
          t.replace(rewriteCssUrls(safe, ctx));
          cssBuf = cssBuf.slice(lastOpen);
        } else {
          t.replace(rewriteCssUrls(cssBuf, ctx));
          cssBuf = '';
        }
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

  // 清除 meta CSP(响应头 CSP 在 handler 里剥,meta 形式在这里剥)
  rewriter = rewriter.on('meta[http-equiv="Content-Security-Policy"], meta[http-equiv="content-security-policy"]', {
    element: (el: any) => {
      el.remove();
    },
  });

  // <base href> 更新,否则相对路径用错基准
  rewriter = rewriter.on('base[href]', {
    element: (el: any) => {
      const v = el.getAttribute('href');
      if (v) el.setAttribute('href', rewriteUrl(v, ctx));
    },
  });

  // 注入运行时 shim:钩 fetch/XHR 等动态请求走 /proxy/
  rewriter = rewriter.on('head', {
    element(el: any) {
      el.prepend(SHIM_SCRIPT, { html: true });
    },
  });

  return rewriter;
}
