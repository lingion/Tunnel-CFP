// 验证 workers pool 里 HTMLRewriter text handler 行为(为 CSS body 重写铺路)
import { describe, it, expect } from 'vitest';
type TextChunk = { text: string; replace(c: string): void };

describe('HTMLRewriter in workers runtime', () => {
  it('text handler can replace text inside <style>', async () => {
    const res = new Response('<html><head><style>a{color:red}</style></head></html>', {
      headers: { 'Content-Type': 'text/html' },
    });
    const out = new HTMLRewriter()
      .on('style', {
        text(t: TextChunk) {
          t.replace(t.text.replace(/red/g, 'blue'));
        },
      })
      .transform(res);
    const body = await out.text();
    expect(body).toContain('a{color:blue}');
    expect(body).not.toContain('red');
  });

  it('attribute handler rewrites style attr', async () => {
    const res = new Response('<div style="background:url(x.png)"></div>', {
      headers: { 'Content-Type': 'text/html' },
    });
    const out = new HTMLRewriter()
      .on('[style]', {
        element(el: any) {
          const v = el.getAttribute('style');
          if (v) el.setAttribute('style', v.replace('x.png', 'rewritten.png'));
        },
      })
      .transform(res);
    const body = await out.text();
    expect(body).toContain('rewritten.png');
  });

  it('script text handler can see inline script content', async () => {
    const res = new Response('<script>var a=1;fetch("/api")</script>', {
      headers: { 'Content-Type': 'text/html' },
    });
    let seen = '';
    const out = new HTMLRewriter()
      .on('script', {
        text(t: TextChunk) {
          seen += t.text;
        },
      })
      .transform(res);
    await out.text();
    expect(seen).toContain('fetch("/api")');
  });
});
