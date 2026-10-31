import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(__dirname, '..', 'src', 'components', 'workspace');

async function importCheckpoints() {
  const source = await fs.readFile(path.join(workspaceDir, 'workspaceNativeCheckpoints.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-checkpoint-map-'));
  const file = path.join(tempDir, 'workspaceNativeCheckpoints.mjs');
  await fs.writeFile(file, output, 'utf8');
  return import(pathToFileURL(file).href);
}

const event = (seq, payload) => ({
  runtime_id: 'runtime-1',
  seq,
  occurred_at: `2026-10-31T00:00:${String(seq).padStart(2, '0')}.000Z`,
  payload,
});
const prompt = (seq, text) => event(seq, { type: 'user_prompt', text, image_count: 0 });
const checkpoint = (seq, id, summary = null) => event(seq, {
  type: 'checkpoint_created',
  provider: 'claude',
  checkpoint_id: id,
  provider_session_id: 'sdk-1',
  prompt_summary: summary,
  source: 'claude-file-checkpoint',
});

test('each checkpoint attaches to the user prompt message that precedes it', async () => {
  const { mapCheckpointsToUserPromptMessages } = await importCheckpoints();
  const map = mapCheckpointsToUserPromptMessages([
    prompt(1, 'first'),
    checkpoint(2, 'cp-a', '<system_tip>…</system_tip> first'),
    event(3, { type: 'assistant_delta', text: 'ok' }),
    prompt(4, 'second'),
    checkpoint(5, 'cp-b'),
  ]);

  assert.deepEqual([...map.keys()], ['user-prompt-1', 'user-prompt-4']);
  assert.equal(map.get('user-prompt-1').checkpointId, 'cp-a');
  assert.equal(map.get('user-prompt-4').checkpointId, 'cp-b');
});

test('SDK-only user messages and duplicate checkpoint events get no transcript anchor', async () => {
  const { mapCheckpointsToUserPromptMessages } = await importCheckpoints();
  const map = mapCheckpointsToUserPromptMessages([
    checkpoint(1, 'cp-sdk-only'),
    prompt(2, 'real prompt'),
    checkpoint(3, 'cp-real'),
    checkpoint(4, 'cp-extra'),
    checkpoint(5, 'cp-real'),
  ]);

  assert.deepEqual([...map.entries()].map(([key, value]) => [key, value.checkpointId]), [
    ['user-prompt-2', 'cp-real'],
  ]);
});

test('a prompt whose checkpoint never arrived yields to the next prompt', async () => {
  const { mapCheckpointsToUserPromptMessages } = await importCheckpoints();
  const map = mapCheckpointsToUserPromptMessages([
    prompt(1, 'no checkpoint'),
    prompt(2, 'next'),
    checkpoint(3, 'cp-next'),
  ]);

  assert.equal(map.has('user-prompt-1'), false);
  assert.equal(map.get('user-prompt-2').checkpointId, 'cp-next');
});

test('rewind status carries onto the mapped checkpoint', async () => {
  const { mapCheckpointsToUserPromptMessages, isUserPromptCheckpointEvent } = await importCheckpoints();
  const events = [
    prompt(1, 'edit files'),
    checkpoint(2, 'cp-a'),
    event(3, { type: 'files_rewound', provider: 'claude', checkpoint_id: 'cp-a', files_changed: [] }),
  ];
  assert.ok(events.every(isUserPromptCheckpointEvent));
  assert.equal(mapCheckpointsToUserPromptMessages(events).get('user-prompt-1').status, 'rewound');
});
