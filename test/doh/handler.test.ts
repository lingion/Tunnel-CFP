// test/doh/handler.test.ts
// DoH 顶层路由分发
import { describe, it, expect } from 'vitest';
import { handleDoh } from '../../src/doh/handler';

const fakeCtx = { waitUntil: (_p: Promise<unknown>) => {} } as unknown as ExecutionContext;

describe('DoH handler dispatcher', () => {
  it('/dns-query routes to RFC 8484 handler', async () => {
    const req = new Request('https://worker.your-subdomain.workers.dev/dns-query', { method: 'GET' });
    const res = await handleDoh(req, fakeCtx);
    // GET without dns param → 400 from rfc8484 (not 404)
    expect(res.status).toBe(400);
  });

  it('/resolve routes to JSON API handler', async () => {
    const req = new Request('https://worker.your-subdomain.workers.dev/resolve');
    const res = await handleDoh(req, fakeCtx);
    // Missing name → 400 from json-api
    expect(res.status).toBe(400);
  });

  it('unknown DoH path returns 404', async () => {
    const req = new Request('https://worker.your-subdomain.workers.dev/unknown-doh-path');
    const res = await handleDoh(req, fakeCtx);
    expect(res.status).toBe(404);
  });
});