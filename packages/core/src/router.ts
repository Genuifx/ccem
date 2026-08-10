import type {
  RouterBindingKey,
  RouterBindings,
  RouterConfig,
  RouterProfile,
} from './types.js';

export const DEFAULT_ROUTER_PORT = 17820;

/**
 * Built-in Agent names observed from Claude Code 2.1.220 without plugins or
 * project-defined agents. Unknown names remain valid for forward compatibility.
 */
export const BUILTIN_CLAUDE_AGENT_NAMES = Object.freeze([
  'claude',
  'Explore',
  'general-purpose',
  'Plan',
  'statusline-setup',
] as const);

export type BuiltinClaudeAgentName = typeof BUILTIN_CLAUDE_AGENT_NAMES[number];

export const DEFAULT_ONLY_ROUTER_PROFILE: Readonly<RouterProfile> = Object.freeze({
  id: 'default-only',
  name: '仅默认规则',
  revision: 1,
  bindings: Object.freeze({}) as RouterBindings,
  allowedEnvs: Object.freeze([]) as unknown as string[],
});

export const BUILTIN_ROUTER_PROFILES: ReadonlyArray<Readonly<RouterProfile>> = Object.freeze([
  DEFAULT_ONLY_ROUTER_PROFILE,
]);

export const DEFAULT_ROUTER_CONFIG: Readonly<RouterConfig> = Object.freeze({
  enabled: false,
  port: DEFAULT_ROUTER_PORT,
  bindings: Object.freeze({}) as RouterBindings,
  profiles: Object.freeze([]) as unknown as RouterProfile[],
  dynamicRouting: true,
  defaultAllowedEnvs: Object.freeze([]) as unknown as string[],
});

const ROUTER_ENVIRONMENT_ALIAS = /^[A-Za-z0-9._-]{1,64}$/u;
const ROUTER_AGENT_NAME = /^[A-Za-z0-9._:-]{1,128}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validate only the dynamic `ccem:<env>` alias grammar. */
export function isValidRouterEnvironmentAlias(value: unknown): value is string {
  return typeof value === 'string' && ROUTER_ENVIRONMENT_ALIAS.test(value);
}

function isNonEmptyEnvironmentReference(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isValidRouterBindingKey(value: unknown): value is RouterBindingKey {
  if (value === 'background' || value === 'subagent:*') {
    return true;
  }
  if (typeof value !== 'string' || !value.startsWith('subagent:')) {
    return false;
  }

  const agentName = value.slice('subagent:'.length);
  return ROUTER_AGENT_NAME.test(agentName);
}

export function validateRouterBindings(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['Router bindings must be an object'];
  }

  const errors: string[] = [];
  for (const [key, envName] of Object.entries(value)) {
    if (!isValidRouterBindingKey(key)) {
      errors.push(`Invalid router binding key '${key}'`);
    }
    if (!isNonEmptyEnvironmentReference(envName)) {
      errors.push(`Router binding '${key}' must target a non-empty environment reference`);
    }
  }
  return errors;
}

function throwValidationErrors(errors: string[]): void {
  if (errors.length > 0) {
    throw new TypeError(errors.join('; '));
  }
}

function cloneBindings(value: unknown, fieldName: string): RouterBindings {
  const errors = validateRouterBindings(value);
  throwValidationErrors(errors.map((error) => `${fieldName}: ${error}`));
  return { ...(value as RouterBindings) };
}

function normalizeEnvironmentNames(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an array of environment names`);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const envName of value) {
    if (!isNonEmptyEnvironmentReference(envName)) {
      throw new TypeError(`${fieldName} must contain only non-empty environment references`);
    }
    if (!seen.has(envName)) {
      seen.add(envName);
      result.push(envName);
    }
  }
  return result;
}

function normalizeProfile(value: unknown, index: number): RouterProfile {
  const fieldName = `Router profile at index ${index}`;
  if (!isRecord(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.trim() !== value.id) {
    throw new TypeError(`${fieldName} must have a non-empty id`);
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim() !== value.name) {
    throw new TypeError(`${fieldName} must have a non-empty name`);
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new TypeError(`${fieldName} must have a non-negative safe integer revision`);
  }

  const bindings = cloneBindings(value.bindings, `${fieldName} bindings`);
  const allowedEnvs = normalizeEnvironmentNames(value.allowedEnvs, `${fieldName} allowedEnvs`);
  for (const [key, target] of Object.entries(bindings)) {
    if (typeof target !== 'string' || !allowedEnvs.includes(target)) {
      throw new TypeError(
        `${fieldName} binding '${key}' targets an environment outside allowedEnvs`,
      );
    }
  }

  return {
    id: value.id,
    name: value.name,
    revision: value.revision as number,
    bindings,
    allowedEnvs,
  };
}

export function createDefaultRouterConfig(): RouterConfig {
  return {
    enabled: DEFAULT_ROUTER_CONFIG.enabled,
    port: DEFAULT_ROUTER_CONFIG.port,
    bindings: {},
    profiles: [],
    dynamicRouting: DEFAULT_ROUTER_CONFIG.dynamicRouting,
    defaultAllowedEnvs: [],
  };
}

export function normalizeRouterConfig(value: Partial<RouterConfig> = {}): RouterConfig {
  if (!isRecord(value)) {
    throw new TypeError('Router config must be an object');
  }

  const normalized = createDefaultRouterConfig();
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      throw new TypeError('Router enabled must be a boolean');
    }
    normalized.enabled = value.enabled;
  }
  if (value.port !== undefined) {
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
      throw new TypeError('Router port must be an integer between 1 and 65535');
    }
    normalized.port = value.port;
  }
  if (value.bindings !== undefined) {
    normalized.bindings = cloneBindings(value.bindings, 'Router bindings');
  }
  if (value.profiles !== undefined) {
    if (!Array.isArray(value.profiles)) {
      throw new TypeError('Router profiles must be an array');
    }
    normalized.profiles = value.profiles.map(normalizeProfile);
    const profileIds = new Set<string>();
    for (const profile of normalized.profiles) {
      if (profileIds.has(profile.id)) {
        throw new TypeError(`Router profile id '${profile.id}' is duplicated`);
      }
      profileIds.add(profile.id);
    }
  }
  if (value.dynamicRouting !== undefined) {
    if (typeof value.dynamicRouting !== 'boolean') {
      throw new TypeError('Router dynamicRouting must be a boolean');
    }
    normalized.dynamicRouting = value.dynamicRouting;
  }
  if (value.defaultAllowedEnvs !== undefined) {
    normalized.defaultAllowedEnvs = normalizeEnvironmentNames(
      value.defaultAllowedEnvs,
      'Router defaultAllowedEnvs',
    );
  }
  return normalized;
}

/** Return stable, secret-free locations that reference a stored environment. */
export function findRouterEnvironmentReferences(
  router: RouterConfig | undefined,
  envName: string,
): string[] {
  if (!router) {
    return [];
  }

  const normalized = normalizeRouterConfig(router);
  const references: string[] = [];
  for (const [key, target] of Object.entries(normalized.bindings)) {
    if (target === envName) {
      references.push(`router.bindings.${key}`);
    }
  }
  if (normalized.defaultAllowedEnvs.includes(envName)) {
    references.push('router.defaultAllowedEnvs');
  }
  for (const profile of normalized.profiles) {
    for (const [key, target] of Object.entries(profile.bindings)) {
      if (target === envName) {
        references.push(`router.profiles[${profile.id}].bindings.${key}`);
      }
    }
    if (profile.allowedEnvs.includes(envName)) {
      references.push(`router.profiles[${profile.id}].allowedEnvs`);
    }
  }
  return references;
}

function replaceEnvironmentNames(
  values: string[],
  oldName: string,
  newName: string,
): string[] {
  return [...new Set(values.map((value) => value === oldName ? newName : value))];
}

function bumpProfileRevision(revision: number): number {
  return revision >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : revision + 1;
}

/** Clone a router config while cascading one stored environment rename. */
export function renameRouterEnvironmentReferences(
  router: RouterConfig,
  oldName: string,
  newName: string,
): RouterConfig {
  const normalized = normalizeRouterConfig(router);
  const renameBindings = (bindings: RouterBindings): RouterBindings =>
    Object.fromEntries(
      Object.entries(bindings).map(([key, target]) => [
        key,
        target === oldName ? newName : target,
      ]),
    ) as RouterBindings;

  return {
    ...normalized,
    bindings: renameBindings(normalized.bindings),
    defaultAllowedEnvs: replaceEnvironmentNames(
      normalized.defaultAllowedEnvs,
      oldName,
      newName,
    ),
    profiles: normalized.profiles.map((profile) => {
      const bindings = renameBindings(profile.bindings);
      const allowedEnvs = replaceEnvironmentNames(profile.allowedEnvs, oldName, newName);
      const changed = Object.entries(profile.bindings)
        .some(([, target]) => target === oldName && target !== newName)
        || profile.allowedEnvs.some((target) => target === oldName && target !== newName);
      return {
        ...profile,
        revision: changed ? bumpProfileRevision(profile.revision) : profile.revision,
        bindings,
        allowedEnvs,
      };
    }),
  };
}
