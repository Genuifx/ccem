import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source = await fs.readFile(new URL('../src/lib/recoveryDrafts.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const api = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
function storage() {
  const values = new Map(); const reads = []; const writes = [];
  return { values, reads, writes, get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem(key, value) { writes.push(key); values.set(key, value); }, removeItem(key) { values.delete(key); } };
}
const image = { id: 'image-1', kind: 'image', source: 'paste', name: 'private image', placeholder: '[Image #1]', mediaType: 'image/png', base64Data: 'aGVsbG8=', byteSize: 5, objectUrl: 'blob:expired' };
const live = api.recoveryDraftKey('live', 'runtime-a');
test('unexpected document loss restores scoped text and image without unload', () => {
  const saved = storage(); api.writeRecoveryDraft(live, 'unsent [Image #1]', [image], saved);
  assert.equal(api.readRecoveryDraft(live, false, saved), null);
  const recovered = api.readRecoveryDraft(live, true, saved);
  assert.equal(recovered.text, 'unsent [Image #1]'); assert.deepEqual(recovered.attachments, [{ ...image, objectUrl: null }]);
  assert.equal(api.readRecoveryDraft(api.recoveryDraftKey('live', 'runtime-b'), true, saved), null);
  assert.equal(api.readRecoveryDraft(api.recoveryDraftKey('history', 'claude', 'runtime-a'), true, saved), null);
});
test('keystrokes and diagnostics never read or rewrite image bodies', () => {
  const saved = storage(); api.writeRecoveryDraft(live, 'first', [image], saved); saved.reads.length = 0; saved.writes.length = 0;
  for (let i = 0; i < 25; i++) api.writeRecoveryDraft(live, `edited ${i}`, [image], saved);
  assert.equal(api.recoveryDraftDiagnostics(saved).drafts, 1);
  assert.ok(saved.reads.every(key => !key.includes('recovery-attachment'))); assert.ok(saved.writes.every(key => !key.includes('recovery-attachment')));
});
test('ACK loss retains uncertain submission without restoring sendable text', () => {
  const saved = storage(); const id = api.writeRecoveryDraft(live, 'possibly accepted', [image], saved);
  api.beginRecoveryDraftSubmission(live, 'possibly accepted', [image], id, saved);
  assert.equal(api.readRecoveryDraft(live, true, saved), null); assert.equal(api.recoveryDraftDiagnostics(saved).uncertain, 1);
});
test('accepted ACK releases its snapshot and unreferenced image', () => {
  const saved = storage(); const id = api.writeRecoveryDraft(live, 'accepted', [image], saved);
  const submit = api.beginRecoveryDraftSubmission(live, 'accepted', [image], id, saved);
  api.finishRecoveryDraftSubmission(live, submit, true, saved);
  assert.equal(api.readRecoveryDraft(live, true, saved), null); assert.equal(saved.length, 0);
});
test('edits during preparation survive acceptance of the earlier submission', () => {
  const saved = storage(); const id = api.writeRecoveryDraft(live, 'first', [image], saved);
  api.writeRecoveryDraft(live, 'new draft', [], saved);
  const submit = api.beginRecoveryDraftSubmission(live, 'first', [image], id, saved);
  api.finishRecoveryDraftSubmission(live, submit, true, saved);
  assert.equal(api.readRecoveryDraft(live, true, saved).text, 'new draft'); assert.equal(api.recoveryDraftDiagnostics(saved).uncertain, 0);
  assert.ok([...saved.values.keys()].every(key => !key.includes('recovery-attachment')));
});
test('explicit rejection restores exact snapshot without overwriting newer edits', () => {
  const saved = storage(); const id = api.writeRecoveryDraft(live, 'rejected', [image], saved);
  const submit = api.beginRecoveryDraftSubmission(live, 'rejected', [image], id, saved);
  api.finishRecoveryDraftSubmission(live, submit, false, saved);
  const recovered = api.readRecoveryDraft(live, true, saved); assert.equal(recovered.text, 'rejected'); assert.equal(recovered.attachments[0].base64Data, image.base64Data);
  const retry = api.beginRecoveryDraftSubmission(live, recovered.text, recovered.attachments, recovered.id, saved);
  api.writeRecoveryDraft(live, 'newer', [], saved); api.finishRecoveryDraftSubmission(live, retry, false, saved);
  assert.equal(api.readRecoveryDraft(live, true, saved).text, 'newer'); assert.equal(api.recoveryDraftDiagnostics(saved).uncertain, 0); assert.equal(api.recoveryDraftDiagnostics(saved).rejected, 1);
});
test('missing image refuses incomplete restoration', () => {
  const saved = storage(); api.writeRecoveryDraft(live, 'important [Image #1]', [image], saved);
  saved.removeItem([...saved.values.keys()].find(key => key.includes('recovery-attachment')));
  assert.equal(api.readRecoveryDraft(live, true, saved), null);
});
test('quota error logs only counters and invalidates stale sendable cache before IPC', () => {
  const saved = storage(); const id = api.writeRecoveryDraft(live, 'do not log this prompt', [], saved);
  const warnings = []; const original = console.warn; console.warn = (...args) => warnings.push(args);
  try { saved.setItem = () => { throw new Error('sensitive storage error'); };
    assert.equal(api.beginRecoveryDraftSubmission(live, 'do not log this prompt', [], id, saved), null);
    assert.equal(api.readRecoveryDraft(live, true, saved), null); assert.ok(warnings.length > 0); assert.doesNotMatch(JSON.stringify(warnings), /do not log|sensitive storage/);
  } finally { console.warn = original; }
});

test('denied sessionStorage access is counted without throwing or logging draft content', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalWarn = console.warn; const warnings = [];
  const initialFailures = api.recoveryDraftDiagnostics(storage()).failedWrites;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get sessionStorage() { throw new Error('private storage failure'); },
  } });
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(api.writeRecoveryDraft(live, 'private draft content', [image]), null);
    assert.equal(api.recoveryDraftDiagnostics(storage()).failedWrites, initialFailures + 1);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(warnings), /private|image|runtime-a/);
  } finally {
    console.warn = originalWarn;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  }
});

for (const hasPreviousDraft of [false, true]) {
  test(`metadata quota failure rolls back new image blobs${hasPreviousDraft ? ' and preserves referenced assets' : ' without leaving an orphan'}`, () => {
    const saved = storage();
    if (hasPreviousDraft) api.writeRecoveryDraft(live, 'previous [Image #1]', [image], saved);
    const previousEntries = [...saved.values.entries()];
    const previousDraft = api.readRecoveryDraft(live, true, saved);
    const newImage = { ...image, id: 'new-image', placeholder: '[Image #2]', base64Data: 'bmV3' };
    const originalSetItem = saved.setItem;
    let newBlobWrites = 0;
    saved.setItem = (key, value) => {
      if (key.includes('recovery-draft')) throw new Error('metadata quota exceeded');
      newBlobWrites += 1;
      originalSetItem(key, value);
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(api.writeRecoveryDraft(live, 'new [Image #2]', hasPreviousDraft ? [image, newImage] : [newImage], saved), null);
      assert.equal(newBlobWrites, 1, 'new image write must succeed before metadata fails');
      assert.deepEqual([...saved.values.entries()], previousEntries, 'rollback removes only newly introduced assets');
      assert.deepEqual(api.readRecoveryDraft(live, true, saved), previousDraft);
    } finally { console.warn = originalWarn; }
  });
}

test('explicitly rejected secondary snapshots restore separately and are garbage collected after recovery', () => {
  const saved = storage(); const id = api.writeRecoveryDraft(live, 'older [Image #1]', [image], saved);
  const submit = api.beginRecoveryDraftSubmission(live, 'older [Image #1]', [image], id, saved, [{ id: 'a', quote: 'quote', note: 'note' }]);
  api.writeRecoveryDraft(live, 'newer', [], saved); api.finishRecoveryDraftSubmission(live, submit, false, saved);
  const rejected = api.readRejectedRecoveryDrafts(live, true, saved);
  assert.equal(rejected.length, 1); assert.equal(rejected[0].text, 'older [Image #1]'); assert.equal(rejected[0].annotations[0].note, 'note');
  api.discardRejectedRecoveryDraft(live, submit, saved);
  assert.equal(api.readRejectedRecoveryDrafts(live, true, saved).length, 0);
  assert.equal(api.readRecoveryDraft(live, true, saved).text, 'newer');
  assert.ok([...saved.values.keys()].every(key => !key.includes('recovery-attachment')));
});

test('renumbered image placeholders retain independent in-flight and new draft snapshots', () => {
  const saved = storage(); const id = api.writeRecoveryDraft(live, 'first [Image #1]', [image], saved);
  const submit = api.beginRecoveryDraftSubmission(live, 'first [Image #1]', [image], id, saved);
  api.writeRecoveryDraft(live, 'second [Image #2]', [{ ...image, placeholder: '[Image #2]' }], saved);
  api.finishRecoveryDraftSubmission(live, submit, false, saved);
  assert.equal(api.readRecoveryDraft(live, true, saved).attachments[0].placeholder, '[Image #2]');
  assert.equal(api.readRejectedRecoveryDrafts(live, true, saved)[0].attachments[0].placeholder, '[Image #1]');
});
