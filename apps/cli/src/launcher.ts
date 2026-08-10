import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import type { EnvConfig, PermissionModeName } from '@ccem/core';
import {
  assertClaudeEnvironmentAuthBoundary,
  decrypt,
  PERMISSION_PRESETS,
  ensureCcemDir,
  normalizePermissionAllowRules,
  resolveEnvConfigForRuntime,
} from '@ccem/core';
import { renderStarting } from './ui.js';
import { startCliClaudeProvenanceTracking, type CliProvenanceTrackingHandle } from './sessionProvenance.js';

export interface LaunchOptions {
  envName?: string;
  envConfig?: EnvConfig;
  permMode?: PermissionModeName;
  workingDir?: string;
  sessionId?: string;
  /** Resume an existing Claude session by its ID */
  resumeSessionId?: string;
  /** Skip UI output (used by hidden launch command) */
  silent?: boolean;
  /** Allow only the Desktop-owned loopback Claude proxy override. */
  allowDesktopProxyOverride?: boolean;
}

export interface BuildEnvVarsOptions {
  allowDesktopProxyOverride?: boolean;
}

const MANAGED_CLAUDE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const;

/**
 * Build environment variables from an EnvConfig, decrypting the auth token.
 */
export function buildEnvVars(
  envName: string | undefined,
  envConfig: EnvConfig,
  options: BuildEnvVarsOptions = {},
): Record<string, string> {
  const runtimeEnv = resolveEnvConfigForRuntime(envName, envConfig);
  const authToken = runtimeEnv.ANTHROPIC_AUTH_TOKEN
    ? decrypt(runtimeEnv.ANTHROPIC_AUTH_TOKEN)
    : undefined;
  if (
    !options.allowDesktopProxyOverride
    || !isTrustedDesktopProxyBaseUrl(runtimeEnv.ANTHROPIC_BASE_URL)
  ) {
    assertClaudeEnvironmentAuthBoundary(
      envName,
      runtimeEnv.ANTHROPIC_BASE_URL,
      authToken,
    );
  }
  const vars: Record<string, string> = {};
  if (runtimeEnv.ANTHROPIC_BASE_URL) vars.ANTHROPIC_BASE_URL = runtimeEnv.ANTHROPIC_BASE_URL;
  if (authToken) vars.ANTHROPIC_AUTH_TOKEN = authToken;
  if (runtimeEnv.ANTHROPIC_DEFAULT_OPUS_MODEL) vars.ANTHROPIC_DEFAULT_OPUS_MODEL = runtimeEnv.ANTHROPIC_DEFAULT_OPUS_MODEL;
  if (runtimeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL) vars.ANTHROPIC_DEFAULT_SONNET_MODEL = runtimeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL;
  if (runtimeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL) vars.ANTHROPIC_DEFAULT_HAIKU_MODEL = runtimeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  if (runtimeEnv.ANTHROPIC_MODEL) vars.ANTHROPIC_MODEL = runtimeEnv.ANTHROPIC_MODEL;
  if (runtimeEnv.CLAUDE_CODE_SUBAGENT_MODEL) vars.CLAUDE_CODE_SUBAGENT_MODEL = runtimeEnv.CLAUDE_CODE_SUBAGENT_MODEL;
  return vars;
}

export function isTrustedDesktopProxyBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname.startsWith('/proxy/claude/');
  } catch {
    return false;
  }
}

/**
 * Build Claude CLI args for a permission mode preset.
 */
export function buildPermArgs(modeName: PermissionModeName): string[] {
  const preset = PERMISSION_PRESETS[modeName];
  if (!preset) return [];

  const args: string[] = ['--permission-mode', preset.permissionMode];
  const allowRules = normalizePermissionAllowRules(preset.permissions.allow);

  if (allowRules.length > 0) {
    args.push('--allowedTools', ...allowRules);
  }

  if (preset.permissions.deny.length > 0) {
    args.push('--disallowedTools', ...preset.permissions.deny);
  }

  return args;
}

/**
 * Ensure ~/.ccem/sessions/ directory exists.
 */
function ensureSessionsDir(): string {
  const dir = path.join(ensureCcemDir(), 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Unified entry point for launching Claude Code.
 *
 * Used by:
 * - Interactive menu "start" action
 * - `ccem <mode>` temporary permission commands
 * - `ccem launch` hidden command (called by Desktop app)
 */
export async function launchClaude(options: LaunchOptions): Promise<void> {
  const {
    envName,
    envConfig,
    permMode,
    workingDir,
    sessionId,
    resumeSessionId,
    silent,
    allowDesktopProxyOverride,
  } = options;
  const ccemRuntimeId = sessionId ?? `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Build env
  const env = { ...process.env };
  for (const key of MANAGED_CLAUDE_ENV_KEYS) {
    delete env[key];
  }
  if (envConfig) {
    Object.assign(env, buildEnvVars(envName, envConfig, { allowDesktopProxyOverride }));
  }
  // Prevent nested session detection
  delete env.CLAUDECODE;
  env.CCEM_RUNTIME_ID = ccemRuntimeId;
  env.CCEM_SESSION_ID = ccemRuntimeId;

  // Build args
  const args: string[] = [];
  if (permMode) {
    const preset = PERMISSION_PRESETS[permMode];
    if (preset) {
      if (!silent) {
        console.log(chalk.green(`已应用 ${preset.name}（临时）`));
        console.log(chalk.gray(`说明: ${preset.description}`));
        console.log('');
      }
      args.push(...buildPermArgs(permMode));
    }
  }

  // Resume an existing session
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  // Change working directory if specified
  if (workingDir) {
    process.chdir(workingDir);
  }
  const effectiveWorkingDir = process.cwd();

  if (!silent && !permMode) {
    console.log(renderStarting());
  }

  // Ensure sessions dir exists for exit tracking
  const sessionsDir = ensureSessionsDir();

  return new Promise((resolve) => {
    let provenanceTracking: CliProvenanceTrackingHandle | null = null;
    const child = spawn('claude', args, {
      stdio: 'inherit',
      shell: false,  // 直接执行二进制，避免 shell 注入风险
      env,
    });

    child.once('spawn', () => {
      if (sessionId) {
        return;
      }

      provenanceTracking = startCliClaudeProvenanceTracking({
        ccemSessionId: ccemRuntimeId,
        envName: envName ?? 'unknown',
        workingDir: effectiveWorkingDir,
        permMode,
        resumeSessionId,
      });
    });

    child.on('exit', (code) => {
      provenanceTracking?.stop();
      // Write exit code file if sessionId provided (Desktop tracking)
      if (sessionId) {
        try {
          fs.writeFileSync(
            path.join(sessionsDir, `${sessionId}.exit`),
            String(code ?? 0),
          );
        } catch {
          // Best effort — don't fail the process
        }
      }
      process.exit(code ?? 0);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      provenanceTracking?.stop();
      if (err.code === 'ENOENT') {
        console.error('');
        console.error(chalk.red.bold('✘ 未找到 Claude Code'));
        console.error('');
        console.error(chalk.white('  CCEM 需要 Claude Code CLI 才能启动会话，但在系统中未检测到 ') + chalk.cyan('claude') + chalk.white(' 命令。'));
        console.error('');
        console.error(chalk.white('  请先安装 Claude Code:'));
        console.error(chalk.cyan('    npm install -g @anthropic-ai/claude-code'));
        console.error('');
        console.error(chalk.gray('  如果已安装但仍报错，请检查:'));
        console.error(chalk.gray('    1. 运行 claude --version 确认安装成功'));
        console.error(chalk.gray('    2. 确保 npm 全局目录在系统 PATH 中（npm config get prefix）'));
        console.error(chalk.gray('    3. 安装后请重启终端'));
        console.error('');
      } else {
        console.error(chalk.red(`启动 Claude Code 失败: ${err.message}`));
      }
      process.exit(1);
    });
  });
}
