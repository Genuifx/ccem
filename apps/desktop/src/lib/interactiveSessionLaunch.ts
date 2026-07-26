import type { Session } from '@/store';

export const INTERACTIVE_SESSION_TERMINAL_OPEN_FAILED =
  'interactive_session_terminal_open_failed';

export type SessionLaunchTraceRecorder = (
  event: string,
  details: Record<string, unknown>,
) => Promise<void>;

export class InteractiveSessionTerminalOpenError extends Error {
  readonly code = INTERACTIVE_SESSION_TERMINAL_OPEN_FAILED;
  readonly sessionId: string;

  constructor(
    readonly session: Session,
    readonly terminalError: unknown,
  ) {
    super(
      `Session ${session.id} was created, but Terminal could not be opened: `
      + formatInteractiveSessionLaunchError(terminalError),
    );
    this.name = 'InteractiveSessionTerminalOpenError';
    this.sessionId = session.id;
  }
}

export function isInteractiveSessionTerminalOpenError(
  error: unknown,
): error is InteractiveSessionTerminalOpenError {
  return error instanceof InteractiveSessionTerminalOpenError;
}

export function formatInteractiveSessionLaunchError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

interface OpenCreatedInteractiveSessionOptions {
  session: Session;
  traceId: string;
  openTerminal: (sessionId: string) => Promise<void>;
  syncSessions: () => Promise<unknown>;
  recordTrace: SessionLaunchTraceRecorder;
  onTerminalOpenError?: (error: unknown) => void;
  onSessionSyncError?: (error: unknown) => void;
}

async function syncSessionsBestEffort({
  syncSessions,
  onSessionSyncError,
}: Pick<
  OpenCreatedInteractiveSessionOptions,
  'syncSessions' | 'onSessionSyncError'
>): Promise<void> {
  try {
    await syncSessions();
  } catch (error) {
    onSessionSyncError?.(error);
  }
}

export async function openTerminalForCreatedInteractiveSession({
  session,
  traceId,
  openTerminal,
  syncSessions,
  recordTrace,
  onTerminalOpenError,
  onSessionSyncError,
}: OpenCreatedInteractiveSessionOptions): Promise<Session> {
  if (session.terminalType !== 'embedded') {
    return session;
  }

  await recordTrace('open_terminal.start', {
    trace_id: traceId,
    session_id: session.id,
  });

  try {
    await openTerminal(session.id);
  } catch (error) {
    await recordTrace('open_terminal.error', {
      trace_id: traceId,
      session_id: session.id,
      error: String(error),
    });
    onTerminalOpenError?.(error);
    await syncSessionsBestEffort({ syncSessions, onSessionSyncError });
    throw new InteractiveSessionTerminalOpenError(session, error);
  }

  await recordTrace('open_terminal.ok', {
    trace_id: traceId,
    session_id: session.id,
  });
  await syncSessionsBestEffort({ syncSessions, onSessionSyncError });
  return session;
}

interface LaunchInteractiveSessionOptions
  extends Omit<OpenCreatedInteractiveSessionOptions, 'session'> {
  createStartDetails: Record<string, unknown>;
  createSession: () => Promise<Session>;
  describeCreatedSession: (session: Session) => Record<string, unknown>;
  onCreateError: (error: unknown) => void | Promise<void>;
  onSessionCreated: (session: Session) => void | Promise<void>;
}

export async function launchInteractiveSession({
  traceId,
  createStartDetails,
  createSession,
  describeCreatedSession,
  onCreateError,
  onSessionCreated,
  openTerminal,
  syncSessions,
  recordTrace,
  onTerminalOpenError,
  onSessionSyncError,
}: LaunchInteractiveSessionOptions): Promise<Session> {
  await recordTrace('create_interactive_session.invoke_start', createStartDetails);

  let session: Session;
  try {
    session = await createSession();
  } catch (error) {
    await recordTrace('create_interactive_session.invoke_error', {
      trace_id: traceId,
      client: createStartDetails.client,
      error: String(error),
    });
    await onCreateError(error);
    throw error;
  }

  await recordTrace('create_interactive_session.invoke_ok', {
    trace_id: traceId,
    ...describeCreatedSession(session),
  });
  await onSessionCreated(session);

  return openTerminalForCreatedInteractiveSession({
    session,
    traceId,
    openTerminal,
    syncSessions,
    recordTrace,
    onTerminalOpenError,
    onSessionSyncError,
  });
}

export interface MultiInteractiveSessionLaunchFailure {
  workingDir: string;
  error: unknown;
}

export interface MultiInteractiveSessionLaunchResult {
  requestedCount: number;
  createdCount: number;
  openedCount: number;
  arranged: boolean;
  arrangementError?: unknown;
  terminalOpenFailures: InteractiveSessionTerminalOpenError[];
  launchFailures: MultiInteractiveSessionLaunchFailure[];
}

interface LaunchMultipleInteractiveSessionsOptions<TLayout> {
  workingDirs: string[];
  layout: TLayout;
  launchSession: (workingDir: string) => Promise<unknown>;
  listArrangeableSessionIds: () => string[];
  arrangeSessions: (sessionIds: string[], layout: TLayout) => Promise<unknown>;
  waitForTerminals?: () => Promise<void>;
}

export async function launchMultipleInteractiveSessions<TLayout>({
  workingDirs,
  layout,
  launchSession,
  listArrangeableSessionIds,
  arrangeSessions,
  waitForTerminals = () => new Promise((resolve) => setTimeout(resolve, 800)),
}: LaunchMultipleInteractiveSessionsOptions<TLayout>): Promise<MultiInteractiveSessionLaunchResult> {
  let openedCount = 0;
  const terminalOpenFailures: InteractiveSessionTerminalOpenError[] = [];
  const launchFailures: MultiInteractiveSessionLaunchFailure[] = [];

  for (const workingDir of workingDirs) {
    try {
      await launchSession(workingDir);
      openedCount += 1;
    } catch (error) {
      if (isInteractiveSessionTerminalOpenError(error)) {
        terminalOpenFailures.push(error);
      } else {
        launchFailures.push({ workingDir, error });
      }
    }
  }

  let arranged = false;
  let arrangementError: unknown;
  if (openedCount >= 2) {
    await waitForTerminals();
    const sessionIds = listArrangeableSessionIds();
    if (sessionIds.length >= 2) {
      try {
        await arrangeSessions(sessionIds, layout);
        arranged = true;
      } catch (error) {
        arrangementError = error;
      }
    }
  }

  return {
    requestedCount: workingDirs.length,
    createdCount: openedCount + terminalOpenFailures.length,
    openedCount,
    arranged,
    arrangementError,
    terminalOpenFailures,
    launchFailures,
  };
}

export interface RetryInteractiveSessionTerminalsResult {
  requestedCount: number;
  openedCount: number;
  failedSessionIds: string[];
}

export async function retryInteractiveSessionTerminals(
  sessionIds: string[],
  openTerminal: (sessionId: string) => Promise<unknown>,
): Promise<RetryInteractiveSessionTerminalsResult> {
  const results = await Promise.allSettled(
    sessionIds.map((sessionId) => openTerminal(sessionId)),
  );
  const failedSessionIds = results.flatMap((result, index) =>
    result.status === 'rejected' ? [sessionIds[index]] : []
  );

  return {
    requestedCount: sessionIds.length,
    openedCount: sessionIds.length - failedSessionIds.length,
    failedSessionIds,
  };
}
