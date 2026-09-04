// test/doh/json-api.test.ts
// JSON-over-HTTPS /resolve compatibility endpoint
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encode } from 'dns-packet';
import { handleJsonApi } from '../../src/doh/json-api';

const validDnsResponse = encode({
  id: 0,
  type: 'response',
  flags: 0x8180,
  questions: [{ type: 'A', name: 'example.com', class: 'IN' }],
  answers: [{ type: 'A', name: 'example.com', class: 'IN', ttl: 60, data: '93.184.216.34' }],
});

describe('DoH /resolve JSON API', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(validDnsResponse, { status: 200 })) as any;
  });

  it('returns JSON for A record query', async () => {
    const req = new Request('https://cfp.lingion04.workers.dev/resolve?name=example.com&type=A');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/dns-json');
    const body: any = await res.json();
    expect(body.answers).toBeDefined();
    expect(body.answers[0].data).toBe('93.184.216.34');
  });

  it('defaults to A type if not specified', async () => {
    const req = new Request('https://cfp.lingion04.workers.dev/resolve?name=example.com');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(200);
  });

  it('rejects missing name param (400)', async () => {
    const req = new Request('https://cfp.lingion04.workers.dev/resolve');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(400);
  });

  it('rejects unsupported type (400)', async () => {
    const req = new Request('https://cfp.lingion04.workers.dev/resolve?name=example.com&type=SOA');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(400);
  });

  it('accepts AAAA query type', async () => {
    const req = new Request('https://cfp.lingion04.workers.dev/resolve?name=example.com&type=AAAA');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(200);
  });

  it('returns 502 on upstream failure', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 502 })) as any;
    const req = new Request('https://cfp.lingion04.workers.dev/resolve?name=example.com');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(502);
  });
});