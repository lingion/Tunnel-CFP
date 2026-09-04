import { describe, it, expect } from 'vitest';
import { sha224Hex } from '../../src/subscription/sha224';
import { createHash } from 'node:crypto';

describe('sha224Hex vectors', () => {
  const vectors: [string, string][] = [
    ['', 'd14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f'],
    ['a', 'abd37534c7d9a2efb9465de931cd7055ffdb8879563ae98078d6d6d5'],
    ['abc', '23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7'],
    ['b88ab8fa-392c-44b3-9343-612c11814708', '4996a1bc073eae363e7bf1d009abae0eef6e464691c679c7c03bb651'],
    ['0'.repeat(55), 'e2feb3ff28b75ce748f128eb8eda46a859b3c2c235ef5bf911c24c1d'],
    ['0'.repeat(56), '556bd9f7bc456d5a75aeb1e5e14cedcf6f2bd9b43f41b604ae7bd1ac'],
    ['0'.repeat(63), '73953388664fd5aa650de86bc6696901e2a36e51d0f7c2b3d6c1ca9a'],
    ['0'.repeat(64), 'fc5d6aed7146d6747dd6fca075f9fe5a30a4c0c9ff67effc484f10b5'],
    ['0'.repeat(119), 'b612df5d349adc58baad75ef0fc55394bd622902d5ec8b29fc75c315'],
  ];
  for (const [input, expected] of vectors) {
    it(`sha224(${JSON.stringify(input.slice(0, 16))}...)`, () => {
      expect(sha224Hex(input)).toBe(expected);
      expect(createHash('sha224').update(input).digest('hex')).toBe(expected); // 锚点自检
    });
  }
});
