import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

const helperSource = await fs.readFile(new URL('../src/lib/recoveryDrafts.ts', import.meta.url), 'utf8');
const transpile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022,
} }).outputText;
const drafts = await import(`data:text/javascript;base64,${Buffer.from(transpile(helperSource)).toString('base64')}`);
const composerSource = await fs.readFile(new URL('../src/components/workspace/WorkspaceSessionComposer.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('composer.tsx', composerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let recoveryEffect;
let syncSegments;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('setRecentFiles(loadComposerRecentFiles(workingDir))')) {
    recoveryEffect = node.arguments[0].getText(ast);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'syncComposerSegments') {
    syncSegments = node.initializer.arguments[0].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(recoveryEffect && syncSegments, 'execute current Composer recovery and input callbacks');

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key), key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; } };
}

test('deferred attachment state processing after immediate mount input cannot reset the captured draft identity', () => {
  const saved = storage();
  const recoveryDraftKey = drafts.recoveryDraftKey('live', 'mount-race');
  const attachmentsRef = { current: [] };
  const recoveryDraftIdRef = { current: null };
  const syncedPlainTextRef = { current: '' };
  const pendingAttachmentUpdates = [];
  const bindings = {
    workingDir: '/tmp', recoveryDraftKey, attachmentsRef, recoveryDraftIdRef, syncedPlainTextRef,
    draftEditRevisionRef: { current: 0 },
    isRecoveringWebcontent: () => false,
    loadComposerRecentFiles: () => [], setRecentFiles() {}, setRejectedDrafts() {},
    readRejectedRecoveryDrafts: () => [], toRecoveredComposerDraft: draft => draft,
    readRecoveryDraft: (key, recovering) => drafts.readRecoveryDraft(key, recovering, saved),
    writeRecoveryDraft: (key, text, attachments) => drafts.writeRecoveryDraft(key, text, attachments, saved),
    revokeComposerImageUrls() {}, setIsDragTarget() {}, setDraggedFileCount() {},
    // React may evaluate/replay a functional updater later than the effect.
    setAttachments: update => pendingAttachmentUpdates.push(update),
    setComposerSegments() {}, serializeComposerSessionReferences: segments => segments.map(s => s.text).join(''),
    onValueChange() {},
  };
  const load = callback => new Function(...Object.keys(bindings), `${transpile(`const callback = ${callback};`)}; return callback;`)(...Object.values(bindings));
  load(recoveryEffect)();
  const input = load(syncSegments);
  input([{ type: 'text', text: 'immediate input' }]);
  const editedDraftId = recoveryDraftIdRef.current;
  assert.ok(editedDraftId);
  for (const update of pendingAttachmentUpdates) {
    if (typeof update === 'function') update([]);
  }
  assert.equal(recoveryDraftIdRef.current, editedDraftId, 'mount state replay cannot invalidate a newer edit');
  const submission = drafts.beginRecoveryDraftSubmission(recoveryDraftKey, syncedPlainTextRef.current,
    attachmentsRef.current, recoveryDraftIdRef.current, saved);
  assert.ok(submission);
  assert.equal(drafts.readRecoveryDraft(recoveryDraftKey, true, saved), null, 'submitted input has no sendable duplicate');
  assert.equal(drafts.recoveryDraftDiagnostics(saved).uncertain, 1);
  input([{ type: 'text', text: 'independent newer intent' }]);
  drafts.finishRecoveryDraftSubmission(recoveryDraftKey, submission, true, saved);
  assert.equal(drafts.readRecoveryDraft(recoveryDraftKey, true, saved).text, 'independent newer intent');
});
