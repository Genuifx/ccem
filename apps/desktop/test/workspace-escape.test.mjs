import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importWorkspaceEscape() {
  const sourcePath = path.join(desktopDir, 'src', 'pages', 'workspaceEscape.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-escape-test-'));
  const outputPath = path.join(tempDir, 'workspaceEscape.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function activeInput(overrides = {}) {
  return {
    key: 'Escape',
    isWorkspaceActive: true,
    isLiveSessionVisible: true,
    isSessionActive: true,
    runtimeId: 'runtime-1',
    activeCommandId: 'command-1',
    ...overrides,
  };
}

test('Escape stops only a visible active live session with an authoritative command', async () => {
  const { decideWorkspaceEscape } = await importWorkspaceEscape();

  assert.deepEqual(decideWorkspaceEscape(activeInput()), {
    kind: 'stop',
    runtimeId: 'runtime-1',
    commandId: 'command-1',
  });

  const ignored = [
    { key: 'Enter' },
    { isWorkspaceActive: false },
    { isLiveSessionVisible: false },
    { isSessionActive: false },
    { activeCommandId: null },
    { activeCommandId: '   ' },
    { runtimeId: null },
    { defaultPrevented: true },
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
  ];

  for (const override of ignored) {
    assert.deepEqual(decideWorkspaceEscape(activeInput(override)), { kind: 'ignore' });
  }
});

test('a held Escape cannot interrupt the command admitted after its first press', async () => {
  const { decideWorkspaceEscape } = await importWorkspaceEscape();

  // First physical press stops the visible turn.
  const first = decideWorkspaceEscape(activeInput());
  assert.equal(first.kind, 'stop');

  // The stop releases the turn and a queued prompt is admitted as a new
  // command. Auto-repeat keydowns from the same physical press must not
  // cancel it even though the command identity changed.
  const repeatOnNewCommand = decideWorkspaceEscape(activeInput({
    activeCommandId: 'command-2',
    repeat: true,
    lastRequestedCommand: { runtimeId: 'runtime-1', commandId: 'command-1' },
  }));
  assert.deepEqual(repeatOnNewCommand, { kind: 'ignore' });

  // A distinct later press (repeat: false) remains a deliberate user stop.
  const distinctPress = decideWorkspaceEscape(activeInput({
    activeCommandId: 'command-2',
    lastRequestedCommand: { runtimeId: 'runtime-1', commandId: 'command-1' },
  }));
  assert.deepEqual(distinctPress, {
    kind: 'stop',
    runtimeId: 'runtime-1',
    commandId: 'command-2',
  });
});

test('form controls, editable content, dialogs, menus, popovers, and command palettes own Escape', async () => {
  const {
    decideWorkspaceEscape,
    hasOpenWorkspaceEscapeLayer,
    isWorkspaceEscapeOwnedByTarget,
  } = await importWorkspaceEscape();
  const dom = new JSDOM(`
    <main>
      <input id="input" />
      <textarea id="textarea"></textarea>
      <select id="select"><option>one</option></select>
      <div id="editable" contenteditable="true"><span id="editable-child">draft</span></div>
      <div role="dialog" data-state="open"><button id="dialog-button">close</button></div>
      <div role="menu" data-state="open"><button id="menu-item" role="menuitem">item</button></div>
      <div id="popover" data-state="open" data-side="bottom"><button id="popover-button">action</button></div>
      <div data-command-palette data-state="open"><button id="palette-button">command</button></div>
      <button id="workspace-button">workspace action</button>
    </main>
  `);
  const document = dom.window.document;

  for (const id of [
    'input',
    'textarea',
    'select',
    'editable-child',
    'dialog-button',
    'menu-item',
    'popover-button',
    'palette-button',
  ]) {
    const target = document.getElementById(id);
    assert.equal(isWorkspaceEscapeOwnedByTarget(target), true, `${id} must own Escape`);
    assert.deepEqual(decideWorkspaceEscape(activeInput({ target })), { kind: 'ignore' });
  }

  assert.equal(
    isWorkspaceEscapeOwnedByTarget(document.getElementById('workspace-button')),
    false,
  );
  assert.equal(hasOpenWorkspaceEscapeLayer(document), true);
  assert.deepEqual(
    decideWorkspaceEscape(activeInput({ hasOpenInteractionLayer: true })),
    { kind: 'ignore' },
  );
});

test('one command can be interrupted once while a changed command can be interrupted again', async () => {
  const { decideWorkspaceEscape } = await importWorkspaceEscape();
  const first = decideWorkspaceEscape(activeInput());
  assert.deepEqual(first, {
    kind: 'stop',
    runtimeId: 'runtime-1',
    commandId: 'command-1',
  });

  assert.deepEqual(
    decideWorkspaceEscape(activeInput({ lastRequestedCommand: first })),
    { kind: 'ignore' },
    'key repeat and repeated Escape must not send a second stop for the same command',
  );
  assert.deepEqual(
    decideWorkspaceEscape(activeInput({
      activeCommandId: 'command-2',
      lastRequestedCommand: first,
    })),
    {
      kind: 'stop',
      runtimeId: 'runtime-1',
      commandId: 'command-2',
    },
  );
  assert.deepEqual(
    decideWorkspaceEscape(activeInput({
      runtimeId: 'runtime-2',
      lastRequestedCommand: first,
    })),
    {
      kind: 'stop',
      runtimeId: 'runtime-2',
      commandId: 'command-1',
    },
  );
});

test('unmanaged provider Escape uses runtime interrupt only while processing', async () => {
  const { decideWorkspaceEscape } = await importWorkspaceEscape();
  for (const provider of ['codex', 'opencode']) {
    const input = activeInput({ provider, activeCommandId: null, isProviderProcessing: true });
    assert.deepEqual(decideWorkspaceEscape(input), { kind: 'stop', runtimeId: 'runtime-1', commandId: null });
    assert.deepEqual(decideWorkspaceEscape({ ...input, repeat: true }), { kind: 'ignore' });
    assert.deepEqual(decideWorkspaceEscape({ ...input, isProviderProcessing: false }), { kind: 'ignore' });
    // A new physical press after another provider turn must not be deduped by a null command id.
    assert.equal(decideWorkspaceEscape({ ...input, lastRequestedCommand: { runtimeId: 'runtime-1', commandId: null } }).kind, 'stop');
  }
});
