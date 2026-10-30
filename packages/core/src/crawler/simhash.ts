import { createHash } from 'node:crypto';

/**
 * 64-bit SimHash over word 3-grams (shingles). Near-duplicate texts produce hashes with a small
 * Hamming distance; distance ≤ 3 on 64 bits is a common near-duplicate threshold.
 */
export function simhash(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 20) return null; // too little text for a meaningful fingerprint
  const weights = new Array<number>(64).fill(0);
  for (let i = 0; i + 2 < words.length; i++) {
    const shingle = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
    const digest = createHash('md5').update(shingle).digest();
    for (let bit = 0; bit < 64; bit++) {
      const byte = digest[bit >> 3]!;
      weights[bit]! += (byte >> (bit & 7)) & 1 ? 1 : -1;
    }
  }
  let hex = '';
  for (let nibble = 0; nibble < 16; nibble++) {
    let value = 0;
    for (let b = 0; b < 4; b++) if (weights[nibble * 4 + b]! > 0) value |= 1 << b;
    hex += value.toString(16);
  }
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  let distance = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance + Math.abs(a.length - b.length) * 4;
}
