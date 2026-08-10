import type { CcemConfig, EnvConfig, RouterConfig } from './types.js';
import { normalizeRouterConfig } from './router.js';

export const OFFICIAL_ENV_NAME = 'official';
export const OFFICIAL_BASE_URL = 'https://api.anthropic.com';

/**
 * The protected OAuth-backed environment may only target Anthropic's root
 * endpoint. A single trailing slash is accepted because EnvConfig stores a URL
 * string rather than a parsed origin; all other textual variants fail closed.
 */
export function isTrustedOfficialBaseUrl(value: unknown): value is string {
  return value === OFFICIAL_BASE_URL || value === `${OFFICIAL_BASE_URL}/`;
}

/** All config writers must retain CCEM's protected built-in environment. */
export function assertOfficialEnvironmentPresent(
  registries: unknown,
): asserts registries is Record<string, unknown> {
  if (
    !registries
    || typeof registries !== 'object'
    || Array.isArray(registries)
    || !Object.prototype.hasOwnProperty.call(registries, OFFICIAL_ENV_NAME)
  ) {
    throw new TypeError(`Cannot remove or rename the protected '${OFFICIAL_ENV_NAME}' environment`);
  }
}

/** All persisted config writers must preserve the trusted built-in endpoint. */
export function assertOfficialEnvironmentInvariant(
  registries: unknown,
): asserts registries is Record<string, EnvConfig> {
  assertOfficialEnvironmentPresent(registries);
  const official = registries[OFFICIAL_ENV_NAME];
  if (
    !official
    || typeof official !== 'object'
    || Array.isArray(official)
    || !isTrustedOfficialBaseUrl(
      (official as Record<string, unknown>).ANTHROPIC_BASE_URL,
    )
  ) {
    throw new TypeError(
      `The protected '${OFFICIAL_ENV_NAME}' environment must use the trusted official root URL`,
    );
  }
}

/**
 * Prevent Claude Code from falling back to a user's local OAuth credentials at
 * an environment-controlled third-party endpoint.
 */
export function assertClaudeEnvironmentAuthBoundary(
  envName: string | undefined,
  baseUrl: string | undefined,
  decryptedAuthToken: string | undefined,
): void {
  if (envName === OFFICIAL_ENV_NAME) {
    if (!isTrustedOfficialBaseUrl(baseUrl)) {
      throw new TypeError(
        `The protected '${OFFICIAL_ENV_NAME}' environment must use the trusted official root URL`,
      );
    }
    return;
  }

  if (!decryptedAuthToken?.trim()) {
    throw new TypeError(
      `Environment '${envName ?? '<unknown>'}' requires an auth token; OAuth is only allowed for '${OFFICIAL_ENV_NAME}'`,
    );
  }
}

export interface LegacyEnvConfig extends EnvConfig {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_SMALL_FAST_MODEL?: string;
}

export interface LegacyCcemConfig {
  registries?: Record<string, Partial<LegacyEnvConfig>>;
  current?: string | null;
  defaultMode?: CcemConfig['defaultMode'];
  router?: Partial<RouterConfig>;
}

const TIER_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);
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

/** Normalize the shared config shape without dropping an optional router section. */
export function normalizeCcemConfig(config: LegacyCcemConfig): CcemConfig {
  const normalized: CcemConfig = {
    registries: Object.fromEntries(
      Object.entries(config.registries ?? {}).map(([name, env]) => [
        name,
        normalizeEnvConfig(env),
      ]),
    ),
  };

  if (config.current !== undefined) {
    normalized.current = config.current;
  }
  if (config.defaultMode !== undefined) {
    normalized.defaultMode = config.defaultMode;
  }
  if (config.router !== undefined) {
    normalized.router = normalizeRouterConfig(config.router);
  }

  return normalized;
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
    isTrustedOfficialBaseUrl(resolved.ANTHROPIC_BASE_URL) &&
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
