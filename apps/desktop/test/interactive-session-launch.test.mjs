import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importInteractiveSessionLaunch() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'lib',
    'interactiveSessionLaunch.ts',
  );
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ccem-interactive-session-launch-test-'),
  );
  const outputPath = path.join(tempDir, 'interactiveSessionLaunch.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function embeddedSession(id = 'session-created-once') {
  return {
    id,
    client: 'claude',
    envName: 'DeepSeek',
    workingDir: '/tmp/project',
    startedAt: new Date('2026-07-26T00:00:00.000Z'),
    status: 'running',
    permMode: 'dev',
    terminalType: 'embedded',
    tmuxTarget: `ccem-${id}`,
  };
}

test('terminal-open failure is an explicit partial success and retries the created session', async () => {
  const {
    launchInteractiveSession,
    openTerminalForCreatedInteractiveSession,
    isInteractiveSessionTerminalOpenError,
  } = await importInteractiveSessionLaunch();
  const session = embeddedSession();
  const traces = [];
  const openedSessionIds = [];
  let createCount = 0;
  let createdCallbackCount = 0;
  let syncCount = 0;
  let partialError;

  try {
    await launchInteractiveSession({
      traceId: 'trace-partial',
      createStartDetails: {
        trace_id: 'trace-partial',
        client: 'claude',
      },
      createSession: async () => {
        createCount += 1;
        return session;
      },
      describeCreatedSession: (created) => ({ session_id: created.id }),
      onCreateError: () => {
        assert.fail('terminal-open failure must not enter the create-error path');
      },
      onSessionCreated: () => {
        createdCallbackCount += 1;
      },
      openTerminal: async (sessionId) => {
        openedSessionIds.push(sessionId);
        throw new Error('Terminal is unavailable');
      },
      syncSessions: async () => {
        syncCount += 1;
      },
      recordTrace: async (event, details) => {
        traces.push({ event, details });
      },
    });
    assert.fail('partial success must not resolve as a complete launch');
  } catch (error) {
    partialError = error;
  }

  assert.equal(isInteractiveSessionTerminalOpenError(partialError), true);
  assert.equal(partialError.sessionId, session.id);
  assert.equal(partialError.session, session);
  assert.match(partialError.message, /Session .* was created/);
  assert.equal(createCount, 1);
  assert.equal(createdCallbackCount, 1);
  assert.equal(syncCount, 1);
  assert.deepEqual(openedSessionIds, [session.id]);
  assert.deepEqual(
    traces.map(({ event }) => event),
    [
      'create_interactive_session.invoke_start',
      'create_interactive_session.invoke_ok',
      'open_terminal.start',
      'open_terminal.error',
    ],
  );
  assert.equal(
    traces.some(({ event }) => event === 'create_interactive_session.invoke_error'),
    false,
  );

  await openTerminalForCreatedInteractiveSession({
    session: partialError.session,
    traceId: 'trace-retry',
    openTerminal: async (sessionId) => {
      openedSessionIds.push(sessionId);
    },
    syncSessions: async () => {
      syncCount += 1;
    },
    recordTrace: async (event, details) => {
      traces.push({ event, details });
    },
  });

  assert.equal(createCount, 1, 'retry must not create another session');
  assert.deepEqual(openedSessionIds, [session.id, session.id]);
  assert.equal(syncCount, 2);
});

test('a session-list sync failure does not relabel an opened terminal as failed', async () => {
  const { openTerminalForCreatedInteractiveSession } =
    await importInteractiveSessionLaunch();
  const session = embeddedSession('session-opened-before-sync-error');
  const traces = [];
  const syncErrors = [];

  const result = await openTerminalForCreatedInteractiveSession({
    session,
    traceId: 'trace-sync-error',
    openTerminal: async () => {},
    syncSessions: async () => {
      throw new Error('list refresh failed');
    },
    recordTrace: async (event) => {
      traces.push(event);
    },
    onSessionSyncError: (error) => {
      syncErrors.push(error);
    },
  });

  assert.equal(result, session);
  assert.deepEqual(traces, ['open_terminal.start', 'open_terminal.ok']);
  assert.equal(syncErrors.length, 1);
});

test('create failure is the only path that records create invoke error', async () => {
  const { launchInteractiveSession } = await importInteractiveSessionLaunch();
  const traces = [];
  const createError = new Error('create invoke failed');
  let openCount = 0;
  let createdCallbackCount = 0;
  let observedCreateError;

  await assert.rejects(
    launchInteractiveSession({
      traceId: 'trace-create-error',
      createStartDetails: {
        trace_id: 'trace-create-error',
        client: 'codex',
      },
      createSession: async () => {
        throw createError;
      },
      describeCreatedSession: () => ({}),
      onCreateError: (error) => {
        observedCreateError = error;
      },
      onSessionCreated: () => {
        createdCallbackCount += 1;
      },
      openTerminal: async () => {
        openCount += 1;
      },
      syncSessions: async () => {},
      recordTrace: async (event) => {
        traces.push(event);
      },
    }),
    createError,
  );

  assert.equal(observedCreateError, createError);
  assert.equal(createdCallbackCount, 0);
  assert.equal(openCount, 0);
  assert.deepEqual(traces, [
    'create_interactive_session.invoke_start',
    'create_interactive_session.invoke_error',
  ]);
});

test('multi-launch separates opened, partial, and create-failed sessions', async () => {
  const {
    InteractiveSessionTerminalOpenError,
    launchMultipleInteractiveSessions,
    retryInteractiveSessionTerminals,
  } = await importInteractiveSessionLaunch();
  const launchedDirs = [];
  const arranged = [];
  let waitCount = 0;
  const partialSession = embeddedSession('multi-partial-session');

  const result = await launchMultipleInteractiveSessions({
    workingDirs: ['/ok-1', '/partial', '/create-failed', '/ok-2'],
    layout: 'horizontal2',
    launchSession: async (workingDir) => {
      launchedDirs.push(workingDir);
      if (workingDir === '/partial') {
        throw new InteractiveSessionTerminalOpenError(
          partialSession,
          new Error('Terminal unavailable'),
        );
      }
      if (workingDir === '/create-failed') {
        throw new Error('create failed');
      }
    },
    listArrangeableSessionIds: () => ['opened-1', 'opened-2'],
    arrangeSessions: async (sessionIds, layout) => {
      arranged.push({ sessionIds, layout });
    },
    waitForTerminals: async () => {
      waitCount += 1;
    },
  });

  assert.deepEqual(
    launchedDirs,
    ['/ok-1', '/partial', '/create-failed', '/ok-2'],
  );
  assert.equal(result.requestedCount, 4);
  assert.equal(result.createdCount, 3);
  assert.equal(result.openedCount, 2);
  assert.equal(result.arranged, true);
  assert.equal(result.terminalOpenFailures.length, 1);
  assert.equal(result.terminalOpenFailures[0].sessionId, partialSession.id);
  assert.deepEqual(
    result.launchFailures.map(({ workingDir }) => workingDir),
    ['/create-failed'],
  );
  assert.equal(waitCount, 1);
  assert.deepEqual(arranged, [{
    sessionIds: ['opened-1', 'opened-2'],
    layout: 'horizontal2',
  }]);

  const retry = await retryInteractiveSessionTerminals(
    [partialSession.id, 'another-created-session'],
    async (sessionId) => {
      if (sessionId === 'another-created-session') {
        throw new Error('still unavailable');
      }
    },
  );
  assert.deepEqual(retry, {
    requestedCount: 2,
    openedCount: 1,
    failedSessionIds: ['another-created-session'],
  });
});
