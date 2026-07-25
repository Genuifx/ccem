import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importTodoSnapshotsModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-todo-snapshots-test-'));
  const outfile = path.join(tempDir, 'todoSnapshots.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'todoSnapshots.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function buildHelperWithTodoSdkEvents() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-todo-helper-test-'));
  const outfile = path.join(tempDir, 'native-runtime-helper.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
    plugins: [{
      name: 'mock-todo-sdks',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
          path: 'claude-agent-sdk',
          namespace: 'todo-sdk',
        }));
        pluginBuild.onLoad({ filter: /^claude-agent-sdk$/, namespace: 'todo-sdk' }, () => ({
          loader: 'js',
          contents: `
            export function tool(name, description, inputSchema, handler) {
              return { name, description, inputSchema, handler };
            }

            export function createSdkMcpServer(config) {
              return {
                type: 'sdk',
                name: config.name,
                instance: {
                  _registeredTools: Object.fromEntries(
                    (config.tools || []).map((definition) => [definition.name, definition]),
                  ),
                },
              };
            }

            export function query({ prompt }) {
              return {
                close() {},
                async *[Symbol.asyncIterator]() {
                  const iterator = prompt[Symbol.asyncIterator]();
                  const next = await iterator.next();
                  if (next.done) return;
                  if (process.env.CCEM_TODO_TEST_SCENARIO === 'resumed-no-seed') {
                    yield {
                      type: 'assistant',
                      message: {
                        id: 'assistant-unknown-baseline-update',
                        content: [{
                          type: 'tool_use',
                          id: 'task-update-unknown-baseline',
                          name: 'TaskUpdate',
                          input: { taskId: 'legacy-task', status: 'completed' },
                        }],
                      },
                    };
                    yield {
                      type: 'user',
                      tool_use_result: {
                        success: true,
                        taskId: 'legacy-task',
                        updatedFields: ['status'],
                      },
                      message: {
                        role: 'user',
                        content: [{
                          type: 'tool_result',
                          tool_use_id: 'task-update-unknown-baseline',
                          content: 'updated',
                        }],
                      },
                    };
                    yield { type: 'result', subtype: 'success', result: 'done', session_id: 'claude-session' };
                    await new Promise(() => {});
                    return;
                  }
                  if (process.env.CCEM_TODO_TEST_SCENARIO === 'reconnect-failed-write') {
                    yield {
                      type: 'assistant',
                      message: {
                        id: 'assistant-failed-todo-write',
                        content: [{
                          type: 'tool_use',
                          id: 'todo-write-failed',
                          name: 'TodoWrite',
                          input: {
                            todos: [{ content: 'Rejected replacement', status: 'in_progress' }],
                          },
                        }],
                      },
                    };
                    yield {
                      type: 'user',
                      message: {
                        role: 'user',
                        content: [{
                          type: 'tool_result',
                          tool_use_id: 'todo-write-failed',
                          content: 'permission denied',
                          is_error: true,
                        }],
                      },
                    };
                    yield {
                      type: 'assistant',
                      message: {
                        id: 'assistant-seeded-task-update',
                        content: [{
                          type: 'tool_use',
                          id: 'task-update-seeded',
                          name: 'TaskUpdate',
                          input: { taskId: 'task-1', status: 'completed' },
                        }],
                      },
                    };
                    yield {
                      type: 'user',
                      tool_use_result: {
                        success: true,
                        taskId: 'task-1',
                        updatedFields: ['status'],
                      },
                      message: {
                        role: 'user',
                        content: [{
                          type: 'tool_result',
                          tool_use_id: 'task-update-seeded',
                          content: 'updated',
                        }],
                      },
                    };
                    yield { type: 'result', subtype: 'success', result: 'done', session_id: 'claude-session' };
                    await new Promise(() => {});
                    return;
                  }
                  const longText = 'Todo text: ' + 'z'.repeat(180);
                  yield {
                    type: 'assistant',
                    message: {
                      id: 'assistant-todos',
                      content: [{
                        type: 'tool_use',
                        id: 'todo-write-1',
                        name: 'TodoWrite',
                        input: {
                          todos: [{ content: longText, status: 'in_progress', activeForm: 'Tracking todo' }],
                        },
                      }],
                    },
                  };
                  yield {
                    type: 'user',
                    message: {
                      role: 'user',
                      content: [{ type: 'tool_result', tool_use_id: 'todo-write-1', content: 'updated' }],
                    },
                  };
                  yield {
                    type: 'assistant',
                    message: {
                      id: 'assistant-task-create',
                      content: [{
                        type: 'tool_use',
                        id: 'task-create-1',
                        name: 'TaskCreate',
                        input: {
                          subject: 'Create event snapshot',
                          description: 'Attach it to completion.',
                          activeForm: 'Creating event snapshot',
                        },
                      }],
                    },
                  };
                  yield {
                    type: 'user',
                    tool_use_result: { task: { id: 'task-1', subject: 'Create event snapshot' } },
                    message: {
                      role: 'user',
                      content: [{ type: 'tool_result', tool_use_id: 'task-create-1', content: 'created' }],
                    },
                  };
                  yield { type: 'result', subtype: 'success', result: 'done', session_id: 'claude-session' };
                  await new Promise(() => {});
                },
              };
            }
          `,
        }));
        pluginBuild.onResolve({ filter: /^@openai\/codex-sdk$/ }, () => ({
          path: 'codex-sdk',
          namespace: 'todo-sdk',
        }));
        pluginBuild.onLoad({ filter: /^codex-sdk$/, namespace: 'todo-sdk' }, () => ({
          loader: 'js',
          contents: `
            const todoItem = (completedFirst, completedSecond) => ({
              id: 'todo-list-1',
              type: 'todo_list',
              items: [
                { text: 'Inspect SDK events', completed: completedFirst },
                { text: 'Emit snapshots', completed: completedSecond },
              ],
            });

            class MockThread {
              async runStreamed() {
                return {
                  events: (async function* () {
                    yield { type: 'turn.started' };
                    yield { type: 'item.started', item: todoItem(false, false) };
                    yield { type: 'item.updated', item: todoItem(true, false) };
                    yield { type: 'item.completed', item: todoItem(true, true) };
                    yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
                  })(),
                };
              }
            }

            export class Codex {
              startThread() { return new MockThread(); }
              resumeThread() { return new MockThread(); }
            }
          `,
        }));
      },
    }],
  });

  return outfile;
}

function collectHelperOutput(helper) {
  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  return { outputs, stderrRef };
}

function waitForOutput(outputs, predicate, stderrRef, description) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const match = outputs.find(predicate);
      if (match) {
        resolve(match);
        return;
      }
      if (Date.now() - startedAt > 2_000) {
        reject(new Error([
          `Timed out waiting for ${description}.`,
          `stdout=${JSON.stringify(outputs)}`,
          `stderr=${stderrRef.value}`,
        ].join('\n')));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

test('emits an exact TodoWrite snapshot on successful completion without truncating long todo text', async () => {
  const { TodoSnapshotTracker } = await importTodoSnapshotsModule();
  const tracker = new TodoSnapshotTracker();
  const text = `Preserve the whole task: ${'x'.repeat(180)}`;
  const input = {
    todos: [{
      content: text,
      status: 'in_progress',
      activeForm: 'Preserving the whole task',
    }],
  };

  assert.equal(tracker.fromClaudeToolStarted('TodoWrite', input), undefined);
  assert.deepEqual(
    tracker.fromClaudeToolCompleted('TodoWrite', input, { success: true }),
    {
      version: 1,
      provider: 'claude',
      source: 'TodoWrite',
      revision: 1,
      items: [{
        id: 'todo-0',
        text,
        status: 'in_progress',
        active_text: 'Preserving the whole task',
      }],
    },
  );
});

test('seeds a restarted tracker so a TaskUpdate preserves every existing task', async () => {
  const { TodoSnapshotTracker } = await importTodoSnapshotsModule();
  const tracker = new TodoSnapshotTracker();
  tracker.reset({
    version: 1,
    provider: 'claude',
    source: 'TaskList',
    revision: 7,
    items: [
      { id: 'task-1', text: 'Keep first task', status: 'pending' },
      { id: 'task-2', text: 'Keep second task', status: 'in_progress' },
    ],
  });

  assert.deepEqual(
    tracker.fromClaudeToolCompleted(
      'TaskUpdate',
      { taskId: 'task-1', status: 'completed' },
      { success: true, taskId: 'task-1', updatedFields: ['status'] },
    ),
    {
      version: 1,
      provider: 'claude',
      source: 'TaskUpdate',
      revision: 8,
      items: [
        { id: 'task-1', text: 'Keep first task', status: 'completed' },
        { id: 'task-2', text: 'Keep second task', status: 'in_progress' },
      ],
    },
  );
});

test('a failed TodoWrite never replaces the last confirmed task list', async () => {
  const { TodoSnapshotTracker } = await importTodoSnapshotsModule();
  const tracker = new TodoSnapshotTracker();
  tracker.reset({
    version: 1,
    provider: 'claude',
    source: 'TaskList',
    revision: 3,
    items: [
      { id: 'task-1', text: 'Confirmed task', status: 'pending' },
    ],
  });

  assert.equal(
    tracker.fromClaudeToolStarted('TodoWrite', {
      todos: [{ content: 'Rejected replacement', status: 'in_progress' }],
    }),
    undefined,
  );

  assert.deepEqual(
    tracker.fromClaudeToolCompleted(
      'TaskUpdate',
      { taskId: 'task-1', status: 'completed' },
      { success: true, taskId: 'task-1', updatedFields: ['status'] },
    ),
    {
      version: 1,
      provider: 'claude',
      source: 'TaskUpdate',
      revision: 4,
      items: [{ id: 'task-1', text: 'Confirmed task', status: 'completed' }],
    },
  );
});

test('a resumed tracker with no seed suppresses partial Task events until a full baseline exists', async () => {
  const { TodoSnapshotTracker } = await importTodoSnapshotsModule();
  const tracker = new TodoSnapshotTracker();
  tracker.reset(undefined, false);

  assert.equal(
    tracker.fromClaudeToolCompleted(
      'TaskCreate',
      { subject: 'Partial new task' },
      { task: { id: 'task-new', subject: 'Partial new task' } },
    ),
    undefined,
  );
  assert.equal(
    tracker.fromClaudeToolCompleted(
      'TaskUpdate',
      { taskId: 'task-old', status: 'completed' },
      { success: true, taskId: 'task-old', updatedFields: ['status'] },
    ),
    undefined,
  );

  const baseline = tracker.fromClaudeToolCompleted(
    'TodoWrite',
    {
      todos: [
        { id: 'task-old', content: 'Known old task', status: 'completed' },
        { id: 'task-next', content: 'Known next task', status: 'pending' },
      ],
    },
    { success: true },
  );
  assert.deepEqual(baseline, {
    version: 1,
    provider: 'claude',
    source: 'TodoWrite',
    revision: 1,
    items: [
      { id: 'task-old', text: 'Known old task', status: 'completed' },
      { id: 'task-next', text: 'Known next task', status: 'pending' },
    ],
  });

  assert.deepEqual(
    tracker.fromClaudeToolCompleted(
      'TaskCreate',
      { subject: 'Now safe to append' },
      { task: { id: 'task-new', subject: 'Now safe to append' } },
    )?.items.map((item) => item.id),
    ['task-old', 'task-next', 'task-new'],
  );
});

test('an invalid or wrong-provider seed cannot mark a resumed Claude baseline as known', async () => {
  const { TodoSnapshotTracker } = await importTodoSnapshotsModule();
  const tracker = new TodoSnapshotTracker();
  tracker.reset({
    version: 1,
    provider: 'codex',
    source: 'todo_list',
    revision: 9,
    items: [{ id: 'codex:0', text: 'Wrong provider state', status: 'pending' }],
  }, true);

  assert.equal(
    tracker.fromClaudeToolCompleted(
      'TaskUpdate',
      { taskId: 'legacy-task', status: 'completed' },
      { success: true, taskId: 'legacy-task', updatedFields: ['status'] },
    ),
    undefined,
  );
});

test('tracks TaskCreate and TaskUpdate with stable ordering and increasing revisions', async () => {
  const { TodoSnapshotTracker } = await importTodoSnapshotsModule();
  const tracker = new TodoSnapshotTracker();

  const createdFirst = tracker.fromClaudeToolCompleted(
    'TaskCreate',
    {
      subject: 'Implement structured snapshots',
      description: 'Add provider-neutral helper state.',
      activeForm: 'Implementing structured snapshots',
    },
    { task: { id: 'task-1', subject: 'Implement structured snapshots' } },
  );
  const createdSecond = tracker.fromClaudeToolCompleted(
    'TaskCreate',
    {
      subject: 'Verify helper behavior',
      description: 'Run focused tests.',
    },
    { task: { id: 'task-2', subject: 'Verify helper behavior' } },
  );
  const updatedFirst = tracker.fromClaudeToolCompleted(
    'TaskUpdate',
    {
      taskId: 'task-1',
      status: 'in_progress',
      activeForm: 'Wiring structured snapshots',
    },
    {
      success: true,
      taskId: 'task-1',
      updatedFields: ['status', 'activeForm'],
    },
  );

  assert.equal(createdFirst.revision, 1);
  assert.equal(createdSecond.revision, 2);
  assert.deepEqual(updatedFirst, {
    version: 1,
    provider: 'claude',
    source: 'TaskUpdate',
    revision: 3,
    items: [
      {
        id: 'task-1',
        text: 'Implement structured snapshots',
        status: 'in_progress',
        active_text: 'Wiring structured snapshots',
      },
      {
        id: 'task-2',
        text: 'Verify helper behavior',
        status: 'pending',
      },
    ],
  });
});

test('removes deleted tasks and replaces TaskList state, including an empty list', async () => {
  const { TodoSnapshotTracker } = await importTodoSnapshotsModule();
  const tracker = new TodoSnapshotTracker();

  tracker.fromClaudeToolCompleted(
    'TaskCreate',
    { subject: 'Old task', description: 'Delete me.' },
    { task: { id: 'task-old', subject: 'Old task' } },
  );
  tracker.fromClaudeToolCompleted(
    'TaskCreate',
    { subject: 'Keep task', description: 'Keep me.' },
    { task: { id: 'task-keep', subject: 'Keep task' } },
  );

  assert.deepEqual(
    tracker.fromClaudeToolCompleted(
      'TaskUpdate',
      { taskId: 'task-old', status: 'deleted' },
      { success: true, taskId: 'task-old', updatedFields: ['status'] },
    ),
    {
      version: 1,
      provider: 'claude',
      source: 'TaskUpdate',
      revision: 3,
      items: [{ id: 'task-keep', text: 'Keep task', status: 'pending' }],
    },
  );

  assert.deepEqual(
    tracker.fromClaudeToolCompleted(
      'TaskList',
      {},
      {
        tasks: [
          { id: 'task-keep', subject: 'Keep task renamed', status: 'completed', blockedBy: [] },
          { id: 'task-new', subject: 'New task', status: 'pending', blockedBy: [] },
        ],
      },
    ),
    {
      version: 1,
      provider: 'claude',
      source: 'TaskList',
      revision: 4,
      items: [
        { id: 'task-keep', text: 'Keep task renamed', status: 'completed' },
        { id: 'task-new', text: 'New task', status: 'pending' },
      ],
    },
  );

  assert.deepEqual(
    tracker.fromClaudeToolCompleted('TaskList', {}, { tasks: [] }),
    {
      version: 1,
      provider: 'claude',
      source: 'TaskList',
      revision: 5,
      items: [],
    },
  );
});

test('does not advance revision for events that do not emit snapshots', async () => {
  const { TodoSnapshotTracker } = await importTodoSnapshotsModule();
  const tracker = new TodoSnapshotTracker();

  assert.equal(tracker.fromClaudeToolStarted('Bash', { command: 'pwd' }), undefined);
  assert.equal(
    tracker.fromClaudeToolCompleted(
      'TaskUpdate',
      { taskId: 'task-1', status: 'completed' },
      { success: false, taskId: 'task-1', updatedFields: [], error: 'not found' },
    ),
    undefined,
  );

  assert.equal(tracker.fromClaudeToolStarted('TodoWrite', { todos: [] }), undefined);
  assert.equal(
    tracker.fromClaudeToolCompleted('TodoWrite', { todos: [] }, { success: true }).revision,
    1,
  );
});

test('normalizes Codex todo_list started, updated, and completed snapshots', async () => {
  const { TodoSnapshotTracker, snapshotFromCodexTodoList } = await importTodoSnapshotsModule();
  const tracker = new TodoSnapshotTracker();
  const startedItem = {
    id: 'todo-list-1',
    type: 'todo_list',
    items: [
      { text: 'Inspect SDK events', completed: false },
      { text: 'Emit snapshots', completed: false },
    ],
  };
  const updatedItem = {
    ...startedItem,
    items: [
      { text: 'Inspect SDK events', completed: true },
      { text: 'Emit snapshots', completed: false },
    ],
  };
  const completedItem = {
    ...startedItem,
    items: [
      { text: 'Inspect SDK events', completed: true },
      { text: 'Emit snapshots', completed: true },
    ],
  };

  assert.deepEqual(snapshotFromCodexTodoList(startedItem), {
    version: 1,
    provider: 'codex',
    source: 'todo_list',
    revision: 1,
    items: [
      { id: 'todo-list-1:0', text: 'Inspect SDK events', status: 'pending' },
      { id: 'todo-list-1:1', text: 'Emit snapshots', status: 'pending' },
    ],
  });
  assert.equal(tracker.fromCodexTodoList(startedItem).revision, 1);
  assert.deepEqual(tracker.fromCodexTodoList(updatedItem), {
    version: 1,
    provider: 'codex',
    source: 'todo_list',
    revision: 2,
    items: [
      { id: 'todo-list-1:0', text: 'Inspect SDK events', status: 'completed' },
      { id: 'todo-list-1:1', text: 'Emit snapshots', status: 'pending' },
    ],
  });
  assert.deepEqual(tracker.fromCodexTodoList(completedItem), {
    version: 1,
    provider: 'codex',
    source: 'todo_list',
    revision: 3,
    items: [
      { id: 'todo-list-1:0', text: 'Inspect SDK events', status: 'completed' },
      { id: 'todo-list-1:1', text: 'Emit snapshots', status: 'completed' },
    ],
  });
});

test('attaches Claude todo snapshots to real helper start and completion events', async (t) => {
  const helperPath = await buildHelperWithTodoSdkEvents();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

  const { outputs, stderrRef } = collectHelperOutput(helper);
  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'track todos',
  })}\n`);

  const completedTodoWrite = await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'tool_use_completed'
      && output.payload.tool_use_id === 'todo-write-1'
      && output.payload.todo_snapshot?.revision === 1,
    stderrRef,
    'confirmed Claude TodoWrite snapshot',
  );
  assert.equal(completedTodoWrite.payload.todo_snapshot.items[0].text.length, 191);
  assert.equal(completedTodoWrite.payload.todo_snapshot.items[0].status, 'in_progress');

  const completed = await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'tool_use_completed'
      && output.payload.tool_use_id === 'task-create-1'
      && output.payload.todo_snapshot?.revision === 2,
    stderrRef,
    'Claude TaskCreate snapshot',
  );
  assert.deepEqual(completed.payload.todo_snapshot.items.map((item) => item.id), [
    'todo-0',
    'task-1',
  ]);
});

test('helper reconnect seed survives a failed TodoWrite and a later TaskUpdate', async (t) => {
  const helperPath = await buildHelperWithTodoSdkEvents();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CCEM_TODO_TEST_SCENARIO: 'reconnect-failed-write',
    },
  });
  t.after(() => helper.kill('SIGTERM'));

  const { outputs, stderrRef } = collectHelperOutput(helper);
  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    provider_session_id: 'existing-provider-session',
    todo_snapshot_seed: {
      version: 1,
      provider: 'claude',
      source: 'TaskList',
      revision: 7,
      items: [
        { id: 'task-1', text: 'Keep first task', status: 'pending' },
        { id: 'task-2', text: 'Keep second task', status: 'in_progress' },
      ],
    },
    initial_prompt: 'continue seeded work',
  })}\n`);

  const updated = await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'tool_use_completed'
      && output.payload.tool_use_id === 'task-update-seeded'
      && output.payload.todo_snapshot?.revision === 8,
    stderrRef,
    'seeded TaskUpdate snapshot after failed TodoWrite',
  );

  const failedTodoEvents = outputs.filter(
    (output) => output.type === 'event'
      && output.payload?.tool_use_id === 'todo-write-failed',
  );
  assert.equal(failedTodoEvents.length, 2);
  assert.equal(failedTodoEvents.some((output) => output.payload.todo_snapshot), false);
  assert.deepEqual(updated.payload.todo_snapshot.items, [
    { id: 'task-1', text: 'Keep first task', status: 'completed' },
    { id: 'task-2', text: 'Keep second task', status: 'in_progress' },
  ]);
});

test('resumed helper without a seed does not publish a partial TaskUpdate snapshot', async (t) => {
  const helperPath = await buildHelperWithTodoSdkEvents();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CCEM_TODO_TEST_SCENARIO: 'resumed-no-seed',
    },
  });
  t.after(() => helper.kill('SIGTERM'));

  const { outputs, stderrRef } = collectHelperOutput(helper);
  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    provider_session_id: 'legacy-provider-session',
    initial_prompt: 'continue legacy work',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'resumed no-seed turn completion',
  );

  const taskEvents = outputs.filter(
    (output) => output.type === 'event'
      && output.payload?.tool_use_id === 'task-update-unknown-baseline',
  );
  assert.equal(taskEvents.length, 2);
  assert.equal(taskEvents.some((output) => output.payload.todo_snapshot), false);
});

test('attaches replacement snapshots to all Codex todo_list lifecycle events', async (t) => {
  const helperPath = await buildHelperWithTodoSdkEvents();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

  const { outputs, stderrRef } = collectHelperOutput(helper);
  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'codex',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'track todos',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'Codex turn completion',
  );

  const todoEvents = outputs.filter((output) => output.type === 'event'
    && output.payload?.raw_name === 'todo_list'
    && output.payload.todo_snapshot);
  assert.deepEqual(
    todoEvents.map((output) => [
      output.payload.type,
      output.payload.todo_snapshot.revision,
      output.payload.todo_snapshot.items.map((item) => item.status),
    ]),
    [
      ['tool_use_started', 1, ['pending', 'pending']],
      ['tool_use_started', 2, ['completed', 'pending']],
      ['tool_use_completed', 3, ['completed', 'completed']],
    ],
  );
});
