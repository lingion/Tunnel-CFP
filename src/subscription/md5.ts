// RFC 1321 MD5 polyfill（CF Workers crypto.subtle 不支持 MD5）
// Verified against Node crypto.createHash('md5') — 7 test vectors all pass.
//   md5("") = d41d8cd98f00b204e9800998ecf8427e
//   md5("a") = 0cc175b9c0f1b6a831c399e269772661
//   md5("abc") = 900150983cd24fb0d6963f7d28e17f72
//   md5("hello") = 5d41402abc4b2a76b9719d911017c592
//   md5("The quick brown fox...") = 9e107d9d372bb6826bd81d3542a419d6
//   md5("...lazy dog.") = e4d909c290d0fb1ca068ffaddf22cbd0
//   md5("abcdbcdecdef...") = 8215ef0796a5bc7a8f55ac8b35e7e8b9

export async function md5(input: Uint8Array): Promise<Uint8Array> {
  const ml = input.length;
  const bitLenLo = (ml * 8) >>> 0;
  const bitLenHi = Math.floor(ml / 0x20000000) >>> 0;
  const padLen = (ml % 64 < 56) ? (56 - ml % 64) : (120 - ml % 64);
  const padded = new Uint8Array(ml + padLen + 8);
  padded.set(input);
  padded[ml] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.byteLength - 8, bitLenLo, true);
  dv.setUint32(padded.byteLength - 4, bitLenHi, true);

  const add = (a: number, b: number) => (a + b) >>> 0;
  const rol = (x: number, n: number) => (((x << n) | (x >>> (32 - n)))) >>> 0;
  const F = (x: number, y: number, z: number) => ((x & y) | (~x & z)) >>> 0;
  const G = (x: number, y: number, z: number) => ((x & z) | (y & ~z)) >>> 0;
  const H = (x: number, y: number, z: number) => (x ^ y ^ z) >>> 0;
  const I = (x: number, y: number, z: number) => (y ^ (x | ~z)) >>> 0;
  const OP = (fn: (a: number, b: number, c: number) => number, a: number, b: number, c: number, d: number, k: number, s: number, T: number) =>
    add(b, rol(add(add(add(a, fn(b, c, d)), k), T), s));

  let a = 0x67452301 | 0, b = 0xefcdab89 | 0, c = 0x98badcfe | 0, d = 0x10325476 | 0;

  for (let i = 0; i < padded.length; i += 64) {
    const x = new Uint32Array(16);
    for (let j = 0; j < 16; j++) x[j] = dv.getUint32(i + j * 4, true);
    const x0: number = x[0]!, x1: number = x[1]!, x2: number = x[2]!, x3: number = x[3]!,
          x4: number = x[4]!, x5: number = x[5]!, x6: number = x[6]!, x7: number = x[7]!;
    const x8: number = x[8]!, x9: number = x[9]!;
    const x10: number = x[10]!, x11: number = x[11]!, x12: number = x[12]!, x13: number = x[13]!,
          x14: number = x[14]!, x15: number = x[15]!;
    const A = a, B = b, C = c, D = d;

    // Round 1
    a = OP(F, a, b, c, d, x0,  7, 0xd76aa478);
    d = OP(F, d, a, b, c, x1, 12, 0xe8c7b756);
    c = OP(F, c, d, a, b, x2, 17, 0x242070db);
    b = OP(F, b, c, d, a, x3, 22, 0xc1bdceee);
    a = OP(F, a, b, c, d, x4,  7, 0xf57c0faf);
    d = OP(F, d, a, b, c, x5, 12, 0x4787c62a);
    c = OP(F, c, d, a, b, x6, 17, 0xa8304613);
    b = OP(F, b, c, d, a, x7, 22, 0xfd469501);
    a = OP(F, a, b, c, d, x8,  7, 0x698098d8);
    d = OP(F, d, a, b, c, x9, 12, 0x8b44f7af);
    c = OP(F, c, d, a, b, x10, 17, 0xffff5bb1);
    b = OP(F, b, c, d, a, x11, 22, 0x895cd7be);
    a = OP(F, a, b, c, d, x12,  7, 0x6b901122);
    d = OP(F, d, a, b, c, x13, 12, 0xfd987193);
    c = OP(F, c, d, a, b, x14, 17, 0xa679438e);
    b = OP(F, b, c, d, a, x15, 22, 0x49b40821);

    // Round 2
    a = OP(G, a, b, c, d, x1,  5, 0xf61e2562);
    d = OP(G, d, a, b, c, x6,  9, 0xc040b340);
    c = OP(G, c, d, a, b, x11, 14, 0x265e5a51);
    b = OP(G, b, c, d, a, x0, 20, 0xe9b6c7aa);
    a = OP(G, a, b, c, d, x5,  5, 0xd62f105d);
    d = OP(G, d, a, b, c, x10,  9, 0x02441453);
    c = OP(G, c, d, a, b, x15, 14, 0xd8a1e681);
    b = OP(G, b, c, d, a, x4, 20, 0xe7d3fbc8);
    a = OP(G, a, b, c, d, x9,  5, 0x21e1cde6);
    d = OP(G, d, a, b, c, x14,  9, 0xc33707d6);
    c = OP(G, c, d, a, b, x3, 14, 0xf4d50d87);
    b = OP(G, b, c, d, a, x8, 20, 0x455a14ed);
    a = OP(G, a, b, c, d, x13,  5, 0xa9e3e905);
    d = OP(G, d, a, b, c, x2,  9, 0xfcefa3f8);
    c = OP(G, c, d, a, b, x7, 14, 0x676f02d9);
    b = OP(G, b, c, d, a, x12, 20, 0x8d2a4c8a);

    // Round 3
    a = OP(H, a, b, c, d, x5,  4, 0xfffa3942);
    d = OP(H, d, a, b, c, x8, 11, 0x8771f681);
    c = OP(H, c, d, a, b, x11, 16, 0x6d9d6122);
    b = OP(H, b, c, d, a, x14, 23, 0xfde5380c);
    a = OP(H, a, b, c, d, x1,  4, 0xa4beea44);
    d = OP(H, d, a, b, c, x4, 11, 0x4bdecfa9);
    c = OP(H, c, d, a, b, x7, 16, 0xf6bb4b60);
    b = OP(H, b, c, d, a, x10, 23, 0xbebfbc70);
    a = OP(H, a, b, c, d, x13,  4, 0x289b7ec6);
    d = OP(H, d, a, b, c, x0, 11, 0xeaa127fa);
    c = OP(H, c, d, a, b, x3, 16, 0xd4ef3085);
    b = OP(H, b, c, d, a, x6, 23, 0x04881d05);
    a = OP(H, a, b, c, d, x9,  4, 0xd9d4d039);
    d = OP(H, d, a, b, c, x12, 11, 0xe6db99e5);
    c = OP(H, c, d, a, b, x15, 16, 0x1fa27cf8);
    b = OP(H, b, c, d, a, x2, 23, 0xc4ac5665);

    // Round 4
    a = OP(I, a, b, c, d, x0,  6, 0xf4292244);
    d = OP(I, d, a, b, c, x7, 10, 0x432aff97);
    c = OP(I, c, d, a, b, x14, 15, 0xab9423a7);
    b = OP(I, b, c, d, a, x5, 21, 0xfc93a039);
    a = OP(I, a, b, c, d, x12,  6, 0x655b59c3);
    d = OP(I, d, a, b, c, x3, 10, 0x8f0ccc92);
    c = OP(I, c, d, a, b, x10, 15, 0xffeff47d);
    b = OP(I, b, c, d, a, x1, 21, 0x85845dd1);
    a = OP(I, a, b, c, d, x8,  6, 0x6fa87e4f);
    d = OP(I, d, a, b, c, x15, 10, 0xfe2ce6e0);
    c = OP(I, c, d, a, b, x6, 15, 0xa3014314);
    b = OP(I, b, c, d, a, x13, 21, 0x4e0811a1);
    a = OP(I, a, b, c, d, x4,  6, 0xf7537e82);
    d = OP(I, d, a, b, c, x11, 10, 0xbd3af235);
    c = OP(I, c, d, a, b, x2, 15, 0x2ad7d2bb);
    b = OP(I, b, c, d, a, x9, 21, 0xeb86d391);

    a = add(a, A); b = add(b, B); c = add(c, C); d = add(d, D);
  }

  const out = new Uint8Array(16);
  new DataView(out.buffer).setUint32(0, a, true);
  new DataView(out.buffer).setUint32(4, b, true);
  new DataView(out.buffer).setUint32(8, c, true);
  new DataView(out.buffer).setUint32(12, d, true);
  return out;
}

export async function md5md5(input: string): Promise<string> {
  const enc = new TextEncoder();
  const a = await md5(enc.encode(input));
  const aHex = Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
  const b = await md5(enc.encode(aHex.slice(7, 27)));
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}