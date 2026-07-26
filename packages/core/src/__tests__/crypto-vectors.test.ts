import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decryptV2WithKey,
  encryptV2WithKey,
} from '../crypto-v2-internal.js';

interface GoldenVectors {
  keyHex: string;
  plaintext: string;
  typescript: {
    nonceHex: string;
    ciphertext: string;
  };
  rust: {
    nonceHex: string;
    ciphertext: string;
  };
}

const vectors = JSON.parse(
  readFileSync(
    new URL('../../test-fixtures/enc-v2-golden-vectors.json', import.meta.url),
    'utf8',
  ),
) as GoldenVectors;
const testKey = Buffer.from(vectors.keyHex, 'hex');

describe('enc:v2 cross-language golden vectors', () => {
  it('decrypts the Rust fixture without reading an install key', () => {
    expect(decryptV2WithKey(vectors.rust.ciphertext, testKey)).toBe(vectors.plaintext);
  });

  it('keeps the TypeScript fixture stable and readable by either implementation', () => {
    const encrypted = encryptV2WithKey(
      vectors.plaintext,
      testKey,
      Buffer.from(vectors.typescript.nonceHex, 'hex'),
    );

    expect(encrypted).toBe(vectors.typescript.ciphertext);
    expect(decryptV2WithKey(encrypted, testKey)).toBe(vectors.plaintext);
  });
});
