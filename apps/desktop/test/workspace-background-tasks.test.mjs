import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importModel() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'components',
    'workspace',
    'workspaceBackgroundTasks.ts',
  );
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-background-tasks-test-'));
  const outputPath = path.join(tempDir, 'workspaceBackgroundTasks.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function task(id, status, updated = 1) {
  return {
    task_id: id,
    tool_use_id: `tool-${id}`,
    task_type: 'bash',
    description: `Task ${id}`,
    status,
    started_at: '2026-08-17T00:00:00.000Z',
    updated_at: `2026-08-17T00:00:${String(updated).padStart(2, '0')}.000Z`,
  };
}

function event(seq, payload) {
  return {
    runtime_id: 'runtime-1',
    seq,
    occurred_at: `2026-08-17T00:00:${String(seq).padStart(2, '0')}.000Z`,
    payload,
  };
}

test('uses live summary as the active baseline and applies only newer events', async () => {
  const { deriveWorkspaceBackgroundTasks } = await importModel();
  const result = deriveWorkspaceBackgroundTasks(
    { background_tasks: [task('live', 'running', 5)], last_event_seq: 5 },
    [
      event(4, { type: 'background_tasks_changed', tasks: [task('stale', 'running', 4)] }),
      event(6, { type: 'background_task_updated', task: task('new', 'running', 6) }),
    ],
  );

  assert.deepEqual(result.active.map((entry) => entry.task_id), ['live'], 'bookend updates cannot add membership to an authoritative live set');
});

test('terminal history is monotonic independently of full live membership', async () => {
  const { deriveWorkspaceBackgroundTasks } = await importModel();
  const completed = task('one', 'completed', 4);
  const result = deriveWorkspaceBackgroundTasks(
    { background_tasks: undefined, last_event_seq: null },
    [
      event(1, { type: 'background_tasks_changed', tasks: [task('one', 'running', 1)] }),
      event(2, { type: 'background_task_updated', task: completed }),
      event(3, { type: 'background_task_updated', task: task('one', 'running', 3) }),
      event(4, { type: 'background_tasks_changed', tasks: [task('one', 'running', 4)] }),
      event(5, { type: 'background_task_updated', task: task('one', 'failed', 5) }),
    ],
  );

  assert.deepEqual(result.active, [task('one', 'running', 4)], 'a newer full snapshot remains authoritative even after terminal history');
  assert.deepEqual(result.recent, [completed]);
});

test('late terminal correlation enriches metadata without changing the first outcome', async () => {
  const { deriveWorkspaceBackgroundTasks } = await importModel();
  const completed = {
    ...task('correlated', 'completed', 2),
    tool_use_id: undefined,
    task_type: undefined,
    description: 'correlated',
    terminal_summary: 'first completion',
  };
  const late = {
    ...task('correlated', 'failed', 3),
    tool_use_id: 'tool-correlated-late',
    task_type: 'agent',
    description: 'Late correlated agent',
    terminal_summary: 'late failure',
    error: 'late error',
  };

  const result = deriveWorkspaceBackgroundTasks(
    { background_tasks: undefined, last_event_seq: null },
    [
      event(2, { type: 'background_task_updated', task: completed }),
      event(3, { type: 'background_task_updated', task: late }),
    ],
  );

  assert.equal(result.recent[0].status, 'completed');
  assert.equal(result.recent[0].terminal_summary, 'first completion');
  assert.equal(result.recent[0].error, undefined);
  assert.equal(result.recent[0].tool_use_id, 'tool-correlated-late');
  assert.equal(result.recent[0].task_type, 'agent');
  assert.equal(result.recent[0].description, 'Late correlated agent');
});

test('record-only summary never revives historical nonterminal tasks', async () => {
  const { deriveWorkspaceBackgroundTasks } = await importModel();
  const completed = task('done', 'completed', 4);
  const result = deriveWorkspaceBackgroundTasks(
    { background_tasks: [], last_event_seq: null },
    [
      event(1, { type: 'background_tasks_changed', tasks: [task('orphan', 'running', 1)] }),
      event(2, { type: 'background_task_updated', task: task('orphan', 'running', 2) }),
      event(4, { type: 'background_task_updated', task: completed }),
    ],
  );

  assert.deepEqual(result.active, []);
  assert.deepEqual(result.recent, [completed]);
});

test('caps recent terminal tasks at twenty newest entries', async () => {
  const { deriveWorkspaceBackgroundTasks, MAX_RECENT_BACKGROUND_TASKS } = await importModel();
  const events = Array.from({ length: 24 }, (_, index) => event(index + 1, {
    type: 'background_task_updated',
    task: task(String(index + 1), 'completed', index + 1),
  }));

  const result = deriveWorkspaceBackgroundTasks(
    { background_tasks: [], last_event_seq: 24 },
    events,
  );

  assert.equal(result.recent.length, MAX_RECENT_BACKGROUND_TASKS);
  assert.equal(result.recent[0].task_id, '24');
  assert.equal(result.recent.at(-1).task_id, '5');
});

test('settling tasks remain active but cannot be stopped', async () => {
  const { canStopBackgroundTask, deriveWorkspaceBackgroundTasks } = await importModel();
  const settling = task('settling', 'settling', 3);
  const result = deriveWorkspaceBackgroundTasks(
    { background_tasks: [settling], last_event_seq: 3 },
    [],
  );

  assert.deepEqual(result.active, [settling]);
  assert.equal(canStopBackgroundTask(settling), false);
  assert.equal(canStopBackgroundTask(task('running', 'running')), true);
});

test('terminal duration stops at updated_at when SDK usage is unavailable', async () => {
  const { backgroundTaskDurationMs } = await importModel();
  const completed = task('done', 'completed', 5);
  const running = task('live', 'running', 5);

  assert.equal(
    backgroundTaskDurationMs(completed, Date.parse('2026-08-17T00:01:00.000Z')),
    5_000,
  );
  assert.equal(
    backgroundTaskDurationMs(running, Date.parse('2026-08-17T00:01:00.000Z')),
    60_000,
  );
});

test('terminal-before-empty retains live settling and empty full snapshot releases it', async () => {
  const { deriveWorkspaceBackgroundTasks } = await importModel();
  const running = task('A', 'running', 1);
  const settling = { ...running, status: 'settling', stop_request_id: undefined, stop_failed: undefined };
  const completed = task('A', 'completed', 2);
  const summary = { background_tasks: [running], last_event_seq: 1 };
  const terminal = event(2, { type: 'background_task_updated', task: completed });
  assert.deepEqual(deriveWorkspaceBackgroundTasks(summary, [terminal]), { active: [settling], recent: [completed] });
  const empty = event(3, { type: 'background_tasks_changed', tasks: [] });
  const late = event(4, { type: 'background_task_updated', task: task('A', 'running', 4) });
  assert.deepEqual(deriveWorkspaceBackgroundTasks(summary, [terminal, empty, late]), { active: [], recent: [completed] });
});
