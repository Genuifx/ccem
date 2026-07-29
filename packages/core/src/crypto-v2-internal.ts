import crypto from 'crypto';

const V2_ALGORITHM = 'aes-256-gcm';

interface V2CiphertextParts {
  nonce: Buffer;
  ciphertextHex: string;
  tag: Buffer;
}

export function encryptV2WithKey(text: string, key: Buffer, nonce: Buffer): string {
  const cipher = crypto.createCipheriv(V2_ALGORITHM, key, nonce);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return `enc:v2:${nonce.toString('hex')}:${encrypted}:${tag.toString('hex')}`;
}

export function parseV2Ciphertext(text: string): V2CiphertextParts {
  const parts = text.split(':');
  if (parts.length !== 5) {
    throw new Error('Invalid enc:v2: ciphertext format');
  }

  const nonceHex = parts[2];
  const ciphertextHex = parts[3];
  const tagHex = parts[4];

  // Buffer.from(str, 'hex') silently truncates malformed input, so validate
  // the wire fields before handing them to Node crypto.
  if (!/^[0-9a-f]{24}$/i.test(nonceHex)) {
    throw new Error('Invalid enc:v2: nonce');
  }
  if (!/^[0-9a-f]{32}$/i.test(tagHex)) {
    throw new Error('Invalid enc:v2: auth tag');
  }
  if (
    ciphertextHex.length === 0
    || !/^[0-9a-f]+$/i.test(ciphertextHex)
    || ciphertextHex.length % 2 !== 0
  ) {
    throw new Error('Invalid enc:v2: ciphertext');
  }

  return {
    nonce: Buffer.from(nonceHex, 'hex'),
    ciphertextHex,
    tag: Buffer.from(tagHex, 'hex'),
  };
}

export function decryptParsedV2Ciphertext(
  { nonce, ciphertextHex, tag }: V2CiphertextParts,
  key: Buffer,
): string {
  const decipher = crypto.createDecipheriv(V2_ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function decryptV2WithKey(text: string, key: Buffer): string {
  return decryptParsedV2Ciphertext(parseV2Ciphertext(text), key);
}
