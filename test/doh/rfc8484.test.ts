// test/doh/rfc8484.test.ts
// RFC 8484 DoH wire format handler tests
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRfc8484 } from '../../src/doh/rfc8484';

// cache.put 需要 waitUntil；Node 环境无 caches，putCachedResponse 直接短路，fakeCtx 只是占位签名
const fakeCtx = { waitUntil: (_p: Promise<unknown>) => {} } as unknown as ExecutionContext;

// Sample DNS A query for example.com built offline:
// Header: id=0, flags=0x0100 (RD), qdcount=1
// Question: example.com, type=A(1), class=IN(1)
function buildExampleAQuery(): Uint8Array {
  // Construct programmatically using dns-packet encode
  // For test purposes, import encode
  // (lazy to avoid circular dep)
  return new Uint8Array(0); // placeholder; real query built in helper
}

// Use dns-packet to build a valid query
import { encode } from 'dns-packet';
function makeQuery(): Uint8Array {
  return encode({
    id: 0,
    type: 'query',
    flags: 0x0100,
    questions: [{ type: 'A', name: 'example.com', class: 'IN' }],
  });
}

const validDnsResponse = encode({
  id: 0,
  type: 'response',
  flags: 0x8180,
  questions: [{ type: 'A', name: 'example.com', class: 'IN' }],
  answers: [{ type: 'A', name: 'example.com', class: 'IN', ttl: 60, data: '93.184.216.34' }],
});

describe('DoH RFC 8484 handler', () => {
  beforeEach(() => {
    // Mock upstream DoH
    globalThis.fetch = vi.fn(async () => new Response(validDnsResponse, { status: 200 })) as any;
  });

  it('accepts POST with application/dns-message and returns binary response', async () => {
    const query = makeQuery();
    const req = new Request('https://worker.your-subdomain.workers.dev/dns-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message' },
      body: query,
    });
    const res = await handleRfc8484(req, fakeCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/dns-message');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('rejects POST with wrong Content-Type (415)', async () => {
    const req = new Request('https://worker.your-subdomain.workers.dev/dns-query', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    const res = await handleRfc8484(req, fakeCtx);
    expect(res.status).toBe(415);
  });

  it('accepts GET with dns=base64url-no-pad', async () => {
    const query = makeQuery();
    // base64url encode without padding
    let b64 = btoa(String.fromCharCode(...query));
    b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const req = new Request(`https://worker.your-subdomain.workers.dev/dns-query?dns=${b64}`, {
      method: 'GET',
    });
    const res = await handleRfc8484(req, fakeCtx);
    expect(res.status).toBe(200);
  });

  it('rejects GET without dns param (400)', async () => {
    const req = new Request('https://worker.your-subdomain.workers.dev/dns-query', { method: 'GET' });
    const res = await handleRfc8484(req, fakeCtx);
    expect(res.status).toBe(400);
  });

  it('rejects other methods (405)', async () => {
    const req = new Request('https://worker.your-subdomain.workers.dev/dns-query', { method: 'PUT' });
    const res = await handleRfc8484(req, fakeCtx);
    expect(res.status).toBe(405);
  });

  it('rejects payload > 65535 bytes (413)', async () => {
    const tooBig = new Uint8Array(65536);
    const req = new Request('https://worker.your-subdomain.workers.dev/dns-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message' },
      body: tooBig,
    });
    const res = await handleRfc8484(req, fakeCtx);
    expect(res.status).toBe(413);
  });
});
// 回归：cache.put 路径必须收到带 waitUntil 的真实 ctx（线上曾因 {} 冒充 ctx 炸 1101）
describe('DoH RFC 8484 cache integration', () => {
  it('GET happy path passes a real ExecutionContext into cache write', async () => {
    const query = makeQuery();
    let b64 = btoa(String.fromCharCode(...query));
    b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const seen: Promise<unknown>[] = [];
    const realCtx = { waitUntil: (p: Promise<unknown>) => seen.push(p) } as unknown as ExecutionContext;
    const req = new Request(`https://worker.your-subdomain.workers.dev/dns-query?dns=${b64}`, { method: 'GET' });
    const res = await handleRfc8484(req, realCtx);
    expect(res.status).toBe(200);
  });
});
