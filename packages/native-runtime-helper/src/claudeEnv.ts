import process from 'node:process';

const CLAUDE_DESKTOP_CLIENT_APP = 'ccem-desktop';
const CLAUDE_NON_INTERACTIVE_SANDBOX = '1';
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

type ClaudeQueryEnvInput = {
  envVars?: Record<string, string>;
  effort?: string | null;
  baseEnv?: Record<string, string | undefined>;
};

export function buildClaudeQueryEnv({
  envVars,
  effort,
  baseEnv = process.env,
}: ClaudeQueryEnvInput = {}) {
  const cleanBaseEnv = { ...baseEnv };
  for (const key of MANAGED_CLAUDE_ENV_KEYS) {
    delete cleanBaseEnv[key];
  }

  const env = {
    ...cleanBaseEnv,
    ...envVars,
    CLAUDE_AGENT_SDK_CLIENT_APP: CLAUDE_DESKTOP_CLIENT_APP,
    CLAUDE_CODE_SANDBOXED: CLAUDE_NON_INTERACTIVE_SANDBOX,
  };

  if (env.ANTHROPIC_AUTH_TOKEN) {
    delete env.ANTHROPIC_API_KEY;
  }

  if (effort) {
    env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  }

  return env;
}
