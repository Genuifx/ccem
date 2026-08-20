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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-transcript-cache-select-'));
  const outputPath = path.join(tempDir, 'workspaceTodos.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function ev(seq, payload) {
  return {
    runtime_id: 'runtime-cache',
    seq,
    occurred_at: `2026-08-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    payload,
  };
}

function snapshotEvent(seq, revision) {
  return ev(seq, {
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
      items: [{ id: 'only', text: 'One task', status: 'in_progress' }],
    },
  });
}

test('an already-ordered array is never copied or sorted', async () => {
  const { selectCachedWorkspaceEvents } = await importWorkspaceTodos();
  const events = Array.from({ length: 10_000 }, (_, index) =>
    ev(index + 1, { type: 'assistant_chunk', text: `chunk ${index + 1}` }));

  const originalSort = Array.prototype.sort;
  let sortCalls = 0;
  Array.prototype.sort = function patchedSort(...args) {
    sortCalls += 1;
    return originalSort.apply(this, args);
  };
  let selected;
  try {
    selected = selectCachedWorkspaceEvents(events, 8000);
  } finally {
    Array.prototype.sort = originalSort;
  }

  assert.equal(sortCalls, 0, 'ordered input must not sort');
  assert.equal(selected.length, 8000);
  // Order + identity: the retained window is the highest seqs, same objects.
  for (let index = 0; index < selected.length; index += 1) {
    assert.ok(selected[index] === events[2000 + index]);
    if (index > 0) {
      assert.ok(selected[index].seq > selected[index - 1].seq);
    }
  }
});

test('unsorted input still gets sorted before tail selection', async () => {
  const { selectCachedWorkspaceEvents } = await importWorkspaceTodos();
  const events = [];
  for (let seq = 1; seq <= 100; seq += 1) {
    events.push(ev(seq, { type: 'assistant_chunk', text: `chunk ${seq}` }));
  }
  // Reverse: strictly descending, fails the ordered-tail check.
  const reversed = [...events].reverse();

  const originalSort = Array.prototype.sort;
  let sortCalls = 0;
  Array.prototype.sort = function patchedSort(...args) {
    sortCalls += 1;
    return originalSort.apply(this, args);
  };
  let selected;
  try {
    selected = selectCachedWorkspaceEvents(reversed, 10);
  } finally {
    Array.prototype.sort = originalSort;
  }

  assert.ok(sortCalls >= 1, 'unsorted input must sort');
  assert.equal(selected.length, 10);
  assert.equal(selected[0].seq, 91);
  assert.equal(selected[selected.length - 1].seq, 100);
});

test('the newest structured snapshot outside the window is prepended', async () => {
  const { selectCachedWorkspaceEvents } = await importWorkspaceTodos();
  const events = [
    snapshotEvent(2, 1),
    ...Array.from({ length: 20 }, (_, index) =>
      ev(index + 10, { type: 'assistant_chunk', text: `chunk ${index + 10}` })),
  ];

  const selected = selectCachedWorkspaceEvents(events, 5);
  assert.equal(selected.length, 6);
  assert.equal(selected[0].seq, 2, 'snapshot event rides along outside the tail');
  assert.equal(selected[1].seq, 25);
  assert.equal(selected[selected.length - 1].seq, 29);
});
