import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await fs.readFile(new URL('../src/hooks/useZoom.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
// Native promise resolution crosses the VM realm before applyZoom resumes.
const settleNativeZoom = () => new Promise((resolve) => setImmediate(resolve));

function mountZoom({ stored = null, storageFails = false } = {}) {
  const pending = [];
  const effects = [];
  const listeners = new Map();
  const sandbox = {
    exports: {},
    require: (name) => {
      if (name === 'react') return { useEffect: (effect) => effects.push(effect) };
      if (name === '@tauri-apps/api/webview') return {
        getCurrentWebview: () => ({ setZoom: (value) => new Promise((resolve, reject) => pending.push({ value, resolve, reject })) }),
      };
      throw Error(`Unexpected import: ${name}`);
    },
    console: { warn() {} },
    navigator: { platform: 'MacIntel', userAgent: 'Macintosh' },
    localStorage: {
      getItem: () => stored,
      setItem: (_, value) => { if (storageFails) throw Error('QuotaExceededError'); stored = value; },
      removeItem: () => { if (storageFails) throw Error('QuotaExceededError'); stored = null; },
    },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    window: {
      addEventListener: (name, handler) => listeners.set(name, handler),
      removeEventListener: (name) => listeners.delete(name),
      dispatchEvent: (event) => listeners.get(event.type)?.(event),
    },
  };
  vm.runInNewContext(outputText, sandbox);
  const api = sandbox.exports;
  api.useZoom();
  const dispose = effects[0]();
  return { api, pending, dispose };
}

test('drag geometry uses native acknowledged zoom instead of a pending saved preference', async () => {
  const { api, pending, dispose } = mountZoom({ stored: '0.8' });
  assert.equal(pending[0].value, 0.8);
  assert.equal(api.readAppZoom(), 1);
  pending.shift().resolve();
  await settleNativeZoom();
  assert.equal(api.readAppZoom(), 0.8);
  dispose();
});

test('successful zoom remains available when localStorage writes fail', async () => {
  const { api, pending, dispose } = mountZoom({ storageFails: true });
  pending.shift().resolve();
  await settleNativeZoom();
  for (const expected of [0.9, 0.8]) {
    api.dispatchAppZoomCommand('zoom_out');
    assert.equal(pending[0].value, expected);
    pending.shift().resolve();
    await settleNativeZoom();
    assert.equal(api.readAppZoom(), expected);
  }
  dispose();
});

test('a rejected native zoom keeps the last successfully applied geometry', async () => {
  const { api, pending, dispose } = mountZoom({ stored: '0.8' });
  pending.shift().resolve();
  await settleNativeZoom();
  api.dispatchAppZoomCommand('zoom_in');
  assert.equal(pending[0].value, 0.9);
  pending.shift().reject(Error('native zoom unavailable'));
  await settleNativeZoom();
  assert.equal(api.readAppZoom(), 0.8);
  dispose();
});
