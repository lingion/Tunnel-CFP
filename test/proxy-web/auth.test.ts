// test/proxy-web/auth.test.ts
import { describe, it, expect } from 'vitest';
import { checkProxyAuth } from '../../src/proxy-web/auth';

describe('checkProxyAuth', () => {
  const req = (u: string, cookie?: string) =>
    new Request(u, cookie ? { headers: { Cookie: cookie } } : {});

  it('allows everything when PROXY_KEY unset', () => {
    expect(checkProxyAuth(req('https://x/proxy/https://a.com'), {})).toBeNull();
  });
  it('rejects missing key when set', () => {
    const r = checkProxyAuth(req('https://x/proxy/https://a.com'), { PROXY_KEY: 's3cr3t' });
    expect(r?.status).toBe(401);
  });
  it('accepts ?key= match', () => {
    expect(checkProxyAuth(req('https://x/proxy/https://a.com?key=s3cr3t'), { PROXY_KEY: 's3cr3t' })).toBeNull();
  });
  it('accepts cookie match', () => {
    expect(checkProxyAuth(req('https://x/proxy/https://a.com', '__proxy_key=s3cr3t'), { PROXY_KEY: 's3cr3t' })).toBeNull();
  });
  it('rejects wrong key', () => {
    expect(checkProxyAuth(req('https://x/proxy/https://a.com?key=nope'), { PROXY_KEY: 's3cr3t' })?.status).toBe(401);
  });
});
