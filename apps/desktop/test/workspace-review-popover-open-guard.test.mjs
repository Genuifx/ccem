import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function readReviewDetails() {
  try {
    return await fs.readFile(
      path.join(desktopDir, 'src', 'components', 'workspace', 'WorkspaceReviewDetails.tsx'),
      'utf8',
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

test('WorkspaceReviewDetails routes open-file through the workspace-guarded IPC command', async () => {
  const component = await readReviewDetails();

  // MUST NOT import the unguarded shell plugin open() — that bypasses the Rust
  // workspace guard and lets session review open arbitrary paths.
  assert.doesNotMatch(
    component,
    /from ['"]@tauri-apps\/plugin-shell['"]/,
    'details must not import @tauri-apps/plugin-shell; route through open_file_in_workspace instead',
  );
  assert.doesNotMatch(
    component,
    /\bopen\(\s*resolveWorkspacePath/,
    'details must not call shell open() with a client-resolved path',
  );

  // MUST invoke the guarded Rust command. The command canonicalizes the
  // session project_dir and rejects any path that escapes it.
  assert.match(
    component,
    /invoke<boolean>\(\s*['"]open_file_in_workspace['"]\s*,\s*\{\s*workingDir:\s*session\.project_dir,\s*filePath:\s*path,?\s*\}\s*\)/,
    'openInEditor must invoke open_file_in_workspace with workingDir + filePath',
  );

  // The client MUST NOT pre-resolve absolute paths itself; resolution belongs
  // to the Rust guard so symlinks and ../ escapes are caught post-canonicalize.
  assert.doesNotMatch(
    component,
    /function resolveWorkspacePath/,
    'client-side resolveWorkspacePath must be removed — Rust owns path resolution',
  );
});

test('WorkspaceReviewDetails surfaces a workspace-boundary rejection toast', async () => {
  const component = await readReviewDetails();

  // When the Rust guard rejects (message contains "escapes working dir"), the
  // UI must not silently swallow the error. Assert a dedicated user-facing
  // message is shown, not the raw IPC string.
  assert.match(
    component,
    /message\.includes\(['"]escapes working dir['"]\)[\s\S]*?toast\.error\(t\(['"]workspace\.reviewPathOutsideWorkspace['"]\)\)/,
    'workspace-guard rejection must surface a workspace-boundary toast',
  );
});
