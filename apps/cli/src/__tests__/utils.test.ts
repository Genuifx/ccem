import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encrypt, decrypt } from '@ccem/core';
import {
  findProjectRoot,
  getSettingsPath,
  ensureClaudeDir,
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
      expect(decrypt('enc:invalid')).toBe('enc:invalid');
      expect(decrypt('enc:xx:yy:zz')).toBe('enc:xx:yy:zz');
    });

    it('should fail closed on malformed v2 ciphertext (wrong field count)', () => {
      expect(() => decrypt('enc:v2:abc')).toThrow(/Invalid enc:v2:/);
      expect(() => decrypt('enc:v2:a:b:c:d')).toThrow(/Invalid enc:v2:/);
    });

    it('should fail closed on malformed v2 (empty nonce)', () => {
      expect(() => decrypt('enc:v2::aabb:00112233445566778899aabbccddeeff')).toThrow(/Invalid enc:v2: nonce/);
    });

    it('should fail closed on malformed v2 (wrong tag length)', () => {
      const encrypted = encrypt('cli-test-value');
      const parts = encrypted.split(':');
      const badTag = '0011223344556677';
      const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}:${badTag}`;
      expect(() => decrypt(tampered)).toThrow(/Invalid enc:v2: auth tag/);
    });

    it('should fail closed on malformed v2 (non-hex nonce)', () => {
      expect(() => decrypt('enc:v2:zzzzzzzzzzzzzzzzzzzzzzzz:aabb:00112233445566778899aabbccddeeff')).toThrow(/Invalid enc:v2: nonce/);
    });

    it('should not return malformed v2 ciphertext as plaintext', () => {
      // Critical: CLI injects decrypt() output into env. A malformed v2 value
      // must never be returned as-is — it would be used as a real token.
      const malformed = 'enc:v2:truncated';
      expect(() => decrypt(malformed)).toThrow();
      // Verify it does NOT return the original string
      try {
        decrypt(malformed);
        expect.unreachable('should have thrown');
      } catch {
        // expected
      }
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
    it('should return CCEM isolated Claude config path', () => {
      const home = path.join(tempDir, 'home');
      process.env.HOME = home;
      expect(getGlobalClaudeConfigPath()).toBe(path.join(home, '.ccem', 'agents', 'claude', '.claude.json'));
    });
  });

  describe('getGlobalClaudeSettingsPath', () => {
    it('should return CCEM isolated Claude settings path', () => {
      const home = path.join(tempDir, 'home');
      process.env.HOME = home;
      expect(getGlobalClaudeSettingsPath()).toBe(path.join(home, '.ccem', 'agents', 'claude', 'settings.json'));
    });
  });
});
