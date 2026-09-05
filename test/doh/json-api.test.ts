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
    const req = new Request('https://worker.your-subdomain.workers.dev/resolve?name=example.com&type=A');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/dns-json');
    const body: any = await res.json();
    expect(body.Answer).toBeDefined();
    expect(body.Answer[0].data).toBe('93.184.216.34');
    expect(body.Status).toBe(0);
  });

  it('defaults to A type if not specified', async () => {
    const req = new Request('https://worker.your-subdomain.workers.dev/resolve?name=example.com');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(200);
  });

  it('rejects missing name param (400)', async () => {
    const req = new Request('https://worker.your-subdomain.workers.dev/resolve');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(400);
  });

  it('rejects unsupported type (400)', async () => {
    const req = new Request('https://worker.your-subdomain.workers.dev/resolve?name=example.com&type=SOA');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(400);
  });

  it('accepts AAAA query type', async () => {
    const req = new Request('https://worker.your-subdomain.workers.dev/resolve?name=example.com&type=AAAA');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(200);
  });

  it('returns 502 on upstream failure', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 502 })) as any;
    const req = new Request('https://worker.your-subdomain.workers.dev/resolve?name=example.com');
    const res = await handleJsonApi(req);
    expect(res.status).toBe(502);
  });
});
// 契约回归：对齐 Cloudflare/Google JSON 事实标准（Status 数值 + Answer 大写 + type 数值）
// 线上曾输出 dns-packet 原生 decode 结果（rcode/answers/type:"A"），消费方按 Status==0 断言会判废
describe('DoH /resolve Google/Cloudflare-compatible contract', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response(validDnsResponse, { status: 200 })) as any;
  });

  it('A query returns Status/Answer with numeric type', async () => {
    const req = new Request('https://worker.your-subdomain.workers.dev/resolve?name=example.com&type=A');
    const res = await handleJsonApi(req);
    const body: any = await res.json();
    expect(body.Status).toBe(0);
    expect(Array.isArray(body.Answer)).toBe(true);
    expect(body.Answer.length).toBeGreaterThan(0);
    expect(body.Answer[0].type).toBe(1);
    expect(body.Answer[0].data).toBe('93.184.216.34');
    expect(typeof body.Answer[0].TTL).toBe('number');
    expect(body.Answer[0].name).toBe('example.com.');
  });

  it('NXDOMAIN response returns Status=3 with empty Answer', async () => {
    const nx = encode({
      id: 0,
      type: 'response',
      flags: 0x8183, // RCODE=3
      questions: [{ type: 'A', name: 'no-such.example', class: 'IN' }],
    });
    globalThis.fetch = vi.fn(async () => new Response(nx, { status: 200 })) as any;
    const req = new Request('https://worker.your-subdomain.workers.dev/resolve?name=no-such.example&type=A');
    const res = await handleJsonApi(req);
    const body: any = await res.json();
    expect(body.Status).toBe(3);
    expect(body.Answer).toBeUndefined();
  });

  it('AAAA answer maps to numeric type 28', async () => {
    const aaaa = encode({
      id: 0,
      type: 'response',
      flags: 0x8180,
      questions: [{ type: 'AAAA', name: 'example.com', class: 'IN' }],
      answers: [{ type: 'AAAA', name: 'example.com', class: 'IN', ttl: 120, data: '2606:2800:220:1:248:1893:25c8:1946' }],
    });
    globalThis.fetch = vi.fn(async () => new Response(aaaa, { status: 200 })) as any;
    const req = new Request('https://worker.your-subdomain.workers.dev/resolve?name=example.com&type=AAAA');
    const res = await handleJsonApi(req);
    const body: any = await res.json();
    expect(body.Status).toBe(0);
    expect(body.Answer[0].type).toBe(28);
  });

  it('CNAME chain entries included in Answer with type 5', async () => {
    const cname = encode({
      id: 0,
      type: 'response',
      flags: 0x8180,
      questions: [{ type: 'A', name: 'alias.example', class: 'IN' }],
      answers: [
        { type: 'CNAME', name: 'alias.example', class: 'IN', ttl: 300, data: 'real.example.' },
        { type: 'A', name: 'real.example', class: 'IN', ttl: 60, data: '1.2.3.4' },
      ],
    });
    globalThis.fetch = vi.fn(async () => new Response(cname, { status: 200 })) as any;
    const req = new Request('https://worker.your-subdomain.workers.dev/resolve?name=alias.example&type=A');
    const res = await handleJsonApi(req);
    const body: any = await res.json();
    expect(body.Status).toBe(0);
    expect(body.Answer[0].type).toBe(5);
    expect(body.Answer[1].type).toBe(1);
  });
});
