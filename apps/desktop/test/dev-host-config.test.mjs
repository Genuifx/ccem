import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('desktop exposes the worktree-aware Tauri dev launcher as its canonical command', async () => {
  const packageJsonPath = path.join(desktopDir, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

  assert.equal(packageJson.scripts['tauri:dev'], 'node scripts/tauri-dev.mjs');
});

test('Tauri dev launcher derives distinct complete instance namespaces from worktree paths', () => {
  const launcherPath = path.join(desktopDir, 'scripts', 'tauri-dev.mjs');
  const describe = (worktreeRoot, environment = {}) => {
    const childEnvironment = { ...process.env, ...environment };
    if (!Object.hasOwn(environment, 'CCEM_DESKTOP_DEV_BACKGROUND_SERVICES')) {
      delete childEnvironment.CCEM_DESKTOP_DEV_BACKGROUND_SERVICES;
    }
    const result = spawnSync(
      process.execPath,
      [launcherPath, '--describe', '--worktree-root', worktreeRoot],
      { encoding: 'utf8', env: childEnvironment },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const alphaRoot = '/tmp/ccem-worktree-alpha';
  const alpha = describe(alphaRoot);
  const alphaAgain = describe(alphaRoot);
  const beta = describe('/tmp/ccem-worktree-beta');
  const alphaHash = alpha.instanceId.slice(-8);

  assert.deepEqual(alphaAgain, alpha, 'the same resolved worktree must keep a stable namespace');
  assert.equal(alpha.worktreeRoot, path.resolve(alphaRoot));
  assert.match(alpha.instanceId, /^ccem-worktree-alpha-[a-f0-9]{8}$/);
  assert.equal(alpha.productName, 'CCEM Desktop Dev ccem-worktree-alpha');
  assert.equal(alpha.identifier, `com.ccem.desktop.dev.i${alphaHash}`);
  assert.ok(alpha.vitePort >= 14000 && alpha.vitePort < 24000);
  assert.ok(alpha.mcpPort >= 30000 && alpha.mcpPort < 60000);
  assert.equal(alpha.mcpPort % 100, 0);
  assert.equal(alpha.tauriConfig.build.devUrl, `http://127.0.0.1:${alpha.vitePort}`);
  assert.equal(
    alpha.tauriConfig.build.beforeDevCommand,
    `pnpm dev --host 127.0.0.1 --port ${alpha.vitePort} --strictPort`,
  );
  assert.equal(alpha.environment.CCEM_DESKTOP_DEV_INSTANCE_ID, alpha.instanceId);
  assert.equal(alpha.environment.CCEM_TAURI_MCP_PORT, String(alpha.mcpPort));
  assert.equal(alpha.environment.CCEM_DESKTOP_DEV_BACKGROUND_SERVICES, '0');
  assert.notEqual(alpha.instanceId, beta.instanceId);
  assert.notEqual(alpha.vitePort, beta.vitePort);
  assert.notEqual(alpha.mcpPort, beta.mcpPort);
  assert.notEqual(alpha.identifier, beta.identifier);
  assert.equal(
    describe('/tmp/ccem-worktree-alpha', {
      CCEM_DESKTOP_DEV_BACKGROUND_SERVICES: 'true',
    }).environment.CCEM_DESKTOP_DEV_BACKGROUND_SERVICES,
    '1',
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
