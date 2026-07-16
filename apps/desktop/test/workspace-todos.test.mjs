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
