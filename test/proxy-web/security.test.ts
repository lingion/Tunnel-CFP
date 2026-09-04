// test/proxy-web/security.test.ts
import { describe, it, expect } from 'vitest';
import { validateTargetUrl, SecurityError } from '../../src/proxy-web/security';

describe('validateTargetUrl', () => {
  it('rejects self-recursion (exact host)', () => {
    expect(() => validateTargetUrl('https://cfp.lingion04.workers.dev/foo'))
      .toThrow(SecurityError);
  });

  it('rejects self-recursion (subdomain)', () => {
    expect(() => validateTargetUrl('https://evil.cfp.lingion04.workers.dev/foo'))
      .toThrow(/self/i);
  });

  it('rejects IP literal', () => {
    expect(() => validateTargetUrl('http://169.254.169.254/latest/meta-data'))
      .toThrow(/ip/i);
  });

  it('rejects non-http(s) protocol', () => {
    expect(() => validateTargetUrl('file:///etc/passwd'))
      .toThrow(/protocol/i);
    expect(() => validateTargetUrl('ftp://example.com/x'))
      .toThrow(/protocol/i);
  });

  it('rejects malformed URL', () => {
    expect(() => validateTargetUrl('not-a-url'))
      .toThrow();
  });

  it('accepts normal https URL', () => {
    expect(() => validateTargetUrl('https://example.com')).not.toThrow();
    expect(() => validateTargetUrl('https://example.com/path?q=1')).not.toThrow();
  });

  it('accepts normal http URL', () => {
    expect(() => validateTargetUrl('http://example.com')).not.toThrow();
  });
});