import fs from 'fs';
import path from 'path';
import type { CcemConfig } from '@ccem/core';
import {
  assertOfficialEnvironmentInvariant,
  findRouterEnvironmentReferences,
  getCcemConfigDir,
  OFFICIAL_ENV_NAME,
  renameRouterEnvironmentReferences,
} from '@ccem/core';
import {
  getDesktopControlDescriptorPath,
  deleteDesktopEnvironment,
  renameDesktopEnvironment,
} from './desktopControl.js';

export interface EnvironmentMutationAuthorityOptions {
  descriptorExists?: () => boolean;
  stateExists?: () => boolean;
  renameRemote?: (oldName: string, newName: string) => Promise<unknown>;
  deleteRemote?: (name: string) => Promise<unknown>;
}

export type EnvironmentMutationAuthorityResult =
  | { authority: 'desktop'; result: unknown }
  | { authority: 'local'; config: CcemConfig };

export type EnvironmentMutationConfigSource = CcemConfig | (() => CcemConfig);

function nativeRuntimeStatePath(): string {
  return path.join(getCcemConfigDir(), 'native-runtime-state.json');
}

function resolveMutationAuthority(options: EnvironmentMutationAuthorityOptions): {
  descriptorExists: () => boolean;
  stateExists: () => boolean;
} {
  const descriptorExists = options.descriptorExists
    ?? (() => fs.existsSync(getDesktopControlDescriptorPath()));
  const stateExists = options.stateExists
    ?? (() => fs.existsSync(nativeRuntimeStatePath()));
  return { descriptorExists, stateExists };
}

function assertOfflineMutationIsSafe(
  name: string,
  stateExists: () => boolean,
): void {
  if (stateExists()) {
    throw new Error(
      `CCEM Desktop is required to update active or recoverable native sessions before changing environment '${name}'. Start CCEM Desktop and retry.`,
    );
  }
}

function resolveLocalConfig(source: EnvironmentMutationConfigSource): CcemConfig {
  return typeof source === 'function' ? source() : source;
}

export async function renameEnvironmentWithAuthority(
  config: EnvironmentMutationConfigSource,
  oldName: string,
  newName: string,
  options: EnvironmentMutationAuthorityOptions = {},
): Promise<EnvironmentMutationAuthorityResult> {
  const authority = resolveMutationAuthority(options);
  if (authority.descriptorExists()) {
    const renameRemote = options.renameRemote ?? renameDesktopEnvironment;
    return {
      authority: 'desktop',
      result: await renameRemote(oldName, newName),
    };
  }
  assertOfflineMutationIsSafe(oldName, authority.stateExists);
  return {
    authority: 'local',
    config: renameEnvironmentInConfig(resolveLocalConfig(config), oldName, newName),
  };
}

export async function deleteEnvironmentWithAuthority(
  config: EnvironmentMutationConfigSource,
  name: string,
  options: EnvironmentMutationAuthorityOptions = {},
): Promise<EnvironmentMutationAuthorityResult> {
  const authority = resolveMutationAuthority(options);
  if (authority.descriptorExists()) {
    const deleteRemote = options.deleteRemote ?? deleteDesktopEnvironment;
    return {
      authority: 'desktop',
      result: await deleteRemote(name),
    };
  }
  assertOfflineMutationIsSafe(name, authority.stateExists);
  return {
    authority: 'local',
    config: deleteEnvironmentFromConfig(resolveLocalConfig(config), name),
  };
}

function validateRename(config: CcemConfig, oldName: string, newName: string): void {
  if (!Object.prototype.hasOwnProperty.call(config.registries, oldName)) {
    throw new Error(`Environment '${oldName}' not found.`);
  }
  if (!newName.trim()) {
    throw new Error('Environment name cannot be empty.');
  }
  if (Object.prototype.hasOwnProperty.call(config.registries, newName)) {
    throw new Error(`Environment '${newName}' already exists.`);
  }
  if (oldName === OFFICIAL_ENV_NAME) {
    throw new Error(`Cannot rename the protected '${OFFICIAL_ENV_NAME}' environment.`);
  }
}

export function renameEnvironmentInConfig(
  config: CcemConfig,
  oldName: string,
  newName: string,
): CcemConfig {
  assertOfficialEnvironmentInvariant(config.registries);
  validateRename(config, oldName, newName);

  const registries = { ...config.registries };
  registries[newName] = registries[oldName];
  delete registries[oldName];

  const next: CcemConfig = {
    ...config,
    registries,
    current: config.current === oldName ? newName : config.current,
    ...(config.router && {
      router: renameRouterEnvironmentReferences(config.router, oldName, newName),
    }),
  };
  assertOfficialEnvironmentInvariant(next.registries);
  return next;
}

export function deleteEnvironmentFromConfig(
  config: CcemConfig,
  name: string,
): CcemConfig {
  assertOfficialEnvironmentInvariant(config.registries);
  if (!Object.prototype.hasOwnProperty.call(config.registries, name)) {
    throw new Error(`Environment '${name}' not found.`);
  }
  if (name === OFFICIAL_ENV_NAME) {
    throw new Error(`Cannot delete the protected '${OFFICIAL_ENV_NAME}' environment.`);
  }

  const references = findRouterEnvironmentReferences(config.router, name);
  if (references.length > 0) {
    throw new Error(
      `Environment '${name}' is referenced by router config: ${references.join(', ')}`,
    );
  }

  const registries = { ...config.registries };
  delete registries[name];
  const next: CcemConfig = {
    ...config,
    registries,
    current: config.current === name ? OFFICIAL_ENV_NAME : config.current,
  };
  assertOfficialEnvironmentInvariant(next.registries);
  return next;
}
