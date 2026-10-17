import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveReleaseCandidate } from './resolve-release-candidate.mjs';

function fixture(t, { annotated = false, candidateVersion = '2.95.0' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ccem-candidate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'checkout');
  mkdirSync(cwd);
  function git(...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function write(file, contents) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), contents);
  }
  function versions(version) {
    for (const file of ['apps/cli/package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json']) {
      write(file, JSON.stringify({ version }));
    }
    write('apps/desktop/src-tauri/Cargo.toml', `[package]\nname = "ccem-desktop"\nversion = "${version}"\n`);
    write('apps/desktop/src-tauri/Cargo.lock', `version = 4\n\n[[package]]\nname = "ccem-desktop"\nversion = "${version}"\n`);
  }
  function commit(message) {
    git('add', '.');
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  }
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'user.name', 'Release Test');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'tag.gpgSign', 'false');
  versions('2.94.0');
  const previousCommit = commit('chore: release v2.94.0');
  git('tag', ...(annotated ? ['-a', '-m', 'baseline'] : []), 'v2.94.0');
  git('init', '--bare', '-q', path.join(root, 'remote.git'));
  git('remote', 'add', 'origin', path.join(root, 'remote.git'));
  versions(candidateVersion);
  const bumpCommit = commit(`chore: release v${candidateVersion}`);
  write('fix.txt', 'verified candidate fix\n');
  const sourceCommit = commit('fix(ci): recover release verification');
  git('push', '-q', 'origin', 'main', 'refs/tags/v2.94.0');
  return { cwd, git, write, versions, commit, previousCommit, bumpCommit, sourceCommit };
}

for (const annotated of [false, true]) {
  test(`resumes the same version on fixed main with a ${annotated ? 'annotated' : 'lightweight'} baseline`, (t) => {
    const f = fixture(t, { annotated });
    const before = f.git('show-ref');
    const result = resolveReleaseCandidate({ cwd: f.cwd });
    assert.deepEqual(result, {
      version: '2.95.0', candidateTag: 'v2.95.0', sourceCommit: f.sourceCommit,
      previousTag: 'v2.94.0', previousCommit: f.previousCommit,
    });
    assert.notEqual(result.sourceCommit, f.bumpCommit);
    assert.equal(f.git('show-ref'), before, 'resolving must not create commits or tags');
    assert.equal(f.git('status', '--porcelain'), '');
  });
}

test('uses committed origin/main versions despite a different dirty local checkout', (t) => {
  const f = fixture(t);
  f.git('checkout', '--detach', f.previousCommit);
  f.versions('9.0.0');
  const before = f.git('diff');
  assert.equal(resolveReleaseCandidate({ cwd: f.cwd }).sourceCommit, f.sourceCommit);
  assert.equal(f.git('diff'), before);
});

test('CLI prints the exact candidate as JSON without mutating the repository', (t) => {
  const f = fixture(t);
  const script = fileURLToPath(new URL('./resolve-release-candidate.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sourceCommit, f.sourceCommit);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('rejects a stale tracking ref after remote main advances', (t) => {
  const f = fixture(t);
  f.write('fix.txt', 'another repair\n');
  f.commit('fix(ci): another repair');
  f.git('push', '-q', 'origin', 'main');
  f.git('update-ref', 'refs/remotes/origin/main', f.sourceCommit);
  assert.throws(() => resolveReleaseCandidate({ cwd: f.cwd }), /origin\/main moved/u);
});

test('rejects mismatched version sources on main', (t) => {
  const f = fixture(t);
  f.write('apps/desktop/src-tauri/Cargo.lock', '[[package]]\nname = "ccem-desktop"\nversion = "2.94.0"\n');
  f.commit('test: mismatched lock version');
  f.git('push', '-q', 'origin', 'main');
  assert.throws(() => resolveReleaseCandidate({ cwd: f.cwd }), /release versions differ/u);
});

test('rejects an existing remote candidate tag even when it has not been fetched', (t) => {
  const f = fixture(t);
  f.git('tag', 'v2.95.0');
  f.git('push', '-q', 'origin', 'refs/tags/v2.95.0');
  f.git('tag', '-d', 'v2.95.0');
  assert.throws(() => resolveReleaseCandidate({ cwd: f.cwd }), /already exists on origin/u);
});

test('rejects an existing local candidate tag outside main history', (t) => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'unrelated', f.previousCommit);
  f.write('unrelated.txt', 'other work\n');
  f.commit('test: unrelated branch');
  f.git('tag', 'v2.95.0');
  assert.throws(() => resolveReleaseCandidate({ cwd: f.cwd }), /already exists locally/u);
});

test('rejects a published version instead of inventing another bump', (t) => {
  const f = fixture(t);
  f.git('tag', 'v2.95.0');
  f.git('push', '-q', 'origin', 'refs/tags/v2.95.0');
  assert.throws(() => resolveReleaseCandidate({ cwd: f.cwd }), /no unpublished candidate/u);
});

test('rejects a baseline tag whose local commit differs from origin', (t) => {
  const f = fixture(t);
  f.git('tag', '-f', 'v2.94.0', f.bumpCommit);
  assert.throws(() => resolveReleaseCandidate({ cwd: f.cwd }), /does not match origin/u);
});

test('fails closed when origin cannot prove candidate tag absence', (t) => {
  const f = fixture(t);
  f.git('remote', 'set-url', 'origin', path.join(f.cwd, 'missing-remote.git'));
  assert.throws(() => resolveReleaseCandidate({ cwd: f.cwd }), /git ls-remote failed/u);
});

test('does not silently reinterpret prerelease recovery as a stable release', (t) => {
  const f = fixture(t, { candidateVersion: '2.95.0-rc.1' });
  assert.throws(() => resolveReleaseCandidate({ cwd: f.cwd }), /stable release recovery/u);
});
