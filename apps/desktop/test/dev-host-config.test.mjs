import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');

test('tauri devUrl uses an IPv4 loopback host', async () => {
  const tauriConfigPath = path.join(desktopDir, 'src-tauri', 'tauri.conf.json');
  const tauriConfig = JSON.parse(await fs.readFile(tauriConfigPath, 'utf8'));

  assert.equal(tauriConfig.build.devUrl, 'http://127.0.0.1:1421');
});

test('vite dev server binds an IPv4 loopback host', async () => {
  const viteConfigPath = path.join(desktopDir, 'vite.config.ts');
  const viteConfig = await fs.readFile(viteConfigPath, 'utf8');

  assert.match(viteConfig, /host:\s*['"]127\.0\.0\.1['"]/);
});

test('desktop development uses an app identity distinct from the installed release', async () => {
  const releaseConfigPath = path.join(desktopDir, 'src-tauri', 'tauri.conf.json');
  const devConfigPath = path.join(desktopDir, 'src-tauri', 'tauri.dev.conf.json');
  const [releaseConfig, devConfig] = await Promise.all([
    fs.readFile(releaseConfigPath, 'utf8').then(JSON.parse),
    fs.readFile(devConfigPath, 'utf8').then(JSON.parse),
  ]);

  assert.notEqual(devConfig.productName, releaseConfig.productName);
  assert.equal(devConfig.productName, 'CCEM Desktop Dev');
  assert.notEqual(devConfig.identifier, releaseConfig.identifier);
  assert.equal(devConfig.identifier, 'com.ccem.desktop.dev');
});

test('desktop exposes one canonical dev command with the isolated identity and locked Cargo graph', async () => {
  const packageJsonPath = path.join(desktopDir, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

  assert.equal(
    packageJson.scripts['tauri:dev'],
    'tauri dev --config src-tauri/tauri.dev.conf.json -- --locked',
  );
});

test('agent guidance protects the installed release during desktop self-test', async () => {
  const [agentsGuide, claudeGuide, bundledSkill] = await Promise.all([
    fs.readFile(path.join(repoRoot, 'AGENTS.md'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'packages', 'agent-skills', 'ccem', 'SKILL.md'), 'utf8'),
  ]);

  for (const guide of [agentsGuide, claudeGuide, bundledSkill]) {
    assert.match(guide, /pnpm tauri:dev/);
    assert.doesNotMatch(guide, /pnpm tauri dev/);
    assert.match(guide, /\/Applications\/CCEM Desktop\.app/);
    assert.match(guide, /must not (?:quit|terminate|kill)/i);
  }
});

test('agent guidance serializes canonical Tauri dev runs across worktrees', async () => {
  const [agentsGuide, claudeGuide, bundledSkill] = await Promise.all([
    fs.readFile(path.join(repoRoot, 'AGENTS.md'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'CLAUDE.md'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'packages', 'agent-skills', 'ccem', 'SKILL.md'), 'utf8'),
  ]);

  for (const guide of [agentsGuide, claudeGuide, bundledSkill]) {
    assert.match(guide, /desktop-app-dev\.lock/);
    assert.match(guide, /iTCP:1421/);
    assert.match(guide, /another task or worktree/i);
    assert.match(guide, /coverage gap/i);
  }
});
