import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MODE2_SIGNED_PRODUCER_JOB,
  MODE2_SIGNED_READINESS_TARGETS,
  run,
  verifyMode2SignedReadinessEvidence,
} from '../scripts/verify-mode2-signed-readiness-evidence.mjs';
import { CEF_FULL_VERSION } from '../scripts/stage-cef-macos.mjs';
import {
  WINDOWS_MAIN_EXECUTABLE_NAME,
  WINDOWS_CEF_SOURCE_PIN,
  WINDOWS_SANDBOX_CLIENT_NAME,
  WINDOWS_SANDBOX_ENTRY_POINT,
} from '../scripts/stage-cef-windows.mjs';
import {
  UPDATER_REPLACEMENT_PROOF_CLASS,
  UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION,
  UPDATER_REPLACEMENT_STAGES,
} from '../scripts/updater-replacement-smoke-contract.mjs';
import {
  WINDOWS_MODE2_CHROMIUM_VERSION,
  WINDOWS_MODE2_REQUIRED_PROCESS_TYPES,
  WINDOWS_MODE2_REQUIRED_STAGES,
  WINDOWS_MODE2_SANDBOX_PROFILE,
  WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
  createWindowsInstalledTreeInventory,
  createWindowsRuntimeInventoryFingerprint,
  hashWindowsMode2SmokeJson,
} from '../scripts/windows-mode2-production-smoke-contract.mjs';
import { RELEASE_INVENTORY_SCHEMA_VERSION } from '../scripts/verify-mode2-release-inventory.mjs';

const VERSION = '2.58.0';
const SOURCE_COMMIT = 'a'.repeat(40);
const RUN_ID = '987654321';
const RUN_ATTEMPT = '3';
const REPOSITORY = 'Genuifx/claude-code-env-manager';
const WORKFLOW_REF =
  `${REPOSITORY}/.github/workflows/mode2-signed-readiness.yml@refs/heads/main`;
const PRODUCER_WORKFLOW_REF =
  `${REPOSITORY}/.github/workflows/mode2-signed-producer.yml@refs/heads/main`;
const JOB = 'build-desktop';
const SAFE_STORAGE_BRANDING = Object.freeze({
  schemaVersion: 1,
  method: 'unique-null-padded-literal-replacement-v1',
  sourceService: 'Chromium Safe Storage',
  service: 'CCEM Safe Storage',
  byteOffset: 1024,
  byteLength: Buffer.byteLength('Chromium Safe Storage'),
  sourceExecutableSha256: '1'.repeat(64),
  brandedExecutableSha256: '2'.repeat(64),
  signedExecutableSha256: '3'.repeat(64),
});

function artifact(fileName, seed) {
  return {
    fileName,
    sha256: seed.repeat(64),
    size: 100 + seed.charCodeAt(0),
  };
}

function macosRuntimeAttestation(target, executableSha256, seed) {
  return {
    schemaVersion: 2,
    platform: target,
    status: 'passed',
    sourceCommit: SOURCE_COMMIT,
    appVersion: VERSION,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    repository: REPOSITORY,
    workflowRef: WORKFLOW_REF,
    producerWorkflowRef: PRODUCER_WORKFLOW_REF,
    job: JOB,
    attestationSha256: seed.repeat(64),
    executableSha256,
    frameworkSha256: SAFE_STORAGE_BRANDING.signedExecutableSha256,
    safeStorageService: 'CCEM Safe Storage',
    credentialStore: 'macos-system-keychain-v2',
    scenarios: ['clean', 'generic-conflict'],
    launchCount: 4,
    cleanKeychainVerified: true,
    genericConflictIsolationVerified: true,
    cookiePersistenceVerified: true,
    productionBehaviorVerified: true,
    semanticLaunchCount: 4,
    effectFenceVerified: true,
    profileIsolationVerified: true,
    screenshotArtifactsVerified: true,
    keychainStateRestored: true,
    cleanupVerified: true,
  };
}

function updaterReplacementAttestation(
  target,
  executableSha256,
  updaterSha256,
  signatureSha256,
  installedTree = null,
) {
  const macos = target.endsWith('apple-darwin');
  const summary = {
    schemaVersion: UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION,
    proofClass: UPDATER_REPLACEMENT_PROOF_CLASS,
    platform: macos ? 'macos' : 'windows',
    target,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    repository: REPOSITORY,
    workflowRef: WORKFLOW_REF,
    producerWorkflowRef: PRODUCER_WORKFLOW_REF,
    job: JOB,
    challengeNonce: '0'.repeat(64),
    sourceCommit: SOURCE_COMMIT,
    previousTag: 'v2.57.0',
    previousSourceCommit: 'b'.repeat(40),
    previousVersion: '2.57.0',
    previousExecutableSha256: '1'.repeat(64),
    instrumentationPatchSha256: '2'.repeat(64),
    previousEmbeddedUpdaterPublicKeySha256: '3'.repeat(64),
    currentVersion: VERSION,
    currentExecutableSha256: executableSha256,
    updaterPublicKeySha256: '4'.repeat(64),
    updaterArtifactSha256: updaterSha256,
    updaterSignatureSha256: signatureSha256,
    transportOrigin: 'https://127.0.0.1:43117',
    installRoot: macos
      ? '/private/tmp/ccem-updater/CCEM Desktop.app'
      : 'D:\\a\\_temp\\ccem-updater\\app',
    previousProcessIdentitySha256: '5'.repeat(64),
    harnessProcessIdentitySha256: '6'.repeat(64),
    currentProcessIdentitySha256: '7'.repeat(64),
    stages: [...UPDATER_REPLACEMENT_STAGES],
    finalStageReceiptSha256: '8'.repeat(64),
    evidenceSha256: '9'.repeat(64),
    badSignatureRejectedWithoutMutation: true,
    poisonSentinelRemoved: true,
    cefPathCount: 4,
    cefPathSetSha256: 'a'.repeat(64),
    cefInventorySha256: 'b'.repeat(64),
    platformProofKind: macos
      ? 'macos-whole-bundle-replacement'
      : 'windows-nsis-replacement',
    processResidueZero: true,
    attestationSha256: 'c'.repeat(64),
  };
  if (!macos) {
    Object.assign(summary, {
      fixtureAclRestricted: true,
      evidenceAclRestricted: true,
      installedTreePathCount: installedTree.pathCount,
      installedTreePathSetSha256: installedTree.pathSetSha256,
      installedTreeInventorySha256: installedTree.inventorySha256,
    });
  }
  return summary;
}

function createInventories() {
  const base = (platform, overrides) => ({
    schemaVersion: RELEASE_INVENTORY_SCHEMA_VERSION,
    platform,
    appVersion: VERSION,
    sourceCommit: SOURCE_COMMIT,
    mode2Included: true,
    cefRuntimeVersion: CEF_FULL_VERSION,
    updaterSignatureVerification: 'minisign-ed25519-blake2b',
    ...(platform.endsWith('apple-darwin')
      ? { cefSafeStorageBranding: { ...SAFE_STORAGE_BRANDING } }
      : {}),
    ...overrides,
  });
  const windowsStableCefResources = { 'libcef.dll': 'f'.repeat(64) };
  const windowsInstalledTree = createWindowsInstalledTreeInventory({
    directories: ['binaries', 'resources'],
    files: [
      { relativePath: 'binaries/ccem-node.exe', size: 101, sha256: '1'.repeat(64) },
      { relativePath: 'ccem-desktop.exe', size: 102, sha256: 'b'.repeat(64) },
      { relativePath: 'cef-windows-staging-manifest.json', size: 103, sha256: '2'.repeat(64) },
      { relativePath: 'libcef.dll', size: 104, sha256: 'f'.repeat(64) },
      { relativePath: 'resources/native-runtime-helper.mjs', size: 105, sha256: '3'.repeat(64) },
      { relativePath: 'uninstall.exe', size: 106, sha256: '4'.repeat(64) },
    ],
  });
  const windowsRuntimeFingerprint = createWindowsRuntimeInventoryFingerprint({
    installedExecutableSha256: 'b'.repeat(64),
    stableCefResources: windowsStableCefResources,
  });
  const windowsRuntimeAttestation = {
    schemaVersion: WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
    platform: 'x86_64-pc-windows-msvc',
    sourceCommit: SOURCE_COMMIT,
    appVersion: VERSION,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    repository: REPOSITORY,
    workflowRef: WORKFLOW_REF,
    producerWorkflowRef: PRODUCER_WORKFLOW_REF,
    job: JOB,
    installedExecutableSha256: 'b'.repeat(64),
    installerSha256: '7'.repeat(64),
    runtimeInventorySha256: windowsRuntimeFingerprint.sha256,
    installedTreeInventorySha256: windowsInstalledTree.inventorySha256,
    installedTreePathSetSha256: windowsInstalledTree.pathSetSha256,
    installedTreePathCount: windowsInstalledTree.pathCount,
    runtimeReceiptSha256: 'd'.repeat(64),
    attestationSha256: 'e'.repeat(64),
    chromiumVersion: WINDOWS_MODE2_CHROMIUM_VERSION,
    sandboxProfile: WINDOWS_MODE2_SANDBOX_PROFILE,
    processTypes: [...WINDOWS_MODE2_REQUIRED_PROCESS_TYPES],
    stages: [...WINDOWS_MODE2_REQUIRED_STAGES],
    lpacSid: 'S-1-15-2-2',
    verifiedPathCount: windowsRuntimeFingerprint.verifiedPathCount,
    verifiedPathsSha256: hashWindowsMode2SmokeJson(windowsRuntimeFingerprint.relativePaths),
    productionPathVerified: true,
    semanticBehaviorVerified: true,
    effectFenceVerified: true,
    profileIsolationVerified: true,
    screenshotArtifactVerified: true,
    nativeWindowVerified: true,
    processTokenSandboxVerified: true,
    networkServiceSandboxed: true,
    upgradeAclNarrowed: true,
    observedDpi: 144,
    profileCleanupVerified: true,
    cleanExit: true,
  };
  return [
    base('aarch64-apple-darwin', {
      platformVerification: 'macos-native-release-trust',
      macosSafeStorageRuntimeAttestation: macosRuntimeAttestation(
        'aarch64-apple-darwin',
        '9'.repeat(64),
        'c',
      ),
      dmgNotarization: {
        id: '01234567-89ab-cdef-0123-456789abcdef',
        status: 'Accepted',
      },
      mainExecutable: artifact('ccem-desktop', '9'),
      artifacts: {
        dmg: artifact('CCEM.Desktop_aarch64.dmg', '1'),
        updater: artifact('CCEM.Desktop_aarch64.app.tar.gz', '2'),
        updaterSignature: artifact('CCEM.Desktop_aarch64.app.tar.gz.sig', '3'),
      },
      updaterReplacementAttestation: updaterReplacementAttestation(
        'aarch64-apple-darwin',
        '9'.repeat(64),
        '2'.repeat(64),
        '3'.repeat(64),
      ),
    }),
    base('x86_64-apple-darwin', {
      platformVerification: 'macos-native-release-trust',
      macosSafeStorageRuntimeAttestation: macosRuntimeAttestation(
        'x86_64-apple-darwin',
        'a'.repeat(64),
        'd',
      ),
      dmgNotarization: {
        id: '12345678-9abc-def0-1234-56789abcdef0',
        status: 'Accepted',
      },
      mainExecutable: artifact('ccem-desktop', 'a'),
      artifacts: {
        dmg: artifact('CCEM.Desktop_x64.dmg', '4'),
        updater: artifact('CCEM.Desktop_x64.app.tar.gz', '5'),
        updaterSignature: artifact('CCEM.Desktop_x64.app.tar.gz.sig', '6'),
      },
      updaterReplacementAttestation: updaterReplacementAttestation(
        'x86_64-apple-darwin',
        'a'.repeat(64),
        '5'.repeat(64),
        '6'.repeat(64),
      ),
    }),
    base('x86_64-pc-windows-msvc', {
      platformVerification: 'windows-native-authenticode-installed-runtime-smoke',
      cefSourcePin: WINDOWS_CEF_SOURCE_PIN,
      sandboxEnabled: true,
      sameExecutableSubprocesses: true,
      sandboxBootstrapExecutable: WINDOWS_MAIN_EXECUTABLE_NAME,
      sandboxClientLibrary: WINDOWS_SANDBOX_CLIENT_NAME,
      sandboxEntryPoint: WINDOWS_SANDBOX_ENTRY_POINT,
      bootstrapCanonicalSha256: 'd'.repeat(64),
      clientCanonicalSha256: 'e'.repeat(64),
      mainExecutable: artifact('ccem-desktop.exe', 'b'),
      stableCefResources: windowsStableCefResources,
      installedTree: windowsInstalledTree,
      windowsRuntimeAttestation,
      artifacts: {
        updater: artifact(`CCEM.Desktop_${VERSION}_x64-setup.exe`, '7'),
        updaterSignature: artifact(`CCEM.Desktop_${VERSION}_x64-setup.exe.sig`, '8'),
      },
      updaterReplacementAttestation: updaterReplacementAttestation(
        'x86_64-pc-windows-msvc',
        'b'.repeat(64),
        '7'.repeat(64),
        '8'.repeat(64),
        windowsInstalledTree,
      ),
    }),
  ];
}

function artifactDirectory(evidenceRoot, target) {
  return path.join(
    evidenceRoot,
    `mode2-signed-evidence-${RUN_ID}-${RUN_ATTEMPT}-${target}`,
  );
}

function inventoryFile(evidenceRoot, target) {
  return path.join(
    artifactDirectory(evidenceRoot, target),
    `mode2-release-inventory-${target}.json`,
  );
}

async function writeInventory(evidenceRoot, inventory, target = inventory.platform) {
  await fs.writeFile(
    inventoryFile(evidenceRoot, target),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
}

async function createFixture(t) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-mode2-signed-readiness-'));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const evidenceRoot = path.join(sandbox, 'evidence');
  const inventories = createInventories();
  await fs.mkdir(evidenceRoot);
  for (const inventory of inventories) {
    await fs.mkdir(artifactDirectory(evidenceRoot, inventory.platform));
    await writeInventory(evidenceRoot, inventory);
  }
  const output = path.join(sandbox, 'aggregate.json');
  return {
    sandbox,
    evidenceRoot,
    inventories,
    output,
    options: {
      evidenceRoot,
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      repository: REPOSITORY,
      workflowRef: WORKFLOW_REF,
      producerWorkflowRef: PRODUCER_WORKFLOW_REF,
      output,
    },
  };
}

function cliArguments(options) {
  return [
    '--evidence-root', options.evidenceRoot,
    '--version', options.version,
    '--source-commit', options.sourceCommit,
    '--run-id', options.runId,
    '--run-attempt', options.runAttempt,
    '--repository', options.repository,
    '--workflow-ref', options.workflowRef,
    '--producer-workflow-ref', options.producerWorkflowRef,
    '--output', options.output,
  ];
}

async function mutateInventory(fixture, target, mutate) {
  const inventory = fixture.inventories.find((candidate) => candidate.platform === target);
  mutate(inventory);
  await writeInventory(fixture.evidenceRoot, inventory, target);
}

test('CLI verifies and atomically writes one three-target signed-readiness aggregate', async (t) => {
  const fixture = await createFixture(t);
  const summary = await run(cliArguments(fixture.options));
  const stored = JSON.parse(await fs.readFile(fixture.output, 'utf8'));
  assert.deepEqual(stored, summary);
  assert.equal(summary.proofClass, 'mode2-signed-readiness');
  assert.equal(summary.status, 'verified');
  assert.equal(summary.runId, RUN_ID);
  assert.equal(summary.runAttempt, RUN_ATTEMPT);
  assert.equal(summary.repository, REPOSITORY);
  assert.equal(summary.workflowRef, WORKFLOW_REF);
  assert.equal(summary.producerWorkflowRef, PRODUCER_WORKFLOW_REF);
  assert.equal(summary.job, JOB);
  assert.equal(MODE2_SIGNED_PRODUCER_JOB, JOB);
  assert.deepEqual(summary.targets.map(({ target }) => target), MODE2_SIGNED_READINESS_TARGETS);
  assert.deepEqual(summary.inventory.targets.map(({ platform }) => platform), MODE2_SIGNED_READINESS_TARGETS);
  assert.equal(summary.targets[0].runtimeAttestation.kind, 'macos-mode2-production-runtime');
  assert.equal(summary.targets[2].runtimeAttestation.kind, 'windows-mode2-runtime');
  assert.match(summary.targets[0].inventorySha256, /^[a-f0-9]{64}$/u);
  assert.equal((await fs.stat(fixture.output)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await fs.readdir(fixture.sandbox)).filter((name) => name.includes('.tmp-')),
    [],
  );
});

test('evidence root requires exactly one artifact directory per signed target', async (t) => {
  await t.test('missing target', async (subtest) => {
    const fixture = await createFixture(subtest);
    await fs.rm(artifactDirectory(fixture.evidenceRoot, MODE2_SIGNED_READINESS_TARGETS[1]), {
      recursive: true,
    });
    await assert.rejects(
      () => verifyMode2SignedReadinessEvidence(fixture.options),
      /downloaded evidence root must contain exactly/u,
    );
  });

  await t.test('duplicate target inventory', async (subtest) => {
    const fixture = await createFixture(subtest);
    await writeInventory(
      fixture.evidenceRoot,
      fixture.inventories[0],
      MODE2_SIGNED_READINESS_TARGETS[1],
    );
    await assert.rejects(
      () => verifyMode2SignedReadinessEvidence(fixture.options),
      /contains inventory for aarch64-apple-darwin/u,
    );
  });

  await t.test('fourth target', async (subtest) => {
    const fixture = await createFixture(subtest);
    await fs.mkdir(path.join(
      fixture.evidenceRoot,
      `mode2-signed-evidence-${RUN_ID}-${RUN_ATTEMPT}-riscv64-unknown-linux-gnu`,
    ));
    await assert.rejects(
      () => verifyMode2SignedReadinessEvidence(fixture.options),
      /downloaded evidence root must contain exactly/u,
    );
  });
});

test('artifact directories reject extra entries, wrong filenames, and symlinks', async (t) => {
  await t.test('extra file', async (subtest) => {
    const fixture = await createFixture(subtest);
    await fs.writeFile(
      path.join(artifactDirectory(fixture.evidenceRoot, MODE2_SIGNED_READINESS_TARGETS[0]), 'extra.json'),
      '{}\n',
    );
    await assert.rejects(
      () => verifyMode2SignedReadinessEvidence(fixture.options),
      /evidence must contain exactly/u,
    );
  });

  await t.test('wrong inventory filename', async (subtest) => {
    const fixture = await createFixture(subtest);
    const target = MODE2_SIGNED_READINESS_TARGETS[0];
    await fs.rename(
      inventoryFile(fixture.evidenceRoot, target),
      path.join(artifactDirectory(fixture.evidenceRoot, target), 'inventory.json'),
    );
    await assert.rejects(
      () => verifyMode2SignedReadinessEvidence(fixture.options),
      /evidence must contain exactly/u,
    );
  });

  await t.test('inventory file symlink', async (subtest) => {
    const fixture = await createFixture(subtest);
    const target = MODE2_SIGNED_READINESS_TARGETS[0];
    const candidate = inventoryFile(fixture.evidenceRoot, target);
    const outside = path.join(fixture.sandbox, 'outside-inventory.json');
    await fs.copyFile(candidate, outside);
    await fs.rm(candidate);
    await fs.symlink(outside, candidate);
    await assert.rejects(
      () => verifyMode2SignedReadinessEvidence(fixture.options),
      /must be a regular non-symlink file/u,
    );
  });

  await t.test('artifact directory symlink', async (subtest) => {
    const fixture = await createFixture(subtest);
    const target = MODE2_SIGNED_READINESS_TARGETS[0];
    const candidate = artifactDirectory(fixture.evidenceRoot, target);
    const outside = path.join(fixture.sandbox, 'outside-artifact');
    await fs.rename(candidate, outside);
    await fs.symlink(outside, candidate);
    await assert.rejects(
      () => verifyMode2SignedReadinessEvidence(fixture.options),
      /must be a regular non-symlink directory/u,
    );
  });

  await t.test('evidence root symlink', async (subtest) => {
    const fixture = await createFixture(subtest);
    const linkedRoot = path.join(fixture.sandbox, 'evidence-link');
    await fs.symlink(fixture.evidenceRoot, linkedRoot);
    await assert.rejects(
      () => verifyMode2SignedReadinessEvidence({ ...fixture.options, evidenceRoot: linkedRoot }),
      /evidence root must be a regular non-symlink directory/u,
    );
  });
});

test('every updater replacement attestation field is bound on every target', async (t) => {
  const mutations = [
    ['runId', '1234'],
    ['runAttempt', '9'],
    ['sourceCommit', 'b'.repeat(40)],
    ['target', 'unexpected-target'],
    ['repository', 'Other/example'],
    ['workflowRef', `${REPOSITORY}/.github/workflows/release-desktop.yml@refs/heads/main`],
    [
      'producerWorkflowRef',
      `${REPOSITORY}/.github/workflows/release-desktop.yml@refs/heads/main`,
    ],
    ['job', 'signed-readiness'],
  ];
  for (const target of MODE2_SIGNED_READINESS_TARGETS) {
    for (const [field, value] of mutations) {
      await t.test(`${target} ${field}`, async (subtest) => {
        const fixture = await createFixture(subtest);
        await mutateInventory(fixture, target, (inventory) => {
          inventory.updaterReplacementAttestation[field] = value;
        });
        await assert.rejects(
          () => verifyMode2SignedReadinessEvidence(fixture.options),
          new RegExp(field === 'sourceCommit' ? 'source|release target' : field, 'u'),
        );
      });
    }
  }
});

test('macOS Safe Storage runtime identity fields are individually bound', async (t) => {
  const mutations = [
    ['runId', '1234'],
    ['runAttempt', '9'],
    ['sourceCommit', 'b'.repeat(40)],
    ['repository', 'Other/example'],
    ['workflowRef', `${REPOSITORY}/.github/workflows/release-desktop.yml@refs/heads/main`],
    [
      'producerWorkflowRef',
      `${REPOSITORY}/.github/workflows/release-desktop.yml@refs/heads/main`,
    ],
    ['job', 'signed-readiness'],
    ['platform', 'x86_64-pc-windows-msvc'],
  ];
  for (const target of MODE2_SIGNED_READINESS_TARGETS.slice(0, 2)) {
    for (const [field, value] of mutations) {
      await t.test(`${target} ${field}`, async (subtest) => {
        const fixture = await createFixture(subtest);
        await mutateInventory(fixture, target, (inventory) => {
          inventory.macosSafeStorageRuntimeAttestation[field] = value;
          if (field === 'repository') {
            inventory.macosSafeStorageRuntimeAttestation.workflowRef =
              `${value}/.github/workflows/mode2-signed-readiness.yml@refs/heads/main`;
          }
        });
        await assert.rejects(
          () => verifyMode2SignedReadinessEvidence(fixture.options),
          /release summary|Safe Storage runtime/u,
        );
      });
    }
  }
});

test('macOS production behavior gates are individually fail-closed', async (t) => {
  for (const [field, value] of [
    ['productionBehaviorVerified', false],
    ['semanticLaunchCount', 3],
    ['effectFenceVerified', false],
    ['profileIsolationVerified', false],
    ['screenshotArtifactsVerified', false],
  ]) {
    await t.test(field, async (subtest) => {
      const fixture = await createFixture(subtest);
      await mutateInventory(fixture, 'aarch64-apple-darwin', (inventory) => {
        inventory.macosSafeStorageRuntimeAttestation[field] = value;
      });
      await assert.rejects(
        () => verifyMode2SignedReadinessEvidence(fixture.options),
        /release summary|productionBehavior|production behavior|semantic|effect|profile|screenshot/u,
      );
    });
  }
});

test('Windows Mode 2 runtime identity fields are individually bound', async (t) => {
  const mutations = [
    ['runId', '1234'],
    ['runAttempt', '9'],
    ['sourceCommit', 'b'.repeat(40)],
    ['repository', 'Other/example'],
    ['workflowRef', `${REPOSITORY}/.github/workflows/release-desktop.yml@refs/heads/main`],
    [
      'producerWorkflowRef',
      `${REPOSITORY}/.github/workflows/release-desktop.yml@refs/heads/main`,
    ],
    ['job', 'signed-readiness'],
    ['platform', 'aarch64-apple-darwin'],
  ];
  for (const [field, value] of mutations) {
    await t.test(field, async (subtest) => {
      const fixture = await createFixture(subtest);
      await mutateInventory(fixture, 'x86_64-pc-windows-msvc', (inventory) => {
        inventory.windowsRuntimeAttestation[field] = value;
        if (field === 'repository') {
          inventory.windowsRuntimeAttestation.workflowRef =
            `${value}/.github/workflows/mode2-signed-readiness.yml@refs/heads/main`;
        }
      });
      await assert.rejects(
        () => verifyMode2SignedReadinessEvidence(fixture.options),
        /(?:Windows Mode 2|smoke) summary|Windows Mode 2 runtime/u,
      );
    });
  }
});

test('Windows production behavior gates are individually fail-closed', async (t) => {
  for (const field of [
    'semanticBehaviorVerified',
    'effectFenceVerified',
    'profileIsolationVerified',
    'screenshotArtifactVerified',
  ]) {
    await t.test(field, async (subtest) => {
      const fixture = await createFixture(subtest);
      await mutateInventory(fixture, 'x86_64-pc-windows-msvc', (inventory) => {
        inventory.windowsRuntimeAttestation[field] = false;
      });
      await assert.rejects(
        () => verifyMode2SignedReadinessEvidence(fixture.options),
        new RegExp(field, 'u'),
      );
    });
  }
});
