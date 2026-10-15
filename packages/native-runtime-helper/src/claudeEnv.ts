import process from 'node:process';
import { buildIsolatedAgentEnv } from '../../core/src/agent-home';

const CLAUDE_DESKTOP_CLIENT_APP = 'ccem-desktop';
const CLAUDE_NON_INTERACTIVE_SANDBOX = '1';
type ClaudeQueryEnvInput = {
  envVars?: Record<string, string>;
  effort?: string | null;
  baseEnv?: Record<string, string | undefined>;
  routerMode?: boolean;
};

const ROUTER_BYPASS_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

function mergeNoProxyHosts(value: string | undefined) {
  const hosts = (value ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  const seen = new Set(hosts.map((host) => host.toLowerCase()));
  for (const host of ROUTER_BYPASS_HOSTS) {
    if (!seen.has(host.toLowerCase())) {
      hosts.push(host);
      seen.add(host.toLowerCase());
    }
  }
  return hosts.join(',');
}

export function buildClaudeQueryEnv({
  envVars,
  effort,
  baseEnv = process.env,
  routerMode = false,
}: ClaudeQueryEnvInput = {}) {
  const env: Record<string, string | undefined> = {
    ...buildIsolatedAgentEnv(baseEnv, envVars),
    CLAUDE_AGENT_SDK_CLIENT_APP: CLAUDE_DESKTOP_CLIENT_APP,
    CLAUDE_CODE_SANDBOXED: CLAUDE_NON_INTERACTIVE_SANDBOX,
  };

  if (env.ANTHROPIC_AUTH_TOKEN) {
    delete env.ANTHROPIC_API_KEY;
  }

  if (routerMode) {
    delete env.CLAUDE_CODE_SUBAGENT_MODEL;
    env.ANTHROPIC_SMALL_FAST_MODEL = 'ccem-route:background';
    env.NO_PROXY = mergeNoProxyHosts(env.NO_PROXY);
    env.no_proxy = mergeNoProxyHosts(env.no_proxy);
  }

  if (effort) {
    env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  }

  return env;
}
