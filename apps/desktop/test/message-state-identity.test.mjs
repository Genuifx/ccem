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
