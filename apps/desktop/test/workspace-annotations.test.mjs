import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const desktopDir = path.resolve(import.meta.dirname, '..');

async function importWorkspaceAnnotations() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-annotations-'));
  const outfile = path.join(tempDir, 'workspaceAnnotations.mjs');
  await build({
    entryPoints: [path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceAnnotationModel.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
  });
  return import(`${outfile}?v=${Date.now()}`);
}

async function importWorkspaceAnnotationRects() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-annotation-rects-'));
  const outfile = path.join(tempDir, 'workspaceAnnotationRects.mjs');
  await build({
    entryPoints: [path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceAnnotationRects.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
  });
  return import(`${outfile}?v=${Date.now()}`);
}

test('annotation highlights use selected text boxes instead of broad layout boxes', async () => {
  const { visibleTextRangeRects } = await importWorkspaceAnnotationRects();
  const firstText = { nodeType: 3, data: '  selected' };
  const interBlockWhitespace = { nodeType: 3, data: '\n    ' };
  const lastText = { nodeType: 3, data: 'words  ' };
  const unselectedTail = { nodeType: 3, data: 'must not be scanned' };
  const nodes = [firstText, interBlockWhitespace, lastText, unselectedTail];
  const visitedNodes = [];
  const textRects = new Map([
    [firstText, [{ left: 20, top: 10, right: 84, bottom: 28, width: 64, height: 18 }]],
    [interBlockWhitespace, []],
    [lastText, [{ left: 20, top: 82, right: 60, bottom: 100, width: 40, height: 18 }]],
  ]);
  let currentNode = null;
  const ownerDocument = {
    defaultView: { NodeFilter: { SHOW_TEXT: 4 } },
    createTreeWalker() {
      let index = -1;
      return {
        get currentNode() {
          return nodes[index];
        },
        set currentNode(node) {
          index = nodes.indexOf(node);
        },
        nextNode() {
          index += 1;
          if (index < nodes.length) visitedNodes.push(nodes[index]);
          return index < nodes.length;
        },
      };
    },
    createRange() {
      return {
        setStart(node, offset) {
          currentNode = node;
          if (node === firstText) assert.equal(offset, 2);
        },
        setEnd(node, offset) {
          assert.equal(node, currentNode);
          if (node === lastText) assert.equal(offset, 5);
        },
        getClientRects() {
          return textRects.get(currentNode) ?? [];
        },
      };
    },
  };
  const root = {
    nodeType: 1,
    ownerDocument,
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 300, bottom: 120, width: 300, height: 120 };
    },
  };
  const range = {
    commonAncestorContainer: root,
    startContainer: firstText,
    startOffset: 0,
    endContainer: lastText,
    endOffset: lastText.data.length,
    intersectsNode: () => true,
    getClientRects() {
      throw new Error('aggregate Range boxes include block element areas and must not be used');
    },
  };

  assert.deepEqual(visibleTextRangeRects(range, root), [
    { left: 20, top: 10, right: 84, bottom: 28, width: 64, height: 18 },
    { left: 20, top: 82, right: 60, bottom: 100, width: 40, height: 18 },
  ]);
  assert.equal(visitedNodes.includes(unselectedTail), false);
});

test('normalizes selected transcript text without destroying meaningful line breaks', async () => {
  const { normalizeWorkspaceSelection } = await importWorkspaceAnnotations();

  assert.equal(
    normalizeWorkspaceSelection('  first line  \n\n  second line  '),
    'first line\n\n  second line',
  );
  assert.equal(normalizeWorkspaceSelection('   '), null);
  assert.equal(normalizeWorkspaceSelection('x'.repeat(12_001)), null);
});

test('annotation prompt keeps selected text and notes structured and escapes XML', async () => {
  const { buildComposerPromptWithAnnotations } = await importWorkspaceAnnotations();
  const prompt = buildComposerPromptWithAnnotations('Please continue', [
    {
      id: 'a-1',
      quote: 'Use <Button> & keep it',
      note: 'Change "keep" to > remove',
      createdAt: '2026-07-12T00:00:00.000Z',
    },
    {
      id: 'a-2',
      quote: 'Second quote',
      note: 'Second note',
      createdAt: '2026-07-12T00:00:01.000Z',
    },
  ]);

  assert.match(prompt, /<workspace_annotations>/);
  assert.match(prompt, /<selected_text>Use &lt;Button&gt; &amp; keep it<\/selected_text>/);
  assert.match(prompt, /<note>Change &quot;keep&quot; to &gt; remove<\/note>/);
  assert.match(prompt, /<annotation index="2">/);
  assert.match(prompt, /<user_request>\nPlease continue\n<\/user_request>/);
});

test('annotation-only prompt is sendable without inventing a user request body', async () => {
  const { buildComposerPromptWithAnnotations } = await importWorkspaceAnnotations();
  const prompt = buildComposerPromptWithAnnotations('', [{
    id: 'a-1',
    quote: 'Selected text',
    note: 'Fix this',
    createdAt: '2026-07-12T00:00:00.000Z',
  }]);

  assert.match(prompt, /<workspace_annotations>/);
  assert.doesNotMatch(prompt, /<user_request>/);
  assert.match(prompt, /Treat these annotations as the user's requested changes/);
});

test('stored annotations reject malformed records and enforce the session limit', async () => {
  const {
    MAX_WORKSPACE_ANNOTATIONS,
    normalizeStoredWorkspaceAnnotations,
  } = await importWorkspaceAnnotations();
  const records = Array.from({ length: MAX_WORKSPACE_ANNOTATIONS + 3 }, (_, index) => ({
    id: `a-${index}`,
    quote: `quote ${index}`,
    note: `note ${index}`,
    createdAt: '2026-07-12T00:00:00.000Z',
  }));
  records.splice(2, 0, { id: 'bad', quote: '', note: 'missing quote' });

  const normalized = normalizeStoredWorkspaceAnnotations(records);
  assert.equal(normalized.length, MAX_WORKSPACE_ANNOTATIONS);
  assert.equal(normalized.some((item) => item.id === 'bad'), false);
});

test('stored annotations enforce a total prompt budget', async () => {
  const {
    MAX_WORKSPACE_ANNOTATION_TOTAL_CHARS,
    normalizeStoredWorkspaceAnnotations,
  } = await importWorkspaceAnnotations();
  const records = Array.from({ length: 8 }, (_, index) => ({
    id: `large-${index}`,
    quote: 'q'.repeat(10_000),
    note: `note ${index}`,
    createdAt: '2026-07-12T00:00:00.000Z',
  }));

  const normalized = normalizeStoredWorkspaceAnnotations(records);
  const totalChars = normalized.reduce((total, item) => total + item.quote.length + item.note.length, 0);
  assert.ok(totalChars <= MAX_WORKSPACE_ANNOTATION_TOTAL_CHARS);
  assert.ok(normalized.length < records.length);
});

test('stored annotations preserve valid transcript anchors and discard malformed anchors only', async () => {
  const { normalizeStoredWorkspaceAnnotations } = await importWorkspaceAnnotations();
  const normalized = normalizeStoredWorkspaceAnnotations([
    {
      id: 'anchored',
      quote: 'selected text',
      note: 'change this',
      createdAt: '2026-07-13T00:00:00.000Z',
      anchor: {
        startItemKey: 'message-a-segment-0-message',
        startOffset: 4,
        endItemKey: 'message-a-segment-0-message',
        endOffset: 17,
      },
    },
    {
      id: 'legacy',
      quote: 'legacy text',
      note: 'keep working',
      createdAt: '2026-07-13T00:00:01.000Z',
      anchor: { startItemKey: '', startOffset: -1 },
    },
  ]);

  assert.deepEqual(normalized[0].anchor, {
    startItemKey: 'message-a-segment-0-message',
    startOffset: 4,
    endItemKey: 'message-a-segment-0-message',
    endOffset: 17,
  });
  assert.equal('anchor' in normalized[1], false);
});

test('live and history workspace paths wire transcript selections into successful composer sends', async () => {
  const [composerSource, liveSource, historySource, detailSource, annotationSource, styleSource] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceSessionComposer.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceNativeSessionView.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'pages', 'Workspace.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceConversationDetail.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceAnnotations.tsx'), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src', 'index.css'), 'utf8'),
  ]);

  assert.match(composerSource, /text = buildComposerPromptWithAnnotations\(text, annotations\)/);
  assert.match(composerSource, /if \(result !== false\)[\s\S]*onAnnotationsSent\?\.\(\)/);
  assert.match(liveSource, /composerHasDraft \|\| sessionAnnotations\.annotations\.length > 0/);
  assert.match(liveSource, /onAdd=\{sessionAnnotations\.addAnnotation\}/);
  assert.match(liveSource, /isActive=\{isVisible\}/);
  assert.match(liveSource, /annotations=\{sessionAnnotations\.annotations\}/);
  assert.match(liveSource, /onAnnotationsSent=\{sessionAnnotations\.clearAnnotations\}/);
  assert.match(historySource, /onAddAnnotation=\{selectedHistorySupportsInline \? historyAnnotations\.addAnnotation : undefined\}/);
  assert.match(historySource, /annotations=\{historyAnnotations\.annotations\}/);
  assert.match(historySource, /onAnnotationsSent=\{historyAnnotations\.clearAnnotations\}/);
  assert.match(detailSource, /<WorkspaceTranscriptSelection/);
  assert.match(annotationSource, /scopeKey/);
  assert.match(annotationSource, /data-workspace-annotation-marker/);
  assert.match(annotationSource, /group-hover:opacity-100/);
  assert.match(annotationSource, /candidate \? candidate\.rects/);
  assert.match(annotationSource, /workspaceSelectionHighlightActive/);
  assert.match(annotationSource, /document\.addEventListener\('mousedown', handleMouseDown, true\)/);
  assert.match(annotationSource, /event\.shiftKey[\s\S]*'Home'[\s\S]*'PageDown'[\s\S]*\.includes\(event\.key\)/);
  assert.match(annotationSource, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(styleSource, /data-workspace-selection-highlight-active/);
});
