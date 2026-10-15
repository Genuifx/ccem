import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-isolation-'));
after(() => fs.rm(temporary, { recursive: true, force: true }));
const helper = path.join(temporary, 'helper.mjs');
await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  outfile: helper, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
});
const executable = path.join(temporary, 'codex-fixture');
await fs.writeFile(executable, `#!${process.execPath}\n` + `
  const fs = require('node:fs');
  fs.writeFileSync(process.env.CCEM_ISOLATION_CAPTURE, JSON.stringify({
    args: process.argv.slice(2),
    home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME,
    apiKey: process.env.CODEX_API_KEY, openaiKey: process.env.OPENAI_API_KEY,
    oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    accessToken: process.env.CODEX_ACCESS_TOKEN,
    hostCredentials: process.env.CLAUDE_CODE_HOST_CREDS_FILE,
  }));
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '11111111-2222-3333-4444-555555555555' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }) + '\\n');
`, { mode: 0o700 });

for (const selectedApiKey of [undefined, 'ccem-selected-key']) {
  test(`Codex SDK child forces CCEM roots and ${selectedApiKey ? 'preserves selected API key' : 'uses isolated login'}`, async () => {
    const capture = path.join(temporary, `capture-${selectedApiKey ? 'selected' : 'official'}.json`);
    const base = path.join(temporary, 'agents');
    const child = spawn(process.execPath, [helper], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env, CCEM_AGENT_HOME: base, CCEM_ISOLATION_CAPTURE: capture,
        CODEX_HOME: '/official/codex', CODEX_SQLITE_HOME: '/official/sqlite',
        OPENAI_API_KEY: 'ambient-openai', CODEX_API_KEY: 'ambient-codex', CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    try {
      child.stdin.write(JSON.stringify({
        type: 'init', provider: 'codex', env_name: 'test', working_dir: temporary,
        perm_mode: 'safe', initial_prompt: 'fixture prompt', codex_path: executable,
        codex_api_key: selectedApiKey,
        env_vars: {
          CODEX_HOME: '/model-override/codex', CODEX_SQLITE_HOME: '/model-override/sqlite', CCEM_AGENT_HOME: '/model-override',
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
      assert.equal(captured.sqlite, captured.home);
      assert.ok(captured.args.includes(`sqlite_home=${JSON.stringify(captured.home)}`));
      assert.equal(captured.openaiKey, undefined);
      assert.equal(captured.oauth, undefined);
      assert.equal(captured.accessToken, undefined);
      assert.equal(captured.hostCredentials, undefined);
      assert.equal(captured.apiKey, selectedApiKey);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    }
  });
}
