import type { EnvConfig } from '@ccem/core';
import type { DshProviderSpec, DshDeriveOptions } from './provider.js';
import { deriveDshProvider } from './provider.js';
import { renderCordisPatch } from './patch.js';
import {
  probeBinVersion,
  probeSimpleBinVersion,
  resolveBinOnPath,
  resolveDshInvocation,
  resolveDshRoot,
  type DshInvocation,
  type VersionProbeDeps,
} from './environment.js';
import {
  DSH_REQUIRED_VERSION,
  DSH_NODE_MIN_VERSION,
  isDshVersionCompatible,
  isNodeVersionCompatible,
} from './version.js';

/**
 * Readiness reporting for `ccem dsh`. Every probe here is offline: binary
 * lookup, `--version` calls, and local config derivation. No profile boot,
 * no model request, no writes anywhere, no token decryption.
 */

export type DshCheckStatus = 'pass' | 'fail' | 'warn';

export interface DshDoctorCheck {
  id: string;
  label: string;
  status: DshCheckStatus;
  detail: string;
  remediation?: string;
}

export interface DshDoctorReport {
  ok: boolean;
  checks: DshDoctorCheck[];
  dshVersion: string | null;
  nodeVersion: string | null;
  dshRoot: string;
  environment: {
    name: string;
    spec: DshProviderSpec | null;
    error: string | null;
  };
}

export interface DoctorEnvironmentInput {
  envName: string;
  envConfig: EnvConfig | undefined;
  deriveOptions?: DshDeriveOptions;
}

export interface DshDoctorDeps extends VersionProbeDeps {
  platform?: NodeJS.Platform;
}

export async function collectDshDoctorReport(
  input: DoctorEnvironmentInput,
  deps: DshDoctorDeps = {},
): Promise<DshDoctorReport> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;

  const checks: DshDoctorCheck[] = [];

  // dsh binary resolution (uses DshInvocation — same resolution as run)
  const invocation = resolveDshInvocation({ env, platform });
  checks.push({
    id: 'dsh-binary',
    label: 'dsh binary',
    status: invocation ? 'pass' : 'fail',
    detail: invocation ? invocation.bin : 'dsh not found on PATH',
    remediation: invocation
      ? undefined
      : `Install dsh: npm install -g @deepseek-ai/dsh@${DSH_REQUIRED_VERSION}`,
  });

  // dsh version — must be exactly the verified contract version
  let dshVersion: string | null = null;
  if (invocation) {
    dshVersion = await probeBinVersion(invocation, deps);
    if (dshVersion === null) {
      checks.push({
        id: 'dsh-version',
        label: 'dsh version',
        status: 'fail',
        detail: `could not read version (requires exactly ${DSH_REQUIRED_VERSION})`,
        remediation: 'Run dsh --version and check the installation',
      });
    } else if (isDshVersionCompatible(dshVersion)) {
      checks.push({
        id: 'dsh-version',
        label: 'dsh version',
        status: 'pass',
        detail: `${dshVersion} (== ${DSH_REQUIRED_VERSION})`,
      });
    } else {
      checks.push({
        id: 'dsh-version',
        label: 'dsh version',
        status: 'fail',
        detail: `${dshVersion} is not the verified contract version (requires exactly ${DSH_REQUIRED_VERSION})`,
        remediation: `Install the verified version: npm install -g @deepseek-ai/dsh@${DSH_REQUIRED_VERSION}`,
      });
    }
  }

  // node version — the interpreter dsh's `#!/usr/bin/env node` shebang resolves.
  // On Windows with cmd shim (prefix.length > 0), invocation.bin IS node.
  // On Windows with direct .exe/.com, or on POSIX, resolve node from PATH.
  const nodeBin = (platform === 'win32' && invocation && invocation.prefix.length > 0)
    ? invocation.bin
    : resolveBinOnPath('node', env, platform);
  let nodeVersion: string | null = null;
  if (nodeBin) {
    nodeVersion = await probeSimpleBinVersion(nodeBin, deps);
  }
  if (nodeVersion !== null && isNodeVersionCompatible(nodeVersion)) {
    checks.push({
      id: 'node-version',
      label: 'node version (runs dsh)',
      status: 'pass',
      detail: `${nodeVersion} (>= ${DSH_NODE_MIN_VERSION}, required by dsh's pi-ai dependency)`,
    });
  } else if (nodeVersion !== null) {
    checks.push({
      id: 'node-version',
      label: 'node version (runs dsh)',
      status: 'fail',
      detail: `${nodeVersion} < ${DSH_NODE_MIN_VERSION}`,
      remediation: `dsh's LLM stack requires Node >= ${DSH_NODE_MIN_VERSION}; switch the PATH-visible node (e.g. via nvm)`,
    });
  } else {
    checks.push({
      id: 'node-version',
      label: 'node version (runs dsh)',
      status: 'fail',
      detail: 'could not resolve the node that will run dsh',
      remediation: `Ensure node >= ${DSH_NODE_MIN_VERSION} is on PATH`,
    });
  }

  // active dsh root
  const dshRoot = resolveDshRoot(env);
  checks.push({
    id: 'dsh-root',
    label: 'active dsh root',
    status: 'pass',
    detail: `${dshRoot} (sessions persist here; ccem dsh run disables the settings row via --patch, so root settings.yaml cannot override the projected provider)`,
  });

  // environment projection (no token decryption)
  let spec: DshProviderSpec | null = null;
  let environmentError: string | null = null;
  if (!input.envConfig) {
    environmentError = `Environment '${input.envName}' not found in CCEM configuration`;
  } else {
    try {
      spec = deriveDshProvider(input.envName, input.envConfig, input.deriveOptions);
    } catch (error) {
      environmentError = error instanceof Error ? error.message : String(error);
    }
  }
  checks.push({
    id: 'environment',
    label: `environment '${input.envName}'`,
    status: spec ? 'pass' : 'fail',
    detail: spec
      ? `${spec.baseURL} · model ${spec.selectedModel} · credential ${spec.credentialState} (value redacted)`
      : environmentError ?? 'environment projection failed',
    remediation: spec
      ? undefined
      : 'Fix the environment with ccem add / ccem env, or select another with --env',
  });

  const ok = checks
    .filter((check) => check.id !== 'dsh-root')
    .every((check) => check.status !== 'fail');

  return {
    ok,
    checks,
    dshVersion,
    nodeVersion,
    dshRoot,
    environment: { name: input.envName, spec, error: environmentError },
  };
}

export interface DshInspectReport {
  environment: {
    name: string;
    baseURL: string | null;
    models: string[];
    selectedModel: string | null;
    credentialState: string | null;
    error: string | null;
  };
  dsh: {
    root: string;
    version: string | null;
    versionCompatible: boolean | null;
  };
  node: {
    version: string | null;
    versionCompatible: boolean | null;
  };
  /** The exact secret-free Cordis patch a run would pass to dsh. */
  patchPreview: string | null;
}

/** Build the redacted projection report; the token never appears here. */
export function buildDshInspectReport(
  input: DoctorEnvironmentInput,
  meta: {
    dshRoot: string;
    dshVersion: string | null;
    nodeVersion: string | null;
  },
): DshInspectReport {
  let spec: DshProviderSpec | null = null;
  let error: string | null = null;
  if (!input.envConfig) {
    error = `Environment '${input.envName}' not found in CCEM configuration`;
  } else {
    try {
      spec = deriveDshProvider(input.envName, input.envConfig, input.deriveOptions);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    environment: {
      name: input.envName,
      baseURL: spec?.baseURL ?? input.envConfig?.ANTHROPIC_BASE_URL?.trim() ?? null,
      models: spec?.models ?? [],
      selectedModel: spec?.selectedModel ?? null,
      credentialState: spec?.credentialState ?? null,
      error,
    },
    dsh: {
      root: meta.dshRoot,
      version: meta.dshVersion,
      versionCompatible: meta.dshVersion === null ? null : isDshVersionCompatible(meta.dshVersion),
    },
    node: {
      version: meta.nodeVersion,
      versionCompatible: meta.nodeVersion === null ? null : isNodeVersionCompatible(meta.nodeVersion),
    },
    patchPreview: spec ? renderCordisPatch(spec) : null,
  };
}
