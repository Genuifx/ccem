import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importPermissionModesModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-runtime-permission-test-'));
  const outfile = path.join(tempDir, 'permissionModes.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'permissionModes.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

test('maps ccem permission names to Claude Agent SDK permission modes', async () => {
  const { normalizeClaudePermissionMode } = await importPermissionModesModule();

  assert.deepEqual(normalizeClaudePermissionMode('yolo'), {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  });
  assert.deepEqual(normalizeClaudePermissionMode('dev'), {
    permissionMode: 'acceptEdits',
    allowDangerouslySkipPermissions: false,
  });
  assert.deepEqual(normalizeClaudePermissionMode('readonly'), {
    permissionMode: 'plan',
    allowDangerouslySkipPermissions: false,
  });
  assert.deepEqual(normalizeClaudePermissionMode('safe'), {
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  });
  assert.deepEqual(normalizeClaudePermissionMode('manual'), {
    permissionMode: 'manual',
    allowDangerouslySkipPermissions: false,
  });  assert.deepEqual(normalizeClaudePermissionMode('auto'), {
    permissionMode: 'auto',
    allowDangerouslySkipPermissions: false,
  });
  assert.deepEqual(normalizeClaudePermissionMode('ci'), {
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  });
});

test('passes persisted Claude plan sessions through as plan mode', async () => {
  const { normalizeClaudePermissionMode } = await importPermissionModesModule();

  assert.deepEqual(normalizeClaudePermissionMode('plan'), {
    permissionMode: 'plan',
    allowDangerouslySkipPermissions: false,
  });
});

test('can start Claude in plan mode while enabling later bypass restore', async () => {
  const { normalizeClaudePermissionMode } = await importPermissionModesModule();

  assert.deepEqual(
    normalizeClaudePermissionMode('plan', {
      allowDangerouslySkipPermissions: true,
    }),
    {
      permissionMode: 'plan',
      allowDangerouslySkipPermissions: true,
    },
  );
});

test('normalizeCodexSandboxMode maps each permission mode to correct sandbox + network policy', async () => {
  const { normalizeCodexSandboxMode } = await importPermissionModesModule();

  const cases = [
    // yolo / danger-full-access → full access, network ON
    { mode: 'yolo', sandboxMode: 'danger-full-access', approvalPolicy: 'never', networkAccessEnabled: true },
    { mode: 'danger-full-access', sandboxMode: 'danger-full-access', approvalPolicy: 'never', networkAccessEnabled: true },

    // readonly / audit / plan / read-only → read-only sandbox, network OFF
    { mode: 'readonly', sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false },
    { mode: 'audit', sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false },
    { mode: 'plan', sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false },
    { mode: 'read-only', sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false },

    // safe / ci → workspace-write but network OFF (conservative)
    { mode: 'safe', sandboxMode: 'workspace-write', approvalPolicy: 'on-request', networkAccessEnabled: false },
    { mode: 'ci', sandboxMode: 'workspace-write', approvalPolicy: 'on-request', networkAccessEnabled: false },

    // dev / default / unknown → workspace-write, network ON (development workflow)
    { mode: 'dev', sandboxMode: 'workspace-write', approvalPolicy: 'on-request', networkAccessEnabled: true },
    { mode: 'default', sandboxMode: 'workspace-write', approvalPolicy: 'on-request', networkAccessEnabled: true },
    { mode: 'unknown-mode', sandboxMode: 'workspace-write', approvalPolicy: 'on-request', networkAccessEnabled: true },
  ];

  for (const { mode, ...expected } of cases) {
    const result = normalizeCodexSandboxMode(mode);
    assert.deepEqual(result, expected, `mode "${mode}" should map to ${JSON.stringify(expected)}`);
  }
});
