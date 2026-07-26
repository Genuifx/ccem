import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  validateInventoryFileBindings,
  validateInventorySet,
} from './verify-mode2-release-inventory.mjs';
import { readJsonWithSha256 } from './verify-mode2-release-inventory-shared.mjs';

export const MODE2_SIGNED_READINESS_EVIDENCE_SCHEMA_VERSION = 2;
export const MODE2_SIGNED_PRODUCER_JOB = 'build-desktop';
export const MODE2_SIGNED_READINESS_TARGETS = Object.freeze([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
]);

const CLI_OPTIONS = new Map([
  ['--evidence-root', 'evidenceRoot'],
  ['--version', 'version'],
  ['--source-commit', 'sourceCommit'],
  ['--run-id', 'runId'],
  ['--run-attempt', 'runAttempt'],
  ['--repository', 'repository'],
  ['--workflow-ref', 'workflowRef'],
  ['--producer-workflow-ref', 'producerWorkflowRef'],
  ['--output', 'output'],
]);

function fail(message) {
  throw new Error(`[mode2-signed-readiness-evidence] ${message}`);
}

function exactText(value, label, maximumLength = 512) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
    || value.trim() !== value
    || value.includes('\0')
  ) {
    fail(`${label} must be exact non-empty text`);
  }
  return value;
}

function exactRunNumber(value, label) {
  const exact = exactText(value, label, 20);
  if (!/^[1-9][0-9]{0,19}$/u.test(exact)) {
    fail(`${label} must be a positive canonical run number`);
  }
  return exact;
}

function exactSourceCommit(value) {
  const exact = exactText(value, 'source commit', 40);
  if (!/^[a-f0-9]{40}$/u.test(exact)) {
    fail('source commit must be an exact lowercase 40-character Git SHA');
  }
  return exact;
}

function exactVersion(value) {
  const exact = exactText(value, 'version', 64);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(exact)) {
    fail('version is invalid');
  }
  return exact;
}

function exactRepository(value) {
  const exact = exactText(value, 'repository', 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(exact)) {
    fail('repository must be an exact owner/name');
  }
  return exact;
}

function exactWorkflowRef(value, repository) {
  const exact = exactText(value, 'workflow ref');
  if (
    !exact.startsWith(`${repository}/.github/workflows/`)
    || !/\.ya?ml@refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(exact)
  ) {
    fail('workflow ref must be an exact repository-bound workflow ref');
  }
  return exact;
}

function exactProducerWorkflowRef(value, repository, callerWorkflowRef) {
  const exact = exactWorkflowRef(value, repository);
  const prefix = `${repository}/.github/workflows/mode2-signed-producer.yml@`;
  const callerRef = callerWorkflowRef.slice(callerWorkflowRef.lastIndexOf('@') + 1);
  if (!exact.startsWith(prefix) || !exact.endsWith(`@${callerRef}`)) {
    fail('producer workflow ref must identify the same-ref Mode 2 signed producer');
  }
  return exact;
}

function sameNames(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

async function requireDirectory(candidate, label) {
  const metadata = await fsp.lstat(candidate).catch((error) => {
    fail(`${label} is missing: ${error.message}`);
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink directory`);
  }
}

async function requireExactEntries(directory, expectedNames, label, expectedType) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  const names = entries.map(({ name }) => name);
  if (names.length !== expectedNames.length || !sameNames(names, expectedNames)) {
    fail(`${label} must contain exactly: ${expectedNames.join(', ')}`);
  }
  for (const name of expectedNames) {
    const candidate = path.join(directory, name);
    const metadata = await fsp.lstat(candidate).catch((error) => {
      fail(`${label} entry ${name} is missing: ${error.message}`);
    });
    const matchesType = expectedType === 'directory'
      ? metadata.isDirectory()
      : metadata.isFile();
    if (!matchesType || metadata.isSymbolicLink()) {
      fail(`${label} entry ${name} must be a regular non-symlink ${expectedType}`);
    }
  }
}

function assertBound(actual, expected, label) {
  if (actual !== expected) fail(`${label} does not bind the current signed-readiness run`);
}

function validateUpdaterRunBinding(inventory, expected) {
  const attestation = inventory.updaterReplacementAttestation;
  assertBound(attestation?.runId, expected.runId, `${expected.target} updater runId`);
  assertBound(attestation?.runAttempt, expected.runAttempt, `${expected.target} updater runAttempt`);
  assertBound(
    attestation?.sourceCommit,
    expected.sourceCommit,
    `${expected.target} updater sourceCommit`,
  );
  assertBound(attestation?.target, expected.target, `${expected.target} updater target`);
  assertBound(attestation?.repository, expected.repository, `${expected.target} updater repository`);
  assertBound(attestation?.workflowRef, expected.workflowRef, `${expected.target} updater workflowRef`);
  assertBound(
    attestation?.producerWorkflowRef,
    expected.producerWorkflowRef,
    `${expected.target} updater producerWorkflowRef`,
  );
  assertBound(attestation?.job, expected.job, `${expected.target} updater job`);
}

function validateRuntimeRunBinding(inventory, expected) {
  const macos = expected.target.endsWith('apple-darwin');
  const field = macos ? 'macosSafeStorageRuntimeAttestation' : 'windowsRuntimeAttestation';
  const label = macos ? 'Safe Storage runtime' : 'Windows Mode 2 runtime';
  const attestation = inventory[field];
  assertBound(attestation?.runId, expected.runId, `${expected.target} ${label} runId`);
  assertBound(attestation?.runAttempt, expected.runAttempt, `${expected.target} ${label} runAttempt`);
  assertBound(
    attestation?.sourceCommit,
    expected.sourceCommit,
    `${expected.target} ${label} sourceCommit`,
  );
  assertBound(
    attestation?.repository,
    expected.repository,
    `${expected.target} ${label} repository`,
  );
  assertBound(
    attestation?.workflowRef,
    expected.workflowRef,
    `${expected.target} ${label} workflowRef`,
  );
  assertBound(
    attestation?.producerWorkflowRef,
    expected.producerWorkflowRef,
    `${expected.target} ${label} producerWorkflowRef`,
  );
  assertBound(attestation?.job, expected.job, `${expected.target} ${label} job`);
  assertBound(attestation?.platform, expected.target, `${expected.target} ${label} platform`);
  if (macos) {
    for (const field of [
      'productionBehaviorVerified',
      'effectFenceVerified',
      'profileIsolationVerified',
      'screenshotArtifactsVerified',
    ]) {
      assertBound(attestation?.[field], true, `${expected.target} ${label} ${field}`);
    }
    assertBound(
      attestation?.semanticLaunchCount,
      4,
      `${expected.target} ${label} semanticLaunchCount`,
    );
  } else {
    for (const field of [
      'semanticBehaviorVerified',
      'effectFenceVerified',
      'profileIsolationVerified',
      'screenshotArtifactVerified',
    ]) {
      assertBound(attestation?.[field], true, `${expected.target} ${label} ${field}`);
    }
  }
  return {
    kind: macos ? 'macos-mode2-production-runtime' : 'windows-mode2-runtime',
    attestationSha256: attestation.attestationSha256,
  };
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function writeJsonAtomically(candidate, value) {
  const output = path.resolve(exactText(candidate, 'output path', 4096));
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await fsp.rename(temporary, output);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function verifyMode2SignedReadinessEvidence({
  evidenceRoot,
  version,
  sourceCommit,
  runId,
  runAttempt,
  repository,
  workflowRef,
  producerWorkflowRef,
  output,
}) {
  const root = path.resolve(exactText(evidenceRoot, 'evidence root', 4096));
  const exactVersionValue = exactVersion(version);
  const exactSourceCommitValue = exactSourceCommit(sourceCommit);
  const exactRunId = exactRunNumber(runId, 'run id');
  const exactRunAttempt = exactRunNumber(runAttempt, 'run attempt');
  const exactRepositoryValue = exactRepository(repository);
  const exactWorkflowRefValue = exactWorkflowRef(workflowRef, exactRepositoryValue);
  const exactProducerWorkflowRefValue = exactProducerWorkflowRef(
    producerWorkflowRef,
    exactRepositoryValue,
    exactWorkflowRefValue,
  );
  const outputPath = path.resolve(exactText(output, 'output path', 4096));
  if (pathIsInside(root, outputPath)) {
    fail('output must be outside the immutable downloaded evidence root');
  }

  await requireDirectory(root, 'evidence root');
  const artifactNames = MODE2_SIGNED_READINESS_TARGETS.map(
    (target) => `mode2-signed-evidence-${exactRunId}-${exactRunAttempt}-${target}`,
  );
  await requireExactEntries(root, artifactNames, 'downloaded evidence root', 'directory');

  const inventories = [];
  const inventoryFiles = [];
  const records = [];
  for (const target of MODE2_SIGNED_READINESS_TARGETS) {
    const artifactName = `mode2-signed-evidence-${exactRunId}-${exactRunAttempt}-${target}`;
    const artifactRoot = path.join(root, artifactName);
    const inventoryFileName = `mode2-release-inventory-${target}.json`;
    await requireExactEntries(artifactRoot, [inventoryFileName], `${target} evidence`, 'file');
    const inventoryFile = path.join(artifactRoot, inventoryFileName);
    const { value: inventory, sha256: inventorySha256 } = await readJsonWithSha256(
      inventoryFile,
      `${target} signed-readiness inventory`,
    );
    if (inventory?.platform !== target) {
      fail(`${target} evidence contains inventory for ${inventory?.platform ?? '<missing>'}`);
    }
    inventories.push(inventory);
    inventoryFiles.push(inventoryFile);
    records.push({ artifactName, inventoryFileName, inventorySha256, inventory, target });
  }

  validateInventoryFileBindings(inventoryFiles, inventories);
  const boundRecords = records.map((record) => {
    const expected = {
      target: record.target,
      runId: exactRunId,
      runAttempt: exactRunAttempt,
      sourceCommit: exactSourceCommitValue,
      repository: exactRepositoryValue,
      workflowRef: exactWorkflowRefValue,
      producerWorkflowRef: exactProducerWorkflowRefValue,
      job: MODE2_SIGNED_PRODUCER_JOB,
    };
    validateUpdaterRunBinding(record.inventory, expected);
    const runtimeAttestation = validateRuntimeRunBinding(record.inventory, expected);
    return { ...record, runtimeAttestation };
  });
  const aggregateInventory = validateInventorySet(
    inventories,
    exactVersionValue,
    exactSourceCommitValue,
  );

  const targets = boundRecords.map((record) => {
    return {
      target: record.target,
      artifactName: record.artifactName,
      inventoryFileName: record.inventoryFileName,
      inventorySha256: record.inventorySha256,
      updaterReplacementAttestationSha256:
        record.inventory.updaterReplacementAttestation.attestationSha256,
      runtimeAttestation: record.runtimeAttestation,
    };
  });

  const summary = {
    schemaVersion: MODE2_SIGNED_READINESS_EVIDENCE_SCHEMA_VERSION,
    proofClass: 'mode2-signed-readiness',
    status: 'verified',
    appVersion: exactVersionValue,
    sourceCommit: exactSourceCommitValue,
    runId: exactRunId,
    runAttempt: exactRunAttempt,
    repository: exactRepositoryValue,
    workflowRef: exactWorkflowRefValue,
    producerWorkflowRef: exactProducerWorkflowRefValue,
    job: MODE2_SIGNED_PRODUCER_JOB,
    inventory: aggregateInventory,
    targets,
  };
  await writeJsonAtomically(outputPath, summary);
  return summary;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const key = CLI_OPTIONS.get(argument);
    if (!key || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      fail(`invalid argument: ${argument ?? '<missing>'}`);
    }
    if (Object.hasOwn(values, key)) fail(`duplicate argument: ${argument}`);
    values[key] = argv[index + 1];
  }
  const missing = [...CLI_OPTIONS.values()].filter((key) => !Object.hasOwn(values, key));
  if (missing.length > 0) fail(`missing required arguments: ${missing.join(', ')}`);
  return values;
}

export async function run(argv = process.argv.slice(2)) {
  return verifyMode2SignedReadinessEvidence(parseArguments(argv));
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().then((summary) => {
    process.stdout.write(
      `[mode2-signed-readiness-evidence] ${summary.targets.length} signed targets verified\n`,
    );
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
