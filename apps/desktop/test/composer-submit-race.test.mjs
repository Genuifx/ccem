import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceSessionComposer.tsx');

async function readComposerSource() {
  return fs.readFile(sourcePath, 'utf8');
}

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `missing ${endNeedle}`);
  return source.slice(start, end);
}

// Live structured snapshot, payload ownership, and same-batch input+submit
// races are covered with real DOM behavior in composer-admission-dom.test.mjs.

// Successful cleanup (including slow ACK edits and rich payload ownership) is
// exercised through the actual PromptArea DOM in composer-admission-dom.test.mjs.
// An unconditional setAttachments([]) source assertion hid draft-loss races.

test('composer submit refreshes skills only for potential references before resolving selected skill files', async () => {
  const source = await readComposerSource();
  const submitBlock = sliceBetween(source, 'const runComposerSubmit = useCallback', 'const handleComposerSubmit = useCallback');
  const refreshIndex = submitBlock.indexOf('await onRefreshSkills()');
  const resolveIndex = submitBlock.indexOf('selectedSkillFilesFromComposerText(promptValue, provider, latestInstalledSkills, workspaceCommands)');

  assert.match(
    submitBlock,
    /if \(onRefreshSkills && composerTextMayContainSkillReference\(promptValue\)\) \{/,
    'ordinary prompts must submit from cached skills without waiting for a workspace skill scan',
  );
  assert.notEqual(refreshIndex, -1, 'missing submit-time skill refresh');
  assert.notEqual(resolveIndex, -1, 'missing refreshed skill list in selected skill resolution');
  assert.ok(refreshIndex < resolveIndex, 'skills must refresh before selected skill resolution');
});

test('composer submit surfaces selected skill read failures instead of sending raw slash prompts', async () => {
  const source = await readComposerSource();
  const submitBlock = sliceBetween(source, 'const runComposerSubmit = useCallback', 'const handleComposerSubmit = useCallback');

  assert.match(submitBlock, /toast\.error\(t\('workspace\.composerSkillReadFailed'\)\);/);
  assert.match(submitBlock, /return false;/);
  assert.match(submitBlock, /Failed to read selected skill files for composer prompt/);
});

test('composer attachment ref updates synchronously when pasted attachments are added', async () => {
  const source = await readComposerSource();
  const addBlock = sliceBetween(source, 'const addAttachments = useCallback', 'const syncComposerSegments');

  assert.match(addBlock, /const next = mergeComposerAttachments\(attachmentsRef\.current, nextAttachments\);/);
  assert.match(addBlock, /attachmentsRef\.current = next;/);
  assert.match(addBlock, /setAttachments\(next\);/);
});

test('composer forwards all pasted images from PromptArea', async () => {
  const source = await readComposerSource();

  assert.match(source, /onImagePaste=\{\(files\) => void handleImagePaste\(files\)\}/);
  assert.doesNotMatch(source, /handleImagePaste\(\[file\]\)/);
});

test('composer inserts pasted image chips before registering attachments', async () => {
  const source = await readComposerSource();
  const pasteBlock = sliceBetween(source, 'const handleImagePaste = useCallback', 'const handleBeforeTextPaste');
  const insertIndex = pasteBlock.indexOf('promptAreaRef.current?.insertChip');
  const addIndex = pasteBlock.indexOf('addAttachments(imageAttachments)');

  assert.notEqual(insertIndex, -1, 'missing pasted image chip insertion');
  assert.notEqual(addIndex, -1, 'missing pasted image attachment registration');
  assert.ok(
    insertIndex < addIndex,
    'new image chips must exist before attachment pruning can see the new image attachments',
  );
});

test('composer image preview dialog sizes itself from the loaded image', async () => {
  const source = await readComposerSource();
  const previewBlock = sliceBetween(source, 'open={previewingImage !== null}', '</Dialog>');

  assert.match(source, /const \[previewImageSize, setPreviewImageSize\] = useState/);
  assert.match(source, /const previewImageFrameStyle = useMemo<CSSProperties \| undefined>/);
  assert.match(
    source,
    /width: `min\(\$\{previewImageSize\.width\}px, min\(92vw, 960px\), calc\(min\(78vh, 720px\) \* \$\{previewImageSize\.width\} \/ \$\{previewImageSize\.height\}\)\)`/,
  );
  assert.match(previewBlock, /className="w-fit max-w-\[calc\(100vw-2rem\)\]/);
  assert.match(previewBlock, /style=\{previewImageFrameStyle\}/);
  assert.match(previewBlock, /naturalWidth/);
  assert.match(previewBlock, /naturalHeight/);
  assert.doesNotMatch(previewBlock, /flex max-h-\[min\(78vh,720px\)\] w-full/);
});
