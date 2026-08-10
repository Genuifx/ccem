import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importInterruptTimeoutModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-interrupt-timeout-test-'));
  const outfile = path.join(tempDir, 'claudeInterruptTimeout.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'claudeInterruptTimeout.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

test('Claude interrupt timeout overrides can only shorten the production default', async () => {
  const {
    DEFAULT_CLAUDE_INTERRUPT_TIMEOUT_MS,
    resolveClaudeInterruptTimeoutMs,
  } = await importInterruptTimeoutModule();

  assert.equal(resolveClaudeInterruptTimeoutMs(undefined), DEFAULT_CLAUDE_INTERRUPT_TIMEOUT_MS);
  assert.equal(resolveClaudeInterruptTimeoutMs('40'), 40);
  assert.equal(
    resolveClaudeInterruptTimeoutMs('999999'),
    DEFAULT_CLAUDE_INTERRUPT_TIMEOUT_MS,
  );
  assert.equal(resolveClaudeInterruptTimeoutMs('-1'), 0);
  assert.equal(resolveClaudeInterruptTimeoutMs('not-a-number'), DEFAULT_CLAUDE_INTERRUPT_TIMEOUT_MS);
});
