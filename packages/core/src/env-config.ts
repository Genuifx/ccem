import type { EnvConfig } from './types.js';

export interface LegacyEnvConfig extends EnvConfig {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_SMALL_FAST_MODEL?: string;
}

const TIER_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);
const OFFICIAL_ENV_NAME = 'official';
const OFFICIAL_BASE_URL = 'https://api.anthropic.com';
const LEGACY_OFFICIAL_MODEL_PIN = 'claude-opus-4-1-20250805';
const LEGACY_OFFICIAL_HAIKU_PIN = 'claude-3-5-haiku-20241022';
const OFFICIAL_RUNTIME_ALIAS = 'opus';

export function hasLegacyEnvFields(envConfig: Partial<LegacyEnvConfig>): boolean {
  return Boolean(
    envConfig.ANTHROPIC_API_KEY ||
    envConfig.ANTHROPIC_SMALL_FAST_MODEL ||
    (envConfig.ANTHROPIC_MODEL &&
      !envConfig.ANTHROPIC_DEFAULT_OPUS_MODEL &&
      !envConfig.ANTHROPIC_DEFAULT_SONNET_MODEL &&
      !envConfig.ANTHROPIC_DEFAULT_HAIKU_MODEL)
  );
}

export function normalizeEnvConfig(
  envConfig: Partial<LegacyEnvConfig>,
  defaultRuntimeModel: string = 'opus'
): EnvConfig {
  const hasTierDefaults =
    Boolean(envConfig.ANTHROPIC_DEFAULT_OPUS_MODEL) ||
    Boolean(envConfig.ANTHROPIC_DEFAULT_SONNET_MODEL) ||
    Boolean(envConfig.ANTHROPIC_DEFAULT_HAIKU_MODEL);

  const defaultOpusModel =
    envConfig.ANTHROPIC_DEFAULT_OPUS_MODEL ??
    (hasTierDefaults ? undefined : envConfig.ANTHROPIC_MODEL);
  const defaultSonnetModel =
    envConfig.ANTHROPIC_DEFAULT_SONNET_MODEL ??
    defaultOpusModel ??
    (hasTierDefaults ? undefined : envConfig.ANTHROPIC_MODEL);
  const defaultHaikuModel =
    envConfig.ANTHROPIC_DEFAULT_HAIKU_MODEL ??
    envConfig.ANTHROPIC_SMALL_FAST_MODEL;

  return {
    ...(envConfig.ANTHROPIC_BASE_URL && {
      ANTHROPIC_BASE_URL: envConfig.ANTHROPIC_BASE_URL,
    }),
    ...((envConfig.ANTHROPIC_AUTH_TOKEN ?? envConfig.ANTHROPIC_API_KEY) && {
      ANTHROPIC_AUTH_TOKEN:
        envConfig.ANTHROPIC_AUTH_TOKEN ?? envConfig.ANTHROPIC_API_KEY,
    }),
    ...(defaultOpusModel && {
      ANTHROPIC_DEFAULT_OPUS_MODEL: defaultOpusModel,
    }),
    ...(defaultSonnetModel && {
      ANTHROPIC_DEFAULT_SONNET_MODEL: defaultSonnetModel,
    }),
    ...(defaultHaikuModel && {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: defaultHaikuModel,
    }),
    ANTHROPIC_MODEL: hasTierDefaults
      ? envConfig.ANTHROPIC_MODEL ?? defaultRuntimeModel
      : defaultRuntimeModel,
    ...(envConfig.CLAUDE_CODE_SUBAGENT_MODEL && {
      CLAUDE_CODE_SUBAGENT_MODEL: envConfig.CLAUDE_CODE_SUBAGENT_MODEL,
    }),
    ...(typeof envConfig.CCEM_LIMIT_WRITE_TOOLS === 'boolean' && {
      CCEM_LIMIT_WRITE_TOOLS: envConfig.CCEM_LIMIT_WRITE_TOOLS,
    }),
  };
}

function shouldRecoverTierModel(model?: string): boolean {
  return !model || TIER_MODEL_ALIASES.has(model);
}

export function recoverEnvConfigFromLegacy(
  currentEnvConfig: Partial<LegacyEnvConfig>,
  legacyEnvConfig: Partial<LegacyEnvConfig>
): EnvConfig {
  const current = normalizeEnvConfig(currentEnvConfig);
  const legacy = normalizeEnvConfig(legacyEnvConfig);

  return {
    ...current,
    ...(!current.ANTHROPIC_AUTH_TOKEN &&
      legacy.ANTHROPIC_AUTH_TOKEN && {
        ANTHROPIC_AUTH_TOKEN: legacy.ANTHROPIC_AUTH_TOKEN,
      }),
    ...(shouldRecoverTierModel(current.ANTHROPIC_DEFAULT_OPUS_MODEL) &&
      legacy.ANTHROPIC_DEFAULT_OPUS_MODEL && {
        ANTHROPIC_DEFAULT_OPUS_MODEL: legacy.ANTHROPIC_DEFAULT_OPUS_MODEL,
      }),
    ...(shouldRecoverTierModel(current.ANTHROPIC_DEFAULT_SONNET_MODEL) &&
      legacy.ANTHROPIC_DEFAULT_SONNET_MODEL && {
        ANTHROPIC_DEFAULT_SONNET_MODEL: legacy.ANTHROPIC_DEFAULT_SONNET_MODEL,
      }),
    ...(shouldRecoverTierModel(current.ANTHROPIC_DEFAULT_HAIKU_MODEL) &&
      legacy.ANTHROPIC_DEFAULT_HAIKU_MODEL && {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: legacy.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      }),
    ...(!current.CLAUDE_CODE_SUBAGENT_MODEL &&
      legacy.CLAUDE_CODE_SUBAGENT_MODEL && {
        CLAUDE_CODE_SUBAGENT_MODEL: legacy.CLAUDE_CODE_SUBAGENT_MODEL,
      }),
  };
}

/**
 * Resolve persisted configuration into the values CCEM should pass to a process.
 *
 * Older CCEM releases stored the same Opus 4.1 pin for both tier aliases in the
 * built-in official environment. Omitting those untouched pins lets Claude Code
 * resolve `opus` and `sonnet` to its current recommended models without
 * rewriting the user's configuration.
 */
export function resolveEnvConfigForRuntime(
  envName: string | undefined,
  envConfig: EnvConfig
): EnvConfig {
  const resolved = { ...envConfig };
  const hasUntouchedLegacyOfficialPins =
    envName === OFFICIAL_ENV_NAME &&
    resolved.ANTHROPIC_BASE_URL === OFFICIAL_BASE_URL &&
    resolved.ANTHROPIC_DEFAULT_OPUS_MODEL === LEGACY_OFFICIAL_MODEL_PIN &&
    resolved.ANTHROPIC_DEFAULT_SONNET_MODEL === LEGACY_OFFICIAL_MODEL_PIN &&
    resolved.ANTHROPIC_DEFAULT_HAIKU_MODEL === LEGACY_OFFICIAL_HAIKU_PIN &&
    resolved.ANTHROPIC_MODEL === OFFICIAL_RUNTIME_ALIAS &&
    resolved.CLAUDE_CODE_SUBAGENT_MODEL === undefined;

  if (hasUntouchedLegacyOfficialPins) {
    delete resolved.ANTHROPIC_DEFAULT_OPUS_MODEL;
    delete resolved.ANTHROPIC_DEFAULT_SONNET_MODEL;
  }

  return resolved;
}
