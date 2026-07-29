import type { LaunchClient } from '@/store';

type TerminalLaunchClient = Extract<LaunchClient, 'claude' | 'codex'>;

export interface LaunchWorkspaceTerminalSessionOptions {
  prompt: string;
  provider: TerminalLaunchClient;
  currentEnv?: string | null;
  workingDir?: string | null;
  pickWorkingDir: () => Promise<string | null>;
  launchTerminal: (
    workingDir?: string,
    resumeSessionId?: string,
    client?: LaunchClient,
    envName?: string,
    initialPrompt?: string,
  ) => Promise<unknown>;
  onWorkingDirResolved?: (workingDir: string) => void;
  scheduleRefresh?: (delayMs?: number) => void;
}

export interface LaunchWorkspaceTerminalSessionResult {
  launched: boolean;
  workingDir: string | null;
}

function isCreatedSessionTerminalOpenFailure(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'interactive_session_terminal_open_failed';
}

export async function launchWorkspaceTerminalSession({
  prompt,
  provider,
  currentEnv,
  workingDir,
  pickWorkingDir,
  launchTerminal,
  onWorkingDirResolved,
  scheduleRefresh,
}: LaunchWorkspaceTerminalSessionOptions): Promise<LaunchWorkspaceTerminalSessionResult> {
  let targetDir = workingDir?.trim() ? workingDir : null;
  if (!targetDir) {
    targetDir = await pickWorkingDir();
  }
  if (!targetDir) {
    return { launched: false, workingDir: null };
  }

  try {
    await launchTerminal(
      targetDir,
      undefined,
      provider,
      currentEnv || undefined,
      prompt.trim() || undefined,
    );
  } catch (error) {
    if (isCreatedSessionTerminalOpenFailure(error)) {
      onWorkingDirResolved?.(targetDir);
      scheduleRefresh?.(350);
    }
    throw error;
  }

  onWorkingDirResolved?.(targetDir);
  scheduleRefresh?.(350);
  return { launched: true, workingDir: targetDir };
}
