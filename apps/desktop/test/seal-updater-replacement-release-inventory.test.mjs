import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sealUpdaterReplacementReleaseInventory } from '../scripts/seal-updater-replacement-release-inventory.mjs';
import { validateUpdaterReplacementSmokeAttestation } from '../scripts/updater-replacement-smoke-contract.mjs';
import { createWindowsInstalledTreeInventory } from '../scripts/windows-mode2-production-smoke-contract.mjs';
import {
  attestationFixture,
  expectedFixture,
} from './updater-replacement-smoke-contract-fixture.test.mjs';

async function writeJson(candidate, value) {
  await fsp.writeFile(candidate, `${JSON.stringify(value, null, 2)}\n`);
}

test('sealer revalidates and binds updater evidence to the exact target inventory', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-seal-'));
  try {
    const expected = expectedFixture('macos');
    const { attestation } = attestationFixture('macos');
    const summary = validateUpdaterReplacementSmokeAttestation(attestation, expected);
    const inventory = {
      schemaVersion: 3,
      platform: expected.target,
      sourceCommit: expected.sourceCommit,
      appVersion: expected.currentVersion,
      mode2Included: true,
      mainExecutable: { sha256: expected.currentExecutableSha256 },
      artifacts: {
        updater: { sha256: expected.updater.artifact.sha256 },
        updaterSignature: { sha256: expected.updater.signature.sha256 },
      },
      macosSafeStorageRuntimeAttestation: {
        runId: expected.run.id,
        runAttempt: expected.run.attempt,
        repository: expected.run.repository,
        workflowRef: expected.run.workflowRef,
        producerWorkflowRef: expected.run.producerWorkflowRef,
        job: expected.run.job,
      },
    };
    const inventoryPath = path.join(root, 'inventory.json');
    const evidencePath = path.join(root, 'evidence.json');
    const outputPath = path.join(root, 'sealed.json');
    await writeJson(inventoryPath, inventory);
    await writeJson(evidencePath, { expected, attestation, summary });
    const sealed = await sealUpdaterReplacementReleaseInventory({
      inventoryPath,
      attestationPath: evidencePath,
      outputPath,
    });
    assert.deepEqual(sealed.updaterReplacementAttestation, summary);

    const staleAttemptPath = path.join(root, 'stale-attempt.json');
    await writeJson(staleAttemptPath, {
      ...inventory,
      macosSafeStorageRuntimeAttestation: {
        ...inventory.macosSafeStorageRuntimeAttestation,
        runAttempt: '3',
      },
    });
    await assert.rejects(
      sealUpdaterReplacementReleaseInventory({
        inventoryPath: staleAttemptPath,
        attestationPath: evidencePath,
        outputPath: path.join(root, 'should-not-seal-stale-attempt.json'),
      }),
      /does not bind the exact release target/u,
    );

    const mismatchedPath = path.join(root, 'mismatched.json');
    await writeJson(mismatchedPath, { ...inventory, platform: 'x86_64-apple-darwin' });
    await assert.rejects(
      sealUpdaterReplacementReleaseInventory({
        inventoryPath: mismatchedPath,
        attestationPath: evidencePath,
        outputPath: path.join(root, 'should-not-exist.json'),
      }),
      /does not bind the exact release target/u,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('sealer binds the Windows updater summary to the exact full installed-tree inventory', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-seal-windows-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const expected = expectedFixture('windows');
  const { attestation } = attestationFixture('windows');
  const summary = validateUpdaterReplacementSmokeAttestation(attestation, expected);
  const inventory = {
    schemaVersion: 3,
    platform: expected.target,
    sourceCommit: expected.sourceCommit,
    appVersion: expected.currentVersion,
    mode2Included: true,
    mainExecutable: { sha256: expected.currentExecutableSha256 },
    installedTree: expected.platformProof.currentInstalledTree,
    artifacts: {
      updater: { sha256: expected.updater.artifact.sha256 },
      updaterSignature: { sha256: expected.updater.signature.sha256 },
    },
    windowsRuntimeAttestation: {
      runId: expected.run.id,
      runAttempt: expected.run.attempt,
      repository: expected.run.repository,
      workflowRef: expected.run.workflowRef,
      producerWorkflowRef: expected.run.producerWorkflowRef,
      job: expected.run.job,
    },
  };
  const inventoryPath = path.join(root, 'inventory.json');
  const evidencePath = path.join(root, 'evidence.json');
  await writeJson(inventoryPath, inventory);
  await writeJson(evidencePath, { expected, attestation, summary });
  const sealed = await sealUpdaterReplacementReleaseInventory({
    inventoryPath,
    attestationPath: evidencePath,
    outputPath: path.join(root, 'sealed.json'),
  });
  assert.equal(
    sealed.updaterReplacementAttestation.installedTreeInventorySha256,
    inventory.installedTree.inventorySha256,
  );
  assert.equal(sealed.updaterReplacementAttestation.fixtureAclRestricted, true);
  assert.equal(sealed.updaterReplacementAttestation.evidenceAclRestricted, true);

  const extraTree = createWindowsInstalledTreeInventory({
    directories: inventory.installedTree.directories,
    files: [
      ...inventory.installedTree.files,
      { relativePath: 'stale-helper.exe', size: 5, sha256: '0'.repeat(64) },
    ],
  });
  const mismatchedPath = path.join(root, 'inventory-mismatched-tree.json');
  await writeJson(mismatchedPath, { ...inventory, installedTree: extraTree });
  await assert.rejects(
    sealUpdaterReplacementReleaseInventory({
      inventoryPath: mismatchedPath,
      attestationPath: evidencePath,
      outputPath: path.join(root, 'should-not-seal.json'),
    }),
    /does not bind the exact release target/u,
  );
});
