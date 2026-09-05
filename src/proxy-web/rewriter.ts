// src/proxy-web/rewriter.ts
// HTMLRewriter 引擎:重写 HTML 中的外链资源为 /proxy/<url>
// 覆盖:标准属性 / srcset / style属性 / <style>块 css / base / meta refresh+清除 meta CSP / 运行时 shim
import { rewriteUrl, rewriteSrcset, rewriteCssUrls, rewriteSrcdocHtml } from './url-resolver';
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
  { tag: 'html', attr: 'manifest' },
  { tag: 'img', attr: 'longdesc' },
  { tag: 'a', attr: 'ping' },
  { tag: 'link', attr: 'imagesrc' },
  { tag: 'source', attr: 'srcset' },
  { tag: 'image', attr: 'href' }, // SVG <image href>
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
  // SVG 老式 xlink:href(选择器需转义冒号)
  rewriter = rewriter.on('image, use', {
    element: (el: any) => {
      const v = el.getAttribute('xlink:href');
      if (v && !v.startsWith('#')) el.setAttribute('xlink:href', rewriteUrl(v, ctx));
    },
  });

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
  // text handler 收到的是流式分块,必须跨 chunk 缓冲:url( 可能在 chunk 边界断开。
  // lastInTextNode() 是权威的"文本节点结束"信号(审计:旧启发式对注释/字符串里
  // 的 url( 误 hold,元素结束时 hold 内容静默丢失;且每 chunk 对增长缓冲
  // lastIndexOf 是 O(n²))。策略:仅当 chunk 是节点尾(lastInTextNode)才整块
  // flush 重写;中途 chunk 用空串替换、内容全攒到尾部一次处理 — 每字节只扫一遍。
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
        if (t.lastInTextNode) {
          // 节点尾:整块 flush(含本 chunk),元素文本已完整,无 hold 丢失
          cssBuf += t.text;
          t.replace(rewriteCssUrls(cssBuf, ctx));
          cssBuf = '';
        } else {
          // 中途 chunk:暂存(空串替换原位),等节点尾一次重写
          cssBuf += t.text;
          t.replace('');
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

  // SRI(integrity)在内容重写后必校验失败 → 浏览器拦截脚本;全部剥除
  rewriter = rewriter.on('[integrity]', {
    element: (el: any) => {
      el.removeAttribute('integrity');
    },
  });

  // iframe srcdoc 内部也是 HTML,以 cfp 为 base 的相对 URL 全 404 → 重写其内容
  rewriter = rewriter.on('iframe', {
    element: (el: any) => {
      const doc = el.getAttribute('srcdoc');
      if (doc) {
        const rewritten = rewriteSrcdocHtml(doc, ctx);
        el.setAttribute('srcdoc', rewritten);
      }
    },
  });

  // 剥 CF 自动注入的 RUM beacon(平台在浏览器请求时插到 </body> 前,
  // 外域直连 + 拖住 load 事件 + 对 cfp 域上报 — 代理站全都不想要)
  rewriter = rewriter.on('script[src*="cloudflareinsights.com"]', {
    element: (el: any) => {
      el.remove();
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
