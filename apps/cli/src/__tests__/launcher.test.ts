import { describe, expect, it } from 'vitest';
import {
  buildEnvVars,
  buildPermArgs,
  isTrustedDesktopProxyBaseUrl,
} from '../launcher.js';

describe('launcher', () => {
  describe('buildPermArgs', () => {
    it('passes allowed and disallowed tool rules as separate argv values', () => {
      const args = buildPermArgs('dev');
      const allowedIndex = args.indexOf('--allowedTools');
      const disallowedIndex = args.indexOf('--disallowedTools');

      expect(args.slice(0, 2)).toEqual(['--permission-mode', 'acceptEdits']);
      expect(allowedIndex).toBeGreaterThan(-1);
      expect(disallowedIndex).toBeGreaterThan(allowedIndex);
      expect(args[allowedIndex + 1]).toBe('Read');
      expect(args[allowedIndex + 1]).not.toContain('"');
      expect(args[allowedIndex + 1]).not.toContain(' ');
      expect(args).toContain('Bash(npm:*)');
      expect(args).not.toContain('Read(*)');
      expect(args).toContain('Bash(sudo:*)');
    });
  });

  describe('buildEnvVars', () => {
    it('omits untouched legacy official tier pins while keeping the opus alias', () => {
      expect(
        buildEnvVars('official', {
          ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1-20250805',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-4-1-20250805',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-5-haiku-20241022',
          ANTHROPIC_MODEL: 'opus',
        })
      ).toEqual({
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-5-haiku-20241022',
        ANTHROPIC_MODEL: 'opus',
      });
    });

    it('refuses direct OAuth for a third-party environment', () => {
      expect(() => buildEnvVars('partner', {
        ANTHROPIC_BASE_URL: 'https://partner.example.com/anthropic',
      })).toThrow(/auth token|oauth/i);
    });

    it('refuses an official environment redirected to a third party even with a token', () => {
      expect(() => buildEnvVars('official', {
        ANTHROPIC_BASE_URL: 'https://partner.example.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'plain-test-token',
      })).toThrow(/trusted.*official|official.*trusted/i);
    });

    it('allows only the Desktop-owned loopback proxy shape to override OAuth routing', () => {
      const localProxy = 'http://127.0.0.1:17820/proxy/claude/session-key';
      expect(isTrustedDesktopProxyBaseUrl(localProxy)).toBe(true);
      expect(buildEnvVars('official', {
        ANTHROPIC_BASE_URL: localProxy,
      }, { allowDesktopProxyOverride: true })).toMatchObject({
        ANTHROPIC_BASE_URL: localProxy,
      });

      for (const unsafe of [
        'https://partner.example.com/proxy/claude/session-key',
        'http://localhost:17820/proxy/claude/session-key',
        'http://127.0.0.1:17820/not-router/session-key',
        'http://user@127.0.0.1:17820/proxy/claude/session-key',
      ]) {
        expect(isTrustedDesktopProxyBaseUrl(unsafe)).toBe(false);
        expect(() => buildEnvVars('official', {
          ANTHROPIC_BASE_URL: unsafe,
        }, { allowDesktopProxyOverride: true })).toThrow(/trusted.*official|official.*trusted/i);
      }
    });
  });
});
