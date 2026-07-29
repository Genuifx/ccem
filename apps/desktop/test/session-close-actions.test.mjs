import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importSessionCloseActions() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'components',
    'sessions',
    'sessionCloseActions.ts',
  );
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ccem-session-close-actions-test-'),
  );
  const outputPath = path.join(tempDir, 'sessionCloseActions.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

test('active headless session resolves to stopThenRemoveHeadless', async () => {
  const { resolveSessionCloseAction } = await importSessionCloseActions();

  for (const status of ['ready', 'processing', 'waiting_permission', 'initializing']) {
    const result = resolveSessionCloseAction({
      unifiedSession: { runtimeKind: 'headless', status, id: 'h1' },
      hasLegacySession: false,
    });
    assert.equal(result, 'stopThenRemoveHeadless', `status ${status} should be stopThenRemoveHeadless`);
  }
});

test('inactive headless session resolves to removeHeadless', async () => {
  const { resolveSessionCloseAction } = await importSessionCloseActions();

  const result = resolveSessionCloseAction({
    unifiedSession: { runtimeKind: 'headless', status: 'completed', id: 'h1' },
    hasLegacySession: false,
  });
  assert.equal(result, 'removeHeadless');
});

test('unified-only interactive session resolves to closeUnifiedInteractive', async () => {
  const { resolveSessionCloseAction } = await importSessionCloseActions();

  const result = resolveSessionCloseAction({
    unifiedSession: { runtimeKind: 'interactive', status: 'running', id: 'i1' },
    hasLegacySession: false,
  });
  assert.equal(result, 'closeUnifiedInteractive');
});

test('unified interactive with a legacy match resolves to closeLegacyInteractive', async () => {
  const { resolveSessionCloseAction } = await importSessionCloseActions();

  const result = resolveSessionCloseAction({
    unifiedSession: { runtimeKind: 'interactive', status: 'running', id: 'i1' },
    hasLegacySession: true,
  });
  assert.equal(result, 'closeLegacyInteractive');
});

test('legacy-only session (no unified) resolves to closeLegacyInteractive', async () => {
  const { resolveSessionCloseAction } = await importSessionCloseActions();

  const result = resolveSessionCloseAction({
    unifiedSession: undefined,
    hasLegacySession: true,
  });
  assert.equal(result, 'closeLegacyInteractive');
});

test('close failures stay actionable and visible to the user', async () => {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'pages', 'Sessions.tsx'),
    'utf8',
  );
  const handler = source.match(
    /const handleConfirmClose = async \(id: string\) => \{([\s\S]*?)\n  \};/,
  )?.[1];

  assert.ok(handler, 'expected the session close confirmation handler');
  assert.match(handler, /setConfirmingId\(null\);\s*\} catch \(err\) \{/);
  assert.match(
    handler,
    /toast\.error\(t\('sessions\.stopFailed'\)\.replace\('\{error\}', String\(err\)\)\)/,
  );
  assert.doesNotMatch(
    handler,
    /\} finally \{\s*setConfirmingId\(null\)/,
    'a failed close must leave the confirmation controls available for retry',
  );
});
