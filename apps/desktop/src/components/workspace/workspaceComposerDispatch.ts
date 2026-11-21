import { normalizeWorkspacePermissionModeName } from '@/components/workspace/workspacePermissionModes';

export type WorkspaceDispatchProvider = 'claude' | 'codex' | 'agy';

export interface WorkspaceComposerDispatchOptions {
  provider: WorkspaceDispatchProvider;
  prompt: string;
  permissionMode: string;
  planModeEnabled: boolean;
}

export interface WorkspaceComposerDispatch {
  prompt: string;
  permMode: string;
  runtimePermMode?: string | null;
}

export function resolveComposerDispatch(
  options: WorkspaceComposerDispatchOptions,
): WorkspaceComposerDispatch {
  const trimmedPrompt = options.prompt.trim();
  const permissionMode = normalizeWorkspacePermissionModeName(options.permissionMode);
  if (!options.planModeEnabled) {
    return {
      prompt: trimmedPrompt,
      permMode: permissionMode,
      runtimePermMode: null,
    };
  }

  if (options.provider === 'claude' || options.provider === 'agy') {
    return {
      prompt: trimmedPrompt,
      permMode: permissionMode,
      runtimePermMode: 'plan',
    };
  }

  return {
    prompt: trimmedPrompt.startsWith('/plan')
      ? trimmedPrompt
      : (trimmedPrompt ? `/plan ${trimmedPrompt}` : '/plan'),
    permMode: permissionMode,
    runtimePermMode: null,
  };
}
