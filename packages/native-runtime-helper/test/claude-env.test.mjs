import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importClaudeEnvModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-claude-env-test-'));
  const outfile = path.join(tempDir, 'claudeEnv.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'claudeEnv.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

test('builds a non-interactive Claude query environment for desktop sessions', async () => {
  const { buildClaudeQueryEnv } = await importClaudeEnvModule();

  const env = buildClaudeQueryEnv({
    baseEnv: {
      PATH: '/usr/bin',
      CLAUDE_CODE_SANDBOXED: '0',
    },
    envVars: {
      ANTHROPIC_AUTH_TOKEN: 'sk-ant-test',
      CLAUDE_CONFIG_DIR: '/tmp/ccem-claude-config',
      CLAUDE_CODE_SANDBOXED: '0',
    },
    effort: 'high',
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-ant-test');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/ccem-claude-config');
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, 'ccem-desktop');
  assert.equal(env.CLAUDE_CODE_SANDBOXED, '1');
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
});

test('removes inherited API key when a managed auth token is present', async () => {
  const { buildClaudeQueryEnv } = await importClaudeEnvModule();

  const env = buildClaudeQueryEnv({
    baseEnv: {
      ANTHROPIC_API_KEY: 'inherited-api-key',
      PATH: '/usr/bin',
    },
    envVars: {
      ANTHROPIC_AUTH_TOKEN: 'managed-auth-token',
    },
  });

  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'managed-auth-token');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('does not restore omitted official model pins from the desktop process environment', async () => {
  const { buildClaudeQueryEnv } = await importClaudeEnvModule();

  const env = buildClaudeQueryEnv({
    baseEnv: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'inherited-opus-pin',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'inherited-sonnet-pin',
      ANTHROPIC_MODEL: 'inherited-model',
      PATH: '/usr/bin',
    },
    envVars: {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_MODEL: 'opus',
    },
  });

  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
  assert.equal(env.ANTHROPIC_MODEL, 'opus');
  assert.equal(env.PATH, '/usr/bin');
});
