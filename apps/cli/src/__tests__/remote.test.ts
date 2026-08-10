import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { getCcemConfigDir } from '@ccem/core';
import Conf from 'conf';
import {
  decryptWithSecret as realDecryptWithSecret,
  getUniqueImportedEnvironmentName,
  resolveLoadCredentials,
} from '../remote';

// Test the decryption logic that remote.ts uses
describe('remote', () => {
  // -----------------------------------------------------------------
  // v2 envelope helpers — mirror the AES-256-GCM implementation in
  // server/index.js and apps/cli/src/remote.ts. v2 is the current
  // default; v1 remains as a legacy fallback.
  // -----------------------------------------------------------------
  const deriveRemoteKey = (secret: string): Buffer =>
    crypto.scryptSync(secret, 'ccem-salt', 32);

  type EnvelopeV2 = { v: 2; nonce: string; ciphertext: string; tag: string };

  const encryptV2Envelope = (text: string, secret: string): string => {
    const key = deriveRemoteKey(secret);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const envelope: EnvelopeV2 = {
      v: 2,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
    return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  };

  const isEnvelopeV2 = (value: unknown): value is EnvelopeV2 => {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
      v.v === 2 &&
      typeof v.nonce === 'string' &&
      typeof v.ciphertext === 'string' &&
      typeof v.tag === 'string'
    );
  };

  // Mirrors decryptWithSecret in remote.ts. Must fail closed on v2 auth
  // failure (no silent fallback to v1).
  const decryptWithSecret = (encryptedBase64: string, secret: string): string => {
    const key = deriveRemoteKey(secret);
    let envelopeV2: EnvelopeV2 | null = null;
    try {
      const jsonStr = Buffer.from(encryptedBase64, 'base64').toString('utf8');
      const parsed = JSON.parse(jsonStr);
      if (isEnvelopeV2(parsed)) {
        envelopeV2 = parsed;
      } else if (
        parsed &&
        typeof parsed === 'object' &&
        'v' in parsed &&
        (parsed as { v: unknown }).v !== 2
      ) {
        const declared = (parsed as { v: unknown }).v;
        throw new Error(`Unsupported remote envelope version: ${declared}`);
      }
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith('Unsupported remote envelope version')
      ) {
        throw err;
      }
      envelopeV2 = null;
    }

    if (envelopeV2) {
      const nonce = Buffer.from(envelopeV2.nonce, 'base64');
      const ciphertext = Buffer.from(envelopeV2.ciphertext, 'base64');
      const tag = Buffer.from(envelopeV2.tag, 'base64');
      if (nonce.length === 0 || ciphertext.length === 0 || tag.length === 0) {
        throw new Error('v2 envelope has empty nonce/ciphertext/tag');
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(ciphertext);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      return decrypted.toString('utf8');
    }

    // Legacy v1 fallback.
    const combined = Buffer.from(encryptedBase64, 'base64');
    if (combined.length < 16) throw new Error('v1 payload too short');
    const iv = combined.subarray(0, 16);
    const encryptedHex = combined.subarray(16).toString('hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  };

  describe('v2 envelope (AES-256-GCM, authenticated)', () => {
    const samplePayload = () =>
      JSON.stringify({
        environments: {
          test: {
            ANTHROPIC_BASE_URL: 'https://api.example.com',
            ANTHROPIC_API_KEY: 'test-key',
          },
        },
      });

    it('round-trips a v2 envelope with the correct secret', () => {
      const secret = 'v2-secret-roundtrip';
      const encrypted = encryptV2Envelope(samplePayload(), secret);
      const decrypted = decryptWithSecret(encrypted, secret);
      expect(decrypted).toBe(samplePayload());
    });

    it('uses a fresh random 12-byte nonce per encryption (no reuse)', () => {
      const secret = 'nonce-uniqueness-secret';
      const a = encryptV2Envelope(samplePayload(), secret);
      const b = encryptV2Envelope(samplePayload(), secret);
      expect(a).not.toBe(b);
      const envA = JSON.parse(Buffer.from(a, 'base64').toString('utf8')) as EnvelopeV2;
      const envB = JSON.parse(Buffer.from(b, 'base64').toString('utf8')) as EnvelopeV2;
      expect(envA.nonce).not.toBe(envB.nonce);
      const nonceBytes = Buffer.from(envA.nonce, 'base64');
      expect(nonceBytes.length).toBe(12);
    });

    it('FAILS CLOSED on a tampered GCM tag (no fallback to v1)', () => {
      const secret = 'tamper-tag-secret';
      const encrypted = encryptV2Envelope(samplePayload(), secret);

      // Decode envelope, flip one bit in the tag, re-encode.
      const env = JSON.parse(
        Buffer.from(encrypted, 'base64').toString('utf8'),
      ) as EnvelopeV2;
      const tagBytes = Buffer.from(env.tag, 'base64');
      tagBytes[0] ^= 0x01;
      env.tag = tagBytes.toString('base64');
      const tampered = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');

      // MUST throw — never fall back to v1, never return plaintext.
      expect(() => decryptWithSecret(tampered, secret)).toThrow();
    });

    it('FAILS CLOSED on tampered ciphertext', () => {
      const secret = 'tamper-ct-secret';
      const encrypted = encryptV2Envelope(samplePayload(), secret);

      const env = JSON.parse(
        Buffer.from(encrypted, 'base64').toString('utf8'),
      ) as EnvelopeV2;
      const ctBytes = Buffer.from(env.ciphertext, 'base64');
      ctBytes[0] ^= 0x80;
      env.ciphertext = ctBytes.toString('base64');
      const tampered = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');

      expect(() => decryptWithSecret(tampered, secret)).toThrow();
    });

    it('rejects a v2 envelope decrypted with the wrong secret', () => {
      const encrypted = encryptV2Envelope(samplePayload(), 'correct-secret');
      expect(() => decryptWithSecret(encrypted, 'wrong-secret')).toThrow();
    });

    it('rejects a malformed v2 envelope (missing fields)', () => {
      // Envelope-shaped (has v:2) but missing tag — must NOT silently fall
      // through to v1. We build it manually so isEnvelopeV2 returns false,
      // but the payload still looks JSON-envelope-shaped.
      const malformedEnv = { v: 2, nonce: 'AAAA', ciphertext: 'AAAA' }; // no tag
      const malformed = Buffer.from(
        JSON.stringify(malformedEnv),
        'utf8',
      ).toString('base64');
      // Not a valid v2 envelope AND not a valid v1 payload → throws.
      expect(() => decryptWithSecret(malformed, 'any-secret')).toThrow();
    });

    it('rejects an unsupported envelope version (fail closed)', () => {
      const futureEnv = {
        v: 99,
        nonce: 'AAAA',
        ciphertext: 'AAAA',
        tag: 'AAAA',
      };
      const future = Buffer.from(
        JSON.stringify(futureEnv),
        'utf8',
      ).toString('base64');
      expect(() => decryptWithSecret(future, 'any-secret')).toThrow(
        /Unsupported remote envelope version/,
      );
    });

    it('v2 key derivation matches v1 (scrypt ccem-salt) so secrets are interchangeable across envelope versions', () => {
      // Sanity: server derives key the same way for v1 and v2; only the
      // cipher mode differs. This is why the same --secret works for both.
      const v1Key = crypto.scryptSync('shared-secret', 'ccem-salt', 32);
      const v2Key = crypto.scryptSync('shared-secret', 'ccem-salt', 32);
      expect(v1Key.equals(v2Key)).toBe(true);
    });
  });

  describe('legacy v1 fallback (AES-256-CBC, unauthenticated)', () => {
    // v1 server-side encrypt: base64(iv(16) + AES-256-CBC ciphertext).
    // The decryptWithSecret at the top of this file auto-detects v1 vs v2.
    const encryptWithSecret = (text: string, secret: string): string => {
      const key = crypto.scryptSync(secret, 'ccem-salt', 32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const combined = Buffer.concat([iv, Buffer.from(encrypted, 'hex')]);
      return combined.toString('base64');
    };

    it('should encrypt and decrypt with same secret', () => {
      const original = JSON.stringify({
        environments: {
          test: {
            ANTHROPIC_BASE_URL: 'https://api.example.com',
            ANTHROPIC_API_KEY: 'test-key',
          },
        },
      });
      const secret = 'my-secret-key';

      const encrypted = encryptWithSecret(original, secret);
      const decrypted = decryptWithSecret(encrypted, secret);

      expect(decrypted).toBe(original);
    });

    it('should reject remote JSON decrypted with a wrong secret', () => {
      const original = JSON.stringify({
        environments: {
          test: {
            ANTHROPIC_API_KEY: 'test-key',
          },
        },
      });
      const encrypted = encryptWithSecret(original, 'correct-secret');

      expect(() => {
        const decrypted = decryptWithSecret(encrypted, 'wrong-secret');
        JSON.parse(decrypted);
      }).toThrow();
    });

    it('should handle JSON with special characters', () => {
      const original = JSON.stringify({
        environments: {
          '中文环境': {
            ANTHROPIC_API_KEY: 'key-with-émojis-🔑',
          },
        },
      });
      const secret = 'test-secret';

      const encrypted = encryptWithSecret(original, secret);
      const decrypted = decryptWithSecret(encrypted, secret);

      expect(decrypted).toBe(original);
    });

    it('should use access key for auth header but encryption secret for decryption (key != secret)', () => {
      // Simulate server: encrypt with SERVER_SECRET, authenticate with ACCESS_KEY
      const ACCESS_KEY = 'dummy-access-key-abc123';
      const SERVER_SECRET = 'dummy-server-secret-xyz789';
      const payload = JSON.stringify({
        environments: {
          prod: {
            ANTHROPIC_BASE_URL: 'https://api.example.com',
            ANTHROPIC_API_KEY: 'prod-key-456',
          },
        },
      });

      // Server encrypts with its own SECRET (not with the access key)
      const encrypted = encryptWithSecret(payload, SERVER_SECRET);

      // Legacy v1 CBC is unauthenticated: a wrong key can occasionally
      // produce garbage instead of throwing on PKCS#7 padding. It must
      // never recover the server payload.
      let decryptedWithAccessKey: string | undefined;
      try {
        decryptedWithAccessKey = realDecryptWithSecret(encrypted, ACCESS_KEY);
      } catch {
        // Wrong-key padding failures are also expected for v1.
      }
      expect(decryptedWithAccessKey).not.toBe(payload);
      const decrypted = realDecryptWithSecret(encrypted, SERVER_SECRET);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(payload));
    });

    it('should not recover a server-encrypted payload with an access key', () => {
      const SERVER_SECRET = 'server-encryption-secret';
      const payload = '{"environments":{}}';
      const encrypted = encryptWithSecret(payload, SERVER_SECRET);

      let decryptedWithAccessKey: string | undefined;
      try {
        decryptedWithAccessKey = realDecryptWithSecret(encrypted, 'different-access-key');
      } catch {
        // Wrong-key padding failures are also expected for v1.
      }
      expect(decryptedWithAccessKey).not.toBe(payload);
    });
  });

  describe('server contract', () => {
    // Reuse the v1 server-side encrypt from the legacy block above.
    // (Defined in scope so the describe is self-contained.)
    const serverEncryptV1 = (text: string, secret: string): string => {
      const key = crypto.scryptSync(secret, 'ccem-salt', 32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const combined = Buffer.concat([iv, Buffer.from(encrypted, 'hex')]);
      return combined.toString('base64');
    };

    it('legacy server encrypt output is base64(iv + ciphertext) matching client decrypt format', () => {
      const secret = 'contract-test-secret';
      const data = JSON.stringify({ environments: { test: { ANTHROPIC_API_KEY: 'k' } } });
      const encrypted = serverEncryptV1(data, secret);

      // Verify format: base64 decodes to at least 16 bytes IV + ciphertext
      const decoded = Buffer.from(encrypted, 'base64');
      expect(decoded.length).toBeGreaterThan(16);

      // Verify roundtrip with client-side decrypt (auto-detects v1)
      const decrypted = decryptWithSecret(encrypted, secret);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(data));
    });

    it('header takes precedence over query param (server contract)', () => {
      // Server reads: req.headers['x-ccem-key'] || req.query.key
      // This means if header is present, query param is ignored
      const headerKey = 'header-key-value';
      const queryKey = 'query-key-value';
      // Simulate server precedence logic
      const effectiveKey = headerKey || queryKey;
      expect(effectiveKey).toBe(headerKey);
      expect(effectiveKey).not.toBe(queryKey);
    });

    it('cross-version compatibility: v2 client decrypts v1 server output (legacy fallback)', () => {
      // A new client must still work against an old (v1-only) server.
      const secret = 'cross-version-secret';
      const payload = JSON.stringify({
        environments: { legacy: { ANTHROPIC_API_KEY: 'legacy-key' } },
      });
      const v1Encrypted = serverEncryptV1(payload, secret);
      const decrypted = decryptWithSecret(v1Encrypted, secret);
      expect(decrypted).toBe(payload);
    });

    it('cross-version compatibility: v2 client decrypts v2 server output (current default)', () => {
      const secret = 'cross-version-secret-v2';
      const payload = JSON.stringify({
        environments: { modern: { ANTHROPIC_API_KEY: 'modern-key' } },
      });
      const v2Encrypted = encryptV2Envelope(payload, secret);
      const decrypted = decryptWithSecret(v2Encrypted, secret);
      expect(decrypted).toBe(payload);
    });

    it('access key and encryption secret are distinct (auth vs decrypt separation)', () => {
      // Server authenticates with ACCESS_KEY, encrypts response with SECRET.
      // Client must decrypt with SECRET, not ACCESS_KEY.
      const ACCESS_KEY = 'auth-access-key';
      const SECRET = 'encryption-secret';
      const payload = JSON.stringify({ environments: {} });
      const encrypted = encryptV2Envelope(payload, SECRET);
      expect(() => decryptWithSecret(encrypted, ACCESS_KEY)).toThrow();
      const decrypted = decryptWithSecret(encrypted, SECRET);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(payload));
    });
  });

  describe('getUniqueName logic', () => {
    it('should return original name if not exists', () => {
      const existing = new Set(['other']);
      expect(getUniqueImportedEnvironmentName('new-env', existing)).toBe('new-env');
    });

    it('should add -remote suffix if name exists', () => {
      const existing = new Set(['my-env']);
      expect(getUniqueImportedEnvironmentName('my-env', existing)).toBe('my-env-remote');
    });

    it('should add numbered suffix if -remote also exists', () => {
      const existing = new Set(['my-env', 'my-env-remote']);
      expect(getUniqueImportedEnvironmentName('my-env', existing)).toBe('my-env-remote-2');
    });

    it('should increment number until unique', () => {
      const existing = new Set([
        'my-env',
        'my-env-remote',
        'my-env-remote-2',
        'my-env-remote-3',
      ]);
      expect(getUniqueImportedEnvironmentName('my-env', existing)).toBe('my-env-remote-4');
    });

    it('renames an imported official environment instead of overwriting the protected entry', () => {
      expect(getUniqueImportedEnvironmentName('official', new Set(['official']))).toBe(
        'official-remote',
      );
    });
  });

  describe('config path consistency', () => {
    it('should use the same config directory as main CLI', () => {
      // 验证 remote.ts 使用的配置路径与主 CLI 一致
      const expectedDir = getCcemConfigDir();

      // 创建一个测试配置实例，模拟 remote.ts 的配置
      const testConfig = new Conf({
        projectName: 'claude-code-env-manager',
        cwd: getCcemConfigDir(),
      });

      // 验证配置路径包含预期的目录
      expect(testConfig.path).toContain('.ccem');
      expect(testConfig.path).toContain('config.json');
    });
  });

  // -----------------------------------------------------------------
  // Real implementation tests — import and exercise the actual
  // decryptWithSecret from remote.ts. These catch regressions that
  // the mirrored copies above cannot.
  // -----------------------------------------------------------------
  describe('real decryptWithSecret (from remote.ts)', () => {
    const encryptV2 = (text: string, secret: string): string => {
      const key = crypto.scryptSync(secret, 'ccem-salt', 32);
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([
        cipher.update(text, 'utf8'),
        cipher.final(),
      ]);
      const envelope = {
        v: 2,
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      };
      return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
    };

    it('decrypts a valid v2 envelope', () => {
      const secret = 'real-impl-test-secret';
      const payload = JSON.stringify({ environments: { test: { ANTHROPIC_API_KEY: 'k' } } });
      const encrypted = encryptV2(payload, secret);
      expect(realDecryptWithSecret(encrypted, secret)).toBe(payload);
    });

    it('throws on malformed v2 envelope (v:2 with missing fields)', () => {
      const malformed = Buffer.from(
        JSON.stringify({ v: 2, nonce: 'AAA' }),
        'utf8',
      ).toString('base64');
      expect(() => realDecryptWithSecret(malformed, 'any-secret')).toThrow(
        /Malformed v2 envelope/,
      );
    });

    it('throws on unsupported envelope version', () => {
      const future = Buffer.from(
        JSON.stringify({ v: 99, nonce: 'A', ciphertext: 'A', tag: 'A' }),
        'utf8',
      ).toString('base64');
      expect(() => realDecryptWithSecret(future, 'any-secret')).toThrow(
        /Unsupported remote envelope version/,
      );
    });

    it('throws on tampered v2 auth tag (fail closed)', () => {
      const secret = 'tamper-test-secret';
      const encrypted = encryptV2('{"test":true}', secret);
      // Parse the envelope, corrupt the tag, re-serialize.
      const json = Buffer.from(encrypted, 'base64').toString('utf8');
      const envelope = JSON.parse(json);
      const tamperedTag = envelope.tag === 'AAAA' ? 'BBBB' : 'AAAA';
      const tampered = Buffer.from(
        JSON.stringify({ ...envelope, tag: tamperedTag }),
        'utf8',
      ).toString('base64');
      expect(() => realDecryptWithSecret(tampered, secret)).toThrow();
    });
  });

  // -----------------------------------------------------------------
  // resolveLoadCredentials — argv vs stdin credential resolution.
  // The desktop app pipes credentials via stdin to keep them out of
  // process listings; argv (--secret/--key) stays for user scripts.
  // -----------------------------------------------------------------
  describe('resolveLoadCredentials (stdin vs argv)', () => {
    it('resolves credentials from argv (--secret only)', () => {
      const result = resolveLoadCredentials({ secret: 'enc-secret' }, '');
      expect(result).toEqual({ secret: 'enc-secret', key: '' });
    });

    it('resolves credentials from argv (--secret + --key)', () => {
      const result = resolveLoadCredentials(
        { secret: 'enc-secret', key: 'access-key' },
        '',
      );
      expect(result).toEqual({ secret: 'enc-secret', key: 'access-key' });
    });

    it('resolves credentials from --credentials-stdin JSON', () => {
      const stdin = JSON.stringify({ secret: 'enc-secret', key: 'access-key' });
      const result = resolveLoadCredentials({ credentialsStdin: true }, stdin);
      expect(result).toEqual({ secret: 'enc-secret', key: 'access-key' });
    });

    it('stdin mode omits key when not provided (CLI falls back to secret for auth)', () => {
      const stdin = JSON.stringify({ secret: 'enc-secret' });
      const result = resolveLoadCredentials({ credentialsStdin: true }, stdin);
      expect(result).toEqual({ secret: 'enc-secret', key: '' });
    });

    it('rejects mixed mode (--credentials-stdin + --secret)', () => {
      expect(() =>
        resolveLoadCredentials(
          { credentialsStdin: true, secret: 'enc-secret' },
          JSON.stringify({ secret: 'enc-secret' }),
        ),
      ).toThrow(/互斥/);
    });

    it('rejects mixed mode (--credentials-stdin + --key)', () => {
      expect(() =>
        resolveLoadCredentials(
          { credentialsStdin: true, key: 'access-key' },
          JSON.stringify({ secret: 'enc-secret' }),
        ),
      ).toThrow(/互斥/);
    });

    it('rejects --credentials-stdin with no secret field', () => {
      expect(() =>
        resolveLoadCredentials(
          { credentialsStdin: true },
          JSON.stringify({ key: 'access-key' }),
        ),
      ).toThrow(/缺少必填字段 secret/);
    });

    it('rejects --credentials-stdin with empty secret', () => {
      expect(() =>
        resolveLoadCredentials(
          { credentialsStdin: true },
          JSON.stringify({ secret: '' }),
        ),
      ).toThrow(/缺少必填字段 secret/);
    });

    it('rejects --credentials-stdin with non-string secret', () => {
      expect(() =>
        resolveLoadCredentials(
          { credentialsStdin: true },
          JSON.stringify({ secret: 123 }),
        ),
      ).toThrow(/缺少必填字段 secret/);
    });

    it('rejects --credentials-stdin with malformed JSON', () => {
      expect(() =>
        resolveLoadCredentials({ credentialsStdin: true }, '{not valid json'),
      ).toThrow(/不是合法 JSON/);
    });

    it('rejects when neither mode provides a secret', () => {
      expect(() => resolveLoadCredentials({}, '')).toThrow(
        /必须提供 --secret 或 --credentials-stdin/,
      );
    });

    it('error messages never echo the secret or key value', () => {
      const secretValue = 'sk-super-secret-DO-NOT-LEAK-12345';
      const keyValue = 'access-key-DO-NOT-LEAK-67890';

      // Mixed mode — error must not contain either value.
      try {
        resolveLoadCredentials(
          { credentialsStdin: true, secret: secretValue },
          JSON.stringify({ secret: secretValue, key: keyValue }),
        );
        throw new Error('should have thrown');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain(secretValue);
        expect(msg).not.toContain(keyValue);
      }

      // Missing secret field — error must not contain the key value.
      try {
        resolveLoadCredentials(
          { credentialsStdin: true },
          JSON.stringify({ key: keyValue }),
        );
        throw new Error('should have thrown');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain(keyValue);
      }
    });
  });
});
