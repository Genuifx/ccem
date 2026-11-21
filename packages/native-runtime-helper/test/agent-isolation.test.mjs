import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createCodexExecutableFixture } from './codex-executable-fixture.mjs';
import { withCodexFixtureCleanup } from './codex-fixture-lifecycle.mjs';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem helper isolation '));
const retainedFixtures = new Set();
after(async () => {
  assert.equal(retainedFixtures.size, 0, `Cleanup unproven; retained ${temporary}: ${[...retainedFixtures].join(', ')}`);
  await fs.rm(temporary, { recursive: true, force: true });
});
const helper = path.join(temporary, 'helper.mjs');
await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  outfile: helper, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
});
const executable = await createCodexExecutableFixture(temporary, `
  const fs = require('node:fs');
  fs.writeFileSync(process.env.CCEM_ISOLATION_CAPTURE, JSON.stringify({
    pid: process.pid, ppid: process.ppid,
    args: process.argv.slice(2),
    home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME,
    isolated: process.env.CCEM_CODEX_ISOLATED,
    apiKey: process.env.CODEX_API_KEY, openaiKey: process.env.OPENAI_API_KEY,
    oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    accessToken: process.env.CODEX_ACCESS_TOKEN,
    hostCredentials: process.env.CLAUDE_CODE_HOST_CREDS_FILE,
  }));
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '11111111-2222-3333-4444-555555555555' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }) + '\\n');
  if (process.env.CCEM_FIXTURE_EXIT_GATE) {
    const timer = setInterval(() => {
      if (fs.existsSync(process.env.CCEM_FIXTURE_EXIT_GATE)) clearInterval(timer);
    }, 10);
  }
`);

async function withFixtureCleanup(options, body) {
  try { return await withCodexFixtureCleanup(options, body); }
  catch (error) {
    if (error.fixtureCleanupIncomplete) retainedFixtures.add(options.capture);
    throw error;
  }
}

for (const selectedApiKey of [undefined, 'ccem-selected-key']) {
  test(`Codex SDK child forces CCEM roots and ${selectedApiKey ? 'preserves selected API key' : 'uses isolated login'}`, async () => {
    const capture = path.join(temporary, `capture-${selectedApiKey ? 'selected' : 'official'}.json`);
    const base = path.join(temporary, 'agents');
    const child = spawn(process.execPath, [helper], {
      cwd: temporary,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env, CCEM_AGENT_HOME: base, CCEM_ISOLATION_CAPTURE: capture, CCEM_CODEX_ISOLATED: '1',
        CODEX_HOME: '/official/codex', CODEX_SQLITE_HOME: '/official/sqlite',
        OPENAI_API_KEY: 'ambient-openai', CODEX_API_KEY: 'ambient-codex', CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth',
      },
    });
    // Register immediately: initialization failures may close before the assertion's cleanup.
    const closed = new Promise((resolve) => child.once('close', resolve));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    await withFixtureCleanup({ child, closed, capture, output: () => ({ stdout, stderr }) }, async () => {
      child.stdin.write(JSON.stringify({
        type: 'init', provider: 'codex', env_name: 'test', working_dir: temporary,
        perm_mode: 'safe', initial_prompt: 'fixture prompt', codex_path: executable,
        codex_api_key: selectedApiKey,
        env_vars: {
          CCEM_CODEX_ISOLATED: '0', CODEX_HOME: '/model-override/codex', CODEX_SQLITE_HOME: '/model-override/sqlite', CCEM_AGENT_HOME: '/model-override',
          CLAUDE_CODE_OAUTH_TOKEN: 'caller-oauth', CODEX_ACCESS_TOKEN: 'caller-access', CLAUDE_CODE_HOST_CREDS_FILE: '/official/host-creds',
        },
      }) + '\n');
      let captured;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        try { captured = JSON.parse(await fs.readFile(capture, 'utf8')); break; } catch { /* Wait for the child executable. */ }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(captured, `Codex child did not start: ${stdout}\n${stderr}`);
      assert.equal(captured.home, path.join(base, 'codex'));
      assert.equal(captured.isolated, '1');
      assert.equal(captured.sqlite, captured.home);
      assert.ok(captured.args.includes(`sqlite_home=${JSON.stringify(captured.home)}`));
      assert.equal(captured.openaiKey, undefined);
      assert.equal(captured.oauth, undefined);
      assert.equal(captured.accessToken, undefined);
      assert.equal(captured.hostCredentials, undefined);
      assert.equal(captured.apiKey, selectedApiKey);
    });
  });
}

for (const isolated of [false, true]) {
  test(`Codex helper pins ${isolated ? 'isolated' : 'shared'} mode before preferences change`, async () => {
    const base = path.join(temporary, isolated ? 'pinned-isolated' : 'pinned-shared');
    const capture = path.join(base, 'capture.json');
    await fs.mkdir(base);
    const preferences = path.join(base, 'profiles.json');
    const officialHome = path.join(temporary, 'official custom codex');
    const officialSqlite = path.join(temporary, 'official custom sqlite');
    await fs.writeFile(preferences, JSON.stringify({ codexIsolation: isolated }));
    const child = spawn(process.execPath, [helper], {
      cwd: temporary,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env, CCEM_AGENT_HOME: base, CCEM_CODEX_ISOLATED: undefined,
        CCEM_ISOLATION_CAPTURE: capture, CODEX_HOME: officialHome, CODEX_SQLITE_HOME: officialSqlite,
        OPENAI_API_KEY: 'official-openai', CODEX_API_KEY: 'official-codex', CODEX_ACCESS_TOKEN: 'official-access',
      },
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    await withFixtureCleanup({ child, closed, capture, output: () => ({ stdout, stderr }) }, async () => {
      child.stdin.write(JSON.stringify({
        type: 'init', provider: 'codex', env_name: 'test', working_dir: temporary,
        perm_mode: 'safe', codex_path: executable,
        env_vars: {
          CCEM_CODEX_ISOLATED: isolated ? '0' : '1', CODEX_HOME: '/model/codex', CODEX_SQLITE_HOME: '/model/sqlite',
          CLAUDE_CODE_OAUTH_TOKEN: 'caller-oauth', CLAUDE_CODE_HOST_CREDS_FILE: '/official/host-creds',
        },
      }) + '\n');
      for (let attempt = 0; attempt < 150 && !stdout.includes('Native runtime helper initialized.'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(stdout.includes('Native runtime helper initialized.'), `${stdout}\n${stderr}`);
      await fs.writeFile(preferences, JSON.stringify({ codexIsolation: !isolated }));
      child.stdin.write(JSON.stringify({ type: 'prompt', text: 'fixture prompt' }) + '\n');
      let captured;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        try { captured = JSON.parse(await fs.readFile(capture, 'utf8')); break; } catch { /* Await actual SDK child. */ }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(captured, `Codex child did not start: ${stdout}\n${stderr}`);
      assert.equal(captured.isolated, isolated ? '1' : '0');
      assert.equal(captured.home, isolated ? path.join(base, 'codex') : officialHome);
      assert.equal(captured.sqlite, isolated ? captured.home : officialSqlite);
      assert.equal(captured.args.some((arg) => arg.startsWith('sqlite_home=')), isolated);
      assert.equal(captured.apiKey, isolated ? undefined : 'official-codex');
      assert.equal(captured.openaiKey, isolated ? undefined : 'official-openai');
      assert.equal(captured.accessToken, isolated ? undefined : 'official-access');
      assert.equal(captured.oauth, undefined);
      assert.equal(captured.hostCredentials, undefined);
    });
  });
}


test('real SDK cleanup waits for fixture exit after capture and turn.completed', async (t) => {
  const capture = path.join(temporary, 'delayed-capture.json');
  const gate = path.join(temporary, 'release-delayed-fixture');
  const child = spawn(process.execPath, [helper], {
    cwd: temporary, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CCEM_AGENT_HOME: path.join(temporary, 'delayed-agents'),
      CCEM_ISOLATION_CAPTURE: capture, CCEM_FIXTURE_EXIT_GATE: gate, CCEM_CODEX_ISOLATED: '1' },
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  let finished = false;
  const running = withFixtureCleanup({ child, closed, capture, output: () => ({ stdout, stderr }) }, async () => {
    child.stdin.write(JSON.stringify({ type: 'init', provider: 'codex', env_name: 'test',
      working_dir: temporary, perm_mode: 'safe', initial_prompt: 'fixture prompt', codex_path: executable }) + '\n');
  }).then(() => ({ error: null }), (error) => ({ error })).then((result) => { finished = true; return result; });
  t.after(async () => {
    await fs.writeFile(gate, 'release');
    const result = await running;
    if (result.error) throw result.error;
  });
  let captured;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { captured = JSON.parse(await fs.readFile(capture, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(captured, `${stdout}\n${stderr}`);
  let completed = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    completed = stdout.split('\n').slice(0, -1).filter(Boolean).some((line) => {
      const event = JSON.parse(line);
      return event.type === 'event' && event.payload?.type === 'lifecycle' && event.payload.stage === 'turn_completed';
    });
    if (completed) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(completed, `Helper never observed turn.completed: ${stdout}\n${stderr}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(finished, false, 'fixture capture and turn.completed must not release cleanup');
  assert.doesNotThrow(() => process.kill(captured.pid, 0));
  await fs.writeFile(gate, 'release');
  const result = await running;
  if (result.error) throw result.error;
  assert.throws(() => process.kill(captured.pid, 0), { code: 'ESRCH' });
});
