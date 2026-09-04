// test/proxy-web/handler.test.ts
// End-to-end 测试：mock HTMLRewriter + fetch，验证 handler 输出
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleWebProxy } from '../../src/proxy-web/handler';

// Mock HTMLRewriter globally with a simple interface
// CF API: rewriter.transform(response) → Response
class MockHTMLRewriter {
  private rules: Array<{ selector: string; element: (el: any) => void }> = [];
  on(selector: string, handler: any) {
    this.rules.push({ selector, element: handler.element });
    return this;
  }
  async transform(response: Response): Promise<Response> {
    const text = await response.text();
    let rewritten = text;
    for (const rule of this.rules) {
      const m = rule.selector.match(/^(\w+)\[(\w+)\]$/);
      if (m) {
        const [, tag, attr] = m;
        const tagRe = new RegExp(`<${tag}\\b([^>]*?)${attr}="([^"]+)"`, 'g');
        rewritten = rewritten.replace(tagRe, (_match, pre, value) => {
          let newValue = value;
          const mockEl = {
            getAttribute: (a: string) => (a === attr ? newValue : null),
            setAttribute: (a: string, v: string) => {
              if (a === attr) newValue = v;
            },
          };
          rule.element(mockEl);
          return `<${tag}${pre}${attr}="${newValue}"`;
        });
      }
    }
    return new Response(rewritten, {
      status: response.status,
      headers: response.headers,
    });
  }
}

beforeEach(() => {
  (globalThis as any).HTMLRewriter = MockHTMLRewriter;
});

describe('handleWebProxy integration', () => {
  it('returns 400 when no target URL provided', async () => {
    const res = await handleWebProxy(new Request('https://cfp.lingion04.workers.dev/proxy/'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when target URL is invalid', async () => {
    const res = await handleWebProxy(
      new Request('https://cfp.lingion04.workers.dev/proxy/not-a-url')
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when target is self-recursion', async () => {
    const res = await handleWebProxy(
      new Request('https://cfp.lingion04.workers.dev/proxy/' + encodeURIComponent('https://cfp.lingion04.workers.dev/foo'))
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Self recursion');
  });

  it('returns 400 when target is direct IP', async () => {
    const res = await handleWebProxy(
      new Request('https://cfp.lingion04.workers.dev/proxy/' + encodeURIComponent('http://169.254.169.254/x'))
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when target uses file:// protocol', async () => {
    const res = await handleWebProxy(
      new Request('https://cfp.lingion04.workers.dev/proxy/' + encodeURIComponent('file:///etc/passwd'))
    );
    expect(res.status).toBe(400);
  });

  it('proxies HTML and rewrites <a href>', async () => {
    const targetHtml = '<html><body><a href="https://example.com/about">About</a></body></html>';
    globalThis.fetch = vi.fn(async () =>
      new Response(targetHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    ) as any;

    const res = await handleWebProxy(
      new Request('https://cfp.lingion04.workers.dev/proxy/' + encodeURIComponent('https://target.com/'))
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('/proxy/https://example.com/about');
  });

  it('strips Content-Security-Policy from upstream headers', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('<html></html>', {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'none'",
          'X-Frame-Options': 'DENY',
        },
      })
    ) as any;

    const res = await handleWebProxy(
      new Request('https://cfp.lingion04.workers.dev/proxy/' + encodeURIComponent('https://target.com/'))
    );
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(res.headers.get('X-Frame-Options')).toBeNull();
  });

  it('passes through non-HTML responses unmodified', async () => {
    const cssBody = 'body { color: red; }';
    globalThis.fetch = vi.fn(async () =>
      new Response(cssBody, {
        status: 200,
        headers: { 'Content-Type': 'text/css' },
      })
    ) as any;

    const res = await handleWebProxy(
      new Request('https://cfp.lingion04.workers.dev/proxy/' + encodeURIComponent('https://target.com/style.css'))
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/css');
    expect(await res.text()).toBe(cssBody);
  });
});