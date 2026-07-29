export type SessionLaunchClient = 'claude' | 'codex' | 'opencode';

export interface LaunchSingleSessionInput {
  selectedWorkingDir?: string | null;
  client?: SessionLaunchClient;
  onLaunch: (client?: SessionLaunchClient) => Promise<void>;
  onLaunchWithDir: (dir: string, client?: SessionLaunchClient) => Promise<void>;
}

export interface LaunchSingleSessionResult {
  launched: true;
  workingDir?: string | null;
}

const SESSION_COMMAND_EXITED_PREFIX = 'session_command_exited:';

export class LaunchAlreadyInProgressError extends Error {
  constructor(readonly key: string) {
    super('Session launch is already in progress for this target.');
    this.name = 'LaunchAlreadyInProgressError';
  }
}

export async function runExclusiveLaunch(
  inFlight: Set<string>,
  key: string,
  launch: () => Promise<void>,
): Promise<void> {
  if (inFlight.has(key)) {
    throw new LaunchAlreadyInProgressError(key);
  }

  inFlight.add(key);
  try {
    await launch();
  } finally {
    inFlight.delete(key);
  }
}

export function isLaunchAlreadyInProgressError(error: unknown): boolean {
  return error instanceof LaunchAlreadyInProgressError
    || (
      error instanceof Error
      && error.name === 'LaunchAlreadyInProgressError'
    );
}

export function formatSessionLaunchError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

export function getSessionCommandExitDetails(error: unknown): string | null {
  const message = formatSessionLaunchError(error);
  if (!message.startsWith(SESSION_COMMAND_EXITED_PREFIX)) {
    return null;
  }

  const details = message
    .slice(SESSION_COMMAND_EXITED_PREFIX.length)
    .trim();
  return details || message;
}

export async function launchSingleSession(
  input: LaunchSingleSessionInput,
): Promise<LaunchSingleSessionResult> {
  const client = input.client ?? 'claude';
  if (input.selectedWorkingDir) {
    await input.onLaunchWithDir(input.selectedWorkingDir, client);
    return { launched: true, workingDir: input.selectedWorkingDir };
  }
  await input.onLaunch(client);
  return { launched: true, workingDir: null };
}
