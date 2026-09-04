// src/subscription/sha224.ts — SHA-224 纯 TS 实现
// Workers/Node webcrypto 均无 SHA-224；trojan 密码 = sha224(UUID) hex，
// 必须与 vendor edgetunnel 入站嗅探的 sha224Password 一致（算法同 vendor sha224()）
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (n: number, b: number): number => ((n >>> b) | (n << (32 - b))) >>> 0;

export function sha224Hex(s: string): string {
  // UTF-8 编码
  const bytes: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000), lo = bitLen & 0xffffffff;
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
  const w: number[] = [];
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    w.push(((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0);
  }
  const h: number[] = [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4];
  for (let i = 0; i < w.length; i += 16) {
    const x: number[] = new Array<number>(64).fill(0);
    for (let j = 0; j < 16; j++) x[j] = w[i + j]!;
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(x[j - 15]!, 7) ^ rotr(x[j - 15]!, 18) ^ (x[j - 15]! >>> 3);
      const s1 = rotr(x[j - 2]!, 17) ^ rotr(x[j - 2]!, 19) ^ (x[j - 2]! >>> 10);
      x[j] = (x[j - 16]! + s0 + x[j - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h0] = h as [number, number, number, number, number, number, number, number];
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (h0 + S1 + ch + K[j]! + x[j]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + maj) >>> 0;
      h0 = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const addends = [a, b, c, d, e, f, g, h0];
    for (let j = 0; j < 8; j++) h[j] = (h[j]! + addends[j]!) >>> 0;
  }
  let hex = '';
  for (let i = 0; i < 7; i++) {
    for (let j = 24; j >= 0; j -= 8) hex += ((h[i]! >>> j) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}
