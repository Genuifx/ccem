import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function readSource(...parts) {
  return fs.readFile(path.join(desktopDir, ...parts), 'utf8');
}

async function importWorkspaceReview() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceReview.ts');
  const todosSourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceTodos.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const todosSource = await fs.readFile(todosSourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const todosOutput = ts.transpileModule(todosSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-review-test-'));
  const outputPath = path.join(tempDir, 'workspaceReview.mjs');
  const todosOutputPath = path.join(tempDir, 'workspaceTodos.mjs');
  await fs.writeFile(
    outputPath,
    output.outputText.replace("from './workspaceTodos'", "from './workspaceTodos.mjs'"),
    'utf8',
  );
  await fs.writeFile(todosOutputPath, todosOutput.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function session() {
  return {
    runtime_id: 'runtime-1',
    provider: 'claude',
    transport: 'native_sdk',
    project_dir: '/repo',
    env_name: 'official',
    perm_mode: 'acceptEdits',
    status: 'ready',
    created_at: '2026-05-31T00:00:00.000Z',
    updated_at: '2026-05-31T00:00:00.000Z',
    is_active: true,
    can_handoff_to_terminal: true,
  };
}

function event(seq, payload) {
  return {
    runtime_id: 'runtime-1',
    seq,
    occurred_at: `2026-05-31T00:00:${String(seq).padStart(2, '0')}.000Z`,
    payload,
  };
}

test('builds review model from Claude task, file, artifact, and git evidence', async () => {
  const { buildWorkspaceReviewModel } = await importWorkspaceReview();
  const events = [
    event(1, {
      type: 'claude_json',
      message_type: 'assistant',
      raw_json: JSON.stringify({
        message: {
          content: [{
            type: 'tool_use',
            id: 'todo-1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: '实现抽屉', status: 'completed' },
                { content: '补测试', status: 'in_progress' },
              ],
            },
          }],
        },
      }),
    }),
    event(2, {
      type: 'tool_use_started',
      tool_use_id: 'todo-1',
      raw_name: 'TodoWrite',
      input_summary: '{"todos":[...]}',
      needs_response: false,
      category: { category: 'task_mgmt', raw_name: 'TodoWrite' },
    }),
    event(3, {
      type: 'tool_use_started',
      tool_use_id: 'edit-1',
      raw_name: 'Write',
      input_summary: 'docs/report.html',
      needs_response: false,
      category: { category: 'file_op', raw_name: 'Write' },
    }),
    event(4, {
      type: 'tool_use_completed',
      tool_use_id: 'edit-1',
      raw_name: 'Write',
      result_summary: 'ok',
      success: true,
    }),
    event(5, {
      type: 'tool_use_completed',
      tool_use_id: 'bash-1',
      raw_name: 'Bash',
      result_summary: 'command failed',
      success: false,
    }),
  ];
  const messages = [{
    msgType: 'assistant',
    uuid: 'assistant-1',
    content: '最终回复内容',
    segmentIndex: 0,
    isCompactBoundary: false,
  }];
  const gitSnapshot = {
    is_repo: true,
    root: '/repo',
    branch: 'main',
    sha: 'abc1234',
    upstream: 'origin/main',
    dirty_count: 1,
    files: [{ path: 'docs/report.html', status: 'M', additions: 12, deletions: 1 }],
  };

  const model = buildWorkspaceReviewModel({
    session: session(),
    events,
    messages,
    gitSnapshot,
  });

  assert.equal(model.finalReply, '最终回复内容');
  assert.equal(model.todoTotal, 2);
  assert.equal(model.todoCompleted, 1);
  assert.equal(model.changedFiles[0].source, 'matched');
  assert.equal(model.artifacts[0].kind, 'html');
  assert.equal(model.failedTools.length, 1);
});

test('builds lightweight review summary without message or todo scans', async () => {
  const { buildWorkspaceReviewSummary } = await importWorkspaceReview();
  const summary = buildWorkspaceReviewSummary({
    events: [
      event(1, {
        type: 'claude_json',
        message_type: 'assistant',
        raw_json: JSON.stringify({
          message: {
            content: [{
              type: 'tool_use',
              id: 'todo-1',
              name: 'TodoWrite',
              input: { todos: [{ content: '无需常驻扫描', status: 'completed' }] },
            }],
          },
        }),
      }),
      event(2, {
        type: 'tool_use_started',
        tool_use_id: 'edit-1',
        raw_name: 'Write',
        input_summary: 'reports/result.html',
        needs_response: false,
        category: { category: 'file_op', raw_name: 'Write' },
      }),
      event(3, {
        type: 'tool_use_completed',
        tool_use_id: 'edit-1',
        raw_name: 'Write',
        result_summary: 'ok',
        success: true,
      }),
      event(4, {
        type: 'tool_use_completed',
        tool_use_id: 'bash-1',
        raw_name: 'Bash',
        result_summary: 'failed',
        success: false,
      }),
    ],
    gitSnapshot: {
      is_repo: true,
      root: '/repo',
      branch: 'main',
      sha: 'abc1234',
      upstream: 'origin/main',
      dirty_count: 1,
      files: [{ path: 'reports/result.html', status: 'M', additions: 3, deletions: 0 }],
    },
  });

  assert.deepEqual(summary, {
    failedTools: 1,
    changedFiles: 1,
    artifacts: 1,
  });
});

test('maps Codex todo_list summaries to unified todos', async () => {
  const { buildWorkspaceReviewModel } = await importWorkspaceReview();
  const model = buildWorkspaceReviewModel({
    session: { ...session(), provider: 'codex' },
    events: [
      event(1, {
        type: 'tool_use_completed',
        tool_use_id: 'todo-list-1',
        raw_name: 'todo_list',
        result_summary: JSON.stringify({
          items: [
            { text: '读取 SDK 事件', completed: true },
            { text: '合并 git snapshot', completed: false },
          ],
        }),
        success: true,
      }),
      event(2, {
        type: 'tool_use_completed',
        tool_use_id: 'todo-list-2',
        raw_name: 'todo_list',
        result_summary: JSON.stringify({
          items: [
            { text: '读取 SDK 事件', completed: true },
            { text: '合并 git snapshot', completed: true },
          ],
        }),
        success: true,
      }),
    ],
    messages: [],
    gitSnapshot: null,
  });

  assert.deepEqual(
    model.todos.map((todo) => [todo.text, todo.status]),
    [
      ['读取 SDK 事件', 'completed'],
      ['合并 git snapshot', 'completed'],
    ],
  );
});

test('exposes structured Todo provenance for truthful review warnings', async () => {
  const { buildWorkspaceReviewModel } = await importWorkspaceReview();
  const model = buildWorkspaceReviewModel({
    session: session(),
    events: [
      event(1, {
        type: 'tool_use_started',
        tool_use_id: 'todo-structured',
        raw_name: 'TodoWrite',
        input_summary: '{"todos":[...]}',
        needs_response: false,
        category: { category: 'task_mgmt', raw_name: 'TodoWrite' },
        todo_snapshot: {
          version: 1,
          provider: 'claude',
          source: 'TodoWrite',
          revision: 7,
          items: [{ id: 'one', text: 'Structured task', status: 'in_progress' }],
        },
      }),
    ],
    messages: [],
    gitSnapshot: null,
  });

  assert.equal(model.todoSource, 'structured');
  assert.equal(model.todoRevision, 7);
});

test('maps Claude TaskCreate TaskUpdate and TaskList to unified todos', async () => {
  const { buildWorkspaceReviewModel } = await importWorkspaceReview();
  const model = buildWorkspaceReviewModel({
    session: session(),
    events: [
      event(1, {
        type: 'claude_json',
        message_type: 'assistant',
        raw_json: JSON.stringify({
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'task-create-1',
                name: 'TaskCreate',
                input: { id: 'task-1', title: '接入审查抽屉', status: 'in_progress' },
              },
              {
                type: 'tool_use',
                id: 'task-list-1',
                name: 'TaskList',
                input: {
                  tasks: [
                    { id: 'task-1', title: '接入审查抽屉', status: 'completed' },
                    { id: 'task-2', title: '验证 git 分支', status: 'pending' },
                  ],
                },
              },
              {
                type: 'tool_use',
                id: 'task-update-1',
                name: 'TaskUpdate',
                input: { task_id: 'task-2', status: 'completed' },
              },
            ],
          },
        }),
      }),
      event(2, {
        type: 'tool_use_started',
        tool_use_id: 'task-create-1',
        raw_name: 'TaskCreate',
        input_summary: '接入审查抽屉',
        needs_response: false,
        category: { category: 'task_mgmt', raw_name: 'TaskCreate' },
      }),
      event(3, {
        type: 'tool_use_started',
        tool_use_id: 'task-list-1',
        raw_name: 'TaskList',
        input_summary: '{"tasks":[...]}',
        needs_response: false,
        category: { category: 'task_mgmt', raw_name: 'TaskList' },
      }),
      event(4, {
        type: 'tool_use_started',
        tool_use_id: 'task-update-1',
        raw_name: 'TaskUpdate',
        input_summary: '验证 git 分支',
        needs_response: false,
        category: { category: 'task_mgmt', raw_name: 'TaskUpdate' },
      }),
    ],
    messages: [],
    gitSnapshot: null,
  });

  assert.deepEqual(
    model.todos.map((todo) => [todo.text, todo.status, todo.sourceLabel]),
    [
      ['接入审查抽屉', 'completed', 'TaskList'],
      ['验证 git 分支', 'completed', 'TaskUpdate'],
    ],
  );
});

test('uses structured Codex file_change summaries as SDK file evidence', async () => {
  const { buildWorkspaceReviewModel } = await importWorkspaceReview();
  const model = buildWorkspaceReviewModel({
    session: { ...session(), provider: 'codex' },
    events: [
      event(1, {
        type: 'tool_use_completed',
        tool_use_id: 'file-change-1',
        raw_name: 'file_change',
        result_summary: JSON.stringify({
          type: 'file_change',
          changes: [
            { path: 'src/review.ts', kind: 'modified' },
            { path: 'docs/result.json', kind: 'added' },
          ],
        }),
        success: true,
      }),
    ],
    messages: [],
    gitSnapshot: {
      is_repo: true,
      root: '/repo',
      dirty_count: 1,
      files: [{ path: 'src/review.ts', status: 'M', additions: 4, deletions: 1 }],
    },
  });

  assert.deepEqual(
    model.changedFiles.map((file) => [file.path, file.source]),
    [
      ['docs/result.json', 'sdk'],
      ['src/review.ts', 'matched'],
    ],
  );
  assert.equal(model.artifacts.find((artifact) => artifact.path === 'docs/result.json')?.kind, 'json');
});

test('attaches git-only changed files to the latest mutating tool candidate', async () => {
  const { buildWorkspaceReviewModel } = await importWorkspaceReview();
  const model = buildWorkspaceReviewModel({
    session: session(),
    events: [
      event(1, {
        type: 'tool_use_started',
        tool_use_id: 'bash-1',
        raw_name: 'Bash',
        input_summary: 'node scripts/generate-report.js',
        needs_response: false,
        category: { category: 'execution', raw_name: 'Bash' },
      }),
      event(2, {
        type: 'tool_use_completed',
        tool_use_id: 'bash-1',
        raw_name: 'Bash',
        result_summary: 'generated report',
        success: true,
      }),
    ],
    messages: [],
    gitSnapshot: {
      is_repo: true,
      root: '/repo',
      dirty_count: 1,
      files: [{ path: 'out/report.html', status: '??', additions: null, deletions: null }],
    },
  });

  assert.equal(model.changedFiles[0].source, 'git');
  assert.deepEqual(model.changedFiles[0].toolUseIds, ['bash-1']);
  assert.deepEqual(model.artifacts[0].toolUseIds, ['bash-1']);
});

test('recognizes expected artifact file types from changed files', async () => {
  const { buildWorkspaceReviewModel } = await importWorkspaceReview();
  const gitFiles = [
    ['site/index.html', 'html'],
    ['image/output.png', 'image'],
    ['reports/summary.md', 'report'],
    ['changes/fix.patch', 'patch'],
    ['logs/run.log', 'log'],
    ['data/result.json', 'json'],
  ];
  const model = buildWorkspaceReviewModel({
    session: session(),
    events: [
      event(1, {
        type: 'tool_use_started',
        tool_use_id: 'write-1',
        raw_name: 'Write',
        input_summary: 'site/index.html',
        needs_response: false,
        category: { category: 'file_op', raw_name: 'Write' },
      }),
    ],
    messages: [],
    gitSnapshot: {
      is_repo: true,
      root: '/repo',
      dirty_count: gitFiles.length,
      files: gitFiles.map(([path]) => ({ path, status: 'M', additions: 1, deletions: 0 })),
    },
  });

  const expectedArtifacts = [...gitFiles].sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(
    model.artifacts.map((artifact) => [artifact.path, artifact.kind, artifact.openable]),
    expectedArtifacts.map(([path, kind]) => [path, kind, true]),
  );
});

test('native history carries replay events into review and provider-only history clears them', async () => {
  const source = await readSource('src', 'pages', 'Workspace.tsx');

  assert.match(
    source,
    /const \[historyEvents, setHistoryEvents\] = useState<SessionEventRecord\[\]>\(\[\]\)/,
  );
  assert.match(
    source,
    /return \{[\s\S]*messages: nativeMessages,[\s\S]*segments: \[\],[\s\S]*events: replayBatch\.events,[\s\S]*\}/,
  );
  assert.match(
    source,
    /if \(nativeHistory && hasNativeHistoryTranscriptMessages\(nativeHistory\.messages\)\) \{[\s\S]*setHistoryEvents\(nativeHistory\.events\)/,
  );
  assert.match(
    source,
    /if \(hasNativeHistorySessionOption\) \{[\s\S]*setHistoryEvents\(nativeHistory\?\.events \?\? \[\]\);[\s\S]*\}/,
  );
  assert.equal(
    source.match(/events: workspaceReviewEvents/g)?.length,
    2,
    'history replay events should feed both the lightweight summary and lazy full review model',
  );
  assert.match(
    source,
    /const workspaceReviewEvents = useMemo\([\s\S]*workspaceMode === 'history' && selectedSession[\s\S]*\? historyEvents[\s\S]*: \[\],[\s\S]*\[historyEvents, selectedSession, workspaceMode\]/,
  );
});

test('routine history refresh with native option omitted preserves replay events', async () => {
  const source = await readSource('src', 'pages', 'Workspace.tsx');

  assert.match(
    source,
    /const hasNativeHistorySessionOption = Object\.prototype\.hasOwnProperty\.call\([\s\S]*options,[\s\S]*'nativeHistorySession',[\s\S]*\)/,
  );
  assert.match(
    source,
    /loadConversation\(selectedSession, \{[\s\S]*resetBeforeLoad: false,[\s\S]*showLoading: false,[\s\S]*\}\)/,
    'routine background refresh should continue omitting nativeHistorySession',
  );
  assert.match(
    source,
    /if \(hasNativeHistorySessionOption\) \{[\s\S]*setHistoryEvents\(nativeHistory\?\.events \?\? \[\]\);[\s\S]*\}/,
    'history events should only be replaced when the native option was explicitly supplied',
  );
});

test('selection loss clears history events and prevents stale review publication', async () => {
  const source = await readSource('src', 'pages', 'Workspace.tsx');
  const selectionLossStart = source.indexOf('if (!stillExists) {');
  const selectionLossEnd = source.indexOf('return retainedSessions;', selectionLossStart);
  const selectionLossBlock = source.slice(selectionLossStart, selectionLossEnd);

  assert.notEqual(selectionLossStart, -1, 'selection-loss cleanup branch should exist');
  assert.match(selectionLossBlock, /setHistoryEvents\(\[\]\)/);
  assert.match(
    source,
    /const workspaceReviewEvents = useMemo\([\s\S]*workspaceMode === 'history' && selectedSession[\s\S]*\? historyEvents[\s\S]*: \[\],[\s\S]*\[historyEvents, selectedSession, workspaceMode\]/,
  );
});
