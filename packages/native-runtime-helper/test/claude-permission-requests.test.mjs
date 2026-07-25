import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importClaudePermissionRequestsModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-claude-permission-requests-test-'));
  const outfile = path.join(tempDir, 'claudePermissionRequests.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'claudePermissionRequests.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

test('uses Claude Agent SDK permission requestId when available', async () => {
  const { resolveClaudePermissionRequestId } = await importClaudePermissionRequestsModule();

  assert.equal(
    resolveClaudePermissionRequestId({
      toolUseID: 'toolu-1',
      requestId: 'req-sdk-1',
    }),
    'req-sdk-1',
  );
});

test('falls back to the legacy toolUseID timestamp request id', async () => {
  const { resolveClaudePermissionRequestId } = await importClaudePermissionRequestsModule();

  assert.equal(
    resolveClaudePermissionRequestId({ toolUseID: 'toolu-1' }, () => 42),
    'toolu-1:42',
  );
});

test('preserves the exact Claude Agent SDK permission requestId', async () => {
  const { resolveClaudePermissionRequestId } = await importClaudePermissionRequestsModule();
  const requestId = `\uFEFF req\u202Eid \uFEFF`;

  assert.equal(
    resolveClaudePermissionRequestId({ toolUseID: 'toolu-1', requestId }),
    requestId,
  );
});
