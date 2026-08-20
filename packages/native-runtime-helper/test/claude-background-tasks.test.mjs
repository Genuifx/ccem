import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importBackgroundTasksModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-background-tasks-test-'));
  const outfile = path.join(tempDir, 'claudeBackgroundTasks.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'claudeBackgroundTasks.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

function createClock() {
  let tick = 0;
  return () => `2026-08-17T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

test('tracks background membership separately from foreground task edges', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const tracker = new ClaudeBackgroundTaskTracker(createClock());

  assert.equal(tracker.applyStarted({
    task_id: 'foreground-task',
    tool_use_id: 'tool-foreground',
    description: 'Foreground agent',
    task_type: 'agent',
  }), null);
  assert.deepEqual(tracker.activeTasks(), []);

  const change = tracker.applySnapshot([{
    task_id: 'foreground-task',
    task_type: 'agent',
    description: 'Now backgrounded',
  }]);

  assert.equal(change.changed.length, 1);
  assert.equal(change.changed[0].status, 'running');
  assert.equal(change.tasks[0].description, 'Now backgrounded');
  assert.equal(tracker.hasUnsettledTasks(), true);
});

test('requires task_notification for terminal state and never regresses it', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const tracker = new ClaudeBackgroundTaskTracker(createClock());

  tracker.markToolBackgroundCandidate('tool-1');
  const started = tracker.applyStarted({
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    description: 'Inspect repository',
    task_type: 'agent',
    subagent_type: 'Explore',
  });
  assert.equal(started.status, 'running');

  const provisional = tracker.applyUpdated({
    task_id: 'task-1',
    patch: { status: 'completed' },
  });
  assert.equal(provisional.status, 'settling');

  const removed = tracker.applySnapshot([]);
  assert.equal(removed.tasks[0].status, 'settling');
  assert.equal(tracker.hasUnsettledTasks(), true);

  const terminal = tracker.applyNotification({
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    status: 'completed',
    output_file: '/tmp/task-1.output',
    summary: 'Repository inspected',
    usage: { total_tokens: 123, tool_uses: 4, duration_ms: 900 },
  });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.terminal_summary, 'Repository inspected');
  assert.equal(tracker.hasUnsettledTasks(), false);

  const staleSnapshot = tracker.applySnapshot([{
    task_id: 'task-1',
    task_type: 'agent',
    description: 'Stale running snapshot',
  }]);
  assert.deepEqual(staleSnapshot.tasks, []);
  assert.equal(tracker.getTask('task-1').status, 'completed');

  const duplicateTerminal = tracker.applyNotification({
    task_id: 'task-1',
    tool_use_id: 'tool-1',
    status: 'failed',
    output_file: '/tmp/task-1-late.output',
    summary: 'Late failure must not replace completion',
  });
  assert.equal(duplicateTerminal.status, 'completed');
  assert.equal(duplicateTerminal.terminal_summary, 'Repository inspected');
});

test('keeps stop provisional until notification and restores failures', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const tracker = new ClaudeBackgroundTaskTracker(createClock());

  tracker.applySnapshot([{
    task_id: 'bash-1',
    task_type: 'bash',
    description: 'Run server',
  }]);
  assert.equal(tracker.markStopping('bash-1', 'stop-1').status, 'stopping');
  assert.equal(tracker.hasUnsettledTasks(), true);

  const restored = tracker.restoreStopFailure('bash-1', 'stop-1', 'Task could not be stopped');
  assert.equal(restored.status, 'running');
  assert.equal(restored.error, 'Task could not be stopped');

  tracker.markStopping('bash-1', 'stop-2');
  const terminal = tracker.applyNotification({
    task_id: 'bash-1',
    status: 'stopped',
    output_file: '/tmp/bash-1.output',
    summary: 'Stopped by user',
  });
  assert.equal(terminal.status, 'stopped');
  assert.equal(terminal.error, undefined);
  assert.equal(terminal.stop_request_id, undefined);
  assert.equal(terminal.stop_failed, undefined);
  assert.equal(tracker.hasUnsettledTasks(), false);
  assert.equal(tracker.markStopping('missing-task', 'stop-3'), null);
});

test('recognizes structured and input-declared background launches', async () => {
  const { isBackgroundLaunchResult } = await importBackgroundTasksModule();

  assert.equal(isBackgroundLaunchResult(
    'Agent',
    { run_in_background: true },
    { status: 'async_launched', agentId: 'agent-1' },
    true,
  ), true);
  assert.equal(isBackgroundLaunchResult(
    'Bash',
    {},
    { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bash-1' },
    true,
  ), true);
  assert.equal(isBackgroundLaunchResult(
    'Bash',
    { run_in_background: true },
    null,
    false,
  ), false);
  assert.equal(isBackgroundLaunchResult('Read', {}, { status: 'completed' }, true), false);
});

test('structured launch receipts bind Bash, Agent, and workflow ids to tool uses', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const tracker = new ClaudeBackgroundTaskTracker(createClock());
  const cases = [
    ['tool-bash', 'Bash', { command: 'sleep 30', run_in_background: true }, { backgroundTaskId: 'bash-1' }, 'bash-1'],
    ['tool-agent', 'Agent', { description: 'Review code', subagent_type: 'reviewer', run_in_background: true }, { status: 'async_launched', agentId: 'agent-1', description: 'Review code', rawOutputPath: '/tmp/agent-1.output' }, 'agent-1'],
    ['tool-workflow', 'Workflow', { description: 'Run spec', run_in_background: true }, { status: 'async_launched', taskId: 'workflow-1', taskType: 'local_workflow', workflowName: 'spec' }, 'workflow-1'],
  ];

  for (const [toolUseId, rawName, input, result, taskId] of cases) {
    const task = tracker.applyLaunchReceipt(toolUseId, rawName, input, result);
    assert.equal(task.task_id, taskId);
    assert.equal(task.tool_use_id, toolUseId);
    assert.equal(tracker.taskIdForToolUse(toolUseId), taskId);
    assert.equal(tracker.toolUseIdForTask(taskId), toolUseId);
    assert.equal(tracker.isBackgroundToolUse(toolUseId), true);
    if (taskId === 'agent-1') {
      assert.equal(task.output_file, '/tmp/agent-1.output');
    }
  }
});

test('background workflow child tools and agents inherit the top-level task owner', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const tracker = new ClaudeBackgroundTaskTracker(createClock());
  tracker.applyLaunchReceipt(
    'tool-workflow',
    'Workflow',
    { description: 'Run spec', run_in_background: true },
    { status: 'async_launched', taskId: 'workflow-1', taskType: 'local_workflow' },
  );

  assert.equal(
    tracker.associateChildToolWithParent('tool-workflow-child', 'tool-workflow'),
    'workflow-1',
  );
  tracker.associateOwnerWithTask('workflow-agent-7', 'workflow-1');

  assert.equal(tracker.backgroundTaskIdForOwner('tool-workflow-child'), 'workflow-1');
  assert.equal(tracker.backgroundTaskIdForOwner('workflow-agent-7'), 'workflow-1');
  assert.equal(tracker.isBackgroundToolUse('tool-workflow-child'), true);
});

test('late launch and progress signals do not regress a settling task', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const tracker = new ClaudeBackgroundTaskTracker(createClock());
  tracker.applySnapshot([
    { task_id: 'task-settling', task_type: 'bash', description: 'Sleep' },
  ]);
  tracker.applySnapshot([]);
  assert.equal(tracker.getTask('task-settling').status, 'settling');

  tracker.applyStarted({
    task_id: 'task-settling',
    tool_use_id: 'tool-settling',
    description: 'Sleep',
  });
  tracker.applyProgress({
    task_id: 'task-settling',
    tool_use_id: 'tool-settling',
    description: 'Sleep',
    usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
  });
  tracker.applyUpdated({
    task_id: 'task-settling',
    patch: { status: 'running', is_backgrounded: true },
  });
  tracker.applySnapshot([
    { task_id: 'task-settling', task_type: 'bash', description: 'Sleep' },
  ]);
  tracker.applyLaunchReceipt(
    'tool-settling',
    'Bash',
    { run_in_background: true, command: 'sleep 30' },
    { backgroundTaskId: 'task-settling' },
  );

  assert.equal(tracker.getTask('task-settling').status, 'settling');
});

test('empty replace snapshots settle launch-receipt tasks not seen in an earlier snapshot', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const tracker = new ClaudeBackgroundTaskTracker(createClock());
  tracker.applyLaunchReceipt(
    'tool-receipt',
    'Bash',
    { command: 'sleep 30', run_in_background: true },
    { backgroundTaskId: 'task-receipt' },
  );

  const change = tracker.applySnapshot([]);
  assert.equal(change.tasks[0].task_id, 'task-receipt');
  assert.equal(change.tasks[0].status, 'settling');
});

test('late correlation enriches the first terminal state without changing its outcome', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const tracker = new ClaudeBackgroundTaskTracker(createClock());
  const pendingNotification = tracker.applyNotification({
    task_id: 'task-notification-first',
    status: 'completed',
    output_file: '/tmp/task-notification-first.output',
    summary: 'Finished before correlation arrived',
  });
  assert.equal(pendingNotification, null, 'notification alone is not background membership evidence');

  const linked = tracker.applyLaunchReceipt(
    'tool-notification-first',
    'Agent',
    { run_in_background: true, description: 'Fast agent' },
    { status: 'async_launched', agentId: 'task-notification-first' },
  );
  assert.equal(linked.status, 'completed');
  assert.equal(linked.tool_use_id, 'tool-notification-first');
  assert.equal(linked.terminal_summary, 'Finished before correlation arrived');
});

test('buffers notification-first terminal edges until a snapshot or is_backgrounded proves membership', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const notification = {
    status: 'completed',
    output_file: '/tmp/notification-first.output',
    summary: 'Finished before membership evidence',
  };

  const snapshotTracker = new ClaudeBackgroundTaskTracker(createClock());
  assert.equal(snapshotTracker.applyNotification({ task_id: 'task-snapshot', ...notification }), null);
  const snapshotChange = snapshotTracker.applySnapshot([
    { task_id: 'task-snapshot', task_type: 'bash', description: 'Snapshot task' },
  ]);
  assert.equal(snapshotChange.changed.length, 1);
  assert.equal(snapshotChange.changed[0].status, 'completed');
  assert.equal(snapshotChange.changed[0].terminal_summary, 'Finished before membership evidence');

  const updatedTracker = new ClaudeBackgroundTaskTracker(createClock());
  assert.equal(updatedTracker.applyNotification({ task_id: 'task-updated', ...notification }), null);
  const promoted = updatedTracker.applyUpdated({
    task_id: 'task-updated',
    patch: { is_backgrounded: true },
  });
  assert.equal(promoted.status, 'completed');
  assert.equal(promoted.terminal_summary, 'Finished before membership evidence');
});

test('does not classify a foreground task notification as background work', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const tracker = new ClaudeBackgroundTaskTracker(createClock());
  tracker.applyStarted({
    task_id: 'task-foreground',
    tool_use_id: 'tool-foreground',
    description: 'Foreground Bash',
  });

  const task = tracker.applyNotification({
    task_id: 'task-foreground',
    tool_use_id: 'tool-foreground',
    status: 'completed',
    output_file: '/tmp/task-foreground.output',
    summary: 'Foreground Bash finished',
  });

  assert.equal(task, null);
  assert.deepEqual(tracker.activeTasks(), []);
  assert.equal(tracker.isBackgroundToolUse('tool-foreground'), false);
});

test('duplicate or invalid stop failures never revive stopping or settling tasks', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const tracker = new ClaudeBackgroundTaskTracker(createClock());
  tracker.applySnapshot([{ task_id: 'task-stop-race', task_type: 'bash', description: 'Sleep' }]);
  tracker.markStopping('task-stop-race', 'stop-race-1');
  assert.equal(tracker.markStopping('task-stop-race', 'stop-race-2'), null);
  assert.equal(
    tracker.restoreStopFailure('task-stop-race', 'stop-race-2', 'duplicate stop').status,
    'stopping',
  );
  tracker.applySnapshot([]);
  assert.equal(tracker.getTask('task-stop-race').status, 'settling');
  assert.equal(
    tracker.restoreStopFailure('task-stop-race', 'stop-race-1', 'late failure').status,
    'settling',
  );
});

test('snapshot identity includes structural task metadata but excludes throttled progress', async () => {
  const { backgroundTaskSnapshotKey } = await importBackgroundTasksModule();
  const base = {
    task_id: 'task-key',
    tool_use_id: 'tool-key',
    task_type: 'agent',
    description: 'Inspect repository',
    status: 'running',
    started_at: '2026-08-17T00:00:00.000Z',
    updated_at: '2026-08-17T00:00:01.000Z',
    progress_summary: 'one',
    usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
  };

  assert.notEqual(
    backgroundTaskSnapshotKey([base]),
    backgroundTaskSnapshotKey([{ ...base, description: 'Inspect tests' }]),
  );
  assert.equal(
    backgroundTaskSnapshotKey([base]),
    backgroundTaskSnapshotKey([{
      ...base,
      updated_at: '2026-08-17T00:00:02.000Z',
      progress_summary: 'two',
      usage: { total_tokens: 2, tool_uses: 2, duration_ms: 2 },
    }]),
  );
});

test('marks unresolved tasks interrupted when their query process is replaced', async () => {
  const { ClaudeBackgroundTaskTracker } = await importBackgroundTasksModule();
  const tracker = new ClaudeBackgroundTaskTracker(createClock());

  tracker.applySnapshot([
    { task_id: 'task-a', task_type: 'agent', description: 'Agent A' },
    { task_id: 'task-b', task_type: 'bash', description: 'Bash B' },
  ]);

  const interrupted = tracker.interruptAll('Claude query restarted');
  assert.deepEqual(interrupted.map((task) => task.status), ['interrupted', 'interrupted']);
  assert.equal(interrupted.every((task) => task.error === 'Claude query restarted'), true);
  assert.deepEqual(tracker.activeTasks(), []);
});
