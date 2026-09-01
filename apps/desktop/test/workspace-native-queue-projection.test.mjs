import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';

const desktopDir = path.resolve(import.meta.dirname, '..');

async function importProjection() {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceNativeQueueProjection.ts'),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-native-queue-projection-'));
  const outputPath = path.join(tempDir, 'projection.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function localPrompt(overrides = {}) {
  return {
    id: 'message-1',
    text: 'queued text',
    deferUntilPersisted: true,
    queuedBehindTurn: true,
    queuedDeliveryState: 'pending',
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    client_message_id: 'message-1',
    display_text: 'queued text',
    delivery_state: 'pending',
    ...overrides,
  };
}

test('queue reconciliation tracks delivery state and preserves rich optimistic payloads', async () => {
  const { reconcileNativeQueuedPrompts } = await importProjection();
  const previous = [localPrompt({
    images: [{ mediaType: 'image/png', base64Data: 'local-image' }],
    annotations: [{ quote: 'before', note: 'keep me' }],
  })];

  const next = reconcileNativeQueuedPrompts(previous, [snapshot({
    delivery_state: 'delivery_uncertain',
  })], {
    activeCommandId: 'command-1',
    expectedQueueCount: 1,
    isTerminal: false,
  });

  assert.equal(next.length, 1);
  assert.equal(next[0].queuedDeliveryState, 'delivery_uncertain');
  assert.equal(next[0].images[0].base64Data, 'local-image');
  assert.deepEqual(next[0].annotations, [{ quote: 'before', note: 'keep me' }]);
});

test('native queued prompts project to the composer queue instead of the transcript', async () => {
  const { partitionNativeQueuedPromptPresentation } = await importProjection();
  const directPrompt = localPrompt({
    id: 'direct-message',
    text: 'already sending',
    queuedBehindTurn: undefined,
    queuedDeliveryState: undefined,
  });
  const queuedPrompt = localPrompt({
    id: 'queued-message',
    text: 'wait above the composer',
    queuedDeliveryState: 'dispatching',
  });

  const projection = partitionNativeQueuedPromptPresentation([
    directPrompt,
    queuedPrompt,
  ]);

  assert.deepEqual(projection.transcriptPrompts, [directPrompt]);
  assert.deepEqual(projection.composerQueuedMessages, [{
    id: 'queued-message',
    text: 'wait above the composer',
    displayText: 'wait above the composer',
    deliveryState: 'dispatching',
    removable: false,
    flushable: false,
  }]);
});

test('only backend pending rows expose the safe cancel action', async () => {
  const { partitionNativeQueuedPromptPresentation } = await importProjection();
  const projection = partitionNativeQueuedPromptPresentation([
    localPrompt({ id: 'pending', queuedDeliveryState: 'pending' }),
    localPrompt({ id: 'dispatching', queuedDeliveryState: 'dispatching' }),
    localPrompt({ id: 'uncertain', queuedDeliveryState: 'delivery_uncertain' }),
  ]);

  assert.deepEqual(
    projection.composerQueuedMessages.map((message) => [
      message.id,
      message.removable,
    ]),
    [
      ['pending', true],
      ['dispatching', false],
      ['uncertain', false],
    ],
  );
});

test('an incomplete snapshot cannot erase a queued optimistic row', async () => {
  const { reconcileNativeQueuedPrompts } = await importProjection();
  const previous = [localPrompt()];
  const next = reconcileNativeQueuedPrompts(previous, [], {
    activeCommandId: 'command-1',
    expectedQueueCount: 1,
    isTerminal: false,
  });

  assert.equal(next, previous);
});

test('an authoritative absence waits for renderer observation before removing an admitted row', async () => {
  const { reconcileNativeQueuedPrompts } = await importProjection();
  const previous = [localPrompt()];

  const admittedNotObserved = reconcileNativeQueuedPrompts(previous, [], {
    activeCommandId: 'command-2',
    expectedQueueCount: 0,
    isTerminal: false,
    observedClientMessageIds: new Set(['message-1']),
  });
  assert.equal(admittedNotObserved, previous);

  const cancelled = reconcileNativeQueuedPrompts(previous, [], {
    activeCommandId: null,
    expectedQueueCount: 0,
    isTerminal: false,
  });
  assert.deepEqual(cancelled, []);
});

test('a complete snapshot rebuilds the native queue in backend FIFO order', async () => {
  const { reconcileNativeQueuedPrompts } = await importProjection();
  const localSecond = localPrompt({ id: 'message-2', text: 'second' });
  const next = reconcileNativeQueuedPrompts([localSecond], [
    snapshot({ client_message_id: 'message-1', display_text: 'first' }),
    snapshot({ client_message_id: 'message-2', display_text: 'second' }),
  ], {
    activeCommandId: 'command-1',
    expectedQueueCount: 2,
    isTerminal: false,
  });

  assert.deepEqual(next.map((prompt) => prompt.id), ['message-1', 'message-2']);
});

test('an empty backend snapshot clears a stale row when lifecycle projection is unavailable', async () => {
  const { reconcileNativeQueuedPrompts } = await importProjection();
  const previous = [localPrompt()];

  const next = reconcileNativeQueuedPrompts(previous, [], {
    activeCommandId: null,
    expectedQueueCount: undefined,
    isTerminal: false,
  });

  assert.deepEqual(next, []);
});

test('remount restores backend rows and stale renderer state is corrected', async () => {
  const { reconcileNativeQueuedPrompts } = await importProjection();
  const item = snapshot({
    delivery_state: 'dispatching',
    images: [{ mediaType: 'image/png', base64Data: 'restored-image' }],
    annotations: [{ quote: 'restored', note: 'annotation' }],
  });

  const restored = reconcileNativeQueuedPrompts([], [item], {
    activeCommandId: 'command-1',
    afterEventSeq: 12,
    expectedQueueCount: 1,
    isTerminal: false,
    now: 1234,
  });
  assert.deepEqual(restored, [{
    id: 'message-1',
    text: 'queued text',
    images: item.images,
    annotations: item.annotations,
    timestamp: 1234,
    afterEventSeq: 12,
    deferUntilPersisted: true,
    queuedBehindTurn: true,
    queuedDeliveryState: 'dispatching',
  }]);

  const corrected = reconcileNativeQueuedPrompts([
    localPrompt({ queuedBehindTurn: undefined, queuedDeliveryState: undefined }),
  ], [item], {
    activeCommandId: 'command-1',
    expectedQueueCount: 1,
    isTerminal: false,
  });
  assert.equal(corrected[0].queuedBehindTurn, true);
  assert.equal(corrected[0].queuedDeliveryState, 'dispatching');
});
