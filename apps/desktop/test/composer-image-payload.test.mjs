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

test('new and resumed workspace sessions pass all composer images as initialImages', async () => {
  const source = await readSource('pages', 'Workspace.tsx');

  for (const handler of ['runCreateNativeConversation', 'runContinueHistorySession']) {
    const block = sliceBetween(source, `const ${handler} = useCallback`, '  }, [');
    assert.match(block, /const attachments = payload\?\.attachments \?\? \[\];/);
    assert.match(block, /const images = extractComposerImagePayloads\(attachments\);/);
    assert.match(block, /initialImages: images\.length > 0 \? images : undefined,/);
    assert.match(block, /initialAnnotations: payload\?\.annotations,/);
  }

  // The public handlers wrap the run* bodies with the synchronous in-flight
  // guard (same-tick double submit protection); the wrappers must delegate.
  for (const handler of ['handleCreateNativeConversation', 'handleContinueHistorySession']) {
    const block = sliceBetween(source, `const ${handler} = useCallback`, '  }, [');
    assert.match(block, /guard\.begin\(\)/);
    assert.match(block, /finally \{\n      guard\.end\(\);/);
  }
});

test('live session sends queued and direct composer images to native runtime', async () => {
  const source = await readSource('components', 'workspace', 'WorkspaceNativeSessionView.tsx');
  const batchBlock = sliceBetween(source, 'const sendPromptBatch = useCallback', '  }, [buildQueuedBatchText');
  const replyBlock = sliceBetween(source, 'const sendInteractivePromptReply = useCallback', '  }, [');

  assert.match(batchBlock, /const allAttachments = prompts\.flatMap\(\(p\) => p\.attachments\);/);
  assert.match(batchBlock, /const images = extractComposerImagePayloads\(allAttachments\);/);
  assert.match(batchBlock, /images\.length > 0 \? images : undefined,/);

  assert.match(replyBlock, /const images = extractComposerImagePayloads\(payload\.attachments \?\? \[\]\);/);
  assert.match(replyBlock, /requestImages = images\.length > 0 \? images : undefined;/);
  assert.match(
    replyBlock,
    /await sendNativeSessionInput\([\s\S]*?session\.runtime_id,[\s\S]*?requestText,[\s\S]*?requestImages,[\s\S]*?promptEntry\.text,[\s\S]*?payload\.annotations,/,
  );
});
