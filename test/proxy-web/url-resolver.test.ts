// test/proxy-web/url-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { rewriteUrl, rewriteSrcset, rewriteCssUrls, rewriteJsUrls } from '../../src/proxy-web/url-resolver';

const ctx = { currentOrigin: 'https://example.com' };

describe('rewriteUrl', () => {
  it('rewrites absolute http(s) URL', () => {
    expect(rewriteUrl('https://other.com/foo', ctx)).toBe('/proxy/https://other.com/foo');
  });
  it('rewrites protocol-relative URL', () => {
    expect(rewriteUrl('//cdn.com/x.css', ctx)).toBe('/proxy/https://cdn.com/x.css');
  });
  it('rewrites relative path (rooted)', () => {
    expect(rewriteUrl('/about.html', ctx)).toBe('/proxy/https://example.com/about.html');
  });
  it('rewrites relative path (relative)', () => {
    expect(rewriteUrl('page.html', ctx)).toBe('/proxy/https://example.com/page.html');
  });
  it('preserves data: URI', () => {
    expect(rewriteUrl('data:image/png;base64,xxx', ctx)).toBe('data:image/png;base64,xxx');
  });
  it('preserves javascript: URI', () => {
    expect(rewriteUrl('javascript:void(0)', ctx)).toBe('javascript:void(0)');
  });
  it('preserves anchor link', () => {
    expect(rewriteUrl('#section1', ctx)).toBe('#section1');
  });
  it('preserves mailto', () => {
    expect(rewriteUrl('mailto:x@y.com', ctx)).toBe('mailto:x@y.com');
  });
  it('preserves tel', () => {
    expect(rewriteUrl('tel:+1234567890', ctx)).toBe('tel:+1234567890');
  });
  it('returns empty string for empty input', () => {
    expect(rewriteUrl('', ctx)).toBe('');
  });
});
describe('rewriteSrcset', () => {
  it('rewrites each candidate with descriptors', () => {
    const out = rewriteSrcset('a.png 1x, /img/b@2x.png 2x', ctx);
    expect(out).toBe('/proxy/https://example.com/a.png 1x, /proxy/https://example.com/img/b@2x.png 2x');
  });
  it('handles single candidate without descriptor', () => {
    expect(rewriteSrcset('logo.png', ctx)).toBe('/proxy/https://example.com/logo.png');
  });
  it('preserves data: URLs in srcset', () => {
    const v = 'data:image/gif;base64,R0lGOD 1x, real.png 2x';
    const out = rewriteSrcset(v, ctx);
    expect(out).toContain('data:image/gif;base64,R0lGOD 1x');
    expect(out).toContain('/proxy/https://example.com/real.png 2x');
  });
});

describe('rewriteCssUrls', () => {
  it('rewrites url() with double quotes', () => {
    expect(rewriteCssUrls('background: url("/img/sprite.svg");', ctx)).toBe(
      'background: url("/proxy/https://example.com/img/sprite.svg");'
    );
  });
  it('rewrites unquoted url()', () => {
    expect(rewriteCssUrls('background:url(img/x.png)', ctx)).toBe(
      'background:url("/proxy/https://example.com/img/x.png")'
    );
  });
  it('rewrites absolute and protocol-relative url()', () => {
    const out = rewriteCssUrls('a{background:url(https://cdn.com/f.png)}b{background:url(//c.com/g.png)}', ctx);
    expect(out).toContain('url("/proxy/https://cdn.com/f.png")');
    expect(out).toContain('url("/proxy/https://c.com/g.png")');
  });
  it('preserves data: url()', () => {
    const css = "filter:url('data:image/svg+xml;charset=utf-8,<svg>')";
    expect(rewriteCssUrls(css, ctx)).toBe(css);
  });
  it('rewrites @import string form', () => {
    expect(rewriteCssUrls('@import "theme.css";', ctx)).toBe(
      '@import "/proxy/https://example.com/theme.css";'
    );
  });
  it('leaves url(#fragment) alone', () => {
    expect(rewriteCssUrls('filter:url(#foo)', ctx)).toBe('filter:url(#foo)');
  });
});

describe('rewriteJsUrls', () => {
  const jsCtx = { ...ctx, currentPath: '/static/app.js' };
  it('rewrites absolute URLs inside string literals', () => {
    const js = `var a="https://cdn.example.com/img.png";var b='https://other.org/api?v=1';`;
    const out = rewriteJsUrls(js, jsCtx);
    expect(out).toContain('"/proxy/https://cdn.example.com/img.png"');
    expect(out).toContain("'/proxy/https://other.org/api?v=1'");
  });
  it('preserves URLs in non-string code positions (regex/comments untouched strings only)', () => {
    const js = `// see https://docs.example.com/guide\nvar re = /https:\\/\\/regex.example.com/;`;
    const out = rewriteJsUrls(js, jsCtx);
    // 注释里也重写无害(不会被执行);regex 字面量里的 / 分隔串不在引号内 → 不动
    expect(out).toContain('/https:\\/\\/regex.example.com/');
  });
  it('skips data: and already-proxied strings', () => {
    const js = `var a="data:image/png;base64,AB";var b="/proxy/https://x.com/y";`;
    const out = rewriteJsUrls(js, jsCtx);
    expect(out).toBe(js);
  });
  it('skips JSON schema namespaces (w3.org etc are NOT executable urls)', () => {
    // w3.org 是 schema 声明,重写会破坏 JSON-LD/JSX runtime — 黑名单豁免
    const js = `var ctx="http://www.w3.org/2000/svg";`;
    expect(rewriteJsUrls(js, jsCtx)).toBe(js);
  });
});
