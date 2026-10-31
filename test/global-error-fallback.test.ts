// 全局兜底壳测试:任何 handler 抛未捕获异常 → 500 JSON,绝不向外 reject
// (向外 reject = Workers 平台 Exception 页,给扫描器"这是个 Worker"的指纹,
//  且 Google/CF 日志把它记成 error)
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/gateway/router', () => ({
  handleGateway: vi.fn(async () => {
    throw new Error('boom');
  }),
}));

import worker from '../src/index';

const env = {
  KV: {} as KVNamespace,
  ADMIN: 'test',
  UUID: '00000000-0000-4000-8000-000000000000',
} as unknown as Env;

describe('全局兜底壳', () => {
  it('handler 抛错时返回 500 JSON 而非向外 reject', async () => {
    const req = new Request('https://worker.test/api/v1/anything');
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    // 关键:整个 promise 必须 resolve,不能 reject
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({ error: 'internal' });
    // 不泄露内部错误信息
    expect(JSON.stringify(body)).not.toContain('boom');
  });
});
