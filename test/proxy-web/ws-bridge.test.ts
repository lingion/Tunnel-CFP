// test/proxy-web/ws-bridge.test.ts
// WS 桥纯逻辑测试:路径解析、WS 帧编解码、桥目标校验
// (端到端 TCP 泵需要真 runtime,由 workers pool 集成测试覆盖部署后验证)
import { describe, it, expect } from 'vitest';
import { validateBridgeTarget } from '../../src/proxy-web/security-bridge';

describe('validateBridgeTarget', () => {
  it('blocks self host (SELF_HOSTS entry)', () => {
    expect(() => validateBridgeTarget('your-worker.your-subdomain.workers.dev')).toThrow(/recursion/i);
  });
  it('blocks self host (subdomain)', () => {
    expect(() => validateBridgeTarget('evil.your-worker.your-subdomain.workers.dev')).toThrow(/recursion/i);
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

// round6b:帧编解码审计覆盖(此前零覆盖)
import { encodeClientFrame } from '../../src/proxy-web/ws-bridge';

describe('ws frame codec (round6 audit coverage)', () => {
  it('client frames are always MASKED (RFC 6455 §5.1)', () => {
    for (const len of [2, 125, 126, 1000, 65535, 70000]) {
      const payload = new Uint8Array(len).fill(0x41);
      const frame = encodeClientFrame(payload, 0x2);
      expect((frame[0]! & 0x80) !== 0, 'FIN set').toBe(true);
      expect(frame[0]! & 0x0f, 'opcode preserved').toBe(0x2);
      expect((frame[1]! & 0x80) !== 0, `mask bit set for len=${len}`).toBe(true);
      // mask key present at correct offset per length class
      const maskOff = len < 126 ? 2 : len < 65536 ? 4 : 10;
      // unmask roundtrip
      const body = frame.slice(maskOff + 4);
      expect(body.length).toBe(len);
      const mask = frame.slice(maskOff, maskOff + 4);
      const unmasked = new Uint8Array(body);
      for (let j = 0; j < unmasked.length; j++) unmasked[j] = unmasked[j]! ^ mask[j & 3]!;
      expect(unmasked[0]).toBe(0x41);
    }
  });

  it('length class encodings (7bit / 16bit / 64bit)', () => {
    const small = encodeClientFrame(new Uint8Array(5), 0x1);
    expect(small[1]! & 0x7f).toBe(5);
    const mid = encodeClientFrame(new Uint8Array(300), 0x1);
    expect(mid[1]! & 0x7f).toBe(126);
    expect((mid[2]! << 8) | mid[3]!).toBe(300);
    const big = encodeClientFrame(new Uint8Array(70000), 0x2);
    expect(big[1]! & 0x7f).toBe(127);
    expect(((big[6]! << 24) | (big[7]! << 16) | (big[8]! << 8) | big[9]!) >>> 0).toBe(70000);
  });

  it('text vs binary opcode', () => {
    const t = encodeClientFrame(new TextEncoder().encode('hi'), 0x1);
    expect(t[0]! & 0x0f).toBe(0x1);
    const b = encodeClientFrame(new Uint8Array(4), 0x2);
    expect(b[0]! & 0x0f).toBe(0x2);
  });
});
