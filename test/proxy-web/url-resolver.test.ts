// test/proxy-web/url-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { rewriteUrl } from '../../src/proxy-web/url-resolver';

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