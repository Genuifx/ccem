import { describe, expect, it } from 'vitest';
import {
  assertClaudeEnvironmentAuthBoundary,
  assertOfficialEnvironmentInvariant,
  assertOfficialEnvironmentPresent,
  hasLegacyEnvFields,
  isTrustedOfficialBaseUrl,
  normalizeCcemConfig,
  normalizeEnvConfig,
  recoverEnvConfigFromLegacy,
  resolveEnvConfigForRuntime,
} from '../env-config.js';

describe('env config migration', () => {
  it('detects legacy auth and model fields', () => {
    expect(
      hasLegacyEnvFields({
        ANTHROPIC_API_KEY: 'legacy-key',
        ANTHROPIC_MODEL: 'glm-4.6',
      })
    ).toBe(true);
  });

  it('migrates legacy auth and model fields into tier defaults', () => {
    const normalized = normalizeEnvConfig({
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_API_KEY: 'legacy-key',
      ANTHROPIC_MODEL: 'glm-4.6',
      ANTHROPIC_SMALL_FAST_MODEL: 'glm-4.5-air',
    });

    expect(normalized).toEqual({
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'legacy-key',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
      ANTHROPIC_MODEL: 'opus',
    });
  });

  it('preserves tier-based configs and runtime model', () => {
    const normalized = normalizeEnvConfig({
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
      ANTHROPIC_MODEL: 'sonnet',
      CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
    });

    expect(normalized).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
      ANTHROPIC_MODEL: 'sonnet',
      CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
    });
  });

  it('preserves the workspace write-tool limit flag', () => {
    expect(
      normalizeEnvConfig({
        ANTHROPIC_BASE_URL: 'https://example.com/anthropic',
        CCEM_LIMIT_WRITE_TOOLS: true,
      })
    ).toMatchObject({
      CCEM_LIMIT_WRITE_TOOLS: true,
    });
  });

  it('recovers missing auth token and tier models from legacy config', () => {
    const recovered = recoverEnvConfigFromLegacy(
      {
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'opus',
        ANTHROPIC_MODEL: 'opus',
      },
      {
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_API_KEY: 'legacy-key',
        ANTHROPIC_MODEL: 'glm-5',
        ANTHROPIC_SMALL_FAST_MODEL: 'glm-4.5-air',
      }
    );

    expect(recovered).toEqual({
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'legacy-key',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
      ANTHROPIC_MODEL: 'opus',
    });
  });
});

describe('runtime environment resolution', () => {
  const legacyOfficialDefaults = {
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1-20250805',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-4-1-20250805',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-5-haiku-20241022',
    ANTHROPIC_MODEL: 'opus',
  };

  it('lets an untouched official environment follow current Claude tier aliases', () => {
    const resolved = resolveEnvConfigForRuntime('official', legacyOfficialDefaults);

    expect(resolved).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-5-haiku-20241022',
      ANTHROPIC_MODEL: 'opus',
    });
    expect(legacyOfficialDefaults).toHaveProperty(
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'claude-opus-4-1-20250805'
    );
  });

  it('preserves customized official model pins', () => {
    const customized = {
      ...legacyOfficialDefaults,
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-custom',
    };

    expect(resolveEnvConfigForRuntime('official', customized)).toEqual(customized);
  });

  it('preserves legacy-looking pins when official uses a custom endpoint', () => {
    const customized = {
      ...legacyOfficialDefaults,
      ANTHROPIC_BASE_URL: 'https://partner.example.com/anthropic',
    };

    expect(resolveEnvConfigForRuntime('official', customized)).toEqual(customized);
  });

  it('preserves legacy-looking pins when another official default was customized', () => {
    const customized = {
      ...legacyOfficialDefaults,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-custom',
    };

    expect(resolveEnvConfigForRuntime('official', customized)).toEqual(customized);
  });

  it('preserves the same model pins for third-party environments', () => {
    expect(resolveEnvConfigForRuntime('partner', legacyOfficialDefaults)).toEqual(
      legacyOfficialDefaults
    );
  });
});

describe('top-level config normalization', () => {
  it('preserves an optional camelCase router section through JSON round-trip', () => {
    const input = JSON.parse(JSON.stringify({
      registries: {
        primary: {
          ANTHROPIC_BASE_URL: 'https://example.com/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'token',
        },
      },
      current: 'primary',
      defaultMode: 'dev',
      router: {
        enabled: true,
        port: 17842,
        bindings: { 'subagent:Explore': 'search-env' },
        profiles: [],
        dynamicRouting: false,
        defaultAllowedEnvs: ['primary', 'search-env'],
      },
    }));

    expect(normalizeCcemConfig(input).router).toEqual(input.router);
  });

  it('keeps router absent for configurations that predate it', () => {
    const normalized = normalizeCcemConfig({
      registries: {},
      current: 'official',
    });

    expect(normalized).not.toHaveProperty('router');
  });
});

describe('protected environment invariant', () => {
  it('accepts an own official environment and rejects missing or inherited entries', () => {
    expect(() => assertOfficialEnvironmentPresent({ official: {} })).not.toThrow();
    expect(() => assertOfficialEnvironmentPresent({ glm: {} })).toThrow(/official/i);

    const inherited = Object.create({ official: {} }) as Record<string, unknown>;
    expect(() => assertOfficialEnvironmentPresent(inherited)).toThrow(/official/i);
  });

  it.each([
    'https://api.anthropic.com',
    'https://api.anthropic.com/',
  ])('accepts the trusted official root URL %s', (baseUrl) => {
    expect(isTrustedOfficialBaseUrl(baseUrl)).toBe(true);
    expect(() => assertOfficialEnvironmentInvariant({
      official: { ANTHROPIC_BASE_URL: baseUrl },
    })).not.toThrow();
  });

  it.each([
    undefined,
    '',
    ' http://api.anthropic.com',
    'http://api.anthropic.com',
    'https://api.anthropic.com:443',
    'https://user@api.anthropic.com',
    'https://api.anthropic.com/v1',
    'https://api.anthropic.com/?debug=1',
    'https://api.anthropic.com/#fragment',
    'https://API.ANTHROPIC.COM',
    'https://api.anthropic.com.evil.test',
  ])('rejects an untrusted official URL %s', (baseUrl) => {
    expect(isTrustedOfficialBaseUrl(baseUrl)).toBe(false);
    expect(() => assertOfficialEnvironmentInvariant({
      official: { ANTHROPIC_BASE_URL: baseUrl },
    })).toThrow(/trusted.*official|official.*trusted/i);
  });

  it('allows OAuth only for the protected official environment', () => {
    expect(() => assertClaudeEnvironmentAuthBoundary(
      'official',
      'https://api.anthropic.com/',
      undefined,
    )).not.toThrow();
    expect(() => assertClaudeEnvironmentAuthBoundary(
      'partner',
      'https://partner.example.com/anthropic',
      undefined,
    )).toThrow(/auth token|oauth/i);
    expect(() => assertClaudeEnvironmentAuthBoundary(
      'partner',
      'https://partner.example.com/anthropic',
      'partner-token',
    )).not.toThrow();
    expect(() => assertClaudeEnvironmentAuthBoundary(
      'official',
      'https://partner.example.com/anthropic',
      'explicit-token',
    )).toThrow(/trusted.*official|official.*trusted/i);
  });
});
