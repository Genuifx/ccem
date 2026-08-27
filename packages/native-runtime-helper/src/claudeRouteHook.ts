export type ClaudeRouterInit = {
  routeTagNonce: string;
  dynamicRouting: boolean;
  menu?: string | null;
};

type ClaudePreToolUseInput = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
};

type ClaudePreToolUseOutput = {
  continue: true;
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'deny';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
};

type ClaudePreToolUseHook = (
  input: ClaudePreToolUseInput,
) => Promise<ClaudePreToolUseOutput>;

type ClaudeHookMatcher = {
  matcher?: string;
  hooks: ClaudePreToolUseHook[];
};

type ClaudeHooks = {
  PreToolUse?: ClaudeHookMatcher[];
  [eventName: string]: unknown;
};

const SAFE_SUBAGENT_TYPE = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ENV_ALIAS = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_ROUTE_NONCE = /^[A-Za-z0-9._~-]{1,256}$/;
const RAW_ENV_OVERRIDE_PREFIX = '<CCEM-ROUTE>ccem:';
const RAW_ENV_OVERRIDE = /^<CCEM-ROUTE>ccem:([A-Za-z0-9._-]{1,64})<\/CCEM-ROUTE>(?:\r?\n)?/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function isSafeSubagentType(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SUBAGENT_TYPE.test(value);
}

function takeExactRawEnvOverride(prompt: string) {
  const match = RAW_ENV_OVERRIDE.exec(prompt);
  if (!match || !SAFE_ENV_ALIAS.test(match[1])) {
    return null;
  }
  return {
    env: match[1],
    rest: prompt.slice(match[0].length),
  };
}

function denyRoute(code: 'ROUTER_ENV_ALIAS_INVALID' | 'ROUTER_AGENT_TYPE_INVALID', message: string) {
  return {
    continue: true as const,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: `${code}: ${message}`,
    },
  };
}

export function buildClaudeRoutePreToolUseHook(
  router: ClaudeRouterInit,
): ClaudePreToolUseHook {
  return async function claudeRoutePreToolUseHook(input) {
    if (
      input.hook_event_name !== 'PreToolUse'
      || input.tool_name !== 'Agent'
      || !SAFE_ROUTE_NONCE.test(router.routeTagNonce)
    ) {
      return { continue: true };
    }

    const toolInput = asRecord(input.tool_input);
    const subagentType = toolInput.subagent_type;
    if (!isSafeSubagentType(subagentType)) {
      return denyRoute(
        'ROUTER_AGENT_TYPE_INVALID',
        "Agent subagent_type must be 1-128 ASCII letters, numbers, '.', '_', '-', or ':'.",
      );
    }

    const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
    const override = takeExactRawEnvOverride(prompt);
    if (prompt.startsWith(RAW_ENV_OVERRIDE_PREFIX) && !override) {
      return denyRoute(
        'ROUTER_ENV_ALIAS_INVALID',
        "Explicit CCEM environment aliases must be 1-64 ASCII letters, numbers, '.', '_', or '-'.",
      );
    }
    const identity = override ? `ccem:${override.env}` : `subagent:${subagentType}`;
    const rest = override?.rest ?? prompt;

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...toolInput,
          prompt: `<CCEM-ROUTE nonce="${router.routeTagNonce}">${identity}</CCEM-ROUTE>\n${rest}`,
        },
      },
    };
  };
}

export function mergeClaudeRouteHooks<T extends ClaudeHooks>(
  hooks: T,
  router?: ClaudeRouterInit | null,
) {
  if (!router || !SAFE_ROUTE_NONCE.test(router.routeTagNonce)) {
    return hooks;
  }

  return {
    ...hooks,
    PreToolUse: [
      ...(hooks.PreToolUse ?? []),
      {
        matcher: 'Agent',
        hooks: [buildClaudeRoutePreToolUseHook(router)],
      },
    ],
  };
}

export function buildClaudeRouterSystemPrompt(router?: ClaudeRouterInit | null) {
  const menu = router?.menu?.trim();
  if (!router?.dynamicRouting || !menu) {
    return undefined;
  }

  return {
    type: 'preset' as const,
    preset: 'claude_code' as const,
    append: menu,
  };
}
