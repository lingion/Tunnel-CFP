// test/subscription/md5.test.ts
// MD5 polyfill + MD5MD5 token 向量测试（RFC 1321 标准向量 + 线上 token 锚点）
import { describe, it, expect } from 'vitest';
import { md5, md5md5 } from '../../src/subscription/md5';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// RFC 1321 Appendix A.5 测试向量
const RFC1321: Array<[string, string]> = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
  ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
];

describe('MD5 polyfill (RFC 1321 vectors)', () => {
  it.each(RFC1321)('md5(%j) matches RFC 1321 vector', async (input, expected) => {
    const digest = await md5(new TextEncoder().encode(input));
    expect(hex(digest)).toBe(expected);
  });

  it.each([
    ['a'.repeat(56), '3b0c8ac703f828b04c6c197006d17218'], // 填充边界：恰需第二块
    ['a'.repeat(64), '014842d480b571495a4a0363793f7367'], // 整块
    ['a'.repeat(119), '8a7bd0732ed6a28ce75f6dabc90e1613'], // 跨块
  ])('md5(padding boundary len=%d) matches reference', async (input, expected) => {
    const digest = await md5(new TextEncoder().encode(input));
    expect(hex(digest)).toBe(expected);
  });
});

describe('MD5MD5 token (md5(hex[7:27]))', () => {
  it('matches live anchor: MD5MD5(worker.example.com + UUID) used by /sub auth', async () => {
    const token = await md5md5('worker.example.com' + '12345678-1234-4123-8123-123456789abc');
    // 该值由 Node crypto.createHash('md5') 独立算出
    expect(token).toBe('dd7c9ec20084c6806391a4f0427d62db');
  });
});
