import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  UPDATER_REPLACEMENT_PROOF_CLASS,
  UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION,
  UPDATER_REPLACEMENT_STAGES,
  validateUpdaterReplacementSmokeAttestation,
} from './updater-replacement-smoke-contract.mjs';
import {
  validateWindowsInstalledTreeInventory,
} from './windows-mode2-production-smoke-contract.mjs';

function fail(message) {
  throw new Error(`[seal-updater-replacement-release-inventory] ${message}`);
}

const SUMMARY_FIELDS = Object.freeze([
  'schemaVersion', 'proofClass', 'platform', 'target', 'runId', 'runAttempt',
  'repository', 'workflowRef', 'producerWorkflowRef', 'job', 'challengeNonce',
  'sourceCommit', 'previousTag',
  'previousSourceCommit', 'previousVersion', 'previousExecutableSha256',
  'instrumentationPatchSha256', 'previousEmbeddedUpdaterPublicKeySha256',
  'currentVersion', 'currentExecutableSha256', 'updaterPublicKeySha256',
  'updaterArtifactSha256', 'updaterSignatureSha256', 'transportOrigin', 'installRoot',
  'previousProcessIdentitySha256', 'harnessProcessIdentitySha256',
  'currentProcessIdentitySha256', 'stages', 'finalStageReceiptSha256', 'evidenceSha256',
  'badSignatureRejectedWithoutMutation', 'poisonSentinelRemoved', 'cefPathCount',
  'cefPathSetSha256', 'cefInventorySha256', 'platformProofKind', 'processResidueZero',
  'attestationSha256',
]);
const WINDOWS_SUMMARY_FIELDS = Object.freeze([
  ...SUMMARY_FIELDS,
  'fixtureAclRestricted', 'evidenceAclRestricted',
  'installedTreePathCount', 'installedTreePathSetSha256',
  'installedTreeInventorySha256',
]);

export function validateUpdaterReplacementReleaseSummary(summary, expected) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    fail('updater replacement release summary must be an object');
  }
  const platform = expected.target.endsWith('apple-darwin') ? 'macos' : 'windows';
  const summaryFields = platform === 'windows' ? WINDOWS_SUMMARY_FIELDS : SUMMARY_FIELDS;
  if (JSON.stringify(Object.keys(summary).sort()) !== JSON.stringify([...summaryFields].sort())) {
    fail('updater replacement release summary fields differ');
  }
  const hashFields = summaryFields.filter((name) => name.endsWith('Sha256'));
  if (hashFields.some((name) => !/^[a-f0-9]{64}$/u.test(summary[name] ?? ''))) {
    fail('updater replacement release summary contains an invalid SHA-256');
  }
  const installedTree = platform === 'windows'
    ? validateWindowsInstalledTreeInventory(
      expected.installedTree,
      'release inventory Windows installed tree',
    )
    : null;
  const expectedProofKind = platform === 'macos'
    ? 'macos-whole-bundle-replacement'
    : 'windows-nsis-replacement';
  const pathApi = platform === 'macos' ? path.posix : path.win32;
  if (
    summary.schemaVersion !== UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION
    || summary.proofClass !== UPDATER_REPLACEMENT_PROOF_CLASS
    || summary.platform !== platform
    || summary.target !== expected.target
    || summary.sourceCommit !== expected.sourceCommit
    || summary.repository !== expected.repository
    || summary.workflowRef !== expected.workflowRef
    || summary.producerWorkflowRef !== expected.producerWorkflowRef
    || summary.job !== expected.job
    || summary.runId !== expected.runId
    || summary.runAttempt !== expected.runAttempt
    || summary.currentVersion !== expected.appVersion
    || summary.currentExecutableSha256 !== expected.currentExecutableSha256
    || summary.updaterArtifactSha256 !== expected.updaterArtifactSha256
    || summary.updaterSignatureSha256 !== expected.updaterSignatureSha256
    || !/^[1-9][0-9]*$/u.test(expected.runId ?? '')
    || !/^[1-9][0-9]*$/u.test(expected.runAttempt ?? '')
    || !/^[1-9][0-9]*$/u.test(summary.runId ?? '')
    || !/^[1-9][0-9]*$/u.test(summary.runAttempt ?? '')
    || !/^[a-f0-9]{40}$/u.test(summary.previousSourceCommit ?? '')
    || summary.previousSourceCommit === expected.sourceCommit
    || summary.previousTag !== `v${summary.previousVersion}`
    || !/^[a-f0-9]{64}$/u.test(summary.challengeNonce ?? '')
    || !Array.isArray(summary.stages)
    || JSON.stringify(summary.stages) !== JSON.stringify(UPDATER_REPLACEMENT_STAGES)
    || summary.badSignatureRejectedWithoutMutation !== true
    || summary.poisonSentinelRemoved !== true
    || summary.processResidueZero !== true
    || summary.cefPathCount < 1
    || summary.platformProofKind !== expectedProofKind
    || (platform === 'windows' && (
      summary.fixtureAclRestricted !== true
      || summary.evidenceAclRestricted !== true
    ))
    || (installedTree !== null && (
      summary.installedTreePathCount !== installedTree.pathCount
      || summary.installedTreePathSetSha256 !== installedTree.pathSetSha256
      || summary.installedTreeInventorySha256 !== installedTree.inventorySha256
    ))
    || !pathApi.isAbsolute(summary.installRoot ?? '')
  ) {
    fail('updater replacement release summary does not bind the exact release target');
  }
  return summary;
}

async function readJson(candidate, label) {
  const exact = path.resolve(candidate);
  const metadata = await fsp.lstat(exact).catch((error) => fail(`${label} is missing: ${error.message}`));
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${label} must be a regular non-link file`);
  const handle = await fsp.open(exact, 'r');
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.size > 16 * 1024 * 1024
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
    ) {
      fail(`${label} changed identity or exceeds the JSON size bound`);
    }
    const bytes = await handle.readFile();
    const final = await handle.stat();
    if (bytes.length !== opened.size || final.size !== opened.size) {
      fail(`${label} changed while it was being consumed`);
    }
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (String(error.message).startsWith('[seal-updater-replacement-release-inventory]')) {
      throw error;
    }
    fail(`${label} is invalid JSON: ${error.message}`);
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function sealUpdaterReplacementReleaseInventory({
  inventoryPath,
  attestationPath,
  outputPath,
}) {
  const inventory = await readJson(inventoryPath, 'base release inventory');
  const wrapper = await readJson(attestationPath, 'updater replacement evidence');
  if (
    !wrapper?.expected
    || !wrapper.attestation
    || !wrapper.summary
    || Object.hasOwn(inventory, 'updaterReplacementAttestation')
  ) {
    fail('base inventory or updater replacement evidence has an invalid sealing shape');
  }
  const summary = validateUpdaterReplacementSmokeAttestation(
    wrapper.attestation,
    wrapper.expected,
  );
  if (JSON.stringify(summary) !== JSON.stringify(wrapper.summary)) {
    fail('stored updater replacement summary differs from fresh contract validation');
  }
  validateUpdaterReplacementReleaseSummary(summary, {
    target: inventory.platform,
    sourceCommit: inventory.sourceCommit,
    appVersion: inventory.appVersion,
    currentExecutableSha256: inventory.mainExecutable?.sha256,
    updaterArtifactSha256: inventory.artifacts?.updater?.sha256,
    updaterSignatureSha256: inventory.artifacts?.updaterSignature?.sha256,
    installedTree: inventory.installedTree,
    runId: inventory.macosSafeStorageRuntimeAttestation?.runId
      ?? inventory.windowsRuntimeAttestation?.runId,
    runAttempt: inventory.macosSafeStorageRuntimeAttestation?.runAttempt
      ?? inventory.windowsRuntimeAttestation?.runAttempt,
    repository: inventory.macosSafeStorageRuntimeAttestation?.repository
      ?? inventory.windowsRuntimeAttestation?.repository,
    workflowRef: inventory.macosSafeStorageRuntimeAttestation?.workflowRef
      ?? inventory.windowsRuntimeAttestation?.workflowRef,
    producerWorkflowRef: inventory.macosSafeStorageRuntimeAttestation?.producerWorkflowRef
      ?? inventory.windowsRuntimeAttestation?.producerWorkflowRef,
    job: inventory.macosSafeStorageRuntimeAttestation?.job
      ?? inventory.windowsRuntimeAttestation?.job,
  });
  const sealed = {
    ...inventory,
    updaterReplacementAttestation: summary,
  };
  await fsp.writeFile(
    path.resolve(outputPath),
    `${JSON.stringify(sealed, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return sealed;
}

function parseArguments(argv) {
  const values = {};
  const names = new Map([
    ['--inventory', 'inventoryPath'],
    ['--attestation', 'attestationPath'],
    ['--output', 'outputPath'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key || argv[index + 1] === undefined) fail(`invalid argument ${argv[index] ?? '<missing>'}`);
    values[key] = argv[index + 1];
  }
  if (Object.keys(values).length !== names.size) fail('inventory, attestation, and output are required');
  return values;
}

async function main() {
  const sealed = await sealUpdaterReplacementReleaseInventory(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `[seal-updater-replacement-release-inventory] ${sealed.platform} ${sealed.updaterReplacementAttestation.attestationSha256}\n`,
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
