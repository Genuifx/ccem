import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importComposerEscInterrupt() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'composerEscInterrupt.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-composer-esc-interrupt-test-'));
  const outputPath = path.join(tempDir, 'composerEscInterrupt.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function composerKey(overrides = {}) {
  return {
    key: 'Escape',
    isArmed: false,
    available: true,
    triggerPanelOpen: false,
    ...overrides,
  };
}

test('first Escape arms the confirm state, second Escape confirms the interrupt', async () => {
  const { decideComposerEscInterrupt } = await importComposerEscInterrupt();

  assert.deepEqual(decideComposerEscInterrupt(composerKey()), { kind: 'arm' });
  assert.deepEqual(decideComposerEscInterrupt(composerKey({ isArmed: true })), { kind: 'confirm' });
});

test('Escape never arms or confirms when the session is not interruptable', async () => {
  const { decideComposerEscInterrupt } = await importComposerEscInterrupt();

  assert.deepEqual(decideComposerEscInterrupt(composerKey({ available: false })), { kind: 'skip' });
  assert.deepEqual(decideComposerEscInterrupt(composerKey({ available: false, isArmed: true })), { kind: 'skip' });
});

test('trigger dropdowns, IME composition, auto-repeat, and handled keys keep Escape ownership', async () => {
  const { decideComposerEscInterrupt } = await importComposerEscInterrupt();

  const skipped = [
    { triggerPanelOpen: true },
    { triggerPanelOpen: true, isArmed: true },
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { defaultPrevented: true },
  ];
  for (const override of skipped) {
    assert.deepEqual(decideComposerEscInterrupt(composerKey(override)), { kind: 'skip' });
  }
});

test('any other keystroke cancels an armed state and leaves an unarmed composer untouched', async () => {
  const { decideComposerEscInterrupt } = await importComposerEscInterrupt();

  assert.deepEqual(decideComposerEscInterrupt(composerKey({ key: 'a', isArmed: true })), { kind: 'disarm' });
  assert.deepEqual(decideComposerEscInterrupt(composerKey({ key: 'Enter', isArmed: true })), { kind: 'disarm' });
  assert.deepEqual(decideComposerEscInterrupt(composerKey({ key: 'a' })), { kind: 'skip' });
});

test('armed state auto-expires so a stale confirm cannot hijack a later send', async () => {
  const { COMPOSER_ESC_INTERRUPT_ARM_TIMEOUT_MS } = await importComposerEscInterrupt();

  assert.equal(typeof COMPOSER_ESC_INTERRUPT_ARM_TIMEOUT_MS, 'number');
  assert.ok(COMPOSER_ESC_INTERRUPT_ARM_TIMEOUT_MS > 0 && COMPOSER_ESC_INTERRUPT_ARM_TIMEOUT_MS <= 5000);
});
