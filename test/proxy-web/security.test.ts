// test/proxy-web/security.test.ts
import { describe, it, expect } from 'vitest';
import { validateTargetUrl, SecurityError } from '../../src/proxy-web/security';

describe('validateTargetUrl', () => {
  it('rejects self-recursion (exact host)', () => {
    expect(() => validateTargetUrl('https://your-worker.your-subdomain.workers.dev/foo'))
      .toThrow(SecurityError);
  });

  it('rejects self-recursion (subdomain)', () => {
    expect(() => validateTargetUrl('https://evil.your-worker.your-subdomain.workers.dev/foo'))
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
describe('self recursion: production domain', () => {
  it('blocks SELF_HOSTS targets', () => {
    expect(() => validateTargetUrl('https://your-worker.your-subdomain.workers.dev/proxy/x')).toThrow(/Self recursion/);
  });
  it('blocks subdomains of SELF_HOSTS', () => {
    expect(() => validateTargetUrl('https://evil.sub.your-worker.your-subdomain.workers.dev/')).toThrow(/Self recursion/);
  });
  it('still allows unrelated external hosts', () => {
    expect(() => validateTargetUrl('https://gh.example.com/foo')).not.toThrow();
  });
});

// round6:对抗审计 — 解析口径 SSRF 防护(字面量变体不再漏判)
describe('round6: parsed-hostname SSRF guard', () => {
  it('blocks integer IPv4 (2130706433 → 127.0.0.1)', () => {
    expect(() => validateTargetUrl('http://2130706433/')).toThrow(/Direct IP/);
  });
  it('blocks hex IPv4 (0x7f000001 → 127.0.0.1)', () => {
    expect(() => validateTargetUrl('http://0x7f000001/')).toThrow(/Direct IP/);
  });
  it('blocks octal IPv4 (0177.0.0.1 → 127.0.0.1)', () => {
    expect(() => validateTargetUrl('http://0177.0.0.1/')).toThrow(/Direct IP/);
  });
  it('blocks short-form IPv4 (127.1 → 127.0.0.1)', () => {
    expect(() => validateTargetUrl('http://127.1/')).toThrow(/Direct IP/);
  });
  it('blocks decimal metadata IP (2852039166 → 169.254.169.254)', () => {
    expect(() => validateTargetUrl('http://2852039166/computeMetadata/v1/')).toThrow(/Direct IP/);
  });
  it('blocks plain public IPv4 too (代理语义按域名走)', () => {
    expect(() => validateTargetUrl('http://8.8.8.8/')).toThrow(/Direct IP/);
  });
  it('blocks IPv4-mapped IPv6 literal', () => {
    expect(() => validateTargetUrl('http://[::ffff:127.0.0.1]/')).toThrow(/Direct IP|Direct/);
  });
  it('blocks localhost and variants', () => {
    expect(() => validateTargetUrl('http://localhost:6379/')).toThrow(/Localhost/);
    expect(() => validateTargetUrl('http://api.localhost/')).toThrow(/Localhost/);
  });
  it('blocks .internal / .local / metadata endpoints', () => {
    expect(() => validateTargetUrl('http://metadata.google.internal/')).toThrow(/Internal/);
    expect(() => validateTargetUrl('http://db.internal/')).toThrow(/Internal/);
    expect(() => validateTargetUrl('http://nas.local/')).toThrow(/Internal/);
  });
  it('blocks RFC1918 dotted quads', () => {
    expect(() => validateTargetUrl('http://10.0.0.5/')).toThrow(/Direct IP/);
    expect(() => validateTargetUrl('http://192.168.1.1/')).toThrow(/Direct IP/);
    expect(() => validateTargetUrl('http://172.16.0.9/')).toThrow(/Direct IP/);
  });
  it('blocks FQDN trailing-dot evasion', () => {
    expect(() => validateTargetUrl('http://localhost./')).toThrow(/Localhost/);
  });
  it('still allows legit domains', () => {
    expect(() => validateTargetUrl('https://example.com')).not.toThrow();
    expect(() => validateTargetUrl('https://notlocalhost.example.com/')).not.toThrow();
    expect(() => validateTargetUrl('https://internal.example.com/')).not.toThrow(); // .internal 只拦尾标签
  });
});

describe('ws bridge parity (validateResolvedHost via bridge)', () => {
  it('bridge blocks integer IPv4 host', async () => {
    const { validateBridgeTarget } = await import('../../src/proxy-web/security-bridge');
    expect(() => validateBridgeTarget('2130706433:6379')).toThrow(/Direct IP/);
  });
  it('bridge blocks localhost', async () => {
    const { validateBridgeTarget } = await import('../../src/proxy-web/security-bridge');
    expect(() => validateBridgeTarget('localhost:8080')).toThrow(/Localhost/);
  });
  it('bridge allows normal host', async () => {
    const { validateBridgeTarget } = await import('../../src/proxy-web/security-bridge');
    expect(() => validateBridgeTarget('ws.example.com:443')).not.toThrow();
  });
});
