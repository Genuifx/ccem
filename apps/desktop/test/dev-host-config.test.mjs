import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requiredMacCefFrameworkFiles } from '../scripts/macos-cef-bundle-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const launcherPath = path.join(desktopDir, 'scripts', 'tauri-dev.mjs');
const {
  parseCefOutDirFromCargoJson,
  prepareBrowserDataRoot,
  prepareMacosCefDevelopmentRuntime,
} = await import(pathToFileURL(launcherPath).href);

async function createCefDevelopmentFixture(t, architecture = 'aarch64') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-cef-dev-launcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outDir = path.join(root, 'target', 'debug', 'build', 'cef-dll-sys-current', 'out');
  const frameworkRoot = path.join(
    outDir,
    `cef_macos_${architecture}`,
    'Chromium Embedded Framework.framework',
  );
  const framework = path.join(frameworkRoot, 'Chromium Embedded Framework');
  const helper = path.join(root, 'target', 'debug', 'ccem-cef-helper');
  const target = `${architecture}-apple-darwin`;
  for (const relative of requiredMacCefFrameworkFiles(target)) {
    const candidate = path.join(frameworkRoot, ...relative.split('/'));
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await fs.writeFile(candidate, `cef:${relative}`);
    if (relative === 'Chromium Embedded Framework' || relative.endsWith('.dylib')) {
      await fs.chmod(candidate, 0o755);
    }
  }
  await fs.mkdir(path.dirname(helper), { recursive: true });
  await fs.writeFile(helper, '#!/bin/sh\nexit 0\n');
  await fs.chmod(helper, 0o755);
  return { root, outDir, frameworkRoot, framework, helper };
}

function cefCargoOutput(outDir, packageId = 'registry+https://example.invalid#index#cef-dll-sys@150.0.0') {
  return [
    JSON.stringify({ reason: 'compiler-artifact', package_id: packageId }),
    JSON.stringify({
      reason: 'build-script-executed',
      package_id: 'registry+https://example.invalid#not-cef-dll-sys@150.0.0',
      out_dir: '/private/tmp/unrelated',
    }),
    JSON.stringify({ reason: 'build-script-executed', package_id: packageId, out_dir: outDir }),
    JSON.stringify({ reason: 'build-finished', success: true }),
  ].join('\n');
}

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

test('canonical Tauri dev launcher prepares the exact macOS CEF development runtime', async () => {
  const launcher = await fs.readFile(launcherPath, 'utf8');

  assert.match(launcher, /const cefHelperName = 'ccem-cef-helper'/u);
  assert.match(launcher, /const cargoArgs = \[[\s\S]*'build'[\s\S]*'--locked'[\s\S]*'--bin'[\s\S]*cefHelperName/u);
  assert.match(launcher, /spawnSync\('cargo', args/u);
  assert.match(launcher, /--message-format=json/u);
  assert.match(launcher, /build-script-executed/u);
  assert.match(launcher, /cef-dll-sys/u);
  assert.match(launcher, /CCEM_CEF_FRAMEWORK_PATH/u);
  assert.match(launcher, /cefFrameworkBundleName = `\$\{cefFrameworkExecutableName\}\.framework`/u);
});

test('CEF dev runtime parser accepts exactly one current Cargo build-script OUT_DIR', () => {
  const current = path.join(os.tmpdir(), 'current-cef-out');
  const stale = path.join(os.tmpdir(), 'stale-cef-out');

  assert.equal(parseCefOutDirFromCargoJson(cefCargoOutput(current)), current);
  assert.throws(
    () => parseCefOutDirFromCargoJson(`${cefCargoOutput(current)}\n${cefCargoOutput(stale)}`),
    /exactly one cef-dll-sys OUT_DIR.*found 2/u,
  );
  assert.throws(
    () => parseCefOutDirFromCargoJson('cargo warning outside the JSON protocol'),
    /invalid JSON/u,
  );
});

test('macOS launcher builds the sibling helper and injects only the emitted CEF runtime', {
  skip: process.platform === 'win32' ? 'requires POSIX executable-mode semantics' : false,
}, async (t) => {
  const fixture = await createCefDevelopmentFixture(t);
  const stale = await createCefDevelopmentFixture(t);
  let invocation;

  const result = await prepareMacosCefDevelopmentRuntime({
    environment: {},
    platform: 'darwin',
    architecture: 'arm64',
    cargoRunner: (request) => {
      invocation = request;
      return { status: 0, stdout: cefCargoOutput(fixture.outDir) };
    },
  });

  assert.deepEqual(invocation.args, [
    'build',
    '--locked',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--bin',
    'ccem-cef-helper',
    '--message-format=json',
  ]);
  assert.equal(invocation.cwd, desktopDir);
  assert.equal(result.source, 'Cargo OUT_DIR');
  assert.equal(result.frameworkPath, await fs.realpath(fixture.framework));
  assert.equal(
    result.environment.CCEM_CEF_FRAMEWORK_PATH,
    await fs.realpath(fixture.framework),
  );
  assert.notEqual(result.frameworkPath, await fs.realpath(stale.framework));
  assert.deepEqual(
    result.stagedRuntimeFiles.map((candidate) => path.basename(candidate)).sort(),
    ['libEGL.dylib', 'libGLESv2.dylib', 'libvk_swiftshader.dylib', 'vk_swiftshader_icd.json'].sort(),
  );
  for (const destination of result.stagedRuntimeFiles) {
    const source = path.join(fixture.frameworkRoot, 'Libraries', path.basename(destination));
    assert.equal((await fs.lstat(destination)).isFile(), true);
    assert.equal(await fs.readFile(destination, 'utf8'), await fs.readFile(source, 'utf8'));
    assert.equal((await fs.stat(destination)).mode & 0o777, (await fs.stat(source)).mode & 0o777);
  }
  const updatedGles = path.join(fixture.frameworkRoot, 'Libraries', 'libGLESv2.dylib');
  await fs.writeFile(updatedGles, 'updated-gles-runtime');
  await fs.chmod(updatedGles, 0o755);
  const refreshed = await prepareMacosCefDevelopmentRuntime({
    environment: {},
    platform: 'darwin',
    architecture: 'arm64',
    cargoRunner: () => ({ status: 0, stdout: cefCargoOutput(fixture.outDir) }),
  });
  assert.equal(
    await fs.readFile(
      refreshed.stagedRuntimeFiles.find((candidate) => path.basename(candidate) === 'libGLESv2.dylib'),
      'utf8',
    ),
    'updated-gles-runtime',
  );
});

test('macOS launcher preserves a valid explicit CEF override and rejects an invalid one', {
  skip: process.platform === 'win32' ? 'requires POSIX executable-mode semantics' : false,
}, async (t) => {
  const fixture = await createCefDevelopmentFixture(t);
  const explicitFixture = await createCefDevelopmentFixture(t);
  const override = explicitFixture.framework;
  await fs.writeFile(
    path.join(explicitFixture.frameworkRoot, 'Libraries', 'libGLESv2.dylib'),
    'explicit-gles',
  );
  const cargoRunner = () => ({ status: 0, stdout: cefCargoOutput(fixture.outDir) });

  const selected = await prepareMacosCefDevelopmentRuntime({
    environment: { CCEM_CEF_FRAMEWORK_PATH: override },
    platform: 'darwin',
    architecture: 'arm64',
    cargoRunner,
  });
  assert.equal(selected.source, 'explicit override');
  assert.equal(selected.frameworkPath, await fs.realpath(override));
  assert.equal(
    await fs.readFile(path.join(fixture.root, 'target', 'debug', 'libGLESv2.dylib'), 'utf8'),
    'explicit-gles',
  );

  await assert.rejects(
    prepareMacosCefDevelopmentRuntime({
      environment: { CCEM_CEF_FRAMEWORK_PATH: path.join(fixture.root, 'missing-framework') },
      platform: 'darwin',
      architecture: 'arm64',
      cargoRunner,
    }),
    /must name Chromium Embedded Framework\.framework\/Chromium Embedded Framework/u,
  );
  await assert.rejects(
    prepareMacosCefDevelopmentRuntime({
      environment: {
        CCEM_CEF_FRAMEWORK_PATH: path.join(
          fixture.root,
          'missing',
          'Chromium Embedded Framework.framework',
          'Chromium Embedded Framework',
        ),
      },
      platform: 'darwin',
      architecture: 'arm64',
      cargoRunner,
    }),
    /explicit CEF framework override is unavailable/u,
  );
});

test('CEF dev preparation rejects an incomplete framework before starting Tauri', {
  skip: process.platform === 'win32' ? 'requires POSIX executable-mode semantics' : false,
}, async (t) => {
  const fixture = await createCefDevelopmentFixture(t);
  const missing = path.join(fixture.frameworkRoot, 'Resources', 'icudtl.dat');
  await fs.unlink(missing);

  await assert.rejects(
    prepareMacosCefDevelopmentRuntime({
      environment: {},
      platform: 'darwin',
      architecture: 'arm64',
      cargoRunner: () => ({ status: 0, stdout: cefCargoOutput(fixture.outDir) }),
    }),
    /CEF framework member Resources\/icudtl\.dat is unavailable/u,
  );
  await assert.rejects(fs.stat(path.join(fixture.root, 'target', 'debug', 'libGLESv2.dylib')));
});

test('CEF dev preparation fails closed without the sibling helper and skips other platforms', async (t) => {
  const fixture = await createCefDevelopmentFixture(t);
  await fs.unlink(fixture.helper);
  const cargoRunner = () => ({ status: 0, stdout: cefCargoOutput(fixture.outDir) });

  await assert.rejects(
    prepareMacosCefDevelopmentRuntime({
      environment: {},
      platform: 'darwin',
      architecture: 'arm64',
      cargoRunner,
    }),
    /CEF development helper is unavailable/u,
  );

  let called = false;
  const skipped = await prepareMacosCefDevelopmentRuntime({
    environment: { CCEM_CEF_FRAMEWORK_PATH: '/ignored' },
    platform: 'linux',
    architecture: 'x64',
    cargoRunner: () => {
      called = true;
      throw new Error('must not build CEF on another platform');
    },
  });
  assert.equal(called, false);
  assert.deepEqual(skipped, {
    environment: {},
    frameworkPath: null,
    source: null,
    stagedRuntimeFiles: [],
  });
});

test('Tauri dev launcher derives distinct complete instance namespaces from worktree paths', () => {
  const describe = (worktreeRoot, environment = {}) => {
    const childEnvironment = { ...process.env, ...environment };
    if (!Object.hasOwn(environment, 'CCEM_DESKTOP_DEV_BACKGROUND_SERVICES')) {
      delete childEnvironment.CCEM_DESKTOP_DEV_BACKGROUND_SERVICES;
    }
    if (!Object.hasOwn(environment, 'CCEM_BROWSER_DATA_ROOT')) {
      delete childEnvironment.CCEM_BROWSER_DATA_ROOT;
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
  const sameBasenameDifferentRoot = describe('/tmp/nested/ccem-worktree-alpha');
  const alphaHash = alpha.instanceId.slice(-8);

  assert.deepEqual(alphaAgain, alpha, 'the same resolved worktree must keep a stable namespace');
  assert.equal(alpha.worktreeRoot, path.resolve(alphaRoot));
  assert.match(alpha.instanceId, /^ccem-worktree-alpha-[a-f0-9]{8}$/);
  assert.equal(alpha.productName, 'CCEM Desktop Dev ccem-worktree-alpha');
  assert.equal(alpha.identifier, `com.ccem.desktop.dev.i${alphaHash}`);
  assert.equal(alpha.tauriConfig.productName, alpha.productName);
  assert.equal(alpha.tauriConfig.identifier, alpha.identifier);
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
  assert.equal(alpha.browserDataRootSource, 'worktree default');
  assert.equal(
    alpha.environment.CCEM_BROWSER_DATA_ROOT,
    path.join(os.homedir(), '.ccem', 'browser-dev', alpha.instanceId),
  );
  assert.notEqual(alpha.instanceId, beta.instanceId);
  assert.notEqual(alpha.vitePort, beta.vitePort);
  assert.notEqual(alpha.mcpPort, beta.mcpPort);
  assert.notEqual(alpha.identifier, beta.identifier);
  assert.notEqual(
    alpha.environment.CCEM_BROWSER_DATA_ROOT,
    beta.environment.CCEM_BROWSER_DATA_ROOT,
  );
  assert.equal(sameBasenameDifferentRoot.productName, alpha.productName);
  assert.notEqual(sameBasenameDifferentRoot.instanceId, alpha.instanceId);
  assert.notEqual(sameBasenameDifferentRoot.identifier, alpha.identifier);
  assert.equal(
    describe('/tmp/ccem-worktree-alpha', {
      CCEM_DESKTOP_DEV_BACKGROUND_SERVICES: 'true',
    }).environment.CCEM_DESKTOP_DEV_BACKGROUND_SERVICES,
    '1',
  );
  assert.equal(
    describe('/tmp/ccem-worktree-alpha', {
      CCEM_BROWSER_DATA_ROOT: '/private/tmp/ccem-explicit-browser-root',
    }).browserDataRootSource,
    'explicit override',
  );
  assert.equal(
    describe('/tmp/ccem-worktree-alpha', {
      CCEM_BROWSER_DATA_ROOT: '/private/tmp/ccem-explicit-browser-root',
    }).environment.CCEM_BROWSER_DATA_ROOT,
    '/private/tmp/ccem-explicit-browser-root',
  );
});

test('canonical Tauri dev launcher makes the browser data root private and rejects a symlink root', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-browser-root-permissions-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const browserDataRoot = path.join(parent, 'persistent');

  await fs.mkdir(browserDataRoot, { mode: 0o755 });
  if (process.platform !== 'win32') await fs.chmod(browserDataRoot, 0o755);
  await prepareBrowserDataRoot(browserDataRoot, { platform: process.platform });
  assert.equal((await fs.lstat(browserDataRoot)).isDirectory(), true);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(browserDataRoot)).mode & 0o777, 0o700);
  }

  const actual = path.join(parent, 'actual');
  const linked = path.join(parent, 'linked');
  await fs.mkdir(actual, { mode: 0o700 });
  await fs.symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    prepareBrowserDataRoot(linked, { platform: process.platform }),
    /browser data root must be a real directory, not a symlink/u,
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
