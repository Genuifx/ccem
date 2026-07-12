import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importControlModel() {
  const sourcePath = path.join(
    desktopDir,
    'src',
    'components',
    'login-browser',
    'loginBrowserControlModel.ts',
  );
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-login-browser-control-'));
  const outputPath = path.join(tempDir, 'loginBrowserControlModel.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function snapshot(overrides = {}) {
  return {
    session_id: 'login-session-0123456789abcdef',
    profile_id: 'login-profile-0123456789abcdef',
    workspace_id: 'workspace-0123456789abcdef',
    runtime_version: '150.0.7871.115',
    control: 'user',
    handoff_epoch: 2,
    current_origin: 'https://accounts.example.test',
    status: 'running',
    ...overrides,
  };
}

test('manual login starts with only agent handoff and close available', async () => {
  const { deriveLoginBrowserControlModel } = await importControlModel();

  assert.deepEqual(deriveLoginBrowserControlModel(snapshot()), {
    owner: 'user',
    ownerTone: 'human',
    primaryAction: 'handoff',
    secondaryAction: null,
    closeAction: 'close',
    canControl: true,
  });
});

test('agent ownership exposes immediate pause and user takeover', async () => {
  const { deriveLoginBrowserControlModel } = await importControlModel();

  assert.deepEqual(deriveLoginBrowserControlModel(snapshot({ control: 'agent' })), {
    owner: 'agent',
    ownerTone: 'agent',
    primaryAction: 'pause',
    secondaryAction: 'takeover',
    closeAction: 'close',
    canControl: true,
  });
});

test('paused ownership can be explicitly resumed or taken over by the user', async () => {
  const { deriveLoginBrowserControlModel } = await importControlModel();

  assert.deepEqual(deriveLoginBrowserControlModel(snapshot({ control: 'paused' })), {
    owner: 'paused',
    ownerTone: 'paused',
    primaryAction: 'handoff',
    secondaryAction: 'takeover',
    closeAction: 'close',
    canControl: true,
  });
});

test('closing and cleanup states fail closed instead of exposing control transitions', async () => {
  const { deriveLoginBrowserControlModel } = await importControlModel();

  assert.deepEqual(deriveLoginBrowserControlModel(snapshot({ status: 'closing' })), {
    owner: 'paused',
    ownerTone: 'paused',
    primaryAction: null,
    secondaryAction: null,
    closeAction: null,
    canControl: false,
  });
  assert.deepEqual(deriveLoginBrowserControlModel(snapshot({ status: 'cleanup_required' })), {
    owner: 'paused',
    ownerTone: 'danger',
    primaryAction: null,
    secondaryAction: null,
    closeAction: 'force_close',
    canControl: false,
  });
});

test('opaque ids stay recognizable without consuming the compact control window', async () => {
  const { compactOpaqueId } = await importControlModel();

  assert.equal(compactOpaqueId('login-profile-0123456789abcdef'), 'login-profile-…0123·89abcdef');
  assert.equal(compactOpaqueId('short-id'), 'short-id');
});

test('recent proof summary counts every bounded kind and selects the newest artifact', async () => {
  const { summarizeLoginBrowserRecentActivity } = await importControlModel();
  const latest = {
    kind: 'network_log',
    artifact_id: 'network-proof-9876543210',
    byte_size: 1536,
    modified_at: '2026-07-11T05:04:00Z',
    immutable: true,
    untrusted: true,
  };

  assert.deepEqual(summarizeLoginBrowserRecentActivity({ artifacts: [
    {
      kind: 'screenshot',
      artifact_id: 'screenshot-proof',
      byte_size: 999,
      modified_at: '2026-07-11T05:00:00Z',
      immutable: true,
      untrusted: true,
    },
    {
      kind: 'audit_log',
      artifact_id: 'audit-proof',
      byte_size: 4096,
      modified_at: '2026-07-11T05:02:00Z',
      immutable: true,
      untrusted: true,
    },
    latest,
    {
      kind: 'network_log',
      artifact_id: 'older-network-proof',
      byte_size: 512,
      modified_at: '2026-07-11T04:59:00Z',
      immutable: true,
      untrusted: true,
    },
  ] }), {
    total: 4,
    counts: {
      screenshot: 1,
      interaction_snapshot: 0,
      console_log: 0,
      network_log: 2,
      audit_log: 1,
    },
    latest,
  });
});

test('recent proof byte labels stay compact and reject invalid sizes', async () => {
  const { formatLoginBrowserArtifactBytes } = await importControlModel();

  assert.equal(formatLoginBrowserArtifactBytes(512), '512 B');
  assert.equal(formatLoginBrowserArtifactBytes(1536), '1.5 KB');
  assert.equal(formatLoginBrowserArtifactBytes(2.25 * 1024 * 1024), '2.3 MB');
  assert.equal(formatLoginBrowserArtifactBytes(Number.NaN), '0 B');
});

test('backend failures are flattened and bounded before display', async () => {
  const { formatLoginBrowserControlError } = await importControlModel();
  const noisy = new Error(`  first line\n${'x'.repeat(240)}  `);
  const formatted = formatLoginBrowserControlError(noisy);

  assert.equal(formatted.includes('\n'), false);
  assert.equal(formatted.length, 160);
  assert.match(formatted, /^first line x+/);
  assert.equal(formatLoginBrowserControlError(null), 'Login Browser control is unavailable.');
});
