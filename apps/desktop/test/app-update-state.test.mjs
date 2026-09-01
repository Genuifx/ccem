import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importAppUpdateState() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'app-update', 'appUpdateState.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-app-update-state-test-'));
  const outputPath = path.join(tempDir, 'appUpdateState.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

const updateInfo = {
  version: '2.11.0',
  currentVersion: '2.10.0',
  channel: 'stable',
  releaseTag: 'v2.11.0',
  releaseUrl: 'https://github.com/Genuifx/ccem/releases/tag/v2.11.0',
  date: null,
  body: null,
};

test('only shows the global updater affordance when action is needed', async () => {
  const { deriveUpdateIndicatorModel } = await importAppUpdateState();

  assert.deepEqual(
    deriveUpdateIndicatorModel({ status: 'idle', updateInfo: null, progress: null, error: null }),
    {
      visible: false,
      tone: 'hidden',
      action: 'none',
      titleKey: 'settings.checkUpdate',
      descriptionKey: null,
      percent: null,
    },
  );

  assert.deepEqual(
    deriveUpdateIndicatorModel({ status: 'available', updateInfo, progress: null, error: null }),
    {
      visible: true,
      tone: 'available',
      action: 'download',
      titleKey: 'settings.updateAvailable',
      descriptionKey: 'settings.updateGlobalDownloadHint',
      percent: null,
    },
  );

  assert.deepEqual(
    deriveUpdateIndicatorModel({ status: 'ready', updateInfo, progress: null, error: null }),
    {
      visible: true,
      tone: 'ready',
      action: 'restart',
      titleKey: 'settings.restartToUpdate',
      descriptionKey: 'settings.updateGlobalRestartHint',
      percent: null,
    },
  );

  assert.deepEqual(
    deriveUpdateIndicatorModel({
      status: 'downloading',
      updateInfo,
      progress: { downloaded: 42, total: 100, percent: 42 },
      error: null,
    }),
    {
      visible: true,
      tone: 'downloading',
      action: 'none',
      titleKey: 'settings.updateDownloading',
      descriptionKey: 'settings.updateGlobalDownloadingHint',
      percent: 42,
    },
  );

  assert.deepEqual(
    deriveUpdateIndicatorModel({
      status: 'error',
      updateInfo,
      progress: { downloaded: 42, total: 100, percent: 42 },
      error: 'network failed',
    }),
    {
      visible: true,
      tone: 'error',
      action: 'retry',
      titleKey: 'settings.updateInstallFailedShort',
      descriptionKey: 'settings.updateGlobalRetryHint',
      percent: 42,
    },
  );
});

test('maps backend update progress events onto the global status model', async () => {
  const { reduceUpdateState } = await importAppUpdateState();
  const initial = { status: 'available', updateInfo, progress: null, error: null };

  const downloading = reduceUpdateState(initial, {
    type: 'progress',
    event: {
      phase: 'download-progress',
      version: '2.11.0',
      downloaded: 42,
      total: 100,
    },
  });

  assert.equal(downloading.status, 'downloading');
  assert.deepEqual(downloading.progress, { downloaded: 42, total: 100, percent: 42 });

  const ready = reduceUpdateState(downloading, {
    type: 'progress',
    event: {
      phase: 'installed',
      version: '2.11.0',
      downloaded: 100,
      total: 100,
    },
  });

  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.progress, { downloaded: 100, total: 100, percent: 100 });
});

test('restores enough update metadata from progress events after provider remounts', async () => {
  const { reduceUpdateState } = await importAppUpdateState();

  const ready = reduceUpdateState(
    { status: 'idle', updateInfo: null, progress: null, error: null },
    {
      type: 'progress',
      event: {
        phase: 'installed',
        version: '2.11.0-beta.1',
        downloaded: 100,
        total: 100,
      },
    },
  );

  assert.equal(ready.status, 'ready');
  assert.equal(ready.updateInfo.version, '2.11.0-beta.1');
  assert.equal(ready.updateInfo.channel, 'beta');
  assert.equal(ready.updateInfo.releaseTag, 'v2.11.0-beta.1');
});
