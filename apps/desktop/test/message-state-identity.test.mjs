import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const desktopDir = path.resolve(import.meta.dirname, '..');

async function importMessageState() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-message-state-'));
  const outfile = path.join(tempDir, 'messageState.mjs');
  await build({
    entryPoints: [path.join(desktopDir, 'src', 'features', 'conversations', 'messageState.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
  });
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}

function assistantWithToolUse(id, text = 'before') {
  return {
    msgType: 'assistant',
    uuid: `assistant-${id}`,
    content: [
      { type: 'text', text },
      { type: 'tool_use', id, name: 'Bash' },
    ],
  };
}

function userWithToolResult(id, extra = false, output = `output-${id}`) {
  const content = [
    { type: 'tool_result', tool_use_id: id, content: output },
  ];
  if (extra) {
    content.push({ type: 'text', text: 'kept' });
  }
  return { msgType: 'user', uuid: `user-${id}`, content };
}

test('mergeToolResults keeps object identity across re-merges of the same list', async () => {
  const { mergeToolResults } = await importMessageState();
  const original = [assistantWithToolUse('t1'), userWithToolResult('t1')];

  const first = mergeToolResults(original);
  const second = mergeToolResults(original);

  assert.strictEqual(first.length, second.length);
  for (let index = 0; index < first.length; index += 1) {
    assert.strictEqual(first[index], second[index], `item ${index} must be referentially equal`);
  }
});

test('mergeToolResults injects results, strips tool_result blocks, and drops emptied user messages', async () => {
  const { mergeToolResults } = await importMessageState();
  const original = [
    assistantWithToolUse('t1'),
    userWithToolResult('t1', true),
    userWithToolResult('t2'),
  ];

  const merged = mergeToolResults(original);
  // t2 has no matching tool_use, so that user message keeps its result block.
  assert.strictEqual(merged.length, 3);

  const assistant = merged[0];
  const toolUse = assistant.content.find((block) => block.type === 'tool_use');
  assert.equal(toolUse._result, 'output-t1');

  const user = merged[1];
  assert.ok(!user.content.some((block) => block.type === 'tool_result'), 'tool_result removed');
  assert.equal(user.content[0].text, 'kept', 'non-result blocks preserved');

  const unmatched = merged[2];
  assert.ok(unmatched.content.some((block) => block.type === 'tool_result'), 'unmatched result kept');
});

test('mergeToolResults returns fresh identities when the tool result payload changes', async () => {
  const { mergeToolResults } = await importMessageState();
  const assistant = assistantWithToolUse('t1');
  const before = mergeToolResults([assistant, userWithToolResult('t1')]);

  // New event batch with a different result payload for the same tool_use.
  const nextUser = userWithToolResult('t1', true, 'output-t1-v2');
  const after = mergeToolResults([assistant, nextUser]);

  assert.notStrictEqual(after[0], before[0], 'assistant merged object refreshes');
  const toolUse = after[0].content.find((block) => block.type === 'tool_use');
  assert.equal(toolUse._result, 'output-t1-v2');
  assert.equal(after[1].content[0].text, 'kept');
  // The follow-up merge of the same new batch must again be stable.
  const afterAgain = mergeToolResults([assistant, nextUser]);
  assert.strictEqual(after[0], afterAgain[0]);
  assert.strictEqual(after[1], afterAgain[1]);
});

test('mergeToolResults leaves tool_use-less and text-only messages untouched', async () => {
  const { mergeToolResults } = await importMessageState();
  const plain = [
    { msgType: 'user', uuid: 'u1', content: 'hello' },
    { msgType: 'assistant', uuid: 'a1', content: [{ type: 'text', text: 'hi' }] },
  ];
  const merged = mergeToolResults(plain);
  assert.strictEqual(merged[0], plain[0]);
  assert.strictEqual(merged[1], plain[1]);
});

for (const isError of [false, true]) {
  test(`native embedded ${isError ? 'error' : 'completion'} keeps identities across 100 tail appends`, async () => {
    const { mergeToolResults } = await importMessageState();
    const assistant = assistantWithToolUse('native-tool');
    assistant.content[1] = Object.freeze({
      ...assistant.content[1],
      _result: isError ? 'native command failed' : 'native command completed',
      _resultError: isError,
      _startedAt: 100,
      _completedAt: 200,
    });
    Object.freeze(assistant.content);
    Object.freeze(assistant);
    const first = mergeToolResults([assistant])[0];
    const firstTool = first.content[1];

    for (let index = 0; index < 100; index += 1) {
      const tail = { msgType: 'assistant', uuid: 'stream-tail', content: `chunk ${index}` };
      const next = mergeToolResults([assistant, tail]);
      assert.strictEqual(next[0], first, `historical message reused on append ${index}`);
      assert.strictEqual(next[0].content, first.content, 'segment-cache content remains stable');
      assert.strictEqual(next[0].content[1], firstTool, 'tool block remains stable');
      assert.strictEqual(next[1], tail, 'changed tail is still delivered');
    }
    assert.equal(firstTool._result, assistant.content[1]._result);
    assert.equal(firstTool._resultError, isError);
    assert.equal(firstTool._completedAt, 200);
  });
}

test('late native embedded completion and error replace only the changed message snapshot', async () => {
  const { mergeToolResults } = await importMessageState();
  const pending = assistantWithToolUse('native-late');
  const before = mergeToolResults([pending])[0];
  const completed = {
    ...pending,
    content: [pending.content[0], { ...pending.content[1], _result: 'done', _resultError: false }],
  };
  const after = mergeToolResults([completed])[0];
  assert.notStrictEqual(after, before);
  assert.notStrictEqual(after.content[1], before.content[1]);
  assert.equal(before.content[1]._result, undefined, 'earlier pending snapshot remains untouched');
  assert.equal(after.content[1]._result, 'done');
  assert.equal(after.content[1]._resultError, false);
  assert.strictEqual(mergeToolResults([completed])[0], after, 'completed result can be cached');

  const failed = {
    ...completed,
    content: [completed.content[0], { ...completed.content[1], _result: 'late error', _resultError: true }],
  };
  const afterError = mergeToolResults([failed])[0];
  assert.notStrictEqual(afterError, after);
  assert.equal(afterError.content[1]._result, 'late error');
  assert.equal(afterError.content[1]._resultError, true);
  assert.equal(after.content[1]._result, 'done', 'prior completed snapshot remains untouched');
  assert.strictEqual(mergeToolResults([failed])[0], afterError);
});

test('a separate late result overrides embedded output and removal restores the embedded result', async () => {
  const { mergeToolResults } = await importMessageState();
  const native = assistantWithToolUse('embedded-overlay');
  native.content[1] = { ...native.content[1], _result: 'embedded output', _resultError: false };
  const before = mergeToolResults([native])[0];
  const external = userWithToolResult('embedded-overlay', false, '');
  external.content[0].is_error = true;
  const withExternal = mergeToolResults([native, external]);
  assert.equal(withExternal.length, 1, 'merged external result message is still stripped');
  assert.notStrictEqual(withExternal[0], before);
  assert.equal(withExternal[0].content[1]._result, '', 'an empty external result still wins');
  assert.equal(withExternal[0].content[1]._resultError, true);
  assert.strictEqual(mergeToolResults([native, external])[0], withExternal[0]);

  const restored = mergeToolResults([native])[0];
  assert.notStrictEqual(restored, withExternal[0]);
  assert.equal(restored.content[1]._result, 'embedded output');
  assert.equal(restored.content[1]._resultError, false);
  assert.strictEqual(mergeToolResults([native])[0], restored);
  assert.equal(before.content[1]._result, 'embedded output');
  assert.equal(withExternal[0].content[1]._result, '', 're-merge does not mutate a prior overlay');
});
