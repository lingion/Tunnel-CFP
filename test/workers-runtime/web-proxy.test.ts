// 真 workers runtime 下测完整 handleWebProxy 管线(真 HTMLRewriter + 真 fetch stub)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleWebProxy } from '../../src/proxy-web/handler';

const SELF = 'https://cfp.lingion04.workers.dev';

function proxyReq(target: string): Request {
  return new Request(`${SELF}/proxy/${encodeURIComponent(target)}`);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('handleWebProxy (workers runtime)', () => {
  it('rewrites <a href> in HTML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html><head></head><body><a href="https://example.com/about">x</a></body></html>', {
        headers: { 'Content-Type': 'text/html' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/'));
    const body = await res.text();
    expect(body).toContain('/proxy/https://example.com/about');
  });

  it('rewrites img src and srcset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        '<img src="/a.png" srcset="/b.png 1x, https://cdn.com/c.png 2x">',
        { headers: { 'Content-Type': 'text/html' } }
      )
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/'));
    const body = await res.text();
    expect(body).toContain('src="/proxy/https://target.com/a.png"');
    expect(body).toContain('/proxy/https://target.com/b.png 1x');
    expect(body).toContain('/proxy/https://cdn.com/c.png 2x');
  });

  it('rewrites url() inside <style> blocks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        '<html><head><style>body{background:url(img/bg.png)}h1{background:url("https://cdn.com/f.svg")}</style></head></html>',
        { headers: { 'Content-Type': 'text/html' } }
      )
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/page'));
    const body = await res.text();
    expect(body).toContain('url("/proxy/https://target.com/img/bg.png")');
    expect(body).toContain('url("/proxy/https://cdn.com/f.svg")');
  });

  it('rewrites style attribute css', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<div style="background:url(x.png)"></div>', {
        headers: { 'Content-Type': 'text/html' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/'));
    const body = await res.text();
    // HTML 序列化会把属性里的引号转义成 &quot;
    expect(body).toContain('url(&quot;/proxy/https://target.com/x.png&quot;)');
  });

  it('injects runtime shim with PROXY_BASE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html><head><title>t</title></head></html>', {
        headers: { 'Content-Type': 'text/html' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/'));
    const body = await res.text();
    expect(body).toContain('__PROXY_SHIM__');
    expect(body).toContain('__PROXY_BASE__');
    expect(body).toContain('https://target.com');
  });

  it('rewrites .css response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('body{background:url(//cdn.other.com/x.png)}', {
        headers: { 'Content-Type': 'text/css' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/style.css'));
    const body = await res.text();
    expect(body).toContain('url("/proxy/https://cdn.other.com/x.png")');
  });

  it('strips CSP/XFO/COOP/COEP headers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html></html>', {
        headers: {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'none'",
          'X-Frame-Options': 'DENY',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'same-origin',
        },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/'));
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(res.headers.get('X-Frame-Options')).toBeNull();
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBeNull();
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBeNull();
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBeNull();
  });

  it('namespaces Set-Cookie with __pw_ prefix', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html></html>', {
        headers: {
          'Content-Type': 'text/html',
          'Set-Cookie': 'session=abc123; Path=/; HttpOnly',
        },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/'));
    const sc = res.headers.get('Set-Cookie');
    expect(sc).toContain('__pw_session=abc123');
  });

  it('removes Content-Length after rewriting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html><body>hello</body></html>', {
        headers: { 'Content-Type': 'text/html', 'Content-Length': '28' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/'));
    expect(res.headers.get('Content-Length')).toBeNull();
  });

  it('removes meta CSP tags from HTML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        '<html><head><meta http-equiv="Content-Security-Policy" content="default-src none"><title>x</title></head></html>',
        { headers: { 'Content-Type': 'text/html' } }
      )
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/'));
    const body = await res.text();
    expect(body).not.toContain('Content-Security-Policy');
  });

  it('rewrites meta refresh target', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        '<html><head><meta http-equiv="refresh" content="0; url=/next"></head></html>',
        { headers: { 'Content-Type': 'text/html' } }
      )
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/'));
    const body = await res.text();
    expect(body).toContain('/proxy/https://target.com/next');
  });
});
