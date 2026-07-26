import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CEF_FULL_VERSION,
  FRAMEWORK_ATTESTED_PATH,
  FRAMEWORK_NESTED_CODE_RELATIVES,
  FRAMEWORK_NAME,
  HELPER_BUNDLE_NAMES,
  SIGNING_ATTESTATION_NAME,
  SIGNING_ATTESTATION_VERIFICATION,
  STAGE_MANIFEST_NAME,
  digestStage,
  resolveRuntime,
} from '../scripts/stage-cef-macos.mjs';
import {
  CCEM_SAFE_STORAGE_SERVICE,
  CEF_SAFE_STORAGE_BRANDING_METHOD,
  CEF_UNBRANDED_SAFE_STORAGE_SERVICE,
} from '../scripts/cef-macos-safe-storage-branding.mjs';
import {
  CEF_LEGAL_DIRECTORY,
  CEF_LICENSE_SHA256,
  cefArchiveSpec,
  cefDirectoryTreeSha256,
  cefFileSha256,
} from '../scripts/cef-runtime-contract.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriDir = path.join(desktopDir, 'src-tauri');
const scriptPath = path.join(desktopDir, 'scripts', 'stage-cef-macos.mjs');
const sourceCommit = 'a'.repeat(40);

const runtimeMembers = [
  'Resources/Info.plist',
  'Resources/chrome_100_percent.pak',
  'Resources/chrome_200_percent.pak',
  'Resources/gpu_shader_cache.bin',
  'Resources/icudtl.dat',
  'Resources/resources.pak',
  'Resources/en.lproj/locale.pak',
  'Resources/v8_context_snapshot.arm64.bin',
  'Libraries/libcef_sandbox.dylib',
  'Libraries/libEGL.dylib',
  'Libraries/libGLESv2.dylib',
  'Libraries/libvk_swiftshader.dylib',
  'Libraries/vk_swiftshader_icd.json',
];

async function createRuntime(runtime) {
  const framework = path.join(runtime, FRAMEWORK_NAME);
  await fs.mkdir(path.join(runtime, 'include'), { recursive: true });
  await fs.writeFile(
    path.join(runtime, 'include', 'cef_version.h'),
    `#define CEF_VERSION "${CEF_FULL_VERSION}"\n`,
  );
  await fs.writeFile(path.join(runtime, 'archive.json'), `${JSON.stringify({
    type: 'minimal',
    name: cefArchiveSpec('aarch64-apple-darwin').name,
    sha1: cefArchiveSpec('aarch64-apple-darwin').sha1,
  })}\n`);
  await fs.writeFile(path.join(runtime, 'CREDITS.html'), 'fixture CEF credits');
  await fs.mkdir(framework, { recursive: true });
  await fs.writeFile(
    path.join(framework, 'Chromium Embedded Framework'),
    Buffer.from(`fixture-before\0${CEF_UNBRANDED_SAFE_STORAGE_SERVICE}\0fixture-after`),
  );
  for (const member of runtimeMembers) {
    const target = path.join(framework, member);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `fixture:${member}`);
  }
  return runtime;
}

async function createFixture(root) {
  const fixture = path.join(root, 'fixture');
  await createRuntime(path.join(fixture, 'runtime'));
  const helper = path.join(fixture, 'ccem-cef-helper');
  await fs.writeFile(helper, '#!/bin/sh\nexit 0\n');
  await fs.chmod(helper, 0o755);
  return fixture;
}

function runStage(args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: desktopDir,
    env: {
      ...process.env,
      APPLE_CERTIFICATE: '',
      APPLE_CERTIFICATE_PASSWORD: '',
      APPLE_SIGNING_IDENTITY: '',
      APPLE_TEAM_ID: '',
      CCEM_OFFICIAL_APPLE_TEAM_ID: '',
      CCEM_CEF_REQUIRE_PRE_SIGNED: '',
      GITHUB_SHA: '',
      ...env,
    },
    encoding: 'utf8',
  });
}

test('base Tauri config stays independent from optional CEF staging', async () => {
  const source = await fs.readFile(path.join(tauriDir, 'tauri.conf.json'), 'utf8');
  const config = JSON.parse(source);
  assert.equal(config.build.beforeBundleCommand, undefined);
  assert.equal(config.bundle.macOS.frameworks, undefined);
  assert.equal(config.bundle.macOS.files, undefined);
  assert.doesNotMatch(source, /cef-bundle|stage-cef-macos/);
});

test('CEF release overlay declares the staging hook, framework, and all five Helper apps', async () => {
  const config = JSON.parse(await fs.readFile(path.join(tauriDir, 'tauri.cef.conf.json'), 'utf8'));
  assert.equal(config.build.beforeBundleCommand, 'node scripts/prepare-cef-before-bundle.mjs');
  assert.deepEqual(config.bundle.macOS.frameworks, [
    'target/cef-bundle/macos/Chromium Embedded Framework.framework',
  ]);

  const expectedFiles = Object.fromEntries(HELPER_BUNDLE_NAMES.map((name) => [
    `Frameworks/${name}`,
    `target/cef-bundle/macos/${name}`,
  ]));
  expectedFiles['Resources/third-party/cef'] = 'target/cef-bundle/macos/third-party/cef';
  assert.deepEqual(config.bundle.macOS.files, expectedFiles);
});

test('CEF_PATH resolution accepts one exact pinned runtime and rejects ambiguity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-cef-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const versioned = path.join(root, '150.0.10', 'cef_macos_aarch64');
  await createRuntime(versioned);
  const fixtureFrameworkSha256 = await cefFileSha256(
    path.join(versioned, FRAMEWORK_NAME, 'Chromium Embedded Framework'),
  );
  const fixtureFrameworkTreeSha256 = await cefDirectoryTreeSha256(
    path.join(versioned, FRAMEWORK_NAME),
  );

  await assert.rejects(
    resolveRuntime({
      target: 'aarch64-apple-darwin',
      targetDir: null,
      profile: 'release',
      fixtureDir: null,
      cefPath: root,
    }),
    /CEF framework executable digest mismatch/,
  );

  const resolved = await resolveRuntime({
    target: 'aarch64-apple-darwin',
    targetDir: null,
    profile: 'release',
    fixtureDir: null,
    cefPath: root,
    expectedFrameworkExecutableSha256: fixtureFrameworkSha256,
    expectedFrameworkTreeSha256: fixtureFrameworkTreeSha256,
  });
  assert.equal(resolved.directory, await fs.realpath(versioned));
  assert.equal(resolved.version, CEF_FULL_VERSION);
  assert.equal(resolved.source, 'CEF_PATH');

  const pinnedResource = path.join(versioned, FRAMEWORK_NAME, 'Resources', 'resources.pak');
  await fs.writeFile(pinnedResource, 'tampered resource');
  await assert.rejects(
    resolveRuntime({
      target: 'aarch64-apple-darwin',
      targetDir: null,
      profile: 'release',
      fixtureDir: null,
      cefPath: root,
      expectedFrameworkExecutableSha256: fixtureFrameworkSha256,
      expectedFrameworkTreeSha256: fixtureFrameworkTreeSha256,
    }),
    /CEF framework tree digest mismatch/,
  );
  await fs.writeFile(pinnedResource, 'fixture:Resources/resources.pak');

  await createRuntime(root);
  await assert.rejects(
    resolveRuntime({
      target: 'aarch64-apple-darwin',
      targetDir: null,
      profile: 'release',
      fixtureDir: null,
      cefPath: root,
      expectedFrameworkExecutableSha256: fixtureFrameworkSha256,
      expectedFrameworkTreeSha256: fixtureFrameworkTreeSha256,
    }),
    /expected exactly one valid CEF 150\.0\.10 runtime from CEF_PATH; found 2/,
  );
});

test('fixture staging is atomic and emits the complete CEF Helper.app layout', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-cef-stage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await createFixture(root);
  const output = path.join(root, 'stage');

  const result = runStage([
    '--fixture', fixture,
    '--output', output,
    '--target', 'aarch64-apple-darwin',
    '--profile', 'release',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /staged CEF 150\.0\.10/);
  const brandedFramework = await fs.readFile(
    path.join(output, FRAMEWORK_NAME, 'Chromium Embedded Framework'),
  );
  assert.equal(brandedFramework.includes(Buffer.from(CEF_UNBRANDED_SAFE_STORAGE_SERVICE)), false);
  assert.equal(brandedFramework.includes(Buffer.from(CCEM_SAFE_STORAGE_SERVICE)), true);
  assert.equal(
    await cefFileSha256(path.join(output, ...CEF_LEGAL_DIRECTORY.split('/'), 'LICENSE.txt')),
    CEF_LICENSE_SHA256,
  );
  assert.equal(
    await fs.readFile(path.join(output, ...CEF_LEGAL_DIRECTORY.split('/'), 'CREDITS.html'), 'utf8'),
    'fixture CEF credits',
  );

  for (const bundleName of HELPER_BUNDLE_NAMES) {
    const executableName = bundleName.slice(0, -'.app'.length);
    const contents = path.join(output, bundleName, 'Contents');
    const executable = path.join(contents, 'MacOS', executableName);
    assert.equal((await fs.stat(executable)).mode & 0o111, 0o111);
    assert.equal(await fs.readFile(path.join(contents, 'PkgInfo'), 'utf8'), 'APPL????');
    const plist = await fs.readFile(path.join(contents, 'Info.plist'), 'utf8');
    assert.match(plist, new RegExp(`<key>CFBundleExecutable</key><string>${executableName.replace(/[()]/g, '\\$&')}</string>`));
    assert.match(plist, /<key>LSUIElement<\/key><true\/>/);
  }

  const manifest = JSON.parse(await fs.readFile(path.join(output, STAGE_MANIFEST_NAME), 'utf8'));
  assert.equal(manifest.cef.runtimeVersion, CEF_FULL_VERSION);
  assert.equal(manifest.cef.sourceFrameworkPinned, false);
  assert.match(manifest.cef.sourceFrameworkTreeSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.cef.brandedFrameworkTreeSha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.cef.safeStorageBranding.method, CEF_SAFE_STORAGE_BRANDING_METHOD);
  assert.equal(manifest.cef.safeStorageBranding.sourceService, CEF_UNBRANDED_SAFE_STORAGE_SERVICE);
  assert.equal(manifest.cef.safeStorageBranding.service, CCEM_SAFE_STORAGE_SERVICE);
  assert.match(manifest.cef.safeStorageBranding.sourceExecutableSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.cef.safeStorageBranding.brandedExecutableSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(
    manifest.cef.safeStorageBranding.sourceExecutableSha256,
    manifest.cef.safeStorageBranding.brandedExecutableSha256,
  );
  assert.equal(manifest.build.target, 'aarch64-apple-darwin');
  assert.equal(manifest.build.profile, 'release');
  assert.equal(manifest.layout.release, 'bundled-only');
  assert.equal(manifest.layout.looseHelperIncluded, false);
  assert.equal(manifest.helpers.length, 5);
  assert.equal(manifest.cef.archive.sha1, cefArchiveSpec('aarch64-apple-darwin').sha1);
  assert.equal(manifest.legal.directory, CEF_LEGAL_DIRECTORY);
  assert.equal(manifest.legal.license.sha256, CEF_LICENSE_SHA256);
  assert.equal(manifest.tauriSigningCoverage.frameworkDeclaredViaMacOSFrameworks, true);
  assert.equal(manifest.tauriSigningCoverage.helperAppsDeclaredViaCustomFiles, true);
  assert.equal(manifest.tauriSigningCoverage.helperAppsAutomaticallyAddedToSignPaths, false);
  assert.equal(manifest.externalSigning.attestationFile, SIGNING_ATTESTATION_NAME);
  assert.match(manifest.unsignedStageDigest, /^[a-f0-9]{64}$/);

  const digestResult = runStage(['--print-stage-digest', '--output', output]);
  assert.equal(digestResult.status, 0, digestResult.stderr);
  assert.equal(digestResult.stdout.trim(), await digestStage(output));
});

test('dry-run with a fixture performs no staging writes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-cef-dry-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await createFixture(root);
  const output = path.join(root, 'must-not-exist');
  const result = runStage([
    '--dry-run',
    '--fixture', fixture,
    '--output', output,
    '--target', 'aarch64-apple-darwin',
    '--profile', 'release',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.stat(output).then(() => true, () => false), false);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.cargo, null);
  assert.deepEqual(plan.helpers, HELPER_BUNDLE_NAMES);

  const debugPlanResult = runStage([
    '--dry-run',
    '--output', output,
    '--target', 'x86_64-apple-darwin',
    '--profile', 'debug',
  ], { TAURI_ENV_PLATFORM: 'macos' });
  assert.equal(debugPlanResult.status, 0, debugPlanResult.stderr);
  const debugPlan = JSON.parse(debugPlanResult.stdout);
  assert.equal(debugPlan.target, 'x86_64-apple-darwin');
  assert.equal(debugPlan.profile, 'debug');
  assert.deepEqual(debugPlan.cargo.args.slice(0, 2), ['build', '--locked']);
  assert.equal(debugPlan.cargo.args.includes('--release'), false);
});

test('Apple signing configuration fails closed until an external attestation exists', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-cef-signing-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await createFixture(root);
  const output = path.join(root, 'stage');
  const signingEnv = {
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Fixture (ABCDEFGHIJ)',
    APPLE_TEAM_ID: 'ABCDEFGHIJ',
    CCEM_OFFICIAL_APPLE_TEAM_ID: 'ABCDEFGHIJ',
    GITHUB_SHA: sourceCommit,
  };

  const prepare = runStage([
    '--prepare-for-signing',
    '--fixture', fixture,
    '--output', output,
    '--target', 'aarch64-apple-darwin',
    '--profile', 'release',
  ], signingEnv);
  assert.equal(prepare.status, 0, prepare.stderr);
  assert.match(prepare.stdout, /external signing and attestation are required/);

  const missingCommit = runStage([
    '--fixture', fixture,
    '--output', output,
    '--target', 'aarch64-apple-darwin',
    '--profile', 'release',
  ], { ...signingEnv, GITHUB_SHA: '' });
  assert.notEqual(missingCommit.status, 0);
  assert.match(missingCommit.stderr, /GITHUB_SHA must identify the exact source commit/);

  const bundle = runStage([
    '--fixture', fixture,
    '--output', output,
    '--target', 'aarch64-apple-darwin',
    '--profile', 'release',
  ], signingEnv);
  assert.notEqual(bundle.status, 0);
  assert.match(bundle.stderr, /not validly pre-signed: external signing attestation is missing/);

  const attestation = {
    schemaVersion: 3,
    verification: SIGNING_ATTESTATION_VERIFICATION,
    identity: signingEnv.APPLE_SIGNING_IDENTITY,
    teamId: signingEnv.CCEM_OFFICIAL_APPLE_TEAM_ID,
    target: 'aarch64-apple-darwin',
    profile: 'release',
    sourceCommit,
    cefRuntimeVersion: CEF_FULL_VERSION,
    stageDigest: await digestStage(output),
    verifiedBundlePaths: [
      FRAMEWORK_ATTESTED_PATH,
      ...HELPER_BUNDLE_NAMES.map((name) => `Frameworks/${name}`),
    ],
    verifiedFramework: {
      bundleIdentifier: 'org.cef.framework',
      bundlePath: FRAMEWORK_ATTESTED_PATH,
      nestedCodePaths: FRAMEWORK_NESTED_CODE_RELATIVES.map(
        (relative) => `${FRAMEWORK_ATTESTED_PATH}/${relative}`,
      ),
      hardenedRuntime: true,
      entitlements: [],
    },
  };
  await fs.writeFile(
    path.join(output, SIGNING_ATTESTATION_NAME),
    `${JSON.stringify({ ...attestation, sourceCommit: 'b'.repeat(40) }, null, 2)}\n`,
  );
  const wrongCommit = runStage([
    '--fixture', fixture,
    '--output', output,
    '--target', 'aarch64-apple-darwin',
    '--profile', 'release',
  ], signingEnv);
  assert.notEqual(wrongCommit.status, 0);
  assert.match(wrongCommit.stderr, /signing attestation schema is invalid/);

  await fs.writeFile(
    path.join(output, SIGNING_ATTESTATION_NAME),
    `${JSON.stringify(attestation, null, 2)}\n`,
  );
  const reuse = runStage([
    '--fixture', fixture,
    '--output', output,
    '--target', 'aarch64-apple-darwin',
    '--profile', 'release',
  ], signingEnv);
  assert.equal(reuse.status, 0, reuse.stderr);
  assert.match(reuse.stdout, /reusing stage/);

  const helperName = HELPER_BUNDLE_NAMES[0].slice(0, -'.app'.length);
  await fs.appendFile(path.join(output, HELPER_BUNDLE_NAMES[0], 'Contents', 'MacOS', helperName), 'tampered');
  const tampered = runStage([
    '--fixture', fixture,
    '--output', output,
    '--target', 'aarch64-apple-darwin',
    '--profile', 'release',
  ], signingEnv);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /staged nested code changed after signing/);
});

test('staging source never invokes signing, Keychain, or notarization tools', async () => {
  const source = await fs.readFile(scriptPath, 'utf8');
  assert.doesNotMatch(source, /spawnSync\(\s*['"](?:security|codesign|xcrun|notarytool)['"]/);
  assert.doesNotMatch(source, /execFileSync\(\s*['"](?:security|codesign|xcrun|notarytool)['"]/);
  assert.match(source, /helperAppsAutomaticallyAddedToSignPaths:\s*false/);
});
