import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importRuntimeModel() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'components',
    'workspace',
    'browserLauncherModel.ts',
  );
  const source = await fs.readFile(sourcePath, 'utf8').catch(() => '');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-browser-launcher-model-'));
  const outputPath = path.join(tempDir, 'browserLauncherModel.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function readiness(overrides = {}) {
  return {
    status: 'ready',
    phase: 'idle',
    progress: null,
    active: {
      version: '150.0.7871.115',
      sequence: 1,
      manifest_sha256: 'a'.repeat(64),
    },
    candidate: null,
    error: null,
    checked_at: '2026-07-11T00:00:00Z',
    ...overrides,
  };
}

test('an active runtime keeps profiles usable while a candidate download stays visible and controllable', async () => {
  const { deriveBrowserRuntimePresentation } = await importRuntimeModel();

  assert.equal(typeof deriveBrowserRuntimePresentation, 'function');
  assert.deepEqual(deriveBrowserRuntimePresentation(readiness({
    phase: 'downloading',
    progress: { completed_bytes: 10, total_bytes: 100 },
    candidate: {
      version: '151.0.1',
      sequence: 2,
      manifest_sha256: 'b'.repeat(64),
    },
  })), {
    canOpenProfiles: true,
    showOperation: true,
    showFailure: false,
    actionMode: 'active',
  });
});

test('paused and failed candidates take priority over the old active runtime maintenance actions', async () => {
  const { deriveBrowserRuntimePresentation } = await importRuntimeModel();

  assert.deepEqual(deriveBrowserRuntimePresentation(readiness({
    phase: 'paused',
    progress: { completed_bytes: 10, total_bytes: 100 },
  })), {
    canOpenProfiles: true,
    showOperation: true,
    showFailure: false,
    actionMode: 'resume',
  });
  assert.deepEqual(deriveBrowserRuntimePresentation(readiness({
    error: { code: 'download_failed', retryable: true },
  })), {
    canOpenProfiles: true,
    showOperation: false,
    showFailure: true,
    actionMode: 'failed',
  });
});

test('idle ready and missing runtimes retain their ordinary maintenance actions', async () => {
  const { deriveBrowserRuntimePresentation } = await importRuntimeModel();

  assert.equal(deriveBrowserRuntimePresentation(readiness()).actionMode, 'ready');
  assert.deepEqual(deriveBrowserRuntimePresentation(readiness({
    status: 'unavailable',
    active: null,
  })), {
    canOpenProfiles: false,
    showOperation: false,
    showFailure: false,
    actionMode: 'prepare',
  });
});

test('saved-profile recent proof stays metadata-only and selects the latest artifact', async () => {
  const { summarizeSavedProfileRecentProof } = await importRuntimeModel();
  const activity = {
    artifacts: [
      {
        kind: 'screenshot',
        artifact_id: 'shot-opaque-a',
        byte_size: 123,
        modified_at: '2026-07-11T01:00:00Z',
        immutable: true,
        untrusted: true,
      },
      {
        kind: 'audit_log',
        artifact_id: 'semantic-audit',
        byte_size: 456,
        modified_at: '2026-07-11T02:00:00Z',
        immutable: false,
        untrusted: false,
      },
    ],
  };

  assert.deepEqual(summarizeSavedProfileRecentProof(activity), {
    total: 2,
    latestModifiedAt: '2026-07-11T02:00:00Z',
    kinds: ['audit_log', 'screenshot'],
  });
});
