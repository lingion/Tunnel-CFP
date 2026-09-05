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
    expect(sc).toMatch(/^__pw[a-z0-9]{8}_session=abc123/);
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

describe('round2: query passing and base-url correctness', () => {
  it('passes query string through to target (search links must not 404)', async () => {
    let fetched = '';
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      fetched = String(input);
      return new Response('<html><head></head></html>', { headers: { 'Content-Type': 'text/html' } });
    }) as any);
    const res = await handleWebProxy(
      new Request(`https://cfp.lingion04.workers.dev/proxy/${encodeURIComponent('https://target.com/search?q=abc&lang=zh')}`)
    );
    expect(res.status).toBe(200);
    expect(fetched).toContain('target.com/search?q=abc&lang=zh');
  });

  it('form GET submission: query appended by browser still reaches target', async () => {
    let fetched = '';
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      fetched = String(input);
      return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
    }) as any);
    // 浏览器对 action="/proxy/https://target.com/search" 提交后请求形态
    const res = await handleWebProxy(
      new Request('https://cfp.lingion04.workers.dev/proxy/https://target.com/search?query=hello')
    );
    expect(res.status).toBe(200);
    expect(fetched).toContain('query=hello');
  });

  it('rewrites relative src against the PAGE path, not origin root', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<img src="img/logo.png"><a href="../up.html">up</a>', {
        headers: { 'Content-Type': 'text/html' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/articles/2024/post.html'));
    const body = await res.text();
    expect(body).toContain('/proxy/https://target.com/articles/2024/img/logo.png');
    expect(body).toContain('/proxy/https://target.com/articles/up.html');
  });

  it('rewrites css url() relative to the CSS FILE path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('body{background:url(bg.png)}', {
        headers: { 'Content-Type': 'text/css' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/css/theme/main.css'));
    const body = await res.text();
    expect(body).toContain('url("/proxy/https://target.com/css/theme/bg.png")');
  });
});

describe('round2: cookie isolation + shim hardening', () => {
  it('namespaces Set-Cookie per target host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<html></html>', {
        headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'session=xyz; Path=/' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/'));
    const sc = res.headers.get('Set-Cookie') ?? '';
    // __pw + 8位host标签 + _session
    expect(sc).toMatch(/^__pw[a-z0-9]{8}_session=xyz/);
  });

  it('different hosts produce different cookie names for same cookie name', async () => {
    async function cookieNameFor(host: string): Promise<string> {
      vi.stubGlobal('fetch', vi.fn(async () =>
        new Response('<html></html>', {
          headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'session=v; Path=/' },
        })
      ) as any);
      const res = await handleWebProxy(proxyReq(`https://${host}/`));
      const sc = res.headers.get('Set-Cookie') ?? '';
      return sc.split('=')[0] ?? '';
    }
    const a = await cookieNameFor('aaa.com');
    const b = await cookieNameFor('bbb.org');
    expect(a).not.toBe(b);
  });

  it('drops cookies belonging to other hosts on the way in', async () => {
    let cookieHeader = '';
    vi.stubGlobal('fetch', vi.fn(async (_t: any, init: any) => {
      cookieHeader = init.headers.get('Cookie') ?? '';
      return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
    }) as any);
    const otherTag = ((): string => {
      let h = 0;
      const host = 'other.com';
      for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36).padStart(8, '0').slice(0, 8);
    })();
    const req = new Request(proxyReq('https://target.com/'), {
      headers: { Cookie: `__pw${otherTag}_stolen=1; legit=2` },
    });
    await handleWebProxy(req as any);
    expect(cookieHeader).not.toContain('stolen');
  });

  it('keeps same-host cookies working (roundtrip)', async () => {
    let cookieHeader = '';
    vi.stubGlobal('fetch', vi.fn(async (_t: any, init: any) => {
      cookieHeader = (init.headers as Headers).get('Cookie') ?? '';
      return new Response('<html></html>', {
        headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'session=abc; Path=/' },
      });
    }) as any);
    // 先拿 target.com 的命名空间名
    const setRes = await handleWebProxy(proxyReq('https://target.com/'));
    const sc = setRes.headers.get('Set-Cookie') ?? '';
    const name = sc.split('=')[0] ?? '';
    expect(name).toMatch(/^__pw[a-z0-9]{8}_session$/);
    // 模拟浏览器存了该 cookie 后回传 → 出站应还原为 session=abc
    await handleWebProxy(new Request(proxyReq('https://target.com/').url, {
      headers: { Cookie: `${name}=abc` },
    }));
    expect(cookieHeader).toBe('session=abc');
  });
});

describe('round2: timeout + error page', () => {
  it('headers-phase hang is cut by AbortSignal (30s in prod)', async () => {
    let capturedSignal: AbortSignal | null = null;
    vi.stubGlobal('fetch', vi.fn((_t: any, init: any) => {
      capturedSignal = init.signal;
      // 挂死直到 abort
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'TimeoutError')));
      });
    }) as any);
    const pending = handleWebProxy(new Request(
      'https://cfp.lingion04.workers.dev/proxy/' + encodeURIComponent('https://slow.com/x')
    ));
    // 模拟 30s 到点(CF runtime 会因 AbortSignal.timeout 触发同一 abort 路径)
    await vi.waitFor(() => expect(capturedSignal).not.toBeNull());
    (capturedSignal as unknown as AbortSignal).dispatchEvent(new Event('abort'));
    const res = await pending;
    expect(res.status).toBe(504);
    const body = await res.text();
    expect(body).toContain('超时');
    expect(body).toContain('slow.com');
  });

  it('DNS/conn failure gets the friendly error page (not raw exception)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed: DNS resolution error');
    }) as any);
    const res = await handleWebProxy(new Request(
      'https://cfp.lingion04.workers.dev/proxy/' + encodeURIComponent('https://broken.example/x')
    ));
    expect(res.status).toBe(504);
    const body = await res.text();
    expect(body).toContain('代理请求失败');
    expect(body).toContain('DNS resolution error');
  });
});

describe('round3: JS URL rewriting', () => {
  it('rewrites absolute URLs in .js responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(`var img="https://cdn.target.com/pic.png";var api='https://api.target.com/v1?x=1';`, {
        headers: { 'Content-Type': 'application/javascript' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/static/app.js'));
    const body = await res.text();
    expect(body).toContain('"/proxy/https://cdn.target.com/pic.png"');
    expect(body).toContain("'/proxy/https://api.target.com/v1?x=1'");
  });

  it('does not touch w3.org namespaces in JS', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(`var ns="http://www.w3.org/2000/svg";`, {
        headers: { 'Content-Type': 'application/javascript' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/x.js'));
    expect(await res.text()).toContain('http://www.w3.org/2000/svg');
  });
});

describe('round3: redirect semantics', () => {
  it('302 Location rewritten to /proxy/ form instead of auto-following', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://target.com/landing?from=login' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/redirect-me'));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/proxy/https://target.com/landing?from=login');
  });

  it('relative Location resolved against target origin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(null, { status: 301, headers: { Location: '/new-path' } })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/old'));
    expect(res.headers.get('Location')).toBe('/proxy/https://target.com/new-path');
  });
});

describe('round3: header hygiene', () => {
  it('does not forward content-encoding when body was rewritten (css/js/html)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('body{a:b}', {
        headers: { 'Content-Type': 'text/css', 'Content-Encoding': 'br' },
      })
    ) as any);
    const res = await handleWebProxy(proxyReq('https://target.com/a.css'));
    expect(res.headers.get('Content-Encoding')).toBeNull();
  });

  it('strips Sec-Fetch-* and CDN loop headers on the way out', async () => {
    let seen: Record<string, string> = {};
    vi.stubGlobal('fetch', vi.fn(async (_t: any, init: any) => {
      init.headers.forEach((v: string, k: string) => (seen[k] = v));
      return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
    }) as any);
    await handleWebProxy(new Request(proxyReq('https://target.com/').url, {
      headers: {
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate',
        'Cdn-Loop': 'cloudflare',
        'X-Forwarded-For': '1.2.3.4',
      },
    }));
    expect(seen['sec-fetch-site']).toBeUndefined();
    expect(seen['cdn-loop']).toBeUndefined();
    expect(seen['x-forwarded-for']).toBeUndefined();
  });
});
