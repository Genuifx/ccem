import { describe, expect, it } from 'vitest';
import type { EnvConfig } from '@ccem/core';
import {
  collectDshModels,
  DshProjectionError,
  deriveDshProvider,
  generateProviderId,
  verifyTokenPresence,
} from '../dsh/provider.js';

const TEST_ENV: EnvConfig = {
  ANTHROPIC_BASE_URL: 'https://gw.example.internal/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'plain-test-token',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'model-a',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'model-a',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'model-b',
  ANTHROPIC_MODEL: 'opus',
};

function deriveError(envName: string | undefined, env: EnvConfig, options?: Parameters<typeof deriveDshProvider>[2]): DshProjectionError {
  try {
    deriveDshProvider(envName, env, options);
  } catch (error) {
    expect(error).toBeInstanceOf(DshProjectionError);
    return error as DshProjectionError;
  }
  throw new Error('expected deriveDshProvider to throw');
}

describe('dsh provider projection', () => {
  it('derives a secret-free spec with deduplicated tier models', () => {
    const spec = deriveDshProvider('partner', TEST_ENV);
    expect(spec.providerId).toBe(generateProviderId('partner'));
    expect(spec.displayName).toBe('CCEM partner');
    expect(spec.baseURL).toBe('https://gw.example.internal/anthropic');
    expect(spec.apiKeyEnv).toBe('CCEM_DSH_API_KEY');
    expect(spec.models).toEqual(['model-a', 'model-b']);
    expect(spec.selectedModel).toBe('model-a');
    expect(spec.credentialState).toBe('present');
    expect(JSON.stringify(spec)).not.toContain('plain-test-token');
  });

  it('generates deterministic per-environment provider IDs', () => {
    const id1 = generateProviderId('partner');
    const id2 = generateProviderId('partner');
    const id3 = generateProviderId('staging');
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id1).toMatch(/^ccem-partner-[0-9a-f]{12}$/);
    expect(id3).toMatch(/^ccem-staging-[0-9a-f]{12}$/);
    // Hostile env names get slug-normalized.
    const hostile = generateProviderId('a/b:c d!');
    expect(hostile).toMatch(/^ccem-[a-z0-9-]+-[0-9a-f]{12}$/);
    expect(hostile).not.toContain('/');
    expect(hostile).not.toContain(':');
  });

  it('different env names yield different provider IDs', () => {
    // Even if slug-normalized form is the same, hash distinguishes.
    const a = generateProviderId('alpha');
    const b = generateProviderId('Alpha');
    expect(a).not.toBe(b);
  });

  it('keeps tier priority order and folds in subagent/runtime pins after tiers', () => {
    const catalog = collectDshModels('partner', {
      ...TEST_ENV,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-x',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-y',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-z',
      CLAUDE_CODE_SUBAGENT_MODEL: 'sub-w',
      ANTHROPIC_MODEL: 'runtime-v',
    });
    expect(catalog.models).toEqual(['opus-x', 'sonnet-y', 'haiku-z', 'sub-w', 'runtime-v']);
    expect(catalog.tierModels).toEqual({ opus: 'opus-x', sonnet: 'sonnet-y', haiku: 'haiku-z' });
  });

  it('skips tier aliases as non-concrete models', () => {
    const catalog = collectDshModels('partner', {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku',
      ANTHROPIC_MODEL: 'haiku',
    });
    expect(catalog.models).toEqual([]);
    expect(catalog.tierModels).toEqual({});
  });

  it('selects by tier', () => {
    expect(deriveDshProvider('partner', TEST_ENV, { tier: 'haiku' }).selectedModel).toBe('model-b');
    expect(deriveDshProvider('partner', TEST_ENV, { tier: 'sonnet' }).selectedModel).toBe('model-a');
  });

  it('falls back across tiers when opus has no concrete pin', () => {
    const spec = deriveDshProvider('partner', {
      ...TEST_ENV,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
    });
    expect(spec.models).toEqual(['model-a', 'model-b']);
    expect(spec.selectedModel).toBe('model-a');
  });

  it('accepts any non-empty explicit model and adds it to route models', () => {
    const spec = deriveDshProvider('partner', TEST_ENV, { model: 'custom-model-xyz' });
    expect(spec.selectedModel).toBe('custom-model-xyz');
    expect(spec.models).toContain('custom-model-xyz');
    // Also accepts a model already in the catalog.
    const spec2 = deriveDshProvider('partner', TEST_ENV, { model: 'model-b' });
    expect(spec2.selectedModel).toBe('model-b');
    // Dedup: model-b should appear once.
    expect(spec2.models.filter((m) => m === 'model-b')).toHaveLength(1);
  });

  it('allows --model to rescue an environment with no tier models', () => {
    const spec = deriveDshProvider('partner', {
      ANTHROPIC_BASE_URL: 'https://gw.example.internal',
      ANTHROPIC_AUTH_TOKEN: 'plain-test-token',
      ANTHROPIC_MODEL: 'opus', // alias, not concrete
    }, { model: 'my-custom-model' });
    expect(spec.selectedModel).toBe('my-custom-model');
    expect(spec.models).toEqual(['my-custom-model']);
  });

  it('rejects tier+model conflict and unknown tier', () => {
    expect(deriveError('partner', TEST_ENV, { tier: 'haiku', model: 'model-b' }).code).toBe('TIER_MODEL_CONFLICT');
    expect(deriveError('partner', TEST_ENV, { tier: 'ultra' as never }).code).toBe('UNKNOWN_TIER');
  });

  it('rejects a tier with no concrete model pin', () => {
    const error = deriveError('partner', {
      ...TEST_ENV,
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-y',
    }, { tier: 'opus' });
    expect(error.code).toBe('MISSING_TIER_MODEL');
  });

  it('rejects the OAuth-backed official environment', () => {
    expect(deriveError('official', {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'plain-test-token',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-5',
    }).code).toBe('OFFICIAL_ENV_REJECTED');
  });

  it('rejects a missing base URL', () => {
    const error = deriveError('partner', { ...TEST_ENV, ANTHROPIC_BASE_URL: undefined });
    expect(error.code).toBe('MISSING_BASE_URL');
  });

  it('rejects a missing or blank token field (no decryption)', () => {
    expect(deriveError('partner', { ...TEST_ENV, ANTHROPIC_AUTH_TOKEN: undefined }).code).toBe('MISSING_TOKEN');
    expect(deriveError('partner', { ...TEST_ENV, ANTHROPIC_AUTH_TOKEN: '   ' }).code).toBe('MISSING_TOKEN');
  });

  it('rejects an environment with no concrete model and no --model override', () => {
    const error = deriveError('partner', {
      ANTHROPIC_BASE_URL: 'https://gw.example.internal',
      ANTHROPIC_AUTH_TOKEN: 'plain-test-token',
      ANTHROPIC_MODEL: 'opus',
    });
    expect(error.code).toBe('MISSING_MODEL');
    expect(error.message).toContain('--model');
  });

  it('verifyTokenPresence checks field existence without decrypting', () => {
    expect(verifyTokenPresence(TEST_ENV)).toBe('present');
    expect(verifyTokenPresence({ ...TEST_ENV, ANTHROPIC_AUTH_TOKEN: undefined })).toBe('missing');
    expect(verifyTokenPresence({ ...TEST_ENV, ANTHROPIC_AUTH_TOKEN: '   ' })).toBe('missing');
    // Even encrypted values report as present.
    expect(verifyTokenPresence({ ...TEST_ENV, ANTHROPIC_AUTH_TOKEN: 'enc:v2:abc:def:ghi' })).toBe('present');
  });
});
