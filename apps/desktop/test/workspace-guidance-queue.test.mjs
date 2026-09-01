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

test('live session guidance delegates active or blocked turns to the backend queue', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const queueBranch = sliceBetween(
    source,
    'if (isProcessingTurn || hasHardBlockingAttention) {',
    'const liveQueuedState = queuedStateRef.current;',
  );

  assert.match(queueBranch, /await sendPromptBatch\(\[nextPrompt\], \{ queuedBehindTurn: true \}\);/);
  assert.doesNotMatch(queueBranch, /setQueuedMessages|stopNativeSession|handleStop|interrupt/);
});

test('legacy renderer queue migrates to backend during a live turn but stays terminal-safe', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const flushBlock = sliceBetween(
    source,
    'const flushQueuedMessages = useCallback((): Promise<boolean> => {',
    'const handleSend = useCallback',
  );

  assert.doesNotMatch(flushBlock, /isProcessingTurn/);
  assert.doesNotMatch(flushBlock, /hasBlockingAttention/);
  assert.match(flushBlock, /isTerminalStatus\(session\.status\)/);
  assert.match(flushBlock, /await waitForPendingEnvironmentUpdate\(\)/);
  assert.match(flushBlock, /await sendPromptBatch\(pendingBatch, \{ queuedBehindTurn: true \}\);/);
  assert.match(flushBlock, /queuedFlushLeaseRef\.current = lease/);
});

test('queued guidance keeps priority over later direct input', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const priorityBlock = sliceBetween(
    source,
    'const legacyQueueMigrationPending = (',
    'try {\n      await sendPromptBatch([nextPrompt]);',
  );

  assert.match(priorityBlock, /if \(!await flushQueuedMessages\(\)\) \{/);
  assert.match(priorityBlock, /await sendPromptBatch\(\[nextPrompt\], \{ queuedBehindTurn: true \}\);/);
  assert.doesNotMatch(priorityBlock, /\[\.\.\.queuedMessages, nextPrompt\]/);
});

test('accepted backend enqueue re-arms the composer before best-effort projection refresh', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const sendBlock = sliceBetween(
    source,
    'const sendPromptBatch = useCallback',
    'const applyRuntimePlanModeChange = useCallback',
  );

  assert.match(sendBlock, /await sendNativeSessionInput\(/);
  assert.match(sendBlock, /finally \{[\s\S]*?setIsSending\(false\);[\s\S]*?\}/);
  assert.match(sendBlock, /void Promise\.allSettled\(\[/);
  assert.doesNotMatch(sendBlock, /await Promise\.allSettled\(\[/);
});

test('legacy renderer queue remains readable for one-time backend migration', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');

  assert.match(source, /GUIDANCE_QUEUE_STORAGE_PREFIX = 'ccem:workspace-native-guidance-queue:v1:'/);
  assert.match(source, /runtimeId: session\.runtime_id/);
  assert.match(source, /previousState\.runtimeId === session\.runtime_id/);
  assert.match(source, /readStoredGuidanceQueue\(session\.runtime_id\)/);
  assert.match(source, /queuedState\.runtimeId !== session\.runtime_id/);
  assert.match(source, /writeStoredGuidanceQueue\(queuedState\.runtimeId, queuedState\.messages\);/);
  assert.match(source, /objectUrl: null,/);
  assert.match(source, /window\.sessionStorage\.setItem/);
  const runtimeReset = sliceBetween(
    source,
    'activeCacheRuntimeRef.current = session.runtime_id;',
    'setSelectedFileCheckpoint(null);',
  );
  assert.doesNotMatch(runtimeReset, /setQueuedMessages\(\[\]\)/);
});

test('composer presents queued messages as model guidance', async () => {
  const nativeViewSource = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const composerSource = await readSource('components', 'workspace', 'WorkspaceSessionComposer.tsx');
  const zh = JSON.parse(await readSource('locales', 'zh.json'));
  const en = JSON.parse(await readSource('locales', 'en.json'));

  assert.match(nativeViewSource, /partitionNativeQueuedPromptPresentation/);
  assert.match(
    nativeViewSource,
    /\.\.\.nativeQueuedPromptPresentation\.composerQueuedMessages,[\s\S]*?\.\.\.queuedMessages/,
  );
  assert.match(nativeViewSource, /queuedMessages=\{composerQueuedMessages\}/);
  assert.doesNotMatch(nativeViewSource, /queuedMessages=\{queuedMessages\}/);
  assert.match(composerSource, /MessageSquareQuote/);
  assert.match(composerSource, /data-ccem-composer-queue/);
  assert.match(composerSource, /data-ccem-composer-queue-heading/);
  assert.match(composerSource, /composerQueuedWaiting/);
  assert.doesNotMatch(composerSource, /composerQueuedCount|composerQueuedTitle/);
  assert.equal(zh.workspace.composerGuideModel, '引导模型');
  assert.match(zh.workspace.composerQueuedWaiting, /不会中断当前执行/);
  assert.equal(en.workspace.composerGuideModel, 'Guide model');
  assert.match(en.workspace.composerQueuedWaiting, /Does not interrupt/);
});

test('pending native rows cancel through the trusted backend command only after success', async () => {
  const nativeViewSource = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const projectionSource = await readSource('components', 'workspace', 'workspaceNativeQueueProjection.ts');
  const hooksSource = await readSource('hooks', 'useTauriCommands.ts');
  const permissionSource = await fs.readFile(
    path.join(desktopDir, 'src-tauri', 'permissions', 'trusted-app-commands.toml'),
    'utf8',
  );

  assert.match(projectionSource, /removable: \(prompt\.queuedDeliveryState \?\? 'pending'\) === 'pending'/);
  assert.match(hooksSource, /invoke<number>\('cancel_native_session_queued_input'/);
  assert.match(permissionSource, /"cancel_native_session_queued_input"/);
  const cancelBlock = sliceBetween(
    nativeViewSource,
    'const handleRemoveQueuedMessage = useCallback',
    'const handlePermission = useCallback',
  );
  const invokeIndex = cancelBlock.indexOf('await cancelNativeSessionQueuedInput');
  const removeIndex = cancelBlock.indexOf('setLocalUserPrompts');
  assert.ok(invokeIndex >= 0 && removeIndex > invokeIndex, 'backend success must precede optimistic removal');
  assert.match(cancelBlock, /queueSnapshotRequestSeqRef\.current \+= 1/);
  assert.match(cancelBlock, /composerCancelQueuedFailed/);
});
