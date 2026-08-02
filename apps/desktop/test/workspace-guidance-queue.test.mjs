import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function readSource(...segments) {
  const source = await fs.readFile(path.join(desktopDir, 'src', ...segments), 'utf8');
  return source.replace(/\r\n?/g, '\n');
}

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return source.slice(start, end);
}

test('live session guidance queues during active or blocked turns without interrupting them', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const queueBranch = sliceBetween(
    source,
    'if (isProcessingTurn || hasHardBlockingAttention) {',
    'if (queuedMessages.length > 0 && !hasBlockingAttention) {',
  );

  assert.match(queueBranch, /setQueuedMessages\(\(previous\) => \[\.\.\.previous, nextPrompt\]\);/);
  assert.doesNotMatch(queueBranch, /stopNativeSession|handleStop|interrupt|sendNativeSessionInput/);
});

test('live session guidance flush waits for current turn completion and terminal safety', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const flushBlock = sliceBetween(
    source,
    'const flushQueuedMessages = useCallback(async () => {',
    'const handlePermission = useCallback',
  );

  assert.match(flushBlock, /isProcessingTurn/);
  assert.match(flushBlock, /hasBlockingAttention/);
  assert.match(flushBlock, /isTerminalStatus\(session\.status\)/);
  assert.match(flushBlock, /await sendPromptBatch\(pendingBatch\);/);
});

test('queued guidance keeps priority over later direct input', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const priorityBlock = sliceBetween(
    source,
    'if (queuedMessages.length > 0 && !hasBlockingAttention) {',
    'try {\n      await sendPromptBatch([nextPrompt]);',
  );

  assert.match(priorityBlock, /const pendingBatch = \[\.\.\.queuedMessages, nextPrompt\];/);
  assert.match(priorityBlock, /setQueuedMessages\(\[\]\);/);
  assert.match(priorityBlock, /await sendPromptBatch\(pendingBatch\);/);
  assert.match(priorityBlock, /setQueuedMessages\(pendingBatch\);/);
});

test('queued guidance persists per runtime and strips object urls from stored images', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');

  assert.match(source, /GUIDANCE_QUEUE_STORAGE_PREFIX = 'ccem:workspace-native-guidance-queue:v1:'/);
  assert.match(source, /runtimeId: session\.runtime_id/);
  assert.match(source, /previousState\.runtimeId === session\.runtime_id/);
  assert.match(source, /readStoredGuidanceQueue\(session\.runtime_id\)/);
  assert.match(source, /queuedState\.runtimeId !== session\.runtime_id/);
  assert.match(source, /writeStoredGuidanceQueue\(queuedState\.runtimeId, queuedState\.messages\);/);
  assert.match(source, /objectUrl: null,/);
  assert.match(source, /window\.sessionStorage\.setItem/);
});

test('composer presents queued messages as model guidance', async () => {
  const composerSource = await readSource('components', 'workspace', 'WorkspaceSessionComposer.tsx');
  const zh = JSON.parse(await readSource('locales', 'zh.json'));
  const en = JSON.parse(await readSource('locales', 'en.json'));

  assert.match(composerSource, /MessageSquareQuote/);
  assert.match(composerSource, /composerQueuedWaiting/);
  assert.equal(zh.workspace.composerGuideModel, '引导模型');
  assert.equal(zh.workspace.composerQueuedTitle, '引导模型');
  assert.match(zh.workspace.composerQueuedWaiting, /不会中断当前执行/);
  assert.equal(en.workspace.composerGuideModel, 'Guide model');
  assert.match(en.workspace.composerQueuedWaiting, /Does not interrupt/);
});
