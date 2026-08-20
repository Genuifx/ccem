import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importTranscriptModule() {
  const [source, identitySource] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceEventTranscript.ts'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'components', 'workspace', 'transcriptIdentity.ts'), 'utf8'),
  ]);
  const compile = (text) => ts.transpileModule(text, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-transcript-tail-bound-'));
  const outputPath = path.join(tempDir, 'workspaceEventTranscript.mjs');
  const identityPath = path.join(tempDir, 'transcriptIdentity.mjs');
  await fs.writeFile(
    outputPath,
    compile(source).replace("from './transcriptIdentity'", "from './transcriptIdentity.mjs'"),
    'utf8',
  );
  await fs.writeFile(identityPath, compile(identitySource), 'utf8');
  return import(pathToFileURL(outputPath).href);
}

const RUNTIME_ID = 'runtime-tail-bound';
const BASE_TS = Date.UTC(2026, 7, 1, 0, 0, 0);
const TOTAL = 20_000;
const TAIL_LIMIT = 5_000;

function ev(seq, payload) {
  return {
    runtime_id: RUNTIME_ID,
    seq,
    occurred_at: new Date(BASE_TS + seq * 10).toISOString(),
    payload,
  };
}

function snapshotPayload(seq) {
  return {
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
      revision: seq,
      items: [{ id: 'only', text: `task ${seq}`, status: 'in_progress' }],
    },
  };
}

function payloadFor(seq) {
  if (seq === 5000 || seq % 500 === 0) {
    return {
      type: 'checkpoint_created',
      provider: 'claude',
      source: 'claude-file-checkpoint',
      checkpoint_id: `cp-${seq}`,
      provider_session_id: 'sess-1',
      prompt_summary: `turn at ${seq}`,
    };
  }
  if (seq === 5005) {
    // Pairing-free anchor right after the real hole (a terminal prompt here
    // would be semantically resolved by the later resolve at 8001).
    return { type: 'files_rewound', checkpoint_id: 'cp-5000', file_count: 1 };
  }
  if (seq === 14_999) {
    return { type: 'terminal_prompt_required', prompt_kind: 'confirm', prompt_text: 'proceed?' };
  }
  if (seq === 8_442) {
    return { type: 'terminal_prompt_required', prompt_kind: 'confirm', prompt_text: 'old prompt' };
  }
  if (seq === 8_443) {
    return { type: 'terminal_prompt_resolved' };
  }
  if (seq === 7_777) {
    return {
      type: 'permission_required',
      request_id: 'perm-unresolved',
      tool_name: 'Bash',
      input_summary: 'rm -rf',
    };
  }
  if (seq % 500 === 2) {
    return {
      type: 'permission_required',
      request_id: `perm-${seq}`,
      tool_name: 'Bash',
      input_summary: 'echo',
    };
  }
  if (seq % 500 === 3) {
    return { type: 'permission_responded', request_id: `perm-${seq - 1}`, approved: true };
  }
  if (seq % 1_500 === 1) {
    return { type: 'files_rewound', checkpoint_id: `cp-${seq - 1}`, file_count: 2 };
  }
  if (seq === 1_111 || seq === 9_111) {
    return snapshotPayload(seq);
  }
  if (seq === 14_998) {
    return { type: 'session_completed', reason: 'Stopped from desktop workspace' };
  }
  return { type: 'assistant_chunk', text: `chunk ${seq} ` };
}

/**
 * Seqs 5001..5004 are deliberately absent: a REAL event hole between two
 * adjacent retained anchors (5000 checkpoint, 5005 terminal prompt), so gap
 * detection must fire there even under full seam suppression.
 */
function buildFixture() {
  const events = [];
  for (let seq = 1; seq <= TOTAL; seq += 1) {
    if (seq > 5_000 && seq < 5_005) {
      continue;
    }
    events.push(ev(seq, payloadFor(seq)));
  }
  return events;
}

function anchorSeqs(events) {
  return new Set(events.map((event) => event.seq));
}

test('pruning keeps the tail window plus every anchor kind', async () => {
  const mod = await importTranscriptModule();
  const events = buildFixture();

  const pruned = mod.pruneRawEventTail(events, TAIL_LIMIT);
  assert.equal(mod.RAW_TAIL_LIMIT, 5_000);
  assert.ok(pruned.prunedCount > 14_000, `pruned a real head (got ${pruned.prunedCount})`);
  assert.ok(pruned.events.length > TAIL_LIMIT);
  assert.ok(pruned.events.length <= TAIL_LIMIT + 200, 'anchor overhead stays small');

  const retained = anchorSeqs(pruned.events);
  // Tail window: the newest 5000 seqs are untouched.
  for (let seq = TOTAL - 4; seq <= TOTAL; seq += 1) {
    assert.ok(retained.has(seq), `tail seq ${seq} must be retained`);
  }
  // Anchors below the window.
  assert.ok(retained.has(500), 'user-visible checkpoint anchor kept');
  assert.ok(retained.has(7_777), 'unresolved permission kept');
  assert.ok(retained.has(14_999), 'unresolved terminal prompt kept');
  assert.ok(retained.has(9_111), 'newest todo snapshot below the window kept');
  assert.ok(retained.has(14_998), 'session_completed kept');
  assert.ok(retained.has(1_501), 'files_rewound kept');
  // Non-anchors dropped; resolved pairs dropped together.
  assert.ok(!retained.has(4), 'plain chunk dropped');
  assert.ok(!retained.has(502) && !retained.has(503), 'resolved permission pair dropped');
  assert.ok(!retained.has(8_442) && !retained.has(8_443), 'resolved terminal pair dropped');
  assert.ok(!retained.has(1_111), 'superseded todo snapshot dropped');

  // Ordering survives: strictly ascending.
  for (let index = 1; index < pruned.events.length; index += 1) {
    assert.ok(pruned.events[index].seq > pruned.events[index - 1].seq);
  }
});

test('prune seams do not fire gap detection, real holes do', async () => {
  const mod = await importTranscriptModule();
  const events = buildFixture();
  const pruned = mod.pruneRawEventTail(events, TAIL_LIMIT);
  assert.ok(pruned.seams.length > 0, 'prune records seams');
  assert.ok(pruned.seams.includes(500), 'first anchor after a skipped run is a seam');

  const deriveGapIds = (suppress) => mod.finalizeTranscriptMessages(
    mod.deriveTranscriptReset([], [], pruned.events, null, suppress),
  ).filter((message) => message.summary === mod.TRANSCRIPT_GAP_SUMMARY_TOKEN)
    .map((message) => message.uuid);

  const unsuppressed = deriveGapIds(undefined);
  assert.ok(unsuppressed.length > 0, 'without suppression the seams look like gaps');

  const suppressed = deriveGapIds({ suppressGapBeforeSeqs: new Set(pruned.seams) });
  // The only surviving gap must be the real hole 5000 -> 5005.
  assert.deepEqual(suppressed, ['transcript-gap-5000-5005']);
});

test('append selection survives pruning and refills trigger a reset', async () => {
  const mod = await importTranscriptModule();
  const events = buildFixture();
  const pruned = mod.pruneRawEventTail(events, TAIL_LIMIT);

  const state = mod.deriveTranscriptReset(
    [],
    [],
    pruned.events,
    null,
    { suppressGapBeforeSeqs: new Set(pruned.seams) },
  );

  // New events after the pruned array: pure suffix extension -> append.
  const withNew = [...pruned.events, ev(TOTAL + 1, { type: 'assistant_chunk', text: 'more ' })];
  let selection = mod.selectTranscriptAppendEvents(withNew, state);
  assert.equal(selection.mode, 'append');
  assert.equal(selection.appended.length, 1);

  // Same array, nothing new: idle.
  selection = mod.selectTranscriptAppendEvents(pruned.events, state);
  assert.equal(selection.mode, 'idle');

  // Refilled head (merge/backfill of the complete list): reset.
  const refilled = [...events, ev(TOTAL + 1, { type: 'assistant_chunk', text: 'more ' })];
  selection = mod.selectTranscriptAppendEvents(refilled, state);
  assert.equal(selection.mode, 'reset');
});
