import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const workspaceDir = path.join(desktopDir, 'src', 'components', 'workspace');

async function importModules() {
  const names = [
    'workspaceEventSubsetFold',
    'workspaceEventTranscript',
    'transcriptIdentity',
    'workspaceNativeAttention',
    'workspaceNativeCheckpoints',
    'workspaceBackgroundTasks',
  ];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-event-subset-fold-'));
  for (const name of names) {
    const source = await fs.readFile(path.join(workspaceDir, `${name}.ts`), 'utf8');
    let output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        isolatedModules: true,
      },
    }).outputText;
    for (const dep of names) {
      output = output.replaceAll(`from './${dep}'`, `from './${dep}.mjs'`);
    }
    await fs.writeFile(path.join(tempDir, `${name}.mjs`), output, 'utf8');
  }
  const load = (name) => import(pathToFileURL(path.join(tempDir, `${name}.mjs`)).href);
  return {
    fold: await load('workspaceEventSubsetFold'),
    attention: await load('workspaceNativeAttention'),
    checkpoints: await load('workspaceNativeCheckpoints'),
    background: await load('workspaceBackgroundTasks'),
  };
}

function event(seq, payload, runtimeId = 'runtime-1') {
  return {
    runtime_id: runtimeId,
    seq,
    occurred_at: `2026-10-18T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    payload,
  };
}

const delta = (seq) => event(seq, { type: 'assistant_delta', text: `chunk ${seq}` });
const permission = (seq, id, runtimeId) => event(seq, {
  type: 'permission_required',
  request_id: id,
  tool_name: 'Bash',
}, runtimeId);

test('subset fold keeps identity across appends of unrelated events', async () => {
  const { fold } = await importModules();
  const isPermission = (e) => e.payload.type === 'permission_required';
  const initial = [delta(1), permission(2, 'p1'), delta(3)];
  const first = fold.foldEventSubset(null, initial, isPermission);
  assert.deepEqual(first.relevant.map((e) => e.seq), [2]);

  const appendedNoise = [...initial, delta(4), delta(5)];
  const second = fold.foldEventSubset(first, appendedNoise, isPermission);
  assert.equal(second.relevant, first.relevant, 'unrelated appends keep array identity');
  assert.equal(second.consumedSeq, 5);
  assert.equal(second.consumedCount, 5);

  const idle = fold.foldEventSubset(second, appendedNoise, isPermission);
  assert.equal(idle, second, 'unchanged events return the same fold');

  const appendedRelevant = [...appendedNoise, permission(6, 'p2')];
  const third = fold.foldEventSubset(second, appendedRelevant, isPermission);
  assert.notEqual(third.relevant, second.relevant);
  assert.deepEqual(third.relevant.map((e) => e.seq), [2, 6]);
});

test('subset fold refilters on replacement and head refill', async () => {
  const { fold } = await importModules();
  const isPermission = (e) => e.payload.type === 'permission_required';
  const tail = [delta(10), permission(11, 'p1')];
  const first = fold.foldEventSubset(null, tail, isPermission);

  // Backfill inserted older events before the consumed marker => reset.
  const refilled = [permission(5, 'old'), ...tail];
  const second = fold.foldEventSubset(first, refilled, isPermission);
  assert.deepEqual(second.relevant.map((e) => e.seq), [5, 11]);

  // Different runtime => reset.
  const other = [permission(1, 'x', 'runtime-2')];
  const third = fold.foldEventSubset(second, other, isPermission);
  assert.deepEqual(third.relevant.map((e) => e.payload.request_id), ['x']);
  assert.equal(third.runtimeId, 'runtime-2');
});

test('derivations over relevant subsets match full-event derivations', async () => {
  const { fold, attention, checkpoints, background } = await importModules();
  const events = [];
  let seq = 0;
  const push = (payload) => events.push(event(++seq, payload));
  push({ type: 'user_prompt', text: 'hi' });
  push({ type: 'assistant_delta', text: 'a' });
  push({ type: 'permission_required', request_id: 'r1', tool_name: 'Bash' });
  push({ type: 'tool_use_started', tool_use_id: 't0', raw_name: 'Read', needs_response: false });
  push({
    type: 'checkpoint_created',
    provider: 'claude',
    source: 'claude-file-checkpoint',
    checkpoint_id: 'c1',
    provider_session_id: 's',
    prompt_summary: 'first',
  });
  push({
    type: 'checkpoint_created',
    provider: 'claude',
    source: 'claude-file-checkpoint',
    checkpoint_id: 'c2',
    provider_session_id: 's',
    prompt_summary: 'second',
  });
  push({ type: 'files_rewound', checkpoint_id: 'c1' });
  push({
    type: 'background_task_updated',
    task: {
      task_id: 'b1',
      description: 'build',
      status: 'running',
      started_at: '2026-10-18T00:00:00.000Z',
      updated_at: '2026-10-18T00:00:01.000Z',
    },
  });
  for (let i = 0; i < 20; i += 1) push({ type: 'assistant_delta', text: `n${i}` });

  const attentionSubset = fold.foldEventSubset(null, events, attention.isAttentionRelevantEvent).relevant;
  const checkpointSubset = fold.foldEventSubset(null, events, checkpoints.isFileCheckpointEvent).relevant;
  const backgroundSubset = fold.foldEventSubset(null, events, background.isBackgroundTaskEvent).relevant;

  assert.ok(attentionSubset.length < events.length);
  assert.deepEqual(
    attention.extractAttentionState(attentionSubset),
    attention.extractAttentionState(events),
  );
  const fullCheckpoints = checkpoints.deriveNativeFileCheckpoints(events);
  assert.deepEqual(checkpoints.deriveNativeFileCheckpoints(checkpointSubset), fullCheckpoints);
  assert.deepEqual(fullCheckpoints.map((c) => [c.checkpointId, c.turnIndex, c.status]), [
    ['c2', 2, 'available'],
    ['c1', 1, 'rewound'],
  ]);
  const summary = { background_tasks: undefined, last_event_seq: null };
  const fullBackground = background.deriveWorkspaceBackgroundTasks(summary, events);
  assert.deepEqual(background.deriveWorkspaceBackgroundTasks(summary, backgroundSubset), fullBackground);
  assert.deepEqual(fullBackground.active.map((t) => t.task_id), ['b1']);
});

test('background task derivation still orders unsorted input by seq', async () => {
  const { background } = await importModules();
  const running = {
    task_id: 'b1',
    description: 'build',
    status: 'running',
    started_at: '2026-10-18T00:00:00.000Z',
    updated_at: '2026-10-18T00:00:01.000Z',
  };
  const done = { ...running, status: 'completed', updated_at: '2026-10-18T00:00:05.000Z' };
  const unsorted = [
    event(5, { type: 'background_task_updated', task: done }),
    event(2, { type: 'background_task_updated', task: running }),
  ];
  const result = background.deriveWorkspaceBackgroundTasks(
    { background_tasks: undefined, last_event_seq: null },
    unsorted,
  );
  assert.deepEqual(result.active, []);
  assert.deepEqual(result.recent.map((t) => t.status), ['completed']);
  assert.equal(unsorted[0].seq, 5, 'input array is not mutated');
});
