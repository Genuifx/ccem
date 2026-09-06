import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../dist/native-runtime-helper.mjs', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const executableFixture = { skip: process.platform === 'win32' ? 'The fixture uses a Unix executable shebang.' : false };

// Run the production helper AND bundled Codex SDK. Only the final Codex binary
// is a fixture: record argv and emit a successful SDK JSON stream.
async function launch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-task-model-'));
  const probe = path.join(dir, 'argv.jsonl');
  const executable = path.join(dir, 'codex');
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.MODEL_PROBE, JSON.stringify(process.argv.slice(2))+'\\n');
process.stdin.resume();
process.stdin.on('end', () => {
 if (process.argv.includes('unavailable-model')) {
  process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'model unavailable'}})+'\\n');
  return;
 }
 for (const event of [
  {type:'thread.started',thread_id:'ccem-model-fixture'},
  {type:'turn.started'},
  {type:'item.completed',item:{type:'agent_message',id:'answer',text:'fixture complete'}},
  {type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}}
 ]) process.stdout.write(JSON.stringify(event)+'\\n');
});
`, { mode: 0o700 });
  const child = spawn(process.execPath, [helper], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: dir, MODEL_PROBE: probe },
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) {
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(1000)]);
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const outputs = [];
  let buffer = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) outputs.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const send = (command) => child.stdin.write(JSON.stringify(command) + '\n');
  const wait = async (predicate) => {
    for (let i = 0; i < 500; i++) {
      const found = outputs.find(predicate);
      if (found) return found;
      await sleep(10);
    }
    throw new Error(JSON.stringify({ outputs, stderr }));
  };
  const args = async () => {
    try { return (await fs.readFile(probe, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const init = {
    type: 'init', provider: 'codex', env_name: '', working_dir: dir,
    perm_mode: 'yolo', effort: 'medium', codex_path: executable,
  };
  return { send, wait, args, init, outputs };
}

for (const resumed of [false, true]) {
  for (const model of [undefined, 'gpt-6-astra']) {
    test(`Codex SDK ${resumed ? 'resume' : 'start'} preserves ${model ?? 'legacy model absence'}`, executableFixture, async (t) => {
      const h = await launch(t);
      h.send({ ...h.init, ...(model === undefined ? {} : { model }),
        ...(resumed ? { provider_session_id: 'ccem-model-resumed' } : {}), initial_prompt: 'first' });
      await h.wait((o) => o.type === 'status' && o.status === 'ready' && o.detail !== 'Native runtime helper initialized.');
      const [args] = await h.args();
      assert.ok(args, JSON.stringify(h.outputs));
      assert.equal(args.includes('--model'), model !== undefined);
      if (model !== undefined) assert.equal(args[args.indexOf('--model') + 1], model);
      assert.equal(args.includes('resume'), resumed);
      if (resumed) assert.ok(args.includes('ccem-model-resumed'));
      assert.ok(args.some((arg) => arg.includes('model_reasoning_effort') && arg.includes('medium')));
      // An effort update retires the thread; the next SDK resume must retain model.
      h.send({ type: 'update_settings', request_id: 'model-effort', effort: 'high' });
      await h.wait((o) => o.type === 'status' && o.detail === 'Settings applied.');
      h.send({ type: 'prompt', text: 'second' });
      for (let i = 0; i < 500 && (await h.args()).length < 2; i++) await sleep(10);
      const second = (await h.args())[1];
      assert.ok(second);
      assert.ok(second.includes('resume'));
      assert.equal(second.includes('--model'), model !== undefined);
      if (model !== undefined) assert.equal(second[second.indexOf('--model') + 1], model);
    });
  }
}

test('provider rejection of explicit model is an error with no default-model retry', executableFixture, async (t) => {
  const h = await launch(t);
  h.send({ ...h.init, model: 'unavailable-model', initial_prompt: 'first' });
  const error = await h.wait((o) => o.type === 'status' && o.status === 'error');
  assert.match(error.detail, /model unavailable/);
  const args = await h.args();
  assert.equal(args.length, 1);
  assert.equal(args[0][args[0].indexOf('--model') + 1], 'unavailable-model');
});

for (const [provider, model, code] of [
  ['claude', 'gpt-6-astra', 'MODEL_PROVIDER_UNSUPPORTED'],
  ['codex', '', 'MODEL_INVALID'], ['codex', 'gpt\n', 'MODEL_INVALID'],
  ['codex', 123, 'MODEL_INVALID'], ['codex', 'gpt 6', 'MODEL_INVALID'],
]) {
  test(`invalid model init never starts SDK: ${provider} ${JSON.stringify(model)}`, async (t) => {
    const h = await launch(t);
    h.send({ ...h.init, provider, model, initial_prompt: 'must not execute' });
    const error = await h.wait((o) => o.type === 'status' && o.status === 'error');
    assert.match(error.detail, new RegExp(code));
    assert.deepEqual(await h.args(), []);
    assert.ok(!h.outputs.some((o) => o.type === 'status' && o.status === 'ready'));
  });
}
