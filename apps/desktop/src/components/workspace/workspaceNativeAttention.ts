import type {
  InteractiveToolPrompt,
  SessionEventRecord,
} from '@/lib/tauri-ipc';

export interface PendingPermissionRequest {
  requestId: string;
  toolUseId?: string;
  toolName: string;
  inputSummary?: string;
  backgroundTaskId?: string;
}

export interface PendingInteractivePrompt {
  toolUseId: string;
  rawName: string;
  prompt: InteractiveToolPrompt;
}

export interface PendingTerminalPrompt {
  promptKind: string;
  promptText: string;
}

export interface NativeSessionAttentionState {
  permissions: PendingPermissionRequest[];
  prompts: PendingInteractivePrompt[];
  terminalPrompt: PendingTerminalPrompt | null;
}

export function isPlanExitPrompt(prompt?: InteractiveToolPrompt | null) {
  return prompt?.prompt_type === 'plan_exit';
}

export function getPlanExitPrimaryReply(
  prompt?: InteractiveToolPrompt | null,
  fallback = '继续执行',
) {
  if (!isPlanExitPrompt(prompt)) {
    return null;
  }

  const replies = (prompt.allowed_prompts ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  return replies[0] ?? fallback;
}

export function isPlanExitApprovalText(text: string, quickReplies: string[]) {
  const normalizedText = text.trim().toLocaleLowerCase();
  if (!normalizedText) {
    return false;
  }

  if (quickReplies.some((reply) => reply.trim().toLocaleLowerCase() === normalizedText)) {
    return true;
  }

  return new Set([
    'ok',
    'okay',
    'yes',
    'y',
    'approve',
    'approved',
    'continue',
    'execute',
    'go',
    'proceed',
    '同意',
    '通过',
    '批准',
    '确认',
    '继续',
    '继续执行',
    '执行',
    '开始执行',
  ]).has(normalizedText);
}

function isSyntheticPlanExitSummary(summary: string) {
  return /^Claude is ready to run\b/.test(summary.trim());
}

function isDetailedPlanExitPrompt(prompt?: InteractiveToolPrompt | null) {
  if (!isPlanExitPrompt(prompt)) {
    return false;
  }

  const summary = prompt.plan_summary?.trim() ?? '';
  return Boolean(summary) && !isSyntheticPlanExitSummary(summary);
}

function hasPlanExitPrompt(prompts: Map<string, PendingInteractivePrompt>) {
  return Array.from(prompts.values()).some((entry) => isPlanExitPrompt(entry.prompt));
}

function hasDetailedPlanExitPrompt(prompts: Map<string, PendingInteractivePrompt>) {
  return Array.from(prompts.values()).some((entry) => isDetailedPlanExitPrompt(entry.prompt));
}

function deletePlanExitPrompts(prompts: Map<string, PendingInteractivePrompt>) {
  for (const [toolUseId, entry] of prompts) {
    if (isPlanExitPrompt(entry.prompt)) {
      prompts.delete(toolUseId);
    }
  }
}

function addInteractivePrompt(
  prompts: Map<string, PendingInteractivePrompt>,
  prompt: PendingInteractivePrompt,
) {
  if (isPlanExitPrompt(prompt.prompt)) {
    if (isDetailedPlanExitPrompt(prompt.prompt)) {
      deletePlanExitPrompts(prompts);
      prompts.set(prompt.toolUseId, prompt);
      return;
    }

    if (!hasPlanExitPrompt(prompts) && !hasDetailedPlanExitPrompt(prompts)) {
      prompts.set(prompt.toolUseId, prompt);
    }
    return;
  }

  prompts.set(prompt.toolUseId, prompt);
}

export function shouldClearPromptOnToolCompletion(
  prompt: PendingInteractivePrompt | undefined,
  success: boolean,
) {
  return !(isPlanExitPrompt(prompt?.prompt) && !success);
}

export function extractAttentionState(events: SessionEventRecord[]): NativeSessionAttentionState {
  const permissions = new Map<string, PendingPermissionRequest>();
  const prompts = new Map<string, PendingInteractivePrompt>();
  let terminalPrompt: PendingTerminalPrompt | null = null;

  for (const event of events) {
    switch (event.payload.type) {
      case 'user_prompt':
        for (const [requestId, request] of permissions) {
          if (!request.backgroundTaskId) {
            permissions.delete(requestId);
          }
        }
        prompts.clear();
        break;
      case 'permission_required':
        permissions.set(event.payload.request_id, {
          requestId: event.payload.request_id,
          toolUseId: event.payload.tool_use_id ?? undefined,
          toolName: event.payload.tool_name,
          inputSummary: event.payload.input_summary ?? undefined,
          ...(event.payload.background_task_id
            ? { backgroundTaskId: event.payload.background_task_id }
            : {}),
        });
        break;
      case 'permission_responded':
        permissions.delete(event.payload.request_id);
        break;
      case 'tool_use_started':
        if (event.payload.needs_response && event.payload.prompt) {
          addInteractivePrompt(prompts, {
            toolUseId: event.payload.tool_use_id,
            rawName: event.payload.raw_name,
            prompt: event.payload.prompt,
          });
        }
        break;
      case 'tool_use_completed': {
        const prompt = prompts.get(event.payload.tool_use_id);
        if (shouldClearPromptOnToolCompletion(prompt, event.payload.success)) {
          prompts.delete(event.payload.tool_use_id);
        }
        break;
      }
      case 'terminal_prompt_required':
        terminalPrompt = {
          promptKind: event.payload.prompt_kind,
          promptText: event.payload.prompt_text,
        };
        break;
      case 'terminal_prompt_resolved':
        terminalPrompt = null;
        break;
      case 'session_completed':
        for (const [requestId, request] of permissions) {
          if (!request.backgroundTaskId) {
            permissions.delete(requestId);
          }
        }
        prompts.clear();
        terminalPrompt = null;
        break;
      default:
        break;
    }
  }

  return {
    permissions: Array.from(permissions.values()),
    prompts: Array.from(prompts.values()),
    terminalPrompt,
  };
}
