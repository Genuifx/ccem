import { describe, expect, it } from 'vitest';
import { buildEnvVars, buildPermArgs } from '../launcher.js';

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
  });
});
