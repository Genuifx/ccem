import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importWorkspaceTodos() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceTodos.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-todos-test-'));
  const outputPath = path.join(tempDir, 'workspaceTodos.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function event(seq, payload) {
  return {
    runtime_id: 'runtime-1',
    seq,
    occurred_at: `2026-07-12T00:00:${String(seq).padStart(2, '0')}.000Z`,
    payload,
  };
}

function snapshotEvent(seq, revision, items, overrides = {}) {
  return event(seq, {
    type: 'tool_use_started',
    tool_use_id: `todo-${seq}`,
    raw_name: 'TodoWrite',
    input_summary: '{"todos":[...]}',
    needs_response: false,
    category: { category: 'task_mgmt', raw_name: 'TodoWrite' },
    todo_snapshot: {
      version: 1,
      provider: 'claude',
      source: 'TodoWrite',
      revision,
      items,
      ...overrides,
    },
  });
}

function historyToolMessage(uuid, block) {
  return {
    msgType: 'assistant',
    uuid,
    content: [block],
    segmentIndex: 0,
    isCompactBoundary: false,
  };
}

test('uses the newest structured snapshot as a full replacement without stale rollback', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const newest = snapshotEvent(3, 3, [
    { id: 'second', text: 'Only current task remains', status: 'completed' },
  ]);

  const result = buildWorkspaceTodos([
    snapshotEvent(1, 1, [
      { id: 'first', text: 'Removed task', status: 'pending' },
      { id: 'second', text: 'Old current task', status: 'in_progress' },
    ]),
    newest,
    snapshotEvent(2, 2, [
      { id: 'first', text: 'Stale late arrival', status: 'completed' },
    ]),
  ]);

  assert.equal(result.source, 'structured');
  assert.equal(result.revision, 3);
  assert.equal(result.completed, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(
    result.items.map((item) => [item.id, item.text, item.status, item.sourceSeq]),
    [['second', 'Only current task remains', 'completed', 3]],
  );
});

test('treats a valid empty structured snapshot as an explicit clear', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([
    snapshotEvent(1, 1, [{ id: 'old', text: 'Old task', status: 'pending' }]),
    snapshotEvent(2, 2, []),
  ]);

  assert.deepEqual(result, {
    items: [],
    completed: 0,
    total: 0,
    source: 'structured',
    revision: 2,
  });
});

test('uses revision to break a sequence tie and ignores malformed or unknown snapshots', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([
    snapshotEvent(5, 2, [{ id: 'older', text: 'Older revision', status: 'pending' }]),
    snapshotEvent(5, 3, [{ id: 'newer', text: 'Newer revision', status: 'in_progress' }]),
    snapshotEvent(6, 4, [{ id: 'unknown', text: 'Unknown version', status: 'completed' }], {
      version: 2,
    }),
    snapshotEvent(7, 5, [{ id: 'broken', text: '', status: 'not-a-status' }]),
  ]);

  assert.equal(result.source, 'structured');
  assert.equal(result.revision, 3);
  assert.deepEqual(
    result.items.map((item) => [item.id, item.text, item.status]),
    [['newer', 'Newer revision', 'in_progress']],
  );
});

test('prefers any valid structured snapshot over later legacy event summaries', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([
    snapshotEvent(1, 1, [{ id: 'canonical', text: 'Canonical task', status: 'pending' }]),
    event(2, {
      type: 'tool_use_completed',
      tool_use_id: 'legacy-list',
      raw_name: 'todo_list',
      result_summary: JSON.stringify({
        items: [{ id: 'legacy', text: 'Legacy task', status: 'completed' }],
      }),
      success: true,
    }),
  ]);

  assert.equal(result.source, 'structured');
  assert.deepEqual(result.items.map((item) => item.id), ['canonical']);
});

test('legacy fallback accepts complete event structures but never guesses from plain summaries', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const unavailable = buildWorkspaceTodos([
    event(1, {
      type: 'tool_use_started',
      tool_use_id: 'plain-summary',
      raw_name: 'TaskCreate',
      input_summary: 'A truncated ordinary-text summary that must not become a Todo',
      needs_response: false,
      category: { category: 'task_mgmt', raw_name: 'TaskCreate' },
    }),
  ]);
  assert.equal(unavailable.source, 'unavailable');
  assert.deepEqual(unavailable.items, []);

  const legacy = buildWorkspaceTodos([
    event(2, {
      type: 'tool_use_completed',
      tool_use_id: 'legacy-list',
      raw_name: 'todo_list',
      result_summary: JSON.stringify({
        items: [
          { id: 'one', text: 'Verified complete structure', status: 'completed' },
          { id: 'two', text: 'Still pending', status: 'pending' },
        ],
      }),
      success: true,
    }),
  ]);
  assert.equal(legacy.source, 'legacy');
  assert.equal(legacy.completed, 1);
  assert.equal(legacy.total, 2);
});

test('restores completed history TodoWrite calls as full replacements', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([], [
    historyToolMessage('history-todo-1', {
      type: 'tool_use',
      id: 'history-todo-1',
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Removed task', status: 'pending' },
          { content: 'Current task', status: 'in_progress' },
        ],
      },
      _result: { success: true },
    }),
    historyToolMessage('history-todo-2', {
      type: 'tool_use',
      id: 'history-todo-2',
      name: 'TodoWrite',
      input: {
        todos: [{ content: 'Current task', status: 'completed' }],
      },
      _result: { success: true },
    }),
  ]);

  assert.equal(result.source, 'history');
  assert.equal(result.revision, null);
  assert.deepEqual(
    result.items.map((item) => [item.text, item.status, item.sourceLabel]),
    [['Current task', 'completed', 'History · TodoWrite']],
  );
});

test('preserves duplicate unnamed history todos and respects an empty TodoWrite clear', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const duplicates = buildWorkspaceTodos([], [
    historyToolMessage('history-duplicates', {
      type: 'tool_use',
      id: 'history-duplicates',
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Same wording', status: 'pending' },
          { content: 'Same wording', status: 'in_progress' },
        ],
      },
      _result: { success: true },
    }),
  ]);
  const cleared = buildWorkspaceTodos([], [
    historyToolMessage('history-before-clear', {
      type: 'tool_use',
      id: 'history-before-clear',
      name: 'TodoWrite',
      input: { todos: [{ content: 'Removed by a clear', status: 'pending' }] },
      _result: { success: true },
    }),
    historyToolMessage('history-clear', {
      type: 'tool_use',
      id: 'history-clear',
      name: 'TodoWrite',
      input: { todos: [] },
      _result: { success: true },
    }),
  ]);

  assert.equal(duplicates.total, 2);
  assert.deepEqual(duplicates.items.map((item) => item.status), ['pending', 'in_progress']);
  assert.equal(cleared.source, 'history');
  assert.deepEqual(cleared.items, []);
});

test('replays successful history TaskList, TaskCreate, and TaskUpdate calls', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([], [
    historyToolMessage('history-task-list', {
      type: 'tool_use',
      id: 'history-task-list',
      name: 'TaskList',
      input: {},
      _result: {
        tasks: [{ id: 'task-1', subject: 'Review the history', status: 'pending' }],
      },
    }),
    historyToolMessage('history-task-create', {
      type: 'tool_use',
      id: 'history-task-create',
      name: 'TaskCreate',
      input: { subject: 'Ship the fallback', status: 'in_progress', activeForm: 'Shipping fallback' },
      _result: { task: { id: 'task-2', subject: 'Ship the fallback' } },
    }),
    historyToolMessage('history-task-update', {
      type: 'tool_use',
      id: 'history-task-update',
      name: 'TaskUpdate',
      input: { taskId: 'task-2', status: 'completed' },
      _result: { success: true, taskId: 'task-2' },
    }),
  ]);

  assert.equal(result.source, 'history');
  assert.deepEqual(
    result.items.map((item) => [item.id, item.text, item.status, item.activeText]),
    [
      ['id:task-1', 'Review the history', 'pending', undefined],
      ['id:task-2', 'Ship the fallback', 'completed', 'Shipping fallback'],
    ],
  );
});

test('treats an empty successful TaskList as an explicit clear', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([], [
    historyToolMessage('history-task-list', {
      type: 'tool_use',
      id: 'history-task-list',
      name: 'TaskList',
      input: {},
      _result: { tasks: [{ id: 'task-1', subject: 'Will be cleared', status: 'pending' }] },
    }),
    historyToolMessage('history-task-list-clear', {
      type: 'tool_use',
      id: 'history-task-list-clear',
      name: 'TaskList',
      input: {},
      _result: { tasks: [] },
    }),
  ]);

  assert.equal(result.source, 'history');
  assert.deepEqual(result.items, []);
});

test('ignores failed or unfinished history task calls', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([], [
    historyToolMessage('history-failed-todo', {
      type: 'tool_use',
      id: 'history-failed-todo',
      name: 'TodoWrite',
      input: { todos: [{ content: 'Rejected task', status: 'in_progress' }] },
      _result: 'permission denied',
      _resultError: true,
    }),
    historyToolMessage('history-unfinished-task', {
      type: 'tool_use',
      id: 'history-unfinished-task',
      name: 'TaskCreate',
      input: { subject: 'Unconfirmed task' },
    }),
    historyToolMessage('history-rejected-result', {
      type: 'tool_use',
      id: 'history-rejected-result',
      name: 'TodoWrite',
      input: { todos: [{ content: 'Rejected by result', status: 'pending' }] },
      _result: { success: false },
    }),
  ]);

  assert.equal(result.source, 'unavailable');
  assert.deepEqual(result.items, []);
});

test('does not fabricate a task from a status-only history TaskUpdate', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([], [
    historyToolMessage('history-status-only-update', {
      type: 'tool_use',
      id: 'history-status-only-update',
      name: 'TaskUpdate',
      input: { taskId: 'unknown-task', status: 'completed' },
      _result: { success: true },
    }),
  ]);

  assert.equal(result.source, 'unavailable');
  assert.deepEqual(result.items, []);
});

test('removes a history task after a successful TaskUpdate deletion', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([], [
    historyToolMessage('history-task-list', {
      type: 'tool_use',
      id: 'history-task-list',
      name: 'TaskList',
      input: {},
      _result: { tasks: [{ id: 'task-1', subject: 'Delete me', status: 'pending' }] },
    }),
    historyToolMessage('history-task-delete', {
      type: 'tool_use',
      id: 'history-task-delete',
      name: 'TaskUpdate',
      input: { task_id: 'task-1', status: 'deleted' },
      _result: { success: true },
    }),
  ]);

  assert.equal(result.source, 'history');
  assert.deepEqual(result.items, []);
});

test('keeps structured event snapshots authoritative over history fallback', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([
    snapshotEvent(1, 1, []),
  ], [
    historyToolMessage('history-todo', {
      type: 'tool_use',
      id: 'history-todo',
      name: 'TodoWrite',
      input: { todos: [{ content: 'Must not reappear', status: 'pending' }] },
      _result: { success: true },
    }),
  ]);

  assert.equal(result.source, 'structured');
  assert.deepEqual(result.items, []);
});

test('lets legacy event state override matching history task state', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([
    event(1, {
      type: 'claude_json',
      message_type: 'assistant',
      raw_json: JSON.stringify({
        message: {
          content: [{
            type: 'tool_use',
            id: 'event-todo',
            name: 'TodoWrite',
            input: { todos: [{ id: 'shared', content: 'Event wins', status: 'in_progress' }] },
          }],
        },
      }),
    }),
    event(2, {
      type: 'tool_use_started',
      tool_use_id: 'event-todo',
      raw_name: 'TodoWrite',
      input_summary: '{"todos":[...]}',
      needs_response: false,
      category: { category: 'task_mgmt', raw_name: 'TodoWrite' },
    }),
  ], [
    historyToolMessage('history-todo', {
      type: 'tool_use',
      id: 'history-todo',
      name: 'TodoWrite',
      input: {
        todos: [
          { id: 'shared', content: 'Event wins', status: 'completed' },
          { id: 'history-only', content: 'Recovered only from history', status: 'pending' },
        ],
      },
      _result: { success: true },
    }),
  ]);

  assert.equal(result.source, 'legacy');
  assert.deepEqual(
    result.items.map((item) => [item.id, item.status, item.sourceLabel]),
    [
      ['id:shared', 'in_progress', 'TodoWrite'],
      ['id:history-only', 'pending', 'History · TodoWrite'],
    ],
  );
});

test('uses legacy event state to override matching unnamed history todos without duplication', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([
    event(1, {
      type: 'claude_json',
      message_type: 'assistant',
      raw_json: JSON.stringify({
        message: {
          content: [{
            type: 'tool_use',
            id: 'event-unnamed-todo',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Unnamed event wins', status: 'in_progress' }] },
          }],
        },
      }),
    }),
    event(2, {
      type: 'tool_use_started',
      tool_use_id: 'event-unnamed-todo',
      raw_name: 'TodoWrite',
      input_summary: '{"todos":[...]}',
      needs_response: false,
      category: { category: 'task_mgmt', raw_name: 'TodoWrite' },
    }),
  ], [
    historyToolMessage('history-unnamed-todo', {
      type: 'tool_use',
      id: 'history-unnamed-todo',
      name: 'TodoWrite',
      input: { todos: [{ content: 'Unnamed event wins', status: 'completed' }] },
      _result: { success: true },
    }),
  ]);

  assert.equal(result.source, 'legacy');
  assert.deepEqual(
    result.items.map((item) => [item.text, item.status, item.sourceLabel]),
    [['Unnamed event wins', 'in_progress', 'TodoWrite']],
  );
});

test('ignores an explicitly failed legacy call instead of overriding confirmed history', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([
    event(1, {
      type: 'claude_json',
      message_type: 'assistant',
      raw_json: JSON.stringify({
        message: {
          content: [{
            type: 'tool_use',
            id: 'failed-event-todo',
            name: 'TodoWrite',
            input: { todos: [{ id: 'shared', content: 'Must stay complete', status: 'in_progress' }] },
          }],
        },
      }),
    }),
    event(2, {
      type: 'tool_use_started',
      tool_use_id: 'failed-event-todo',
      raw_name: 'TodoWrite',
      input_summary: '{"todos":[...]}',
      needs_response: false,
      category: { category: 'task_mgmt', raw_name: 'TodoWrite' },
    }),
    event(3, {
      type: 'tool_use_completed',
      tool_use_id: 'failed-event-todo',
      raw_name: 'TodoWrite',
      result_summary: 'permission denied',
      success: false,
    }),
  ], [
    historyToolMessage('confirmed-history-todo', {
      type: 'tool_use',
      id: 'confirmed-history-todo',
      name: 'TodoWrite',
      input: { todos: [{ id: 'shared', content: 'Must stay complete', status: 'completed' }] },
      _result: { success: true },
    }),
  ]);

  assert.equal(result.source, 'history');
  assert.deepEqual(
    result.items.map((item) => [item.id, item.status, item.sourceLabel]),
    [['id:shared', 'completed', 'History · TodoWrite']],
  );
});

test('treats successful legacy TodoWrite and TaskList empty states as explicit clears', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const history = [
    historyToolMessage('history-before-event-clear', {
      type: 'tool_use',
      id: 'history-before-event-clear',
      name: 'TodoWrite',
      input: { todos: [{ id: 'old', content: 'Old task', status: 'pending' }] },
      _result: { success: true },
    }),
  ];
  const todoWriteClear = buildWorkspaceTodos([
    event(1, {
      type: 'claude_json',
      message_type: 'assistant',
      raw_json: JSON.stringify({
        message: {
          content: [{
            type: 'tool_use',
            id: 'event-todo-clear',
            name: 'TodoWrite',
            input: { todos: [] },
          }],
        },
      }),
    }),
    event(2, {
      type: 'tool_use_started',
      tool_use_id: 'event-todo-clear',
      raw_name: 'TodoWrite',
      input_summary: '{"todos":[]}',
      needs_response: false,
      category: { category: 'task_mgmt', raw_name: 'TodoWrite' },
    }),
    event(3, {
      type: 'tool_use_completed',
      tool_use_id: 'event-todo-clear',
      raw_name: 'TodoWrite',
      result_summary: '{"success":true}',
      success: true,
    }),
  ], history);
  const taskListClear = buildWorkspaceTodos([
    event(1, {
      type: 'tool_use_completed',
      tool_use_id: 'event-task-list-clear',
      raw_name: 'TaskList',
      result_summary: JSON.stringify({ tasks: [] }),
      success: true,
    }),
  ], history);

  assert.deepEqual(todoWriteClear, {
    items: [],
    completed: 0,
    total: 0,
    source: 'legacy',
    revision: null,
  });
  assert.deepEqual(taskListClear, todoWriteClear);
});

test('applies a status-only legacy TaskUpdate on the recovered task without replacing its title', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([
    event(1, {
      type: 'claude_json',
      message_type: 'assistant',
      raw_json: JSON.stringify({
        message: {
          content: [{
            type: 'tool_use',
            id: 'event-task-update',
            name: 'TaskUpdate',
            input: { taskId: 'task-1', status: 'completed' },
          }],
        },
      }),
    }),
    event(2, {
      type: 'tool_use_started',
      tool_use_id: 'event-task-update',
      raw_name: 'TaskUpdate',
      input_summary: '{"taskId":"task-1","status":"completed"}',
      needs_response: false,
      category: { category: 'task_mgmt', raw_name: 'TaskUpdate' },
    }),
    event(3, {
      type: 'tool_use_completed',
      tool_use_id: 'event-task-update',
      raw_name: 'TaskUpdate',
      result_summary: 'Updated task #task-1 status',
      success: true,
    }),
  ], [
    historyToolMessage('history-task-list', {
      type: 'tool_use',
      id: 'history-task-list',
      name: 'TaskList',
      input: {},
      _result: { tasks: [{ id: 'task-1', subject: 'Keep the real title', status: 'pending' }] },
    }),
  ]);

  assert.equal(result.source, 'legacy');
  assert.deepEqual(
    result.items.map((item) => [item.id, item.text, item.status, item.sourceLabel]),
    [['id:task-1', 'Keep the real title', 'completed', 'TaskUpdate']],
  );
});

test('uses todo_list input when a successful result only reports success', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const result = buildWorkspaceTodos([
    event(1, {
      type: 'claude_json',
      message_type: 'assistant',
      raw_json: JSON.stringify({
        message: {
          content: [{
            type: 'tool_use',
            id: 'event-todo-list',
            name: 'todo_list',
            input: { items: [{ id: 'from-input', text: 'Use the submitted task', status: 'in_progress' }] },
          }],
        },
      }),
    }),
    event(2, {
      type: 'tool_use_started',
      tool_use_id: 'event-todo-list',
      raw_name: 'todo_list',
      input_summary: '{"items":[...]}',
      needs_response: false,
      category: { category: 'task_mgmt', raw_name: 'todo_list' },
    }),
    event(3, {
      type: 'tool_use_completed',
      tool_use_id: 'event-todo-list',
      raw_name: 'todo_list',
      result_summary: '{"success":true}',
      success: true,
    }),
  ]);

  assert.equal(result.source, 'legacy');
  assert.deepEqual(
    result.items.map((item) => [item.id, item.text, item.status]),
    [['id:from-input', 'Use the submitted task', 'in_progress']],
  );
});

test('replays Claude textual TaskCreate, TaskUpdate, and TaskList results', async () => {
  const { buildWorkspaceTodos } = await importWorkspaceTodos();
  const createdThenUpdated = buildWorkspaceTodos([], [
    historyToolMessage('text-task-create', {
      type: 'tool_use',
      id: 'text-task-create',
      name: 'TaskCreate',
      input: {
        subject: 'Ship textual fallback',
        status: 'in_progress',
        activeForm: 'Shipping textual fallback',
      },
      _result: 'Task #42 created successfully: Ship textual fallback',
    }),
    historyToolMessage('text-task-update', {
      type: 'tool_use',
      id: 'text-task-update',
      name: 'TaskUpdate',
      input: { taskId: '42', status: 'completed' },
      _result: 'Updated task #42 status',
    }),
  ]);
  const listed = buildWorkspaceTodos([], [
    historyToolMessage('text-task-list', {
      type: 'tool_use',
      id: 'text-task-list',
      name: 'TaskList',
      input: {},
      _result: [
        {
          type: 'text',
          text: '#7 [completed] Review source — verify citations, Reviewing source\n#8 [in_progress] Ship fallback — implement it, Shipping fallback',
        },
      ],
    }),
  ]);

  assert.deepEqual(
    createdThenUpdated.items.map((item) => [item.id, item.text, item.status, item.activeText]),
    [['id:42', 'Ship textual fallback', 'completed', 'Shipping textual fallback']],
  );
  assert.equal(listed.source, 'history');
  assert.deepEqual(
    listed.items.map((item) => [item.id, item.text, item.status]),
    [
      ['id:7', 'Review source', 'completed'],
      ['id:8', 'Ship fallback', 'in_progress'],
    ],
  );
});

test('keeps the latest snapshot event in cache in addition to the retained tail', async () => {
  const { selectCachedWorkspaceEvents } = await importWorkspaceTodos();
  const latestSnapshot = snapshotEvent(2, 2, [
    { id: 'anchor', text: 'Persisted anchor', status: 'in_progress' },
  ]);
  const events = [
    snapshotEvent(1, 1, [{ id: 'stale', text: 'Stale anchor', status: 'pending' }]),
    latestSnapshot,
    event(3, { type: 'assistant_chunk', text: 'one' }),
    event(4, { type: 'assistant_chunk', text: 'two' }),
    event(5, { type: 'assistant_chunk', text: 'three' }),
  ];

  assert.deepEqual(
    selectCachedWorkspaceEvents(events, 2).map((entry) => entry.seq),
    [2, 4, 5],
  );
});

test('initial replay replaces stale cached duplicates and merges events in sequence order', async () => {
  const { mergeWorkspaceReplayEvents } = await importWorkspaceTodos();
  const cached = [
    event(2, {
      type: 'tool_use_started',
      tool_use_id: 'todo-2',
      raw_name: 'TodoWrite',
      input_summary: '{"todos":[...]}',
      needs_response: false,
      category: { category: 'task_mgmt', raw_name: 'TodoWrite' },
    }),
    event(4, { type: 'assistant_chunk', text: 'cached tail' }),
  ];
  const replayed = [
    event(1, { type: 'user_prompt', text: 'start', image_count: 0 }),
    snapshotEvent(2, 2, [{ id: 'anchor', text: 'Recovered from SQLite', status: 'in_progress' }]),
    event(3, { type: 'assistant_chunk', text: 'replayed tail' }),
  ];

  const merged = mergeWorkspaceReplayEvents(cached, replayed);

  assert.deepEqual(merged.map((entry) => entry.seq), [1, 2, 3, 4]);
  assert.equal(merged[1].payload.todo_snapshot.items[0].text, 'Recovered from SQLite');
});

test('live native view always issues one limited initial replay before incremental polling', async () => {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceNativeSessionView.tsx'),
    'utf8',
  );

  assert.match(source, /const initialReplayRuntimeRef = useRef<string \| null>\(null\)/);
  assert.match(
    source,
    /const isInitialReplay = initialReplayRuntimeRef\.current !== session\.runtime_id/,
  );
  assert.match(
    source,
    /const sinceSeq = isInitialReplay \? null : lastSeenSeqRef\.current;[\s\S]*sinceSeq,[\s\S]*isInitialReplay \? INITIAL_EVENT_REPLAY_LIMIT : null/,
  );
  assert.match(
    source,
    /isInitialReplay[\s\S]*mergeWorkspaceReplayEvents\(previous, batch\.events\)/,
  );
});
