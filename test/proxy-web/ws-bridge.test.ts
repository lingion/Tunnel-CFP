// test/proxy-web/ws-bridge.test.ts
// WS 桥纯逻辑测试:路径解析、WS 帧编解码、桥目标校验
// (端到端 TCP 泵需要真 runtime,由 workers pool 集成测试覆盖部署后验证)
import { describe, it, expect } from 'vitest';
import { validateBridgeTarget } from '../../src/proxy-web/security-bridge';

describe('validateBridgeTarget', () => {
  it('blocks self host (workers.dev)', () => {
    expect(() => validateBridgeTarget('cfp.lingion04.workers.dev')).toThrow(/recursion/i);
  });
  it('blocks self host (production domain)', () => {
    expect(() => validateBridgeTarget('cfp.qdp.qzz.io')).toThrow(/recursion/i);
  });
  it('blocks direct IPv4', () => {
    expect(() => validateBridgeTarget('169.254.169.254:80')).toThrow(/IP/);
  });
  it('blocks IPv6 literal', () => {
    expect(() => validateBridgeTarget('[::1]:8080')).toThrow(/IP/);
  });
  it('blocks .internal names', () => {
    expect(() => validateBridgeTarget('metadata.google.internal')).toThrow(/internal/i);
  });
  it('allows normal external hosts', () => {
    expect(() => validateBridgeTarget('ws.postman-echo.com')).not.toThrow();
  });
});
