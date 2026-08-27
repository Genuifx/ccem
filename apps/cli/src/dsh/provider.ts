import { createHash } from 'crypto';
import type { EnvConfig } from '@ccem/core';
import {
  OFFICIAL_ENV_NAME,
  resolveEnvConfigForRuntime,
} from '@ccem/core';

/**
 * Provider-neutral CCEM → DSH projection.
 *
 * Derives an ephemeral `anthropic-messages` provider route from a stored CCEM
 * environment. The derived spec is secret-free by construction: the auth token
 * never enters it, and the launcher passes the token to the dsh child only
 * through the `CCEM_DSH_API_KEY` environment variable.
 */

export const DSH_API_KEY_ENV = 'CCEM_DSH_API_KEY';
export const DSH_PROTOCOL = 'anthropic-messages';

export type DshTier = 'opus' | 'sonnet' | 'haiku';

export const DSH_TIERS: readonly DshTier[] = ['opus', 'sonnet', 'haiku'];

export type DshProjectionErrorCode =
  | 'OFFICIAL_ENV_REJECTED'
  | 'MISSING_BASE_URL'
  | 'MISSING_TOKEN'
  | 'MISSING_MODEL'
  | 'MISSING_TIER_MODEL'
  | 'UNKNOWN_TIER'
  | 'TIER_MODEL_CONFLICT'
  | 'LEADING_DASH_TASK'
  | 'EMPTY_TASK'
  | 'DSH_BINARY_MISSING'
  | 'DSH_VERSION_UNREADABLE'
  | 'DSH_VERSION_UNSUPPORTED'
  | 'NODE_VERSION_UNREADABLE'
  | 'NODE_VERSION_UNSUPPORTED'
  | 'INVALID_PERMISSION';

export class DshProjectionError extends Error {
  readonly code: DshProjectionErrorCode;

  constructor(code: DshProjectionErrorCode, message: string) {
    super(message);
    this.name = 'DshProjectionError';
    this.code = code;
  }
}

/** Redacted credential state — the token value itself is never represented. */
export type DshCredentialState = 'present' | 'missing';

export interface DshProviderSpec {
  /** Per-environment provider route id (deterministic slug derived from env name). */
  providerId: string;
  /** Human-facing route label (contains the CCEM environment name). */
  displayName: string;
  /** Anthropic-compatible endpoint of the selected environment. */
  baseURL: string;
  /** Environment variable name the dsh child reads the token from. */
  apiKeyEnv: string;
  /** Concrete model ids registered on the provider route. */
  models: string[];
  /** The model this run selects via `agent-default-model`. */
  selectedModel: string;
  /** Token presence, redacted. Never the token value. */
  credentialState: DshCredentialState;
}

export interface DshDeriveOptions {
  tier?: DshTier;
  /** Explicit model id — may be any non-empty string; added to route models if not already present. */
  model?: string;
}

type TierModelKey =
  | 'ANTHROPIC_DEFAULT_OPUS_MODEL'
  | 'ANTHROPIC_DEFAULT_SONNET_MODEL'
  | 'ANTHROPIC_DEFAULT_HAIKU_MODEL';

const TIER_MODEL_KEYS: ReadonlyArray<readonly [DshTier, TierModelKey]> = [
  ['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL'],
  ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'],
  ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
];

/** Tier aliases are Claude Code selectors, not concrete model ids. */
const TIER_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

function firstConcreteModel(value: string | undefined): string | undefined {
  const model = value?.trim();
  if (!model || TIER_MODEL_ALIASES.has(model)) return undefined;
  return model;
}

export interface DshModelCatalog {
  /** Deduplicated concrete models in tier-priority order. */
  models: string[];
  /** Concrete model per tier, when that tier pins one. */
  tierModels: Partial<Record<DshTier, string>>;
}

/** Collect concrete models from opus/sonnet/haiku tiers, then the subagent and runtime pins. */
export function collectDshModels(envName: string | undefined, envConfig: EnvConfig): DshModelCatalog {
  const runtimeEnv = resolveEnvConfigForRuntime(envName, envConfig);
  const models: string[] = [];
  const seen = new Set<string>();
  const tierModels: Partial<Record<DshTier, string>> = {};

  const push = (model: string | undefined): string | undefined => {
    if (!model || seen.has(model)) return model;
    seen.add(model);
    models.push(model);
    return model;
  };

  for (const [tier, key] of TIER_MODEL_KEYS) {
    tierModels[tier] = push(firstConcreteModel(runtimeEnv[key])) ?? tierModels[tier];
  }
  push(firstConcreteModel(runtimeEnv.CLAUDE_CODE_SUBAGENT_MODEL));
  push(firstConcreteModel(runtimeEnv.ANTHROPIC_MODEL));

  return { models, tierModels };
}

/**
 * Generate a deterministic, readable per-environment provider ID.
 * Format: `ccem-<slug>-<hash12>` where slug is the env name normalized to
 * [a-z0-9-] and hash12 is the first 12 hex chars of sha256(envName).
 * 12 hex chars = 48 bits of entropy, practically collision-free across
 * any realistic number of environments.
 * Note: renaming an environment forms a new provider ID by design since the
 * CCEM registry has no stable UUID for environments.
 */
export function generateProviderId(envName: string): string {
  const slug = envName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'env';
  const hash = createHash('sha256').update(envName).digest('hex').slice(0, 12);
  return `ccem-${slug}-${hash}`;
}

/**
 * Check whether an encrypted token field is present (non-blank) without
 * decrypting. Used by inspect/doctor — only the run path decrypts.
 */
export function verifyTokenPresence(envConfig: EnvConfig): DshCredentialState {
  const raw = envConfig.ANTHROPIC_AUTH_TOKEN?.trim();
  return raw ? 'present' : 'missing';
}

function defaultSelectedModel(catalog: DshModelCatalog): string | undefined {
  return (
    catalog.tierModels.opus
    ?? catalog.tierModels.sonnet
    ?? catalog.tierModels.haiku
    ?? catalog.models[0]
  );
}

/**
 * Derive the secret-free provider spec for a CCEM environment.
 *
 * This function NEVER decrypts the token — it only checks field presence.
 * Token decryption happens in the run path after all gates pass.
 *
 * Rejected, fail closed: the OAuth-backed official environment, a missing
 * auth token field, a missing base URL, and an environment without any
 * concrete model (unless --model provides one). --tier and --model are
 * mutually exclusive.
 */
export function deriveDshProvider(
  envName: string | undefined,
  envConfig: EnvConfig,
  options: DshDeriveOptions = {},
): DshProviderSpec {
  const { tier, model } = options;

  if (tier !== undefined && model !== undefined) {
    throw new DshProjectionError(
      'TIER_MODEL_CONFLICT',
      'Options --tier and --model are mutually exclusive; pass one of them',
    );
  }

  if (envName === OFFICIAL_ENV_NAME) {
    throw new DshProjectionError(
      'OFFICIAL_ENV_REJECTED',
      `Environment '${OFFICIAL_ENV_NAME}' is the OAuth-backed Claude environment; ccem dsh projects non-official Anthropic-compatible environments only`,
    );
  }

  const baseURL = envConfig.ANTHROPIC_BASE_URL?.trim();
  if (!baseURL) {
    throw new DshProjectionError(
      'MISSING_BASE_URL',
      `Environment '${envName ?? '<unknown>'}' has no ANTHROPIC_BASE_URL`,
    );
  }

  const credentialState = verifyTokenPresence(envConfig);
  if (credentialState === 'missing') {
    throw new DshProjectionError(
      'MISSING_TOKEN',
      `Environment '${envName ?? '<unknown>'}' has no auth token; ccem dsh needs a token-based environment`,
    );
  }

  const catalog = collectDshModels(envName, envConfig);

  // --model accepts any non-empty model id and adds it to route models.
  let selectedModel: string | undefined;
  if (tier !== undefined) {
    if (!DSH_TIERS.includes(tier)) {
      throw new DshProjectionError(
        'UNKNOWN_TIER',
        `Unknown tier '${tier}'; expected one of ${DSH_TIERS.join(', ')}`,
      );
    }
    selectedModel = catalog.tierModels[tier];
    if (!selectedModel) {
      throw new DshProjectionError(
        'MISSING_TIER_MODEL',
        `Environment '${envName ?? '<unknown>'}' pins no concrete '${tier}' tier model; available models: ${catalog.models.join(', ')}`,
      );
    }
  } else if (model !== undefined) {
    const normalized = model.trim();
    if (!normalized) {
      throw new DshProjectionError(
        'MISSING_MODEL',
        'The --model value must be a non-empty model id',
      );
    }
    selectedModel = normalized;
    // Add the explicit model to route models if not already present.
    if (!catalog.models.includes(normalized)) {
      catalog.models.push(normalized);
    }
  } else {
    selectedModel = defaultSelectedModel(catalog);
  }

  if (!selectedModel || catalog.models.length === 0) {
    throw new DshProjectionError(
      'MISSING_MODEL',
      `Environment '${envName ?? '<unknown>'}' has no concrete tier model (opus/sonnet/haiku pins are all empty or aliases); pass --model <id> to provide one explicitly`,
    );
  }

  const providerId = generateProviderId(envName ?? 'unknown');

  return {
    providerId,
    displayName: `CCEM ${envName ?? '<unknown>'}`,
    baseURL,
    apiKeyEnv: DSH_API_KEY_ENV,
    models: catalog.models,
    selectedModel,
    credentialState,
  };
}
