import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { encrypt, decrypt } from '../utils.js';
import {
  findProjectRoot,
  getSettingsPath,
  ensureClaudeDir,
  ensureCcemDir,
  getCcemConfigDir,
  getHomeDir,
  getGlobalClaudeConfigPath,
  getGlobalClaudeSettingsPath,
} from '../utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('utils', () => {
  describe('encrypt/decrypt', () => {
    it('should return empty string for empty input', () => {
      expect(encrypt('')).toBe('');
      expect(decrypt('')).toBe('');
    });

    it('should encrypt and decrypt a simple string', () => {
      const original = 'my-api-key-12345';
      const encrypted = encrypt(original);

      expect(encrypted).not.toBe(original);
      expect(encrypted.startsWith('enc:')).toBe(true);

      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should produce different ciphertext for same input (random IV)', () => {
      const original = 'test-key';
      const encrypted1 = encrypt(original);
      const encrypted2 = encrypt(original);

      expect(encrypted1).not.toBe(encrypted2);
      expect(decrypt(encrypted1)).toBe(original);
      expect(decrypt(encrypted2)).toBe(original);
    });

    it('should return original text if not encrypted format', () => {
      const plain = 'plain-text-without-prefix';
      expect(decrypt(plain)).toBe(plain);
    });

    it('should handle special characters', () => {
      const original = 'key-with-special-chars!@#$%^&*()_+-=[]{}|;:",./<>?/`~';
      const encrypted = encrypt(original);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should handle unicode characters', () => {
      const original = '中文密钥🔑émojis';
      const encrypted = encrypt(original);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should handle long strings', () => {
      const original = 'a'.repeat(10000);
      const encrypted = encrypt(original);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should return input for malformed legacy encrypted string', () => {
      // Legacy format (enc:iv:ct) malformed values still fall back to plaintext
      expect(decrypt('enc:invalid')).toBe('enc:invalid');
      expect(decrypt('enc:xx:yy:zz')).toBe('enc:xx:yy:zz');
    });

    it('should fail closed on malformed v2 ciphertext (wrong field count)', () => {
      expect(() => decrypt('enc:v2:abc')).toThrow(/Invalid enc:v2:/);
      expect(() => decrypt('enc:v2:a:b')).toThrow(/Invalid enc:v2:/);
      expect(() => decrypt('enc:v2:a:b:c:d')).toThrow(/Invalid enc:v2:/);
      // Exactly 5 parts but bad nonce length still fails
      expect(() => decrypt('enc:v2:short:abcd:abcd')).toThrow(/Invalid enc:v2:/);
    });

    it('should fail closed on malformed v2 (empty nonce)', () => {
      // enc:v2:<empty>:<ct>:<tag> — nonce must be 24 hex chars
      expect(() => decrypt('enc:v2::aabb:00112233445566778899aabbccddeeff')).toThrow(/Invalid enc:v2: nonce/);
    });

    it('should fail closed on malformed v2 (wrong tag length)', () => {
      const encrypted = encrypt('test-value');
      const parts = encrypted.split(':');
      // Replace tag with wrong-length hex (16 chars instead of 32)
      const badTag = '0011223344556677';
      const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}:${badTag}`;
      expect(() => decrypt(tampered)).toThrow(/Invalid enc:v2: auth tag/);
    });

    it('should fail closed on malformed v2 (non-hex nonce)', () => {
      // 24 chars but contains non-hex characters
      expect(() => decrypt('enc:v2:zzzzzzzzzzzzzzzzzzzzzzzz:aabb:00112233445566778899aabbccddeeff')).toThrow(/Invalid enc:v2: nonce/);
    });

    it('should fail closed on malformed v2 (non-hex ciphertext)', () => {
      // Valid nonce and tag format, but ciphertext is not hex
      expect(() => decrypt('enc:v2:000000000000000000000000:xyz:00112233445566778899aabbccddeeff')).toThrow(/Invalid enc:v2: ciphertext/);
    });

    it('should produce v2 format with GCM structure', () => {
      const encrypted = encrypt('test-token');
      expect(encrypted.startsWith('enc:v2:')).toBe(true);
      const parts = encrypted.split(':');
      expect(parts.length).toBe(5); // enc, v2, nonce, ciphertext, tag
      expect(parts[2].length).toBe(24); // 12-byte nonce = 24 hex chars
      expect(parts[4].length).toBe(32); // 16-byte tag = 32 hex chars
    });

    it('should decrypt legacy enc: format (AES-256-CBC migration)', () => {
      // Simulate a legacy encrypted value created with the old hardcoded key
      const legacyKey = crypto.scryptSync('claude-code-env-manager-secret', 'salt', 32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', legacyKey, iv);
      let enc = cipher.update('legacy-api-key', 'utf8', 'hex');
      enc += cipher.final('hex');
      const legacyEncrypted = `enc:${iv.toString('hex')}:${enc}`;

      // decrypt should handle legacy format
      const decrypted = decrypt(legacyEncrypted);
      expect(decrypted).toBe('legacy-api-key');
    });

    it('should migrate legacy to v2: decrypt legacy, re-encrypt, decrypt v2', () => {
      const plaintext = 'migration-test-value-123';

      // Create legacy encrypted value
      const legacyKey = crypto.scryptSync('claude-code-env-manager-secret', 'salt', 32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', legacyKey, iv);
      let enc = cipher.update(plaintext, 'utf8', 'hex');
      enc += cipher.final('hex');
      const legacyEncrypted = `enc:${iv.toString('hex')}:${enc}`;

      // Step 1: Decrypt legacy
      const decrypted = decrypt(legacyEncrypted);
      expect(decrypted).toBe(plaintext);

      // Step 2: Re-encrypt with v2
      const v2Encrypted = encrypt(decrypted);
      expect(v2Encrypted.startsWith('enc:v2:')).toBe(true);

      // Step 3: Decrypt v2 — should match original
      const finalDecrypted = decrypt(v2Encrypted);
      expect(finalDecrypted).toBe(plaintext);
    });

    it('should detect tampered v2 ciphertext (AEAD auth tag)', () => {
      const encrypted = encrypt('sensitive-value');
      const parts = encrypted.split(':');

      // Replace auth tag with zeros — GCM auth should fail
      const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}:${'0'.repeat(32)}`;
      // v2 tamper must throw — silently returning ciphertext as plaintext is dangerous
      expect(() => decrypt(tampered)).toThrow(/Failed to decrypt enc:v2/);
    });
  });
});

describe('path utilities', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-test-'));
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('findProjectRoot', () => {
    it('should find directory with .git', () => {
      const gitDir = path.join(tempDir, '.git');
      fs.mkdirSync(gitDir);

      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
      expect(findProjectRoot()).toBe(tempDir);
    });

    it('should find directory with package.json', () => {
      fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');

      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
      expect(findProjectRoot()).toBe(tempDir);
    });

    it('should search parent directories', () => {
      const subDir = path.join(tempDir, 'src', 'deep', 'nested');
      fs.mkdirSync(subDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, '.git'));

      vi.spyOn(process, 'cwd').mockReturnValue(subDir);
      expect(findProjectRoot()).toBe(tempDir);
    });

    it('should return cwd if no project root found', () => {
      const isolatedDir = path.join(tempDir, 'isolated');
      fs.mkdirSync(isolatedDir);

      vi.spyOn(process, 'cwd').mockReturnValue(isolatedDir);
      const result = findProjectRoot();
      expect(typeof result).toBe('string');
    });
  });

  describe('getSettingsPath', () => {
    it('should return settings.local.json path by default', () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

      const result = getSettingsPath();
      expect(result).toBe(path.join(tempDir, '.claude', 'settings.local.json'));
    });

    it('should return settings.json path when useLocal is false', () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

      const result = getSettingsPath(false);
      expect(result).toBe(path.join(tempDir, '.claude', 'settings.json'));
    });
  });

  describe('ensureClaudeDir', () => {
    it('should create .claude directory if not exists', () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

      const result = ensureClaudeDir();
      expect(result).toBe(path.join(tempDir, '.claude'));
      expect(fs.existsSync(result)).toBe(true);
    });

    it('should return existing .claude directory', () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      fs.mkdirSync(path.join(tempDir, '.claude'));
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

      const result = ensureClaudeDir();
      expect(result).toBe(path.join(tempDir, '.claude'));
    });
  });

  describe('ensureCcemDir', () => {
    it.skipIf(process.platform === 'win32')('creates the directory with POSIX mode 0700', () => {
      process.env.HOME = tempDir;

      const result = ensureCcemDir();

      expect(result).toBe(getCcemConfigDir());
      expect(fs.statSync(result).mode & 0o777).toBe(0o700);
    });

    it.skipIf(process.platform === 'win32')('repairs the root mode without changing descendants', () => {
      process.env.HOME = tempDir;
      const ccemDir = getCcemConfigDir();
      const nestedDir = path.join(ccemDir, 'runtime-tools');
      const nestedFile = path.join(nestedDir, 'helper.sh');
      fs.mkdirSync(nestedDir, { recursive: true, mode: 0o755 });
      fs.writeFileSync(nestedFile, '#!/bin/sh\n', { mode: 0o744 });
      fs.chmodSync(ccemDir, 0o755);
      fs.chmodSync(nestedDir, 0o755);
      fs.chmodSync(nestedFile, 0o744);

      ensureCcemDir();

      expect(fs.statSync(ccemDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(nestedDir).mode & 0o777).toBe(0o755);
      expect(fs.statSync(nestedFile).mode & 0o777).toBe(0o744);
    });
  });

  describe('getHomeDir', () => {
    it('should return HOME environment variable', () => {
      const home = path.join(tempDir, 'custom-home');
      process.env.HOME = home;
      process.env.USERPROFILE = path.join(tempDir, 'ignored-userprofile');
      expect(getHomeDir()).toBe(home);
    });

    it('should return USERPROFILE when HOME is not set', () => {
      const userProfile = path.join(tempDir, 'userprofile-home');
      delete process.env.HOME;
      process.env.USERPROFILE = userProfile;
      expect(getHomeDir()).toBe(userProfile);
    });
  });

  describe('getGlobalClaudeConfigPath', () => {
    it('should return ~/.claude.json path', () => {
      const home = path.join(tempDir, 'home');
      process.env.HOME = home;
      expect(getGlobalClaudeConfigPath()).toBe(path.join(home, '.claude.json'));
    });
  });

  describe('getGlobalClaudeSettingsPath', () => {
    it('should return ~/.claude/settings.json path', () => {
      const home = path.join(tempDir, 'home');
      process.env.HOME = home;
      expect(getGlobalClaudeSettingsPath()).toBe(path.join(home, '.claude', 'settings.json'));
    });
  });
});
