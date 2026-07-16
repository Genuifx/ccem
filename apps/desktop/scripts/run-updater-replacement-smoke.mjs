import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { macReleaseFileFingerprint } from './macos-macho-integrity.mjs';
import { fingerprintMacCefFramework } from './macos-cef-bundle-contract.mjs';
import {
  UPDATER_REPLACEMENT_FLOW,
  UPDATER_REPLACEMENT_PROOF_CLASS,
  UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION,
  createUpdaterReplacementCefFingerprint,
  createUpdaterReplacementContextFingerprint,
  createUpdaterReplacementEvidenceFingerprint,
  hashUpdaterReplacementSmokeJson,
  validateUpdaterReplacementSmokeAttestation,
} from './updater-replacement-smoke-contract.mjs';
import {
  assertUpdaterReplacementSmokeAuthorization,
  createHarnessProcessIdentity,
  createUpdaterReplacementChildEnvironment,
  observeProcessIdentity,
  readAndVerifyStage,
  readRegularJson,
  scanNoFollowTree,
  sha256File,
  spawnObserved,
  updaterReplacementPathsEqual,
  waitForChildExit,
  waitForRegularJson,
  writeHarnessStage,
  writePrivateJsonCreateNew,
} from './updater-replacement-smoke-runner-core.mjs';
import {
  copyAndResignMacosFixture,
  inspectMacosCodeSignature,
  inspectWindowsAuthenticode,
  inspectWindowsTreeSafety,
  installPreviousWindowsFixture,
  protectWindowsEvidenceRoot,
  startWindowsNsisObserver,
  waitForOwnedProcessResidueZero,
} from './updater-replacement-smoke-platform-runner.mjs';
import {
  generateUpdaterReplacementTlsMaterial,
  startUpdaterReplacementHttpsServer,
} from './updater-replacement-smoke-server.mjs';
import {
  loadUpdaterPublicKeyConfig,
  validateUpdaterReplacementPayload,
} from './updater-replacement-smoke-inputs.mjs';
import {
  createWindowsInstalledTreeInventory,
  validateWindowsInstalledTreeInventory,
} from './windows-mode2-production-smoke-contract.mjs';

const NONCE_HEADER_NAME = 'X-CCEM-Updater-Challenge';
const DEFAULT_TIMEOUT_MS = 180_000;
const activeChildren = new Set();
let activeServer = null;
let activeFixtureRoot = null;

function fail(message) {
  throw new Error(`[run-updater-replacement-smoke] ${message}`);
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be an exact SHA-256`);
  }
  return value;
}

function exactGitSha(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) {
    fail(`${label} must be an exact Git SHA`);
  }
  return value;
}

function exactWindowsThumbprint(value) {
  const normalized = typeof value === 'string'
    ? value.replaceAll(/\s/gu, '').toUpperCase()
    : '';
  if (!/^[A-F0-9]{40}$/u.test(normalized)) fail('Windows signer thumbprint is invalid');
  return normalized;
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeBasename(value, label) {
  if (typeof value !== 'string' || path.basename(value) !== value || /[\\/\u0000]/u.test(value)) {
    fail(`${label} must be an exact basename`);
  }
  return value;
}

function assertInside(candidate, root, label) {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} must be strictly inside its current-run root`);
  }
}

function trackChild(child) {
  activeChildren.add(child);
  child.once('exit', () => activeChildren.delete(child));
  return child;
}

async function emergencyCleanup() {
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  activeChildren.clear();
  if (activeServer !== null) {
    await activeServer.close().catch(() => {});
    activeServer = null;
  }
  if (activeFixtureRoot !== null) {
    await fsp.rm(activeFixtureRoot, { recursive: true, force: true }).catch(() => {});
    activeFixtureRoot = null;
  }
}

export function mutateUpdaterSignature(signatureText) {
  const encoded = typeof signatureText === 'string' ? signatureText.trim() : '';
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) fail('updater signature is not canonical base64');
  const minisign = Buffer.from(encoded, 'base64').toString('utf8');
  const lines = minisign.trim().split(/\r?\n/u);
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ')) {
    fail('updater signature is not the expected four-line minisign payload');
  }
  const packet = Buffer.from(lines[1], 'base64');
  if (packet.length !== 74) fail('updater minisign signature packet has the wrong length');
  packet[10] ^= 0x01;
  lines[1] = packet.toString('base64');
  const mutated = Buffer.from(`${lines.join('\n')}\n`, 'utf8').toString('base64');
  return signatureText.endsWith('\n') ? `${mutated}\n` : mutated;
}

function fingerprintDescriptorSha256(value) {
  return sha256Bytes(Buffer.from(value, 'utf8'));
}

function assertWindowsTreeSafe(observation, label) {
  for (const field of [
    'reparsePointPaths', 'adsPaths', 'reservedNamePaths', 'unsupportedEntries',
  ]) {
    if (observation[field].length > 0) fail(`${label} contains unsafe Windows entries in ${field}`);
  }
}

export function currentCefFilesFromInventory(inventory, platform) {
  const resources = inventory?.stableCefResources;
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    fail('immutable release inventory lacks stableCefResources');
  }
  const files = {};
  for (const [relativePath, record] of Object.entries(resources)) {
    if (platform === 'macos') {
      if (record?.type === 'file' && typeof record.fingerprint === 'string') {
        files[relativePath] = fingerprintDescriptorSha256(record.fingerprint);
      } else if (!['directory', 'symlink'].includes(record?.type)) {
        fail(`unsupported macOS immutable CEF inventory entry ${relativePath}`);
      }
    } else {
      files[relativePath] = exactSha256(record, `Windows CEF inventory ${relativePath}`);
    }
  }
  if (Object.keys(files).length === 0) fail('immutable CEF inventory contains no regular files');
  return files;
}

async function actualCefFileDigest(candidate, platform) {
  if (platform === 'macos') {
    return fingerprintDescriptorSha256(await macReleaseFileFingerprint(candidate));
  }
  return sha256File(candidate);
}

function canonicalJsonObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export async function observeCurrentCef({
  root,
  files,
  platform,
  stableInventory,
  fullInstalledTreeExact = false,
  rootNoReparsePoint = true,
}) {
  const metadata = await fsp.lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('current CEF root is not a real directory');
  if (platform === 'macos') {
    const actualStableInventory = await fingerprintMacCefFramework(root);
    if (
      JSON.stringify(canonicalJsonObject(actualStableInventory))
      !== JSON.stringify(canonicalJsonObject(stableInventory))
    ) {
      fail('installed current macOS CEF typed inventory differs from the immutable payload inventory');
    }
  } else {
    const tree = await scanNoFollowTree(root);
    if (tree.linkPaths.length > 0 || tree.unsupportedEntries.length > 0) {
      fail('installed current Windows tree contains a link or unsupported entry');
    }
    if (fullInstalledTreeExact !== true) {
      fail('Windows CEF subset observation requires an exact full installed-tree proof');
    }
  }
  const observed = {};
  const missingPaths = [];
  const linkPaths = [];
  for (const [relativePath, expectedSha256] of Object.entries(files)) {
    const candidate = path.join(root, ...relativePath.split('/'));
    const entry = await fsp.lstat(candidate).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry) {
      missingPaths.push(relativePath);
    } else if (!entry.isFile() || entry.isSymbolicLink()) {
      linkPaths.push(relativePath);
    } else {
      const digest = await actualCefFileDigest(candidate, platform);
      if (digest !== expectedSha256) fail(`installed current CEF digest mismatch: ${relativePath}`);
      observed[relativePath] = digest;
    }
  }
  if (missingPaths.length || linkPaths.length) fail('installed current CEF path set is incomplete or linked');
  const fingerprint = createUpdaterReplacementCefFingerprint(observed, platform);
  return {
    root,
    rootType: 'directory',
    rootNoLink: true,
    rootNoReparsePoint,
    files: fingerprint.files,
    pathCount: fingerprint.pathCount,
    pathSetSha256: fingerprint.pathSetSha256,
    inventorySha256: fingerprint.inventorySha256,
    scanMethod: platform === 'windows'
      ? 'immutable-full-install-tree-plus-cef-subset-with-root-reparse-and-ads-enumeration'
      : 'immutable-cef-inventory-recursive-lstat-no-follow',
    allEntriesEnumerated: true,
    missingPaths: [],
    extraPaths: [],
    linkPaths: [],
    reparsePointPaths: [],
    adsPaths: [],
    reservedNamePaths: [],
    unsupportedEntries: [],
  };
}

export async function observeCurrentWindowsInstalledTree(root, expectedInventory) {
  const expected = validateWindowsInstalledTreeInventory(
    expectedInventory,
    'immutable current Windows installed tree',
  );
  const tree = await scanNoFollowTree(root);
  if (tree.linkPaths.length > 0 || tree.unsupportedEntries.length > 0) {
    fail('installed current Windows tree contains a link or unsupported entry');
  }
  const actual = createWindowsInstalledTreeInventory({
    directories: tree.entries
      .filter((entry) => entry.type === 'directory')
      .map((entry) => entry.relativePath),
    files: tree.entries
      .filter((entry) => entry.type === 'file')
      .map(({ relativePath, size, sha256 }) => ({ relativePath, size, sha256 })),
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('installed current Windows tree differs from the immutable full-tree inventory');
  }
  return { tree, inventory: actual };
}

function processIdentityWithoutObservationFields(value) {
  return {
    pid: value.pid,
    osStartToken: value.osStartToken,
    canonicalImagePath: value.canonicalImagePath,
    imageSha256: value.imageSha256,
    runtimeVersion: value.runtimeVersion,
    embeddedSourceCommit: value.embeddedSourceCommit,
    challengeNonce: value.challengeNonce,
    processIdentitySha256: value.processIdentitySha256,
  };
}

async function waitForNewBoot(sharedRoot, excludedPids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await fsp.readdir(sharedRoot);
    for (const entry of entries.sort()) {
      const match = entry.match(/^boot-(\d+)\.json$/u);
      if (!match || excludedPids.has(Number(match[1]))) continue;
      return readRegularJson(path.join(sharedRoot, entry), 'current app boot record');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  fail('timed out waiting for installed current app boot record');
}

async function observeAndAcknowledgeBoot({ boot, sharedRoot, platform, acknowledge = true }) {
  const observed = await observeProcessIdentity({
    pid: boot.pid,
    boot,
    platform: platform === 'macos' ? 'darwin' : 'win32',
  });
  const identity = processIdentityWithoutObservationFields(observed);
  if (acknowledge) {
    await writePrivateJsonCreateNew(path.join(sharedRoot, `identity-${boot.pid}.json`), identity);
  }
  return { identity, parentPid: observed.parentPid };
}

async function acknowledgeBootIdentity(sharedRoot, identity) {
  await writePrivateJsonCreateNew(path.join(sharedRoot, `identity-${identity.pid}.json`), identity);
}

async function waitUntilPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail(`process ${pid} did not exit before cleanup deadline`);
}

function parseArguments(argv) {
  const values = { timeoutMs: DEFAULT_TIMEOUT_MS };
  const names = new Map([
    ['--payload', 'payloadRoot'],
    ['--previous-artifact', 'previousArtifact'],
    ['--previous-provenance', 'previousProvenance'],
    ['--tauri-config', 'tauriConfig'],
    ['--output', 'outputPath'],
    ['--timeout-ms', 'timeoutMs'],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key || argv[index + 1] === undefined) fail(`invalid argument ${argv[index] ?? '<missing>'}`);
    values[key] = key === 'timeoutMs' ? Number(argv[index + 1]) : argv[index + 1];
  }
  if (!values.payloadRoot || !values.previousArtifact || !values.previousProvenance || !values.tauriConfig || !values.outputPath) {
    fail('payload, previous artifact/provenance, tauri config, and output are required');
  }
  if (!Number.isSafeInteger(values.timeoutMs) || values.timeoutMs < 30_000 || values.timeoutMs > 600_000) {
    fail('timeout must be between 30000 and 600000 milliseconds');
  }
  return values;
}

async function runSmoke(options) {
  const runnerName = assertUpdaterReplacementSmokeAuthorization();
  const platform = runnerName === 'macOS' ? 'macos' : 'windows';
  const windowsSignerThumbprint = platform === 'windows'
    ? exactWindowsThumbprint(process.env.WINDOWS_CERTIFICATE_THUMBPRINT)
    : null;
  const target = process.env.CCEM_RELEASE_TARGET;
  const sourceCommit = exactGitSha(process.env.GITHUB_SHA, 'current source commit');
  const payload = await validateUpdaterReplacementPayload(
    options.payloadRoot,
    target,
    sourceCommit,
  );
  const provenance = await readRegularJson(
    options.previousProvenance,
    'previous-source instrumentation provenance',
  );
  if (
    provenance.schemaVersion !== 1
    || provenance.proofClass !== UPDATER_REPLACEMENT_PROOF_CLASS
    || provenance.currentSourceCommit !== sourceCommit
    || provenance.previousRef !== `v${provenance.previousVersion}`
    || provenance.freshDetachedWorktree !== true
    || provenance.initiallyClean !== true
  ) {
    fail('previous-source instrumentation provenance is not exact');
  }
  const currentConfig = await loadUpdaterPublicKeyConfig(options.tauriConfig);
  const publicKeySha256 = sha256Bytes(currentConfig.publicKey);
  if (provenance.embeddedUpdaterPublicKeySha256 !== publicKeySha256) {
    fail('previous embedded updater key differs; key rotation needs a migration protocol');
  }

  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const challengeNonce = randomBytes(32).toString('hex');
  const runnerTempRoot = path.resolve(process.env.RUNNER_TEMP);
  const fixtureRoot = path.join(
    runnerTempRoot,
    `ccem-updater-replacement-${runId}-${runAttempt}-${challengeNonce}`,
  );
  await fsp.lstat(fixtureRoot).then(
    () => fail('current-run updater fixture root must initially be absent'),
    (error) => { if (error.code !== 'ENOENT') throw error; },
  );
  await fsp.mkdir(fixtureRoot, { mode: 0o700 });
  activeFixtureRoot = fixtureRoot;
  const fixtureAcl = platform === 'windows'
    ? await protectWindowsEvidenceRoot(fixtureRoot)
    : null;
  const outputRelativeToFixture = path.relative(fixtureRoot, path.resolve(options.outputPath));
  if (
    outputRelativeToFixture === ''
    || (!outputRelativeToFixture.startsWith('..') && !path.isAbsolute(outputRelativeToFixture))
  ) {
    fail('attestation output must be outside the disposable replacement fixture');
  }
  const sharedRoot = path.join(fixtureRoot, 'evidence');
  await fsp.mkdir(sharedRoot, { mode: 0o700 });
  const evidenceAcl = platform === 'windows'
    ? await protectWindowsEvidenceRoot(sharedRoot)
    : null;
  const updaterTempRoot = path.join(fixtureRoot, 'updater-temp');
  await fsp.mkdir(updaterTempRoot, { mode: 0o700 });
  const installRoot = platform === 'macos'
    ? path.join(fixtureRoot, 'CCEM Desktop.app')
    : path.join(fixtureRoot, 'app');
  const executableRelativePath = platform === 'macos'
    ? 'Contents/MacOS/ccem-desktop'
    : 'ccem-desktop.exe';
  const executablePath = path.join(installRoot, ...executableRelativePath.split('/'));
  const cefRoot = platform === 'macos'
    ? path.join(installRoot, 'Contents/Frameworks/Chromium Embedded Framework.framework')
    : installRoot;
  const poisonRelativePath = 'old-cef-poison.bin';
  const poisonRoot = cefRoot;
  const poisonPath = path.join(poisonRoot, poisonRelativePath);
  const poisonBytes = randomBytes(64);
  const poisonSha256 = sha256Bytes(poisonBytes);

  let oldCodeSignature;
  let oldExecutableAuthenticode;
  if (platform === 'macos') {
    await copyAndResignMacosFixture({
      sourceBundle: path.resolve(options.previousArtifact),
      destinationBundle: installRoot,
      poisonPath,
      poisonBytes,
      signingIdentity: process.env.APPLE_SIGNING_IDENTITY,
    });
    oldCodeSignature = await inspectMacosCodeSignature({
      bundlePath: installRoot,
      executablePath,
    });
  } else {
    const previousInstallerAuthenticode = await inspectWindowsAuthenticode(
      path.resolve(options.previousArtifact),
    );
    if (
      previousInstallerAuthenticode.publisher !== process.env.CCEM_OFFICIAL_WINDOWS_PUBLISHER
      || previousInstallerAuthenticode.signerThumbprint
        !== windowsSignerThumbprint
    ) {
      fail('previous fixture installer is not signed by the pinned Windows release identity');
    }
    await installPreviousWindowsFixture({
      installerPath: path.resolve(options.previousArtifact),
      installRoot,
      timeoutMs: options.timeoutMs,
    });
    await fsp.writeFile(poisonPath, poisonBytes, { flag: 'wx', mode: 0o600 });
    oldExecutableAuthenticode = await inspectWindowsAuthenticode(executablePath);
  }
  let initialWindowsInstallSafety;
  let updaterTempSafety;
  if (platform === 'windows') {
    initialWindowsInstallSafety = await inspectWindowsTreeSafety(installRoot);
    updaterTempSafety = await inspectWindowsTreeSafety(updaterTempRoot);
    assertWindowsTreeSafe(initialWindowsInstallSafety, 'previous Windows install tree');
    assertWindowsTreeSafe(updaterTempSafety, 'Windows updater temp root');
  }
  const previousExecutableSha256 = await sha256File(executablePath);
  const currentExecutableSha256 = exactSha256(
    payload.inventory.mainExecutable?.sha256,
    'immutable current executable digest',
  );
  if (previousExecutableSha256 === currentExecutableSha256) {
    fail('previous and current executable bytes must differ');
  }
  const installTreeBefore = await scanNoFollowTree(installRoot);

  const signatureText = await fsp.readFile(payload.signaturePath, 'utf8');
  const badSignatureText = mutateUpdaterSignature(signatureText);
  const badSignaturePath = path.join(sharedRoot, `${payload.updater.fileName}.bad.sig`);
  await fsp.writeFile(badSignaturePath, badSignatureText, { flag: 'wx', mode: 0o600 });
  const tls = await generateUpdaterReplacementTlsMaterial(sharedRoot);
  const server = await startUpdaterReplacementHttpsServer({
    tls,
    artifactPath: payload.artifactPath,
    signaturePath: payload.signaturePath,
    badSignaturePath,
    currentVersion: payload.manifest.appVersion,
    challengeNonce,
    nonceHeaderName: NONCE_HEADER_NAME,
  });
  activeServer = server;

  const harnessProcess = await createHarnessProcessIdentity({ sourceCommit, challengeNonce });
  const currentCefFiles = currentCefFilesFromInventory(payload.inventory, platform);
  const commonExpected = {
    proofClass: UPDATER_REPLACEMENT_PROOF_CLASS,
    platform,
    target,
    run: {
      id: runId,
      attempt: runAttempt,
      repository: process.env.GITHUB_REPOSITORY,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
      job: process.env.GITHUB_JOB,
      challengeNonce,
    },
    sourceCommit,
    previous: {
      tag: provenance.previousRef,
      sourceCommit: provenance.previousCommit,
      version: provenance.previousVersion,
      executableSha256: previousExecutableSha256,
      instrumentationPatchSha256: provenance.instrumentationPatchSha256,
      embeddedUpdaterPublicKeySha256: provenance.embeddedUpdaterPublicKeySha256,
    },
    harness: {
      canonicalImagePath: harnessProcess.canonicalImagePath,
      imageSha256: harnessProcess.imageSha256,
      runtimeVersion: harnessProcess.runtimeVersion,
      sourceCommit,
    },
    currentVersion: payload.manifest.appVersion,
    currentExecutableSha256,
    updater: {
      publicKeySha256,
      artifact: { fileName: payload.updater.fileName, sha256: payload.updater.sha256 },
      signature: { fileName: payload.signature.fileName, sha256: payload.signature.sha256 },
      badSignature: {
        fileName: path.basename(badSignaturePath),
        sha256: await sha256File(badSignaturePath),
      },
      transport: server.transportExpectation,
    },
    installRoot,
    poisonSentinel: {
      root: poisonRoot,
      absolutePath: poisonPath,
      relativePath: poisonRelativePath,
      sha256: poisonSha256,
    },
    currentCef: { root: cefRoot, files: currentCefFiles },
  };
  const expected = platform === 'macos' ? {
    ...commonExpected,
    platformProof: {
      bundleIdentifier: currentConfig.bundleIdentifier,
      teamIdentifier: process.env.CCEM_OFFICIAL_APPLE_TEAM_ID,
      designatedRequirementSha256: oldCodeSignature.designatedRequirementSha256,
      runnerTempRoot,
      fixtureRoot,
      oldExecutablePath: executablePath,
      currentExecutablePath: executablePath,
    },
  } : {
    ...commonExpected,
    platformProof: {
      publisher: process.env.CCEM_OFFICIAL_WINDOWS_PUBLISHER,
      signerThumbprint: windowsSignerThumbprint,
      releaseInstallerPath: payload.artifactPath,
      updaterTempRoot,
      nsisExecutableFileName: `${currentConfig.productName}-${payload.manifest.appVersion}-installer.exe`,
      oldExecutablePath: executablePath,
      currentExecutablePath: executablePath,
      currentInstalledTree: payload.inventory.installedTree,
    },
  };
  const contextSha256 = createUpdaterReplacementContextFingerprint(expected);
  const configPath = path.join(sharedRoot, 'smoke-config.json');
  await writePrivateJsonCreateNew(configPath, {
    schemaVersion: 1,
    proofClass: UPDATER_REPLACEMENT_PROOF_CLASS,
    platform,
    target,
    run: { id: runId, attempt: runAttempt, challengeNonce },
    contextSha256,
    sourceCommit,
    previous: {
      sourceCommit: provenance.previousCommit,
      version: provenance.previousVersion,
      executableSha256: previousExecutableSha256,
      embeddedUpdaterPublicKeySha256: provenance.embeddedUpdaterPublicKeySha256,
    },
    currentVersion: payload.manifest.appVersion,
    currentExecutableSha256,
    updater: {
      publicKey: currentConfig.publicKey,
      publicKeySha256,
      artifactSha256: payload.updater.sha256,
      negativeEndpoint: server.endpoints.negative,
      positiveEndpoint: server.endpoints.positive,
      caPemPath: tls.caCertificate,
      nonceHeaderName: NONCE_HEADER_NAME,
    },
    sharedRoot,
  });

  let nsisObserver;
  const childEnvironment = createUpdaterReplacementChildEnvironment(process.env, {
    CCEM_UPDATER_REPLACEMENT_SMOKE_ALLOW: '1',
    ...(platform === 'windows' ? { TEMP: updaterTempRoot, TMP: updaterTempRoot } : {}),
  }, platform === 'macos' ? 'darwin' : 'win32');
  const smokeArguments = ['--ccem-updater-replacement-smoke', configPath];
  const previousChild = trackChild(spawnObserved(executablePath, smokeArguments, {
    environment: childEnvironment,
  }));
  const previousExitPromise = waitForChildExit(previousChild, options.timeoutMs);
  const previousBoot = await waitForRegularJson(
    path.join(sharedRoot, `boot-${previousChild.pid}.json`),
    { label: 'previous app boot record', timeoutMs: options.timeoutMs },
  );
  const previousObserved = await observeAndAcknowledgeBoot({
    boot: previousBoot,
    sharedRoot,
    platform,
    acknowledge: platform !== 'windows',
  });
  const previousProcess = previousObserved.identity;
  if (platform === 'windows') {
    nsisObserver = startWindowsNsisObserver({
      updaterTempRoot,
      nsisFileName: expected.platformProof.nsisExecutableFileName,
      expectedParentPid: previousProcess.pid,
      expectedParentOsStartToken: previousProcess.osStartToken,
      timeoutMs: options.timeoutMs,
    });
    trackChild(nsisObserver.child);
    await nsisObserver.ready;
    await acknowledgeBootIdentity(sharedRoot, previousProcess);
  }

  const stage1 = await readAndVerifyStage(sharedRoot, 1, 'badSignatureRejected');
  const installTreeAfterRejection = await scanNoFollowTree(installRoot);
  if (installTreeAfterRejection.treeSha256 !== installTreeBefore.treeSha256) {
    fail('bad-signature control mutated the install tree');
  }
  await writePrivateJsonCreateNew(path.join(sharedRoot, 'signal-negative-tree-verified.json'), {
    beforeTreeSha256: installTreeBefore.treeSha256,
    afterTreeSha256: installTreeAfterRejection.treeSha256,
  });
  const checkStage = await readAndVerifyStage(sharedRoot, 2, 'check');
  const downloadStage = await readAndVerifyStage(sharedRoot, 3, 'download');
  const installStage = await readAndVerifyStage(sharedRoot, 4, 'installTransition');
  server.assertComplete();

  let nsisObservation;
  let macInstallReturn;
  if (platform === 'windows') {
    nsisObservation = await nsisObserver.observation;
    await nsisObserver.exited;
    if (
      nsisObservation.start.parentPid !== previousProcess.pid
      || nsisObservation.start.parentOsStartToken !== previousProcess.osStartToken
      || !updaterReplacementPathsEqual(
        nsisObservation.start.parentCanonicalImagePath,
        previousProcess.canonicalImagePath,
        'windows',
      )
      || nsisObservation.start.parentImageSha256 !== previousProcess.imageSha256
    ) {
      fail('Windows NSIS process-start lineage differs from the independently observed previous app');
    }
  } else {
    macInstallReturn = await waitForRegularJson(
      path.join(sharedRoot, 'signal-macos-install-returned.json'),
      { label: 'macOS updater install-return signal', timeoutMs: options.timeoutMs },
    );
    if (macInstallReturn.installApiReturned !== true || macInstallReturn.atomicSwapClaimed !== false) {
      fail('macOS instrumented previous app did not attest the exact updater install return boundary');
    }
  }
  const previousExit = await previousExitPromise;
  if (previousExit.code !== 0) fail(`previous app exited ${previousExit.code}`);
  const stage5Receipt = await writeHarnessStage({
    sharedRoot,
    sequence: 5,
    name: 'oldExit',
    identity: harnessProcess,
    contextSha256,
    previousReceipt: installStage.receipt,
    detail: {
      oldPid: previousProcess.pid,
      oldOsStartToken: previousProcess.osStartToken,
      exited: true,
      code: 0,
      observedByHarnessProcessIdentitySha256: harnessProcess.processIdentitySha256,
    },
  });

  let currentChild;
  if (platform === 'macos') {
    currentChild = trackChild(spawnObserved(executablePath, smokeArguments, {
      environment: childEnvironment,
    }));
  }
  const currentBoot = platform === 'macos'
    ? await waitForRegularJson(path.join(sharedRoot, `boot-${currentChild.pid}.json`), {
      label: 'current app boot record', timeoutMs: options.timeoutMs,
    })
    : await waitForNewBoot(sharedRoot, new Set([previousProcess.pid]), options.timeoutMs);
  const currentObserved = await observeAndAcknowledgeBoot({ boot: currentBoot, sharedRoot, platform });
  const currentProcess = currentObserved.identity;
  const currentExitPromise = currentChild
    ? waitForChildExit(currentChild, options.timeoutMs)
    : waitUntilPidGone(currentProcess.pid, options.timeoutMs).then(() => null);
  const stage6 = await readAndVerifyStage(sharedRoot, 6, 'currentStart');

  const poisonAfter = await fsp.lstat(poisonPath).then(
    () => ({ exists: true }),
    (error) => error.code === 'ENOENT' ? ({ exists: false }) : Promise.reject(error),
  );
  if (poisonAfter.exists) fail('old CEF poison sentinel survived replacement');
  let currentWindowsInstallSafety;
  if (platform === 'windows') {
    currentWindowsInstallSafety = await inspectWindowsTreeSafety(installRoot);
    assertWindowsTreeSafe(currentWindowsInstallSafety, 'installed current Windows tree');
  }
  let currentTree;
  let currentInstalledTree;
  if (platform === 'windows') {
    const observation = await observeCurrentWindowsInstalledTree(
      installRoot,
      payload.inventory.installedTree,
    );
    currentTree = observation.tree;
    currentInstalledTree = observation.inventory;
  } else {
    currentTree = await scanNoFollowTree(installRoot);
  }
  const currentCef = await observeCurrentCef({
    root: cefRoot,
    files: currentCefFiles,
    platform,
    stableInventory: payload.inventory.stableCefResources,
    fullInstalledTreeExact: platform === 'windows',
    rootNoReparsePoint: currentWindowsInstallSafety?.rootNoReparsePoint ?? true,
  });
  if (currentTree.treeSha256 === installTreeBefore.treeSha256) {
    fail('positive updater did not replace the install tree');
  }
  let currentCodeSignature;
  let currentExecutableAuthenticode;
  if (platform === 'macos') {
    currentCodeSignature = await inspectMacosCodeSignature({ bundlePath: installRoot, executablePath });
  } else {
    currentExecutableAuthenticode = await inspectWindowsAuthenticode(executablePath);
  }
  await writePrivateJsonCreateNew(path.join(sharedRoot, 'signal-current-installation-verified.json'), {
    installTreeSha256: currentTree.treeSha256,
    cefInventorySha256: currentCef.inventorySha256,
    poisonRemoved: true,
  });
  const stage7 = await readAndVerifyStage(sharedRoot, 7, 'currentFinalized');
  const currentExit = await currentExitPromise;
  if (currentExit !== null && currentExit.code !== 0) fail(`current app exited ${currentExit.code}`);
  await waitUntilPidGone(previousProcess.pid, options.timeoutMs);
  const remainingOwnedProcesses = await waitForOwnedProcessResidueZero({
    platform,
    roots: [installRoot, updaterTempRoot, fixtureRoot],
    challengeNonce,
    seedPids: [
      previousProcess.pid,
      currentProcess.pid,
      ...(platform === 'windows' ? [nsisObservation.start.pid] : []),
    ],
    timeoutMs: options.timeoutMs,
  });

  const observedProcesses = [previousProcess, currentProcess];
  let platformProof;
  if (platform === 'macos') {
    platformProof = {
      kind: 'macos-whole-bundle-replacement',
      runnerTempRoot,
      fixtureRoot,
      fixtureInitiallyAbsent: true,
      fixtureCreatedForCurrentRun: true,
      bundlePath: installRoot,
      bundleIdentifier: currentConfig.bundleIdentifier,
      oldExecutablePath: executablePath,
      currentExecutablePath: executablePath,
      replacementSemantics: 'tauri-updater-install-returned-current-bundle-observed',
      installApiReturned: macInstallReturn.installApiReturned,
      currentBundleInstalledAtExpectedPath: true,
      atomicSwapClaimed: macInstallReturn.atomicSwapClaimed,
      oldCodeSignature,
      currentCodeSignature,
    };
  } else {
    const nsisProcess = {
      pid: nsisObservation.start.pid,
      osStartToken: nsisObservation.start.osStartToken,
      canonicalImagePath: nsisObservation.start.canonicalImagePath,
      imageSha256: nsisObservation.start.imageSha256,
      runtimeVersion: payload.manifest.appVersion,
      embeddedSourceCommit: sourceCommit,
      challengeNonce,
    };
    nsisProcess.processIdentitySha256 = hashUpdaterReplacementSmokeJson(nsisProcess);
    observedProcesses.push(nsisProcess);
    const installerAuthenticode = {
      status: nsisObservation.start.authenticode.status,
      signerThumbprint: nsisObservation.start.authenticode.signerThumbprint,
      publisher: nsisObservation.start.authenticode.publisher,
      timestampThumbprint: nsisObservation.start.authenticode.timestampThumbprint,
      executableSha256: nsisObservation.start.imageSha256,
    };
    platformProof = {
      kind: 'windows-nsis-replacement',
      oldExecutablePath: executablePath,
      currentExecutablePath: executablePath,
      updaterTempRoot,
      updaterTempRootType: updaterTempSafety.rootType,
      updaterTempRootNoLink: true,
      updaterTempRootNoReparsePoint: updaterTempSafety.rootNoReparsePoint,
      nsisProcess,
      nsisInvocation: {
        method: 'os-process-start-event-with-parent-start-token',
        parentPid: nsisObservation.start.parentPid,
        parentOsStartToken: nsisObservation.start.parentOsStartToken,
        parentProcessIdentitySha256: previousProcess.processIdentitySha256,
        harnessWasNotInvoker: nsisObservation.start.parentPid !== harnessProcess.pid,
      },
      nsisExecutableRegularFile: nsisObservation.start.regularFile,
      nsisExecutableNoLink: true,
      nsisExecutableNoReparsePoint: nsisObservation.start.noReparsePoint,
      nsisExit: {
        exited: true,
        code: nsisObservation.exit.code,
        observedByHarnessProcessIdentitySha256: harnessProcess.processIdentitySha256,
        clock: 'system-boot-monotonic-ms',
        bootMonotonicMs: nsisObservation.exit.bootMonotonicMs,
      },
      silent: true,
      rebootRequired: false,
      installerAuthenticode,
      oldExecutableAuthenticode,
      currentExecutableAuthenticode,
      currentInstalledTree,
      fixtureAcl,
      evidenceAcl,
    };
  }
  observedProcesses.sort((left, right) => left.processIdentitySha256.localeCompare(right.processIdentitySha256));
  const attestation = {
    schemaVersion: UPDATER_REPLACEMENT_SMOKE_SCHEMA_VERSION,
    proofClass: UPDATER_REPLACEMENT_PROOF_CLASS,
    platform,
    target,
    contextSha256,
    evidenceSha256: '0'.repeat(64),
    run: { ...expected.run },
    sourceCommit,
    previous: { ...expected.previous },
    currentVersion: payload.manifest.appVersion,
    currentExecutableSha256,
    updater: {
      flow: UPDATER_REPLACEMENT_FLOW,
      publicKeySha256,
      artifact: { ...expected.updater.artifact },
      signature: {
        ...expected.updater.signature,
        verified: true,
        verifiedArtifactSha256: payload.updater.sha256,
      },
      badSignature: { ...expected.updater.badSignature },
      transport: {
        origin: server.origin,
        tlsTrustMode: 'pinned-test-ca-spki',
        caSpkiSha256: tls.caSpkiSha256,
        tlsPeerSpkiSha256: tls.serverSpkiSha256,
        nonceHeader: { name: NONCE_HEADER_NAME, value: challengeNonce },
        redirectPolicy: 'error',
        redirectsFollowed: 0,
        requestLedger: server.requestLedger,
      },
      negativeControl: {
        result: 'signature-rejected',
        processIdentitySha256: previousProcess.processIdentitySha256,
        badSignatureFileName: expected.updater.badSignature.fileName,
        badSignatureSha256: expected.updater.badSignature.sha256,
        noMutationBeforePositiveAttempt: true,
        installTreeBeforeSha256: installTreeBefore.treeSha256,
        installTreeAfterRejectionSha256: installTreeAfterRejection.treeSha256,
        positiveAttemptStartTreeSha256: installTreeAfterRejection.treeSha256,
        completedBootMonotonicMs: stage1.receipt.bootMonotonicMs,
      },
      instrumentation: {
        previousSourceHarness: true,
        runtimeEndpointOverride: true,
        pinnedTestCa: true,
        directArtifactInstall: false,
        directArchiveExtraction: false,
        directInstallerInvocation: false,
        signatureVerificationDisabled: false,
        tlsVerificationDisabled: false,
        bypasses: [],
      },
    },
    installation: {
      root: installRoot,
      previousProcess,
      harnessProcess,
      currentProcess,
    },
    stages: [
      stage1.receipt, checkStage.receipt, downloadStage.receipt, installStage.receipt,
      stage5Receipt, stage6.receipt, stage7.receipt,
    ],
    poisonSentinel: {
      root: poisonRoot,
      rootType: 'directory',
      rootNoLink: true,
      rootNoReparsePoint: initialWindowsInstallSafety?.rootNoReparsePoint ?? true,
      absolutePath: poisonPath,
      relativePath: poisonRelativePath,
      before: {
        exists: true,
        type: 'file',
        regularFile: true,
        noLink: true,
        noReparsePoint: true,
        sha256: poisonSha256,
      },
      after: { exists: false },
    },
    currentCef,
    platformProof,
    cleanup: {
      scope: 'replaced-installation-process-tree-and-descendants',
      method: 'os-process-census-by-pid-start-token-image-and-challenge',
      challengeNonce,
      observedProcesses,
      remainingOwnedProcesses,
      residueCount: remainingOwnedProcesses.length,
    },
  };
  attestation.evidenceSha256 = createUpdaterReplacementEvidenceFingerprint(attestation);
  const stage8 = await writeHarnessStage({
    sharedRoot,
    sequence: 8,
    name: 'evidenceSealed',
    identity: harnessProcess,
    contextSha256,
    previousReceipt: stage7.receipt,
    detail: { evidenceSha256: attestation.evidenceSha256 },
  });
  attestation.stages.push(stage8);
  const summary = validateUpdaterReplacementSmokeAttestation(attestation, expected);
  await writePrivateJsonCreateNew(options.outputPath, { expected, attestation, summary });
  await server.close();
  activeServer = null;
  await fsp.rm(fixtureRoot, { recursive: true, force: true });
  activeFixtureRoot = null;
  return summary;
}

async function main() {
  const summary = await runSmoke(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `[run-updater-replacement-smoke] ${summary.target} ${summary.attestationSha256}\n`,
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(async (error) => {
    await emergencyCleanup();
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
