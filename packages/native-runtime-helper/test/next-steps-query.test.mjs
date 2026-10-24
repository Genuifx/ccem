import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-next-steps-'));
const outfile = path.join(temp, 'next-steps.mjs');
await build({ entryPoints: [fileURLToPath(new URL('../src/nextStepsQuery.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' });
const { parseNextSteps, generateNextSteps } = await import(pathToFileURL(outfile).href);
test.after(() => fs.rm(temp, { recursive: true, force: true }));

test('parses a fenced JSON array and keeps at most two unique, complete suggestions', () => {
  const raw = '好的：\n```json\n[{"title":"修复登录","prompt":"修复 login.ts 的空指针"},{"title":"修复登录","prompt":"dup"},{"title":"","prompt":"x"},{"title":"补文档","prompt":"为 API 写文档"},{"title":"第三条","prompt":"y"}]\n```';
  assert.deepEqual(parseNextSteps(raw), [
    { title: '修复登录', prompt: '修复 login.ts 的空指针' },
    { title: '补文档', prompt: '为 API 写文档' },
  ]);
});

test('returns no suggestions for empty, malformed or non-array output', () => {
  assert.deepEqual(parseNextSteps('[]'), []);
  assert.deepEqual(parseNextSteps('没有建议'), []);
  assert.deepEqual(parseNextSteps('[{"title":'), []);
  assert.deepEqual(parseNextSteps('{"title":"a","prompt":"b"}'), []);
});

test('clips overlong titles and prompts', () => {
  const [suggestion] = parseNextSteps(JSON.stringify([{ title: '标'.repeat(60), prompt: 'p'.repeat(3000) }]));
  assert.equal([...suggestion.title].length, 40);
  assert.equal(suggestion.prompt.length, 2000);
});

test('blank context short-circuits without a model call', async () => {
  assert.deepEqual(await generateNextSteps({ context: '   ', working_dir: '/tmp' }), []);
});
