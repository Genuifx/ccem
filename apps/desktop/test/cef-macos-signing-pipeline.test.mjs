import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODESIGN_PATH,
  resolveSigningIdentity,
  validateSignatureInspection,
  writeAttestationAtomically,
} from '../scripts/sign-and-attest-cef-macos.mjs';
import {
  CEF_FULL_VERSION,
  FRAMEWORK_NAME,
  HELPER_SPECS,
} from '../scripts/stage-cef-macos.mjs';
import { cefArchiveSpec } from '../scripts/cef-runtime-contract.mjs';
import { requiredMacCefFrameworkFiles } from '../scripts/macos-cef-bundle-contract.mjs';
import { CEF_UNBRANDED_SAFE_STORAGE_SERVICE } from '../scripts/cef-macos-safe-storage-branding.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(desktopDir, '..', '..');
const tauriDir = path.join(desktopDir, 'src-tauri');
const stageScript = path.join(desktopDir, 'scripts', 'stage-cef-macos.mjs');
const signingScript = path.join(desktopDir, 'scripts', 'sign-and-attest-cef-macos.mjs');
const jitEntitlements = path.join(tauriDir, 'entitlements', 'cef-helper-jit.plist');
const identity = 'Developer ID Application: CCEM Fixture (ABCDEFGHIJ)';
const sourceCommit = 'a'.repeat(40);
const expectedHelpers = [
  ['ccem-desktop Helper (GPU).app', 'com.ccem.desktop.helper.gpu', true],
  ['ccem-desktop Helper (Renderer).app', 'com.ccem.desktop.helper.renderer', true],
  ['ccem-desktop Helper (Plugin).app', 'com.ccem.desktop.helper.plugin', false],
  ['ccem-desktop Helper (Alerts).app', 'com.ccem.desktop.helper.alerts', false],
  ['ccem-desktop Helper.app', 'com.ccem.desktop.helper', false],
];

async function createFixture(root) {
  const fixture = path.join(root, 'fixture');
  const runtime = path.join(fixture, 'runtime');
  const framework = path.join(runtime, FRAMEWORK_NAME);
  await fs.mkdir(path.join(runtime, 'include'), { recursive: true });
  await fs.writeFile(
    path.join(runtime, 'include', 'cef_version.h'),
    `#define CEF_VERSION "${CEF_FULL_VERSION}"\n`,
  );
  const archive = cefArchiveSpec('aarch64-apple-darwin');
  await fs.writeFile(path.join(runtime, 'archive.json'), `${JSON.stringify({
    type: archive.type,
    name: archive.name,
    sha1: archive.sha1,
  })}\n`);
  await fs.writeFile(path.join(runtime, 'CREDITS.html'), 'fixture CEF credits');
  const members = requiredMacCefFrameworkFiles('aarch64-apple-darwin');
  for (const member of members) {
    const target = path.join(framework, ...member.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    const contents = member === 'Chromium Embedded Framework'
      ? `fixture:${member}\0${CEF_UNBRANDED_SAFE_STORAGE_SERVICE}\0fixture-end`
      : `fixture:${member}`;
    await fs.writeFile(target, contents);
  }
  const helper = path.join(fixture, 'ccem-cef-helper');
  await fs.writeFile(helper, '#!/bin/sh\nexit 0\n');
  await fs.chmod(helper, 0o755);
  return fixture;
}

function cleanSigningEnvironment(extra = {}) {
  return {
    ...process.env,
    APPLE_CERTIFICATE: '',
    APPLE_CERTIFICATE_PASSWORD: '',
    APPLE_SIGNING_IDENTITY: identity,
    APPLE_TEAM_ID: 'ABCDEFGHIJ',
    CCEM_OFFICIAL_APPLE_TEAM_ID: 'ABCDEFGHIJ',
    CCEM_CEF_ALLOW_CODESIGN: '',
    CCEM_CEF_TARGET_TRIPLE: 'aarch64-apple-darwin',
    GITHUB_ACTIONS: '',
    RUNNER_OS: '',
    GITHUB_SHA: sourceCommit,
    ...extra,
  };
}

async function createStage(root) {
  const fixture = await createFixture(root);
  const stage = path.join(root, 'stage');
  const result = spawnSync(process.execPath, [
    stageScript,
    '--fixture', fixture,
    '--output', stage,
    '--target', 'aarch64-apple-darwin',
    '--profile', 'release',
  ], {
    cwd: desktopDir,
    env: {
      ...process.env,
      APPLE_CERTIFICATE: '',
      APPLE_CERTIFICATE_PASSWORD: '',
      APPLE_SIGNING_IDENTITY: '',
      APPLE_TEAM_ID: '',
      CCEM_OFFICIAL_APPLE_TEAM_ID: '',
      CCEM_CEF_REQUIRE_PRE_SIGNED: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return stage;
}

test('CEF helper hardened-runtime entitlements grant only Chromium JIT', async () => {
  const source = await fs.readFile(jitEntitlements, 'utf8');
  const keys = [...source.matchAll(/<key>\s*([^<]+?)\s*<\/key>/g)].map((match) => match[1]);
  assert.deepEqual(keys, ['com.apple.security.cs.allow-jit']);
  assert.doesNotMatch(source, /disable-library-validation|allow-unsigned-executable-memory|get-task-allow/);
});

test('signing dry-run plans fixed codesign commands without executing them', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-cef-sign-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = await createStage(root);
  const result = spawnSync(process.execPath, [
    signingScript,
    '--dry-run',
    '--stage', stage,
    '--target', 'aarch64-apple-darwin',
  ], {
    cwd: desktopDir,
    env: cleanSigningEnvironment(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.target, 'aarch64-apple-darwin');
  assert.equal(output.sourceCommit, sourceCommit);
  assert.equal(output.stageDir, stage);
  assert.equal(output.plan.helpers.length, 5);
  assert.deepEqual(
    output.plan.helpers.map(({ bundleName, bundleIdentifier, needsJit }) => [
      bundleName,
      bundleIdentifier,
      needsJit,
    ]),
    expectedHelpers,
  );
  for (const item of output.plan.helpers) {
    assert.equal(item.commands.signExecutable.program, CODESIGN_PATH);
    assert.equal(item.commands.signBundle.program, CODESIGN_PATH);
    assert.deepEqual(
      item.commands.signBundle.args.slice(0, 6),
      ['--force', '--sign', identity, '--options', 'runtime', '--timestamp'],
    );
    assert.equal(item.commands.signBundle.args.includes('--entitlements'), item.needsJit);
    assert.equal(item.commands.signBundle.args.includes('--deep'), false);
    assert.deepEqual(
      item.commands.verifyBundle.args.slice(0, 4),
      ['--verify', '--deep', '--strict', '--verbose=4'],
    );
  }
  const jitHelpers = output.plan.helpers
    .filter((item) => item.needsJit)
    .map((item) => item.bundleName)
    .sort();
  assert.deepEqual(jitHelpers, [
    'ccem-desktop Helper (GPU).app',
    'ccem-desktop Helper (Renderer).app',
  ]);
  assert.equal(
    output.plan.helpers.every(
      (item) => item.entitlementsPath === null || item.entitlementsPath === jitEntitlements,
    ),
    true,
  );
  assert.equal(output.plan.framework.bundleIdentifier, 'org.cef.framework');
  assert.equal(output.plan.framework.nestedCode.length, 4);
  assert.deepEqual(
    output.plan.framework.nestedCode.map(({ relative }) => relative),
    [
      'Libraries/libEGL.dylib',
      'Libraries/libGLESv2.dylib',
      'Libraries/libcef_sandbox.dylib',
      'Libraries/libvk_swiftshader.dylib',
    ],
  );
  for (const nested of output.plan.framework.nestedCode) {
    assert.equal(nested.commands.sign.program, CODESIGN_PATH);
    assert.equal(nested.commands.sign.args.includes('--entitlements'), false);
    assert.deepEqual(
      nested.commands.verify.args.slice(0, 3),
      ['--verify', '--strict', '--verbose=4'],
    );
  }
  assert.equal(output.plan.framework.commands.signBundle.program, CODESIGN_PATH);
  assert.equal(output.plan.framework.commands.signBundle.args.includes('--entitlements'), false);
  assert.deepEqual(
    output.plan.framework.commands.verifyBundle.args.slice(0, 4),
    ['--verify', '--deep', '--strict', '--verbose=4'],
  );
});

test('signing identity pins the exact official Team ID and Developer ID authority', () => {
  assert.deepEqual(resolveSigningIdentity({
    APPLE_SIGNING_IDENTITY: identity,
    APPLE_TEAM_ID: 'ABCDEFGHIJ',
    CCEM_OFFICIAL_APPLE_TEAM_ID: 'ABCDEFGHIJ',
  }), {
    identity,
    teamId: 'ABCDEFGHIJ',
  });
  assert.throws(() => resolveSigningIdentity({
    APPLE_SIGNING_IDENTITY: identity,
    APPLE_TEAM_ID: 'ZZZZZZZZZZ',
    CCEM_OFFICIAL_APPLE_TEAM_ID: 'ABCDEFGHIJ',
  }), /APPLE_TEAM_ID does not match the official Team ID/);
  assert.throws(() => resolveSigningIdentity({
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: CCEM Fixture (ZZZZZZZZZZ)',
    APPLE_TEAM_ID: 'ABCDEFGHIJ',
    CCEM_OFFICIAL_APPLE_TEAM_ID: 'ABCDEFGHIJ',
  }), /not the exact official Developer ID Application identity/);
});

test('actual signer fails before codesign outside the explicit CI boundary', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-cef-sign-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = await createStage(root);
  const result = spawnSync(process.execPath, [
    signingScript,
    '--stage', stage,
    '--target', 'aarch64-apple-darwin',
  ], {
    cwd: desktopDir,
    env: cleanSigningEnvironment(),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /actual CEF signing is allowed only on a macOS GitHub Actions runner/);
  assert.equal(await fs.stat(path.join(stage, 'cef-signing-attestation.json')).then(() => true, () => false), false);
});

test('signature inspection requires exact authority, Team ID, identifier, runtime, and entitlements', () => {
  const spec = HELPER_SPECS.find(({ needsJit }) => needsJit);
  const inspection = [
    `Identifier=${spec.bundleIdentifier}`,
    'TeamIdentifier=ABCDEFGHIJ',
    `Authority=${identity}`,
    'Authority=Developer ID Certification Authority',
    'CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+1 location=embedded',
  ].join('\n');
  const entitlements = '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>';
  assert.doesNotThrow(() => validateSignatureInspection({
    inspection,
    entitlements,
    identity,
    teamId: 'ABCDEFGHIJ',
    bundleIdentifier: spec.bundleIdentifier,
    needsJit: true,
  }));
  assert.throws(() => validateSignatureInspection({
    inspection,
    entitlements: `${entitlements}<key>com.apple.security.cs.disable-library-validation</key><true/>`,
    identity,
    teamId: 'ABCDEFGHIJ',
    bundleIdentifier: spec.bundleIdentifier,
    needsJit: true,
  }), /unexpected entitlements/);
  assert.throws(() => validateSignatureInspection({
    inspection: inspection.replace('(runtime)', '(adhoc)'),
    entitlements,
    identity,
    teamId: 'ABCDEFGHIJ',
    bundleIdentifier: spec.bundleIdentifier,
    needsJit: true,
  }), /hardened runtime flag is missing/);
});

test('attestation writes atomically with private permissions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-cef-attestation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'cef-signing-attestation.json');
  await fs.writeFile(target, '{"old":true}\n');
  await writeAttestationAtomically(target, {
    schemaVersion: 3,
    sourceCommit,
    stageDigest: 'fixture',
  });
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {
    schemaVersion: 3,
    sourceCommit,
    stageDigest: 'fixture',
  });
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes('.tmp-')), []);
});

test('release workflow imports once, pre-signs CEF, and excludes CEF from unsigned mac builds', async () => {
  const workflow = await fs.readFile(path.join(repoDir, '.github', 'workflows', 'release-desktop.yml'), 'utf8');
  const importIndex = workflow.indexOf('uses: Apple-Actions/import-codesign-certs@5142e029c445c10ffc7149d172e540235a065466');
  const prepareIndex = workflow.indexOf('node scripts/stage-cef-macos.mjs --prepare-for-signing');
  const signIndex = workflow.indexOf('node scripts/sign-and-attest-cef-macos.mjs');
  const signedActionIndex = workflow.indexOf('- name: Build production bundles without release access');
  const unsignedActionIndex = workflow.indexOf('- name: Build unsigned Preview-only macOS bundles without release access');
  assert.ok(importIndex > 0 && importIndex < prepareIndex && prepareIndex < signIndex && signIndex < signedActionIndex);
  const signedAction = workflow.slice(
    signedActionIndex,
    unsignedActionIndex,
  );
  assert.doesNotMatch(signedAction, /APPLE_CERTIFICATE(?:_PASSWORD)?:/);
  assert.match(signedAction, /CCEM_CEF_TARGET_TRIPLE: \$\{\{ matrix\.target \}\}/);
  assert.match(workflow, /aarch64-apple-darwin --config src-tauri\/tauri\.cef\.conf\.json/);
  assert.match(workflow, /x86_64-apple-darwin --config src-tauri\/tauri\.cef\.conf\.json/);
  assert.match(workflow, /unsignedArgs: '--target aarch64-apple-darwin'/);
  assert.match(workflow, /unsignedArgs: '--target x86_64-apple-darwin'/);
  const unsignedAction = workflow.slice(unsignedActionIndex);
  assert.match(unsignedAction, /args: \$\{\{ matrix\.unsignedArgs \}\}/);
  assert.doesNotMatch(unsignedAction, /args: \$\{\{ matrix\.args \}\}/);
});

test('signer has one fixed signing executable and no Keychain or notarization commands', async () => {
  const source = await fs.readFile(signingScript, 'utf8');
  assert.match(source, /CODESIGN_PATH = '\/usr\/bin\/codesign'/);
  assert.match(source, /GITHUB_ACTIONS !== 'true'/);
  assert.match(source, /RUNNER_OS !== 'macOS'/);
  assert.match(source, /CCEM_CEF_ALLOW_CODESIGN !== '1'/);
  assert.match(source, /process\.platform !== 'darwin'/);
  assert.match(source, /path\.resolve\(options\.stageDir\) !== defaultStageDir/);
  assert.match(source, /CCEM_CEF_TARGET_TRIPLE !== options\.target/);
  assert.doesNotMatch(source, /\/usr\/bin\/(?:security|xcrun|notarytool)/);
  assert.doesNotMatch(source, /execSync|shell:\s*true/);
});
