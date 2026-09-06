import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { run } from '../scripts/prepare-adhoc-cef-before-bundle.mjs';

test('ad-hoc build prepares nested code before Rust consumes framework paths', async () => {
  const config = JSON.parse(await fs.readFile(new URL('../src-tauri/tauri.cef.adhoc.conf.json', import.meta.url)));
  assert.equal(config.build.beforeBuildCommand, 'pnpm build && node scripts/prepare-adhoc-cef-before-bundle.mjs');
  assert.equal(config.build.beforeBundleCommand, 'node scripts/macos-adhoc-cef-signing.mjs --verify-stage');
  assert.deepEqual(config.build.features, ['macos-adhoc-cef']);
  assert.equal(config.bundle.macOS.signingIdentity, '-');
  assert.equal(config.bundle.macOS.hardenedRuntime, false);
});

test('helper staging cannot inherit unbuilt framework paths and restores parent config', { skip: process.platform !== 'darwin' }, async (t) => {
  const original = process.env.TAURI_CONFIG;
  t.after(() => {
    if (original === undefined) delete process.env.TAURI_CONFIG;
    else process.env.TAURI_CONFIG = original;
  });
  process.env.TAURI_CONFIG = '{"bundle":{"macOS":{"frameworks":["not-built-yet"]}}}';
  const parent = process.env.TAURI_CONFIG;
  const steps = [];
  await run({
    stage: async () => {
      assert.equal(process.env.TAURI_CONFIG, undefined);
      steps.push('stage');
      return { status: 'staged', plan: { outputDir: '/stage' } };
    },
    sign: (directory) => {
      assert.equal(directory, '/stage');
      assert.equal(process.env.TAURI_CONFIG, parent);
      steps.push('sign');
    },
  });
  assert.deepEqual(steps, ['stage', 'sign']);
  await assert.rejects(run({ stage: async () => { throw new Error('helper failed'); } }), /helper failed/u);
  assert.equal(process.env.TAURI_CONFIG, parent);
});
