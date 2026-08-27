import type { Command } from 'commander';
import chalk from 'chalk';
import type { EnvConfig } from '@ccem/core';
import { decrypt } from '@ccem/core';
import {
  DshProjectionError,
  DSH_TIERS,
  deriveDshProvider,
  type DshTier,
  type DshDeriveOptions,
} from './provider.js';
import {
  runDshTask,
  runPreflightGate,
  DSH_PERMISSION_MODES,
  type DshPermissionMode,
} from './launcher.js';
import { buildDshInspectReport, collectDshDoctorReport } from './doctor.js';
import {
  resolveDshInvocation,
  probeBinVersion,
  probeSimpleBinVersion,
  resolveBinOnPath,
  resolveDshRoot,
} from './environment.js';

export interface DshCliContext {
  getRegistries: () => Record<string, EnvConfig>;
  getCurrentEnvName: () => string;
}

/**
 * Injectable dependencies for the dsh run action. Production uses the real
 * implementations; tests can inject vi.fn() spies to prove gate ordering.
 */
export interface DshCliActionDeps {
  runPreflightGate: typeof runPreflightGate;
  decryptToken: (envName: string, envConfig: EnvConfig) => string;
  runDshTask: typeof runDshTask;
  processExit: (code: number) => never;
  /** Test-only hook: receives the error before failWith processes it. */
  onActionError?: (error: unknown) => void;
}

const STATUS_MARKS = {
  pass: chalk.green('✓'),
  fail: chalk.red('✗'),
  warn: chalk.yellow('⚠'),
} as const;

interface ResolvedEnvironment {
  envName: string;
  envConfig: EnvConfig | undefined;
}

function resolveEnvironment(context: DshCliContext, envFlag: string | undefined): ResolvedEnvironment {
  const envName = envFlag?.trim() || context.getCurrentEnvName();
  return { envName, envConfig: context.getRegistries()[envName] };
}

function failWith(error: unknown, exit: (code: number) => never = (c) => process.exit(c)): never {
  const message = error instanceof DshProjectionError || error instanceof Error
    ? error.message
    : String(error);
  console.error(chalk.red(`✗ ${message}`));
  exit(1);
}

function formatVersionLine(version: string | null, compatible: boolean | null): string {
  if (version === null) return 'not found';
  const suffix = compatible === false ? chalk.red(' (incompatible)') : '';
  return `${version}${suffix}`;
}

function parseDeriveOptions(options: { tier?: string; model?: string }): DshDeriveOptions {
  return {
    tier: options.tier as DshTier | undefined,
    model: options.model,
  };
}

/**
 * Decrypt the environment auth token. Only called in the run path after all
 * pre-flight gates pass. The token never enters inspect/doctor reports.
 */
function decryptToken(envName: string, envConfig: EnvConfig): string {
  const raw = envConfig.ANTHROPIC_AUTH_TOKEN?.trim();
  if (!raw) {
    throw new DshProjectionError(
      'MISSING_TOKEN',
      `Environment '${envName}' has no auth token; ccem dsh needs a token-based environment`,
    );
  }
  const token = decrypt(raw).trim();
  if (!token) {
    throw new DshProjectionError(
      'MISSING_TOKEN',
      `Environment '${envName}' auth token decrypted to empty; check the encryption key`,
    );
  }
  return token;
}

export function registerDshCommands(program: Command, context: DshCliContext, deps?: Partial<DshCliActionDeps>): void {
  const doPreflightGate = deps?.runPreflightGate ?? runPreflightGate;
  const doDecryptToken = deps?.decryptToken ?? decryptToken;
  const doRunDshTask = deps?.runDshTask ?? runDshTask;
  const doProcessExit = deps?.processExit ?? ((code: number) => process.exit(code)) as (code: number) => never;
  const doOnActionError = deps?.onActionError;
  const dshCmd = program
    .command('dsh')
    .description('Project a CCEM environment onto DeepSeek Harness (dsh)');

  dshCmd
    .command('run <task...>')
    .description('Run one task through dsh headless with the projected environment')
    .option('--env <name>', 'CCEM environment to project (default: current)')
    .option('--tier <tier>', `Tier model to select: ${DSH_TIERS.join(' | ')}`)
    .option('--model <id>', 'Explicit model id (any non-empty value; added to route if new)')
    .option('--permission <mode>', `dsh permission: ${DSH_PERMISSION_MODES.join(' | ')} (default: workspace-write). headless has no approval responder.`, 'workspace-write')
    .option('--cwd <dir>', 'Working directory for the dsh process')
    .addHelpText('after', `
Examples:
  ccem dsh run "summarize this repo"
  ccem dsh run --env partner --tier opus "refactor auth"
  ccem dsh run --model custom-model-id "do something"
  ccem dsh run --permission read-only "audit the code"
  ccem dsh run -- "task text that starts with a dash after --"

Note: Use -- to separate task text from options if the task could be
      parsed as flags. headless profile has no interactive approval
      responder, so --permission controls what the agent can do.`)
    .action(async (taskWords: string[], options: {
      env?: string;
      tier?: string;
      model?: string;
      permission?: string;
      cwd?: string;
    }) => {
      const { envName, envConfig } = resolveEnvironment(context, options.env);
      if (!envConfig) failWith(new Error(`Environment '${envName}' not found in CCEM configuration`));

      try {
        // 1. Validate permission mode FIRST — before any preflight or decryption.
        const permission = (options.permission ?? 'workspace-write') as DshPermissionMode;
        if (!DSH_PERMISSION_MODES.includes(permission)) {
          throw new DshProjectionError(
            'INVALID_PERMISSION',
            `Unknown permission mode '${permission}'; expected one of ${DSH_PERMISSION_MODES.join(', ')}`,
          );
        }

        // 2. Derive the spec (no token decryption).
        const spec = deriveDshProvider(envName, envConfig, parseDeriveOptions(options));

        // 3. Pre-flight gate: binary exists, dsh==0.1.1-rc.2, node>=22.19.
        const gate = await doPreflightGate();

        // 4. Decrypt token only after all gates pass.
        const token = doDecryptToken(envName, envConfig);

        // 5. Launch.
        const result = await doRunDshTask({
          task: taskWords.join(' ').trim(),
          spec,
          token,
          invocation: gate.invocation,
          permission,
          cwd: options.cwd,
        });
        if (result.spawnError) {
          console.error(chalk.red(`✗ ${result.spawnError}`));
        }
        doProcessExit(result.exitCode);
      } catch (error) {
        doOnActionError?.(error);
        failWith(error, doProcessExit);
      }
    });

  dshCmd
    .command('inspect')
    .description('Show the projected dsh provider for an environment (secrets redacted)')
    .option('--env <name>', 'CCEM environment to inspect (default: current)')
    .option('--tier <tier>', `Tier model to select: ${DSH_TIERS.join(' | ')}`)
    .option('--model <id>', 'Explicit model id to preview')
    .option('--json', 'Output as JSON')
    .action(async (options: { env?: string; tier?: string; model?: string; json?: boolean }) => {
      const { envName, envConfig } = resolveEnvironment(context, options.env);
      const invocation = resolveDshInvocation();
      const nodeBin = resolveBinOnPath('node') ?? 'node';
      const [dshVersion, nodeVersion] = await Promise.all([
        invocation ? probeBinVersion(invocation) : Promise.resolve(null),
        probeSimpleBinVersion(nodeBin),
      ]);
      const report = buildDshInspectReport(
        { envName, envConfig, deriveOptions: parseDeriveOptions(options) },
        { dshRoot: resolveDshRoot(), dshVersion, nodeVersion },
      );

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const env = report.environment;
        if (env.error) {
          console.error(chalk.red(`✗ ${env.error}`));
        } else {
          console.log(chalk.bold(`Environment ${chalk.cyan(env.name)} → dsh provider`));
          console.log(`  endpoint:         ${env.baseURL}`);
          console.log(`  models:           ${env.models.join(', ')}`);
          console.log(`  selected model:   ${chalk.cyan(env.selectedModel ?? '-')}`);
          console.log(`  credential:       ${env.credentialState} (value redacted)`);
        }
        console.log(`  dsh root:         ${report.dsh.root}`);
        console.log(`  dsh version:      ${formatVersionLine(report.dsh.version, report.dsh.versionCompatible)}`);
        console.log(`  node version:     ${formatVersionLine(report.node.version, report.node.versionCompatible)}`);
        if (report.patchPreview) {
          console.log(chalk.gray('  --- patch preview (secret-free) ---'));
          for (const line of report.patchPreview.trimEnd().split('\n')) {
            console.log(chalk.gray(`  ${line}`));
          }
        }
      }

      process.exit(report.environment.error ? 1 : 0);
    });

  dshCmd
    .command('doctor')
    .description('Check dsh binary, versions, and config readiness (no model request, no token decryption)')
    .option('--env <name>', 'CCEM environment to check (default: current)')
    .option('--tier <tier>', `Tier model to select: ${DSH_TIERS.join(' | ')}`)
    .option('--model <id>', 'Explicit model id to check')
    .option('--json', 'Output as JSON')
    .action(async (options: { env?: string; tier?: string; model?: string; json?: boolean }) => {
      const { envName, envConfig } = resolveEnvironment(context, options.env);
      const report = await collectDshDoctorReport({
        envName,
        envConfig,
        deriveOptions: parseDeriveOptions(options),
      });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        for (const check of report.checks) {
          console.log(`${STATUS_MARKS[check.status]} ${chalk.bold(check.label)}: ${check.detail}`);
          if (check.remediation && check.status !== 'pass') {
            console.log(chalk.gray(`    → ${check.remediation}`));
          }
        }
      }

      process.exit(report.ok ? 0 : 1);
    });
}
