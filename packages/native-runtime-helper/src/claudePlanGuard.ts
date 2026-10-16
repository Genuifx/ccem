import path from 'node:path';
import { getCcemAgentHome } from '../../core/src/agent-home';

const PLAN_MODE_BLOCKED_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

export type ClaudePlanModePreToolUseInput = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
};

type ClaudePlanModeHookOutput = {
  continue: true;
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractPathLikeValue(input: Record<string, unknown>) {
  for (const key of ['file_path', 'path', 'target_file', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function isClaudeInternalPlanFile(toolName: string, input: Record<string, unknown>, claudeHome = getCcemAgentHome('claude')) {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    return false;
  }

  const pathLikeValue = extractPathLikeValue(input);
  if (!pathLikeValue) {
    return false;
  }

  const resolvedTarget = path.resolve(pathLikeValue);
  const planDir = path.resolve(claudeHome, 'plans');
  return resolvedTarget === planDir || resolvedTarget.startsWith(`${planDir}${path.sep}`);
}

export function shouldBlockClaudeToolInPlanMode(toolName: string, input: Record<string, unknown>, claudeHome = getCcemAgentHome('claude')) {
  if (!PLAN_MODE_BLOCKED_TOOLS.has(toolName)) {
    return false;
  }

  return !isClaudeInternalPlanFile(toolName, input, claudeHome);
}

export function buildClaudePlanModePreToolUseHook(
  isPlanMode: () => boolean,
  claudeHome = getCcemAgentHome('claude'),
) {
  return async function claudePlanModePreToolUseHook(
    input: ClaudePlanModePreToolUseInput,
  ): Promise<ClaudePlanModeHookOutput> {
    if (!isPlanMode() || input.hook_event_name !== 'PreToolUse') {
      return { continue: true };
    }

    const toolName = input.tool_name ?? '';
    const toolInput = asRecord(input.tool_input);
    if (!shouldBlockClaudeToolInPlanMode(toolName, toolInput, claudeHome)) {
      return { continue: true };
    }

    const reason = `Plan mode is active. Confirm the plan before running ${toolName}.`;
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  };
}

export function buildClaudePlanModeHooks(
  isPlanMode: () => boolean,
  claudeHome = getCcemAgentHome('claude'),
) {
  return {
    PreToolUse: [{
      hooks: [buildClaudePlanModePreToolUseHook(isPlanMode, claudeHome)],
    }],
  };
}
