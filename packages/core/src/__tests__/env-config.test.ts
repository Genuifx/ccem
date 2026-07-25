import { describe, expect, it } from 'vitest';
import {
  hasLegacyEnvFields,
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
