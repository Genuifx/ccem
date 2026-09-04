import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const desktopDir = path.resolve(import.meta.dirname, '..');
const repoDir = path.resolve(desktopDir, '..', '..');
const manifestDir = path.join(desktopDir, 'src-tauri', 'runtime-manifests');

test('signed browser runtime assets keep their exact repository bytes on Windows checkout', async () => {
  const assetNames = (await fs.readdir(manifestDir)).filter((name) =>
    /\.(?:json|pub|sig)$/u.test(name),
  );

  for (const assetName of assetNames) {
    const repoPath = path
      .relative(repoDir, path.join(manifestDir, assetName))
      .split(path.sep)
      .join('/');
    const repositoryBytes = execFileSync('git', ['show', `HEAD:${repoPath}`], {
      cwd: repoDir,
    });
    const windowsCheckoutBytes = execFileSync(
      'git',
      [
        '-c',
        'core.autocrlf=true',
        'cat-file',
        '--filters',
        `--path=${repoPath}`,
        `HEAD:${repoPath}`,
      ],
      { cwd: repoDir },
    );

    assert.equal(
      windowsCheckoutBytes.equals(repositoryBytes),
      true,
      `${repoPath} must not change bytes when checked out on Windows ` +
        `(repository=${repositoryBytes.length}, checkout=${windowsCheckoutBytes.length})`,
    );
  }
});
