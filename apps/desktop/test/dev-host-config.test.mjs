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

  const alpha = describe('/tmp/ccem-worktree-alpha');
  const beta = describe('/tmp/ccem-worktree-beta');

  assert.deepEqual(
    {
      instanceId: alpha.instanceId,
      vitePort: alpha.vitePort,
      mcpPort: alpha.mcpPort,
      productName: alpha.productName,
      identifier: alpha.identifier,
      devUrl: alpha.tauriConfig.build.devUrl,
      beforeDevCommand: alpha.tauriConfig.build.beforeDevCommand,
      lockInstance: alpha.environment.CCEM_DESKTOP_DEV_INSTANCE_ID,
      mcpEnvironmentPort: alpha.environment.CCEM_TAURI_MCP_PORT,
      backgroundServices: alpha.environment.CCEM_DESKTOP_DEV_BACKGROUND_SERVICES,
    },
    {
      instanceId: 'ccem-worktree-alpha-5343974e',
      vitePort: 22574,
      mcpPort: 42200,
      productName: 'CCEM Desktop Dev ccem-worktree-alpha',
      identifier: 'com.ccem.desktop.dev.i5343974e',
      devUrl: 'http://127.0.0.1:22574',
      beforeDevCommand: 'pnpm dev --host 127.0.0.1 --port 22574 --strictPort',
      lockInstance: 'ccem-worktree-alpha-5343974e',
      mcpEnvironmentPort: '42200',
      backgroundServices: '0',
    },
  );
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
