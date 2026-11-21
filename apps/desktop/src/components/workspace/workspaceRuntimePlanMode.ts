import type { WorkspaceDispatchProvider } from '@/components/workspace/workspaceComposerDispatch';

export function resolveWorkspaceRuntimePlanMode(
  provider: WorkspaceDispatchProvider,
  planModeEnabled: boolean,
) {
  if (provider !== 'claude' && provider !== 'agy') {
    return null;
  }
  return planModeEnabled ? 'plan' : null;
}
