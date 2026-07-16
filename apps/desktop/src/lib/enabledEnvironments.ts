import type { Environment } from '@/store';

/**
 * Runtime selector filter for environments.
 *
 * - `null` / `undefined` → legacy mode: all environments are treated as enabled.
 * - `string[]` → explicit enable list. Only listed names are shown in runtime pickers.
 *   Current env is always kept visible even if disabled, so the user can still see it.
 */
export function isEnvironmentEnabled(
  name: string,
  enabledEnvironments: string[] | null | undefined,
): boolean {
  if (enabledEnvironments == null) return true;
  return enabledEnvironments.includes(name);
}

export function filterRuntimeEnvironments<T extends Pick<Environment, 'name'>>(
  environments: T[],
  enabledEnvironments: string[] | null | undefined,
  options?: { currentEnv?: string | string[] | null },
): T[] {
  if (enabledEnvironments == null) return environments;

  const enabledSet = new Set(enabledEnvironments);
  const currentEnv = options?.currentEnv ?? null;
  const alwaysVisible = new Set(
    Array.isArray(currentEnv)
      ? currentEnv.filter((name): name is string => typeof name === 'string' && name.length > 0)
      : typeof currentEnv === 'string' && currentEnv.length > 0
        ? [currentEnv]
        : [],
  );

  return environments.filter(
    (env) => enabledSet.has(env.name) || alwaysVisible.has(env.name),
  );
}

export function suggestCopiedEnvironmentName(
  sourceName: string,
  existingNames: Iterable<string>,
): string {
  const existing = new Set(existingNames);
  const base = `${sourceName}-copy`;
  if (!existing.has(base)) return base;

  let index = 2;
  while (existing.has(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

/**
 * Toggle one environment in the explicit enable list.
 *
 * First toggle bootstraps the list from all known environment names (legacy → managed).
 * Returns the next explicit list.
 */
export function toggleEnabledEnvironment(
  name: string,
  enabledEnvironments: string[] | null | undefined,
  allEnvironmentNames: string[],
): string[] {
  if (enabledEnvironments == null) {
    // Enter managed mode: start from "all enabled", then flip the target off.
    return allEnvironmentNames.filter((envName) => envName !== name);
  }

  if (enabledEnvironments.includes(name)) {
    return enabledEnvironments.filter((envName) => envName !== name);
  }

  return [...enabledEnvironments, name];
}
