import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

// routerConflict.ts is dependency-free at runtime (type-only core import is
// erased under isolatedModules), so it can be transpiled and imported directly.
async function importRouterConflict() {
  const source = await fs.readFile(
    path.join(desktopDir, 'src', 'lib', 'routerConflict.ts'),
    'utf8',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-router-conflict-'));
  const outputPath = path.join(tempDir, 'routerConflict.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

const CURRENT_STATE = {
  launchTransport: 'routed',
  defaultEnv: 'glm',
  bindings: { 'subagent:Explore': 'glm' },
  allowedEnvs: ['official', 'glm'],
  sourceProfileId: null,
  profileRevision: null,
  dynamicRouting: true,
  revision: 7,
  warnings: [],
};

test('extractRouterServiceError: reads a serialized struct rejection', async () => {
  const { extractRouterServiceError } = await importRouterConflict();
  const err = extractRouterServiceError({
    code: 'ROUTER_REVISION_CONFLICT',
    message: 'Router revision changed; retry from revision 7.',
    current: CURRENT_STATE,
  });
  assert.equal(err.code, 'ROUTER_REVISION_CONFLICT');
  assert.equal(err.current.revision, 7);
  assert.equal(err.current.defaultEnv, 'glm');
});

test('extractRouterServiceError: parses a stringified JSON rejection (Tauri string path)', async () => {
  const { extractRouterServiceError } = await importRouterConflict();
  const payload = JSON.stringify({
    code: 'ROUTER_REVISION_CONFLICT',
    message: 'stale',
    current: CURRENT_STATE,
  });
  const err = extractRouterServiceError(payload);
  assert.equal(err.code, 'ROUTER_REVISION_CONFLICT');
  assert.equal(err.current.revision, 7);
});

test('extractRouterServiceError: conflict.current is undefined when payload omits it', async () => {
  const { extractRouterServiceError } = await importRouterConflict();
  const err = extractRouterServiceError({ code: 'ROUTER_ENV_ALIAS_INVALID', message: 'bad name' });
  assert.equal(err.code, 'ROUTER_ENV_ALIAS_INVALID');
  assert.equal(err.current, undefined);
});

test('extractRouterServiceError: conflict.current is rejected when structurally invalid (revision missing)', async () => {
  const { extractRouterServiceError } = await importRouterConflict();
  const err = extractRouterServiceError({
    code: 'ROUTER_REVISION_CONFLICT',
    message: 'x',
    current: { launchTransport: 'routed', defaultEnv: 'glm' }, // no revision number
  });
  assert.equal(err.code, 'ROUTER_REVISION_CONFLICT');
  assert.equal(err.current, undefined, 'malformed current must not leak through as truthy');
});

test('extractRouterServiceError: unknown shapes never throw and yield a usable fallback', async () => {
  const { extractRouterServiceError } = await importRouterConflict();
  assert.equal(extractRouterServiceError(undefined).code, 'UNKNOWN');
  assert.equal(extractRouterServiceError(null).code, 'UNKNOWN');
  assert.equal(extractRouterServiceError(42).code, 'UNKNOWN');
  assert.equal(extractRouterServiceError('plain string').message, 'plain string');
  assert.equal(extractRouterServiceError('{not json').code, 'UNKNOWN');
  assert.equal(extractRouterServiceError('').message, 'Router request failed');
});

test('extractRouterServiceError: launchTransport must be routed|direct to be trusted', async () => {
  const { extractRouterServiceError } = await importRouterConflict();
  const bogus = { ...CURRENT_STATE, launchTransport: 'banana' };
  const err = extractRouterServiceError({ code: 'X', message: 'y', current: bogus });
  assert.equal(err.current, undefined);
});

test('isRouterOperational: disabled state and config win; starting/degraded/failed stay operational', async () => {
  const { isRouterOperational } = await importRouterConflict();
  assert.equal(isRouterOperational('disabled', true), false);
  assert.equal(isRouterOperational('ready', true), true);
  assert.equal(isRouterOperational('starting', true), true);
  assert.equal(isRouterOperational('degraded', true), true, 'degraded must stay reachable for recovery');
  assert.equal(isRouterOperational('failed', true), true, 'failed must stay reachable for recovery');
  assert.equal(isRouterOperational('ready', false), false, 'config disabled forces off');
  assert.equal(isRouterOperational(undefined, true), false);
});

test('isRouterOperational: chip hides before the first status arrives', async () => {
  const { isRouterOperational } = await importRouterConflict();
  // routerConfig may be loaded before routerStatus; null state must read as inactive.
  assert.equal(isRouterOperational(null, true), false);
});
