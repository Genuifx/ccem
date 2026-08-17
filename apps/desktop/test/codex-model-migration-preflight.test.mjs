import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, stop as stopEsbuild } from 'esbuild';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

after(() => stopEsbuild());

function affected(model = 'gpt-5.4', proofToken = 'proof-a') {
  return model === 'gpt-5.4-mini'
    ? {
        status: 'affected',
        model,
        replacement: 'gpt-5.6-luna',
        proofToken,
      }
    : {
        status: 'affected',
        model,
        replacement: 'gpt-5.6-terra',
        proofToken,
      };
}

async function resolveDesktopSource(importPath) {
  const base = path.join(desktopDir, 'src', importPath.slice(2));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next source shape.
    }
  }
  return null;
}

async function importGate() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-codex-migration-gate-'));
  const outfile = path.join(tempDir, 'gate.cjs');
  await build({
    entryPoints: [path.join(
      desktopDir,
      'src/components/workspace/workspaceCodexModelMigration.ts',
    )],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
  });
  return {
    gate: await import(pathToFileURL(outfile).href),
    tempDir,
  };
}

test('safe, unknown, malformed, and failed probes start silently while Claude skips the probe', async () => {
  const { gate, tempDir } = await importGate();
  try {
    let claudeProbeCount = 0;
    let claudeStartCount = 0;
    const claudeLaunch = await gate.startAfterCodexModelMigrationGate({
      provider: 'claude',
      envName: 'official',
      workingDir: '/workspace/claude',
      preflight: async () => {
        claudeProbeCount += 1;
        return affected();
      },
      confirm: async () => false,
      start: async () => {
        claudeStartCount += 1;
        return 'claude-session';
      },
    });
    assert.deepEqual(claudeLaunch, { started: true, value: 'claude-session' });
    assert.equal(claudeProbeCount, 0);
    assert.equal(claudeStartCount, 1);

    const silentResults = [
      { status: 'unaffected' },
      { status: 'unknown' },
      { status: 'affected', model: 'gpt-5.4', replacement: 'gpt-5.6-terra' },
      { status: 'affected', model: 'GPT-5.4', replacement: 'gpt-5.6-terra', proofToken: 'bad' },
      { status: 'affected', model: 'gpt-5.4', replacement: 'gpt-5.6-luna', proofToken: 'bad' },
    ];

    for (const result of silentResults) {
      let confirmCount = 0;
      let startCount = 0;
      const launch = await gate.startAfterCodexModelMigrationGate({
        provider: 'codex',
        envName: 'official',
        workingDir: '/workspace/codex',
        preflight: async () => result,
        confirm: async () => {
          confirmCount += 1;
          return false;
        },
        start: async () => {
          startCount += 1;
          return 'codex-session';
        },
      });
      assert.deepEqual(launch, { started: true, value: 'codex-session' });
      assert.equal(confirmCount, 0);
      assert.equal(startCount, 1);
    }

    let failedStartCount = 0;
    const failedProbeLaunch = await gate.startAfterCodexModelMigrationGate({
      provider: 'codex',
      envName: 'official',
      workingDir: '/workspace/codex',
      preflight: async () => {
        throw new Error('bridge unavailable');
      },
      confirm: async () => false,
      start: async () => {
        failedStartCount += 1;
        return 'codex-session';
      },
    });
    assert.equal(failedProbeLaunch.started, true);
    assert.equal(failedStartCount, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('cancel stops before native creation and leaves launch-owned state untouched', async () => {
  const { gate, tempDir } = await importGate();
  try {
    const events = [];
    const launch = await gate.startAfterCodexModelMigrationGate({
      provider: 'codex',
      envName: 'official',
      workingDir: '/workspace/cancel',
      preflight: async () => {
        events.push('probe');
        return affected('gpt-5.4-mini', 'proof-cancel');
      },
      confirm: async () => {
        events.push('cancel');
        return false;
      },
      start: async () => {
        events.push('create');
        return 'must-not-exist';
      },
    });

    assert.deepEqual(launch, { started: false, reason: 'cancelled' });
    assert.deepEqual(events, ['probe', 'cancel']);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('continue rechecks the exact proof before one create and remembers only that proof', async () => {
  const { gate, tempDir } = await importGate();
  try {
    const acknowledgedWarnings = new Set();
    const events = [];
    const createProofs = [];
    const warning = affected('gpt-5.4', 'proof-stable');
    const launch = () => gate.startAfterCodexModelMigrationGate({
      provider: 'codex',
      envName: 'official',
      workingDir: '/workspace/stable',
      preflight: async () => {
        events.push('probe');
        return warning;
      },
      confirm: async () => {
        events.push('confirm');
        return true;
      },
      acknowledgedWarnings,
      start: async (proofToken) => {
        events.push('create');
        createProofs.push(proofToken);
        return 'session';
      },
    });

    assert.deepEqual(await launch(), { started: true, value: 'session' });
    assert.deepEqual(events, ['probe', 'confirm', 'probe', 'create']);
    assert.deepEqual(createProofs, ['proof-stable']);
    assert.equal(acknowledgedWarnings.size, 1);

    events.length = 0;
    assert.deepEqual(await launch(), { started: true, value: 'session' });
    assert.deepEqual(events, ['probe', 'create']);
    assert.deepEqual(createProofs, ['proof-stable', 'proof-stable']);

    events.length = 0;
    let changedProofProbeCount = 0;
    const changedProof = await gate.startAfterCodexModelMigrationGate({
      provider: 'codex',
      envName: 'official',
      workingDir: '/workspace/stable',
      preflight: async () => {
        changedProofProbeCount += 1;
        events.push('probe-changed');
        return affected('gpt-5.4', 'proof-changed');
      },
      confirm: async () => {
        events.push('confirm-changed');
        return false;
      },
      acknowledgedWarnings,
      start: async () => {
        events.push('create-changed');
        return 'session';
      },
    });
    assert.deepEqual(changedProof, { started: false, reason: 'cancelled' });
    assert.equal(changedProofProbeCount, 1);
    assert.deepEqual(events, ['probe-changed', 'confirm-changed']);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('a changed affected proof refreshes confirmation until the exact result is stable', async () => {
  const { gate, tempDir } = await importGate();
  try {
    const sequence = [
      affected('gpt-5.4', 'proof-before'),
      affected('gpt-5.4-mini', 'proof-after'),
      affected('gpt-5.4-mini', 'proof-after'),
    ];
    const confirmed = [];
    let startCount = 0;
    const launch = await gate.startAfterCodexModelMigrationGate({
      provider: 'codex',
      envName: 'official',
      workingDir: '/workspace/changed',
      preflight: async () => sequence.shift(),
      confirm: async (warning) => {
        confirmed.push([warning.model, warning.replacement, warning.proofToken]);
        return true;
      },
      acknowledgedWarnings: new Set(),
      start: async () => {
        startCount += 1;
        return 'session';
      },
    });

    assert.deepEqual(launch, { started: true, value: 'session' });
    assert.deepEqual(confirmed, [
      ['gpt-5.4', 'gpt-5.6-terra', 'proof-before'],
      ['gpt-5.4-mini', 'gpt-5.6-luna', 'proof-after'],
    ]);
    assert.equal(startCount, 1);
    assert.equal(sequence.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('an atomic create sentinel refreshes the gate and sends only the newly confirmed proof', async () => {
  const { gate, tempDir } = await importGate();
  try {
    const sequence = [
      affected('gpt-5.4', 'proof-before-create'),
      affected('gpt-5.4', 'proof-before-create'),
      affected('gpt-5.4-mini', 'proof-after-create'),
      affected('gpt-5.4-mini', 'proof-after-create'),
    ];
    const confirmed = [];
    const createProofs = [];
    const launch = await gate.startAfterCodexModelMigrationGate({
      provider: 'codex',
      envName: 'official',
      workingDir: '/workspace/atomic-change',
      preflight: async () => sequence.shift(),
      confirm: async (warning) => {
        confirmed.push(warning.proofToken);
        return true;
      },
      acknowledgedWarnings: new Set(),
      start: async (proofToken) => {
        createProofs.push(proofToken);
        if (createProofs.length === 1) {
          throw new Error('codex_migration_preflight_changed');
        }
        return 'session-after-refresh';
      },
    });

    assert.deepEqual(launch, { started: true, value: 'session-after-refresh' });
    assert.deepEqual(confirmed, ['proof-before-create', 'proof-after-create']);
    assert.deepEqual(createProofs, ['proof-before-create', 'proof-after-create']);
    assert.equal(sequence.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('repeated atomic proof changes stop without surfacing a generic create failure', async () => {
  const { gate, tempDir } = await importGate();
  try {
    let probeCount = 0;
    let confirmCount = 0;
    let startCount = 0;
    const sentinelShapes = [
      'codex_migration_preflight_changed',
      { code: 'codex_migration_preflight_changed' },
      { message: 'codex_migration_preflight_changed' },
    ];
    const launch = await gate.startAfterCodexModelMigrationGate({
      provider: 'codex',
      envName: 'official',
      workingDir: '/workspace/keeps-changing',
      preflight: async () => {
        probeCount += 1;
        return affected('gpt-5.4', 'proof-loop');
      },
      confirm: async () => {
        confirmCount += 1;
        return true;
      },
      acknowledgedWarnings: new Set(),
      start: async () => {
        const sentinel = sentinelShapes[startCount];
        startCount += 1;
        throw sentinel;
      },
    });

    assert.deepEqual(launch, { started: false, reason: 'preflight_changed' });
    assert.equal(confirmCount, 1, 'an unchanged acknowledged proof must not reopen the dialog');
    assert.equal(probeCount, 4, 'the initial proof is checked twice, then refreshed before each retry');
    assert.equal(startCount, 3);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('unknown, unaffected, or failed rechecks fail open without caching stale approval', async () => {
  const { gate, tempDir } = await importGate();
  try {
    const rechecks = [
      async () => ({ status: 'unknown' }),
      async () => ({ status: 'unaffected' }),
      async () => {
        throw new Error('read changed while dialog was open');
      },
    ];

    for (const recheck of rechecks) {
      const acknowledgedWarnings = new Set();
      let probeCount = 0;
      let startCount = 0;
      const launch = await gate.startAfterCodexModelMigrationGate({
        provider: 'codex',
        envName: 'official',
        workingDir: '/workspace/recheck',
        preflight: async () => {
          probeCount += 1;
          return probeCount === 1 ? affected('gpt-5.4', 'proof-stale') : recheck();
        },
        confirm: async () => true,
        acknowledgedWarnings,
        start: async () => {
          startCount += 1;
          return 'session';
        },
      });

      assert.deepEqual(launch, { started: true, value: 'session' });
      assert.equal(probeCount, 2);
      assert.equal(startCount, 1);
      assert.equal(acknowledgedWarnings.size, 0);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

const dialogLabels = {
  'workspace.codexModelMigrationTitle': 'This Codex model is being retired',
  'workspace.codexModelMigrationDescription': 'This workspace is configured to start Codex with {model}. OpenAI will stop supporting it for ChatGPT sign-ins on August 31, 2026.',
  'workspace.codexModelMigrationReplacementLabel': 'OpenAI recommends',
  'workspace.codexModelMigrationBoundary': 'CCEM will not edit your Codex configuration. Continue rechecks it, then starts with the current settings; cancel keeps your draft.',
  'workspace.codexModelMigrationCancel': 'Not now',
  'workspace.codexModelMigrationContinue': 'Continue starting',
};

async function importDialogHarness() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-codex-migration-dialog-'));
  const outfile = path.join(tempDir, 'dialog.cjs');
  await build({
    stdin: {
      contents: `
        import React, { act, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { WorkspaceCodexModelMigrationDialog } from '@/components/workspace/WorkspaceCodexModelMigrationDialog';

        const warning = ${JSON.stringify(affected('gpt-5.4', 'proof-dialog'))};

        function ControlledDialog({ onCancel, onContinue }) {
          const [open, setOpen] = useState(true);
          return (
            <WorkspaceCodexModelMigrationDialog
              open={open}
              warning={open ? warning : null}
              onCancel={() => {
                onCancel();
                setOpen(false);
              }}
              onContinue={() => {
                onContinue();
                setOpen(false);
              }}
            />
          );
        }

        export function mount(container, callbacks) {
          const root = createRoot(container);
          act(() => root.render(<ControlledDialog {...callbacks} />));
          return {
            click(element) {
              act(() => element.click());
            },
            unmount() {
              act(() => root.unmount());
            },
          };
        }

        export async function flush() {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
        }
      `,
      resolveDir: desktopDir,
      sourcefile: 'codex-model-migration-dialog-harness.tsx',
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'desktop-alias-and-locale-stub',
      setup(builder) {
        builder.onResolve({ filter: /^@\/locales$/ }, () => ({
          path: 'locales',
          namespace: 'stub',
        }));
        builder.onLoad({ filter: /^locales$/, namespace: 'stub' }, () => ({
          loader: 'js',
          contents: `
            const labels = ${JSON.stringify(dialogLabels)};
            export function useLocale() {
              return {
                t(key, params = {}) {
                  return Object.entries(params).reduce(
                    (message, [name, value]) => message.split('{' + name + '}').join(String(value)),
                    labels[key] || key,
                  );
                },
              };
            }
          `,
        }));
        builder.onResolve({ filter: /^@\// }, async (args) => {
          const resolved = await resolveDesktopSource(args.path);
          return resolved
            ? { path: resolved }
            : { errors: [{ text: `Cannot resolve ${args.path}` }] };
        });
      },
    }],
    logLevel: 'silent',
  });
  return {
    harness: await import(pathToFileURL(outfile).href),
    tempDir,
  };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  });
  const { window } = dom;
  const previous = new Map();
  const expose = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };

  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class TestMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })),
      };
    }
  }

  for (const name of [
    'Node',
    'NodeFilter',
    'Element',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'HTMLTextAreaElement',
    'SVGElement',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'CustomEvent',
    'MutationObserver',
    'DOMRect',
  ]) {
    expose(name, window[name]);
  }
  expose('window', window);
  expose('self', window);
  expose('document', window.document);
  expose('navigator', window.navigator);
  expose('getComputedStyle', window.getComputedStyle.bind(window));
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  expose('MessageChannel', TestMessageChannel);
  expose('ResizeObserver', ResizeObserver);
  expose('PointerEvent', window.MouseEvent);
  expose('requestAnimationFrame', (callback) => setTimeout(() => callback(Date.now()), 0));
  expose('cancelAnimationFrame', clearTimeout);
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: ResizeObserver });
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: window.MouseEvent });

  return {
    container: window.document.getElementById('root'),
    restore() {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete globalThis[name];
        }
      }
    },
  };
}

test('migration dialog shows the consequence and exact replacement before either decision', async () => {
  const { container, restore } = installDom();
  const { harness, tempDir } = await importDialogHarness();
  const decisions = [];
  let mounted;
  try {
    mounted = harness.mount(container, {
      onCancel: () => decisions.push('cancel'),
      onContinue: () => decisions.push('continue'),
    });
    await harness.flush();

    const dialog = document.querySelector('[data-codex-model-migration-dialog]');
    assert.ok(dialog);
    assert.match(dialog.textContent, /August 31, 2026/);
    assert.match(dialog.textContent, /gpt-5\.4\s*→\s*gpt-5\.6-terra/);
    assert.match(dialog.textContent, /will not edit your Codex configuration/);

    const cancel = dialog.querySelector('[data-codex-model-migration-cancel]');
    const continueButton = dialog.querySelector('[data-codex-model-migration-continue]');
    assert.equal(cancel?.textContent, 'Not now');
    assert.equal(continueButton?.textContent, 'Continue starting');

    mounted.click(cancel);
    await harness.flush();
    assert.deepEqual(decisions, ['cancel']);
    assert.equal(document.querySelector('[data-codex-model-migration-dialog]'), null);
  } finally {
    mounted?.unmount();
    restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Workspace wires both native launch paths through the gate and preserves resume identity and drafts', async () => {
  const source = await fs.readFile(path.join(desktopDir, 'src/pages/Workspace.tsx'), 'utf8');
  const createStart = source.indexOf('const handleCreateNativeConversation');
  const resumeStart = source.indexOf('const handleContinueHistorySession');
  const createBlock = source.slice(createStart, resumeStart);
  const resumeBlock = source.slice(resumeStart, source.indexOf('const handleLiveSessionUpdate', resumeStart));

  assert.ok(createStart >= 0 && resumeStart > createStart);
  assert.match(createBlock, /startAfterCodexModelMigrationGate\(\{/);
  assert.match(resumeBlock, /startAfterCodexModelMigrationGate\(\{/);
  assert.match(resumeBlock, /providerSessionId:\s*selectedSession\.id/);

  assert.ok(
    createBlock.indexOf('if (!launch.started)') < createBlock.indexOf("resetComposePrompt('')"),
    'cancel returns before the new-session draft is cleared',
  );
  assert.ok(
    resumeBlock.indexOf('if (!launch.started)') < resumeBlock.indexOf("resetHistoryComposerText('')"),
    'cancel returns before the resumed-session draft is cleared',
  );

  const hookSource = await fs.readFile(
    path.join(desktopDir, 'src/hooks/useTauriCommands.ts'),
    'utf8',
  );
  assert.match(
    hookSource,
    /invoke<CodexModelMigrationPreflightResult>\('preflight_codex_model_migration'/,
  );
  assert.match(hookSource, /codexMigrationProofToken:\s*options\.codexMigrationProofToken \?\? null/);
  assert.match(source, /workspace\.codexModelMigrationChanged/);
});
