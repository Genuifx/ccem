import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MACOS_SAFE_STORAGE_PHASES,
  MACOS_SAFE_STORAGE_REQUIRED_RUNTIME_STAGES,
  MACOS_SAFE_STORAGE_SMOKE_ALLOW_ENV,
  MACOS_SAFE_STORAGE_SMOKE_ATTESTATION_ENV,
  MACOS_SAFE_STORAGE_SMOKE_NONCE_ENV,
  MACOS_SAFE_STORAGE_SMOKE_ROOT_ENV,
  createMacosSafeStorageReleaseSummary,
  createMacosSafeStorageSmokePlan,
  validateMacosSafeStorageReleaseSummary,
  validateMacosSafeStorageRuntimeReceipt,
  validateMacosSafeStorageSmokeAttestation,
} from '../scripts/macos-mode2-safe-storage-smoke-contract.mjs';
import {
  MACOS_CODESIGN_PATH,
  MACOS_SECURITY_PATH,
  assertMacosSafeStorageSmokeAuthorization,
  run,
} from '../scripts/run-macos-mode2-safe-storage-smoke.mjs';
import { inspectMacosSafeStorageReleaseAttestation } from '../scripts/verify-macos-safe-storage-release.mjs';

const NONCE = 'b'.repeat(64);
const SOURCE_COMMIT = 'a'.repeat(40);
const RUNNER_TEMP = '/private/tmp/ccem-safe-storage-test';
const RUN_ROOT = `${RUNNER_TEMP}/ccem-mode2-safe-storage-smoke/12345-2-${NONCE.slice(0, 16)}`;
const environment = {
  GITHUB_ACTIONS: 'true',
  CI: 'true',
  RUNNER_OS: 'macOS',
  RUNNER_TEMP,
  GITHUB_WORKSPACE: '/private/tmp/ccem-workspace',
  GITHUB_SHA: SOURCE_COMMIT,
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '2',
  [MACOS_SAFE_STORAGE_SMOKE_ALLOW_ENV]: '1',
  [MACOS_SAFE_STORAGE_SMOKE_NONCE_ENV]: NONCE,
  [MACOS_SAFE_STORAGE_SMOKE_ROOT_ENV]: RUN_ROOT,
  [MACOS_SAFE_STORAGE_SMOKE_ATTESTATION_ENV]: `${RUN_ROOT}/evidence/attestation.json`,
};
const sourceApp = `${RUNNER_TEMP}/build/CCEM Desktop.app`;
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(desktopDir, '../..');

function planFixture() {
  return createMacosSafeStorageSmokePlan({ environment, sourceApp });
}

function receiptFixture(plan, scenario, phase) {
  const scenarioPlan = plan.scenarios.find((entry) => entry.name === scenario);
  return {
    schemaVersion: 1,
    smoke: 'macos-mode2-safe-storage-release',
    status: 'passed',
    exitCode: 0,
    error: null,
    nonce: NONCE,
    sourceCommit: SOURCE_COMMIT,
    runId: '12345',
    runAttempt: '2',
    scenario,
    phase,
    appVersion: '2.53.0',
    mainPid: phase === 'prime' ? 4101 : 4102,
    executablePath: plan.paths.executable,
    smokeRoot: scenarioPlan.root,
    cefCacheRoot: scenarioPlan.cacheRoot,
    profileId: `safe-storage-${scenario}-${NONCE.slice(0, 24)}`,
    surfaceId: `mode2-safe-storage-${scenario}-${phase}-${NONCE.slice(0, 12)}`,
    credentialStore: 'macos-system-keychain-v2',
    safeStorageService: 'CCEM Safe Storage',
    distributionSignatureVerified: true,
    safeStorageBrandingVerified: true,
    systemKeychainMarkerVerified: true,
    persistentCookieVerified: true,
    persistentProfileStorage: true,
    normalStartupBypassed: true,
    sandboxEnabled: true,
    stages: MACOS_SAFE_STORAGE_REQUIRED_RUNTIME_STAGES.map((name, index) => ({
      name,
      monotonicMs: index + 1,
    })),
  };
}

function attestationFixture(plan) {
  return {
    schemaVersion: 1,
    platform: 'macos',
    status: 'passed',
    sourceCommit: SOURCE_COMMIT,
    nonce: NONCE,
    run: { id: '12345', attempt: '2' },
    app: {
      bundlePath: plan.paths.installedApp,
      executablePath: plan.paths.executable,
      executableSha256: 'c'.repeat(64),
      frameworkSha256: 'd'.repeat(64),
      signatureVerified: true,
    },
    safeStorageBranding: {
      service: 'CCEM Safe Storage',
      genericServiceAbsentFromFramework: true,
      uniqueBrandedSlot: true,
    },
    scenarios: plan.scenarios.map(({ name }) => ({
      name,
      genericItemSeeded: name === 'generic-conflict',
      genericItemPresentAfter: name === 'generic-conflict',
      ccemItemPresentAfter: true,
      genericItemUnchanged: true,
      exclusiveTemporaryKeychain: true,
      launchCount: 2,
      receipts: Object.fromEntries(MACOS_SAFE_STORAGE_PHASES.map((phase) => [
        phase,
        receiptFixture(plan, name, phase),
      ])),
      ownedProcessesAfter: 0,
    })),
    cleanup: {
      originalKeychainStateRestored: true,
      temporaryKeychainsDeleted: true,
      scenarioRootsDeleted: true,
      installedAppDeleted: true,
    },
  };
}

test('plan binds copied app, two scenarios, receipts, and attestation to one runner attempt', () => {
  const plan = planFixture();
  assert.equal(plan.paths.smokeRoot, RUN_ROOT);
  assert.equal(plan.paths.installedApp, `${RUN_ROOT}/app/CCEM.app`);
  assert.equal(plan.paths.executable, `${RUN_ROOT}/app/CCEM.app/Contents/MacOS/ccem-desktop`);
  assert.deepEqual(plan.scenarios.map((entry) => entry.name), ['clean', 'generic-conflict']);
  for (const scenario of plan.scenarios) {
    assert.equal(scenario.keychain, `${scenario.root}/keychain/smoke.keychain-db`);
    assert.equal(scenario.receipts.prime, `${scenario.root}/evidence/prime-runtime.json`);
    assert.equal(scenario.receipts.verify, `${scenario.root}/evidence/verify-runtime.json`);
  }
});

test('real runner rejects local, debug, non-GitHub, and missing explicit authorization', () => {
  assert.throws(
    () => assertMacosSafeStorageSmokeAuthorization(environment, 'linux'),
    /GitHub Actions macOS runner/,
  );
  for (const name of ['GITHUB_ACTIONS', 'CI', 'RUNNER_OS', MACOS_SAFE_STORAGE_SMOKE_ALLOW_ENV]) {
    assert.throws(
      () => assertMacosSafeStorageSmokeAuthorization({ ...environment, [name]: 'false' }, 'darwin'),
      /GitHub Actions macOS runner/,
    );
  }
  assert.equal(assertMacosSafeStorageSmokeAuthorization(environment, 'darwin'), true);
});

test('dry-run is pure and never executes a Keychain or GUI dependency', async () => {
  let calls = 0;
  const result = await run(['--dry-run', '--app', sourceApp], {
    environment,
    platform: 'linux',
    command: async () => {
      calls += 1;
      throw new Error('must not execute');
    },
  });
  assert.equal(result.paths.smokeRoot, RUN_ROOT);
  assert.equal(calls, 0);
});

test('runner state machine restores Keychain state and removes every owned temporary surface', async () => {
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-safe-storage-runner-')),
  );
  const dynamicNonce = NONCE;
  const dynamicRoot = `${temporary}/ccem-mode2-safe-storage-smoke/12345-2-${dynamicNonce.slice(0, 16)}`;
  const dynamicEnvironment = {
    ...environment,
    RUNNER_TEMP: temporary,
    GITHUB_WORKSPACE: `${temporary}/workspace`,
    [MACOS_SAFE_STORAGE_SMOKE_ROOT_ENV]: dynamicRoot,
    [MACOS_SAFE_STORAGE_SMOKE_ATTESTATION_ENV]: `${dynamicRoot}/evidence/attestation.json`,
  };
  const dynamicSource = `${temporary}/build/CCEM Desktop.app`;
  const framework = path.join(
    dynamicSource,
    'Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework',
  );
  const executable = path.join(dynamicSource, 'Contents/MacOS/ccem-desktop');
  const slot = Buffer.alloc(Buffer.byteLength('Chromium Safe Storage'));
  Buffer.from('CCEM Safe Storage').copy(slot);
  await fs.mkdir(path.dirname(framework), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
  await fs.writeFile(framework, Buffer.concat([Buffer.from('prefix'), slot, Buffer.from('suffix')]));
  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const dynamicPlan = createMacosSafeStorageSmokePlan({
    environment: dynamicEnvironment,
    sourceApp: dynamicSource,
  });
  let searchList = [`${temporary}/original.keychain-db`];
  let defaultKeychain = searchList[0];
  const originalState = { searchList: [...searchList], defaultKeychain };
  const items = new Map();
  const command = async (program, args, options = {}) => {
    const success = (stdout = '') => ({
      code: 0, signal: null, timedOut: false, stdout, stderr: '',
    });
    if (program === '/usr/bin/ditto') {
      await fs.cp(args.at(-2), args.at(-1), { recursive: true, verbatimSymlinks: true });
      return success();
    }
    if (program === '/usr/bin/codesign') return success();
    if (program === '/bin/ps') return success('');
    if (program === '/usr/bin/security') {
      const operation = args[0];
      if (operation === 'list-keychains' && !args.includes('-s')) {
        return success(searchList.map((entry) => `    "${entry}"`).join('\n'));
      }
      if (operation === 'default-keychain' && !args.includes('-s')) {
        return success(`    "${defaultKeychain}"\n`);
      }
      if (operation === 'list-keychains') {
        searchList = args.slice(args.indexOf('-s') + 1);
        return success();
      }
      if (operation === 'default-keychain') {
        defaultKeychain = args.at(-1);
        return success();
      }
      if (operation === 'create-keychain') {
        await fs.writeFile(args.at(-1), '', { mode: 0o600 });
        return success();
      }
      if (operation === 'set-keychain-settings' || operation === 'unlock-keychain') {
        return success();
      }
      if (operation === 'add-generic-password') {
        const key = `${args.at(-1)}\0${args[args.indexOf('-s') + 1]}`;
        items.set(key, args[args.indexOf('-w') + 1]);
        return success();
      }
      if (operation === 'find-generic-password') {
        const key = `${args.at(-1)}\0${args[args.indexOf('-s') + 1]}`;
        if (!items.has(key)) {
          return { ...success(), code: 44, stderr: 'item not found' };
        }
        return success(args.includes('-w') ? `${items.get(key)}\n` : 'item metadata\n');
      }
      if (operation === 'delete-keychain') {
        await fs.rm(args.at(-1), { force: true });
        return success();
      }
      throw new Error(`unexpected security operation ${operation}`);
    }
    if (program === dynamicPlan.paths.executable) {
      const scenario = options.environment.CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_SCENARIO;
      const phase = options.environment.CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_PHASE;
      const keychain = options.environment.CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_KEYCHAIN_PATH;
      items.set(`${keychain}\0CCEM Safe Storage`, 'cef-created-secret');
      const receipt = receiptFixture(dynamicPlan, scenario, phase);
      await fs.writeFile(
        options.environment.CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_RECEIPT_PATH,
        `${JSON.stringify(receipt)}\n`,
        { mode: 0o600 },
      );
      return success();
    }
    throw new Error(`unexpected command ${program}`);
  };

  try {
    const attestation = await run(['--app', dynamicSource], {
      environment: dynamicEnvironment,
      platform: 'darwin',
      command,
    });
    assert.equal(attestation.status, 'passed');
    assert.deepEqual(searchList, originalState.searchList);
    assert.equal(defaultKeychain, originalState.defaultKeychain);
    assert.equal(attestation.scenarios.length, 2);
    assert.equal(attestation.scenarios[1].genericItemUnchanged, true);
    assert.equal((await fs.readdir(dynamicRoot)).join(','), 'evidence');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('runtime and final contracts require two successful signed launches per scenario', () => {
  const plan = planFixture();
  const attestation = attestationFixture(plan);
  for (const scenario of ['clean', 'generic-conflict']) {
    for (const phase of MACOS_SAFE_STORAGE_PHASES) {
      assert.equal(
        validateMacosSafeStorageRuntimeReceipt(
          attestation.scenarios.find((entry) => entry.name === scenario).receipts[phase],
          plan,
          scenario,
          phase,
        ).status,
        'passed',
      );
    }
  }
  assert.equal(validateMacosSafeStorageSmokeAttestation(attestation, plan).status, 'passed');

  for (const mutate of [
    (value) => { value.scenarios[0].launchCount = 1; },
    (value) => { value.scenarios[1].genericItemUnchanged = false; },
    (value) => { value.scenarios[1].genericItemPresentAfter = false; },
    (value) => { value.scenarios[0].receipts.prime.safeStorageBrandingVerified = false; },
    (value) => { value.scenarios[0].receipts.verify.persistentCookieVerified = false; },
    (value) => { value.cleanup.originalKeychainStateRestored = false; },
  ]) {
    const invalid = structuredClone(attestation);
    mutate(invalid);
    assert.throws(() => validateMacosSafeStorageSmokeAttestation(invalid, plan));
  }
});

test('release summary binds target, app bytes, version, and full attestation digest', () => {
  const plan = planFixture();
  const attestation = attestationFixture(plan);
  const expected = {
    target: 'aarch64-apple-darwin',
    sourceCommit: SOURCE_COMMIT,
    appVersion: '2.53.0',
    executableSha256: 'c'.repeat(64),
    frameworkSha256: 'd'.repeat(64),
  };
  const summary = createMacosSafeStorageReleaseSummary(attestation, plan, {
    target: expected.target,
    appVersion: expected.appVersion,
    attestationSha256: 'e'.repeat(64),
    executableSha256: expected.executableSha256,
    frameworkSha256: expected.frameworkSha256,
  });
  assert.deepEqual(validateMacosSafeStorageReleaseSummary(summary, expected), summary);
  assert.equal(summary.launchCount, 4);
  assert.equal(summary.genericConflictIsolationVerified, true);

  assert.throws(() => createMacosSafeStorageReleaseSummary(attestation, plan, {
    target: expected.target,
    appVersion: '2.54.0',
    attestationSha256: 'e'.repeat(64),
    executableSha256: expected.executableSha256,
    frameworkSha256: expected.frameworkSha256,
  }), /exact release app bytes and version/);
  assert.throws(() => validateMacosSafeStorageReleaseSummary({
    ...summary,
    genericConflictIsolationVerified: false,
  }, expected), /does not prove/);
  assert.throws(() => validateMacosSafeStorageReleaseSummary({
    ...summary,
    attestationSha256: 'f'.repeat(63),
  }, expected), /does not prove/);
});

test('release inventory consumes only the exact private current-run attestation file', async (t) => {
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-safe-storage-release-')),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const dynamicRoot = `${temporary}/ccem-mode2-safe-storage-smoke/12345-2-${NONCE.slice(0, 16)}`;
  const dynamicEnvironment = {
    ...environment,
    RUNNER_TEMP: temporary,
    [MACOS_SAFE_STORAGE_SMOKE_ROOT_ENV]: dynamicRoot,
    [MACOS_SAFE_STORAGE_SMOKE_ATTESTATION_ENV]: `${dynamicRoot}/evidence/attestation.json`,
  };
  const dynamicSource = `${temporary}/build/CCEM Desktop.app`;
  const plan = createMacosSafeStorageSmokePlan({
    environment: dynamicEnvironment,
    sourceApp: dynamicSource,
  });
  await fs.mkdir(plan.paths.evidenceRoot, { recursive: true, mode: 0o700 });
  const attestation = attestationFixture(plan);
  await fs.writeFile(
    plan.paths.attestationPath,
    `${JSON.stringify(attestation)}\n`,
    { mode: 0o600 },
  );
  const input = {
    attestationPath: plan.paths.attestationPath,
    appDir: dynamicSource,
    target: 'aarch64-apple-darwin',
    appVersion: '2.53.0',
    sourceCommit: SOURCE_COMMIT,
    executableSha256: 'c'.repeat(64),
    frameworkSha256: 'd'.repeat(64),
    environment: dynamicEnvironment,
  };
  const summary = await inspectMacosSafeStorageReleaseAttestation(input);
  assert.equal(summary.status, 'passed');
  assert.equal(summary.attestationSha256.length, 64);

  const tampered = structuredClone(attestation);
  tampered.scenarios[0].receipts.verify.appVersion = '2.54.0';
  await fs.writeFile(plan.paths.attestationPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  await assert.rejects(
    inspectMacosSafeStorageReleaseAttestation(input),
    /same persistent profile and app build|exact release app bytes and version/,
  );

  const outside = path.join(temporary, 'outside.json');
  await fs.writeFile(outside, `${JSON.stringify(attestation)}\n`, { mode: 0o600 });
  await fs.rm(plan.paths.attestationPath);
  await fs.symlink(outside, plan.paths.attestationPath);
  await assert.rejects(
    inspectMacosSafeStorageReleaseAttestation(input),
    /private, real, current-user file/,
  );
});

test('source contract keeps debug mock Keychain separate and release smoke CI-only', async () => {
  const [runner, gate, runtime, debugSmoke, bootstrap, desktopLib, workflow] = await Promise.all([
    fs.readFile(path.join(desktopDir, 'scripts/run-macos-mode2-safe-storage-smoke.mjs'), 'utf8'),
    fs.readFile(path.join(
      desktopDir,
      'src-tauri/src/browser/login/cef/macos_safe_storage_smoke.rs',
    ), 'utf8'),
    fs.readFile(path.join(
      desktopDir,
      'src-tauri/src/browser/login/cef/macos_safe_storage_smoke/runtime.rs',
    ), 'utf8'),
    fs.readFile(path.join(
      desktopDir,
      'src-tauri/src/browser/login/cef/debug_smoke/runtime.rs',
    ), 'utf8'),
    fs.readFile(path.join(
      desktopDir,
      'src-tauri/src/browser/login/cef/bootstrap.rs',
    ), 'utf8'),
    fs.readFile(path.join(desktopDir, 'src-tauri/src/lib.rs'), 'utf8'),
    fs.readFile(path.join(repoDir, '.github/workflows/mode2-signed-producer.yml'), 'utf8'),
  ]);
  assert.equal(MACOS_SECURITY_PATH, '/usr/bin/security');
  assert.equal(MACOS_CODESIGN_PATH, '/usr/bin/codesign');
  assert.match(runner, /list-keychains', '-d', 'user', '-s', keychain/);
  assert.match(runner, /default-keychain', '-d', 'user', '-s', keychain/);
  assert.match(runner, /restoreKeychainState/);
  assert.match(runner, /delete-keychain', scenario\.keychain/);
  assert.match(runner, /find-generic-password', '-w'[^]*genericSecret/);
  assert.doesNotMatch(runner, /const environment = \{ \.\.\.process\.env \}/u);
  for (const secret of [
    'APPLE_PASSWORD',
    'APPLE_CERTIFICATE',
    'TAURI_SIGNING_PRIVATE_KEY',
    'GITHUB_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
  ]) {
    assert.doesNotMatch(runner.match(/function runtimeEnvironment[^]*?\n\}/u)?.[0] ?? '', new RegExp(secret));
  }
  assert.match(gate, /GITHUB_ACTIONS/);
  assert.match(gate, /RUNNER_OS/);
  assert.match(gate, /not\(debug_assertions\)/);
  assert.match(gate, /consume_one_shot_ticket/);
  assert.match(runtime, /persistent_cookie_verified/);
  assert.match(runtime, /macos-system-keychain-v2/);
  assert.match(runtime, /WATCHDOG_TIMEOUT/);
  assert.match(debugSmoke, /CefCredentialStorePolicy::MockKeychain/);
  assert.match(bootstrap, /use-mock-keychain/);
  const updaterGateIndex = desktopLib.indexOf('if updater_replacement_smoke::is_requested()');
  const safeStorageGateIndex = desktopLib.indexOf(
    'macos_safe_storage_smoke::gate_from_process_environment()',
  );
  const nativeHelperIndex = desktopLib.indexOf(
    'native_runtime::run_native_helper_launcher_if_requested()',
  );
  assert.ok(
    updaterGateIndex > 0
      && updaterGateIndex < safeStorageGateIndex
      && safeStorageGateIndex < nativeHelperIndex,
  );
  assert.match(desktopLib, /macos_safe_storage_smoke::rejection_json\(&error\)/u);
  assert.match(desktopLib, /macos_safe_storage_smoke::EXIT_GATE_REJECTED/u);
  assert.match(desktopLib, /cfg\(all\(target_os = "macos", not\(debug_assertions\)\)\)/u);
  assert.doesNotMatch(runner, /login\.keychain/u);
  const smokeIndex = workflow.indexOf(
    '- name: Prove signed macOS Mode 2 Safe Storage isolation and persistence',
  );
  const evidenceIndex = workflow.indexOf(
    '- name: Retain macOS Mode 2 Safe Storage signed-runner evidence',
  );
  const inventoryIndex = workflow.indexOf(
    '- name: Verify final signed macOS Mode 2 app, DMG, updater, and trust tickets',
  );
  assert.ok(smokeIndex > 0 && smokeIndex < evidenceIndex && evidenceIndex < inventoryIndex);
  const smokeBlock = workflow.slice(smokeIndex, evidenceIndex);
  assert.match(smokeBlock, /CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_ALLOW: '1'/u);
  assert.match(smokeBlock, /randomBytes\(32\)/u);
  assert.match(smokeBlock, /run-macos-mode2-safe-storage-smoke\.mjs --app/u);
  assert.doesNotMatch(smokeBlock, /APPLE_(?:CERTIFICATE|PASSWORD|SIGNING_IDENTITY)/u);
  assert.match(workflow.slice(inventoryIndex), /--safe-storage-attestation "\$CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_ATTESTATION"/u);
});
