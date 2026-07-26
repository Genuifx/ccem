import fsp from 'node:fs/promises';
import path from 'node:path';

import { CEF_FULL_VERSION } from './stage-cef-macos.mjs';
import { normalizeThumbprint } from './validate-release-signing-config.mjs';
import {
  WINDOWS_MAIN_EXECUTABLE_NAME,
  WINDOWS_RUNTIME_FILES,
  WINDOWS_SANDBOX_CLIENT_NAME,
  WINDOWS_SANDBOX_ENTRY_POINT,
  WINDOWS_SANDBOX_MARKER_NAME,
  WINDOWS_SIGNED_RESOURCE_FILES,
  WINDOWS_SOURCE_BOOTSTRAP_NAME,
  WINDOWS_STAGE_MANIFEST,
  WINDOWS_CEF_SOURCE_PIN,
  validateWindowsSandboxMarker,
} from './stage-cef-windows.mjs';
import {
  CEF_LEGAL_DIRECTORY,
  CEF_LEGAL_FILES,
  cefArchiveSpec,
  inspectStagedCefLegalFiles,
} from './cef-runtime-contract.mjs';
import { canonicalPeFileSha256 } from './windows-pe-contract.mjs';
import {
  RELEASE_INVENTORY_SCHEMA_VERSION,
  fail,
  fingerprintFiles,
  pathType,
  readJson,
  requireDirectory,
  requireFile,
  sameJson,
  sha256,
} from './verify-mode2-release-inventory-shared.mjs';

export async function inspectWindowsLocaleInventory(root) {
  const localesRoot = path.join(root, 'locales');
  await requireDirectory(localesRoot, 'CEF locales');
  const localeDirectoryEntries = await fsp.readdir(localesRoot, { withFileTypes: true });
  const invalidLocaleEntries = localeDirectoryEntries.filter(
    (entry) => !entry.isFile() || !/^[A-Za-z0-9-]+\.pak$/.test(entry.name),
  );
  if (localeDirectoryEntries.length === 0 || invalidLocaleEntries.length > 0) {
    const invalidNames = invalidLocaleEntries.map(({ name }) => name).sort().join(', ');
    fail(`CEF locale inventory must contain only regular locale .pak files: ${invalidNames}`);
  }
  const localeEntries = localeDirectoryEntries.map(({ name }) => name).sort();
  if (!localeEntries.includes('en-US.pak')) {
    fail('CEF locale inventory must include en-US.pak');
  }
  return localeEntries;
}

export async function inspectWindowsTree({
  root,
  version,
  sourceCommit,
  requireApp = true,
  requireManifest = false,
  expectedCefCreditsSha256,
  expectedSourcePin = WINDOWS_CEF_SOURCE_PIN,
}) {
  await requireDirectory(root, 'Windows release tree');
  const app = path.join(root, WINDOWS_MAIN_EXECUTABLE_NAME);
  const sandboxClient = path.join(root, WINDOWS_SANDBOX_CLIENT_NAME);
  if (requireApp) await requireFile(app, 'CCEM executable');
  await requireFile(sandboxClient, 'CEF sandbox client DLL');
  for (const legacyHelper of ['ccem-cef-helper.exe', 'ccem-cef-helper.dll']) {
    if (await pathType(path.join(root, legacyHelper)) !== 'missing') {
      fail(`Windows release tree must not contain legacy helper artifact ${legacyHelper}`);
    }
  }
  const bootstrapSource = path.join(root, WINDOWS_SOURCE_BOOTSTRAP_NAME);
  if (!requireApp) await requireFile(bootstrapSource, 'official CEF bootstrap');
  const bootstrapCanonicalSha256 = requireApp
    ? await canonicalPeFileSha256(app)
    : await canonicalPeFileSha256(bootstrapSource);
  const clientCanonicalSha256 = await canonicalPeFileSha256(sandboxClient);
  const manifest = requireManifest
    ? await readJson(path.join(root, WINDOWS_STAGE_MANIFEST), 'Windows CEF stage manifest')
    : null;
  const legal = await inspectStagedCefLegalFiles(
    root,
    'x86_64-pc-windows-msvc',
    manifest?.legal,
    expectedCefCreditsSha256 ? { expectedCreditsSha256: expectedCefCreditsSha256 } : {},
  );
  const sandbox = validateWindowsSandboxMarker(
    await readJson(
      path.join(root, WINDOWS_SANDBOX_MARKER_NAME),
      'Windows CEF sandbox artifact marker',
    ),
    {
      expectedGitSha: sourceCommit,
      expectedSourcePin,
      bootstrapCanonicalSha256,
      clientCanonicalSha256,
    },
  );
  const hashes = await fingerprintFiles(root, WINDOWS_RUNTIME_FILES);
  hashes[WINDOWS_SANDBOX_CLIENT_NAME] = await sha256(sandboxClient);
  hashes[WINDOWS_SANDBOX_MARKER_NAME] = await sha256(
    path.join(root, WINDOWS_SANDBOX_MARKER_NAME),
  );
  const localeEntries = await inspectWindowsLocaleInventory(root);
  if (localeEntries.length !== expectedSourcePin.runtimeLocaleCount) {
    fail('CEF locale inventory count does not match the verified official source');
  }
  Object.assign(
    hashes,
    await fingerprintFiles(root, localeEntries.map((entry) => `locales/${entry}`)),
  );
  Object.assign(
    hashes,
    await fingerprintFiles(
      root,
      CEF_LEGAL_FILES.map((entry) => `${CEF_LEGAL_DIRECTORY}/${entry}`),
    ),
  );
  if (requireManifest) {
    const archiveSpec = cefArchiveSpec('x86_64-pc-windows-msvc');
    if (
      manifest.schemaVersion !== 4
      || manifest.target !== 'x86_64-pc-windows-msvc'
      || manifest.profile !== 'release'
      || manifest.sourceCommit !== sourceCommit
      || manifest.cefRuntimeVersion !== CEF_FULL_VERSION
      || !sameJson(manifest.archive, {
        type: archiveSpec.type,
        name: archiveSpec.name,
        sha1: archiveSpec.sha1,
      })
      || !sameJson(manifest.sourcePin, expectedSourcePin)
      || !sameJson(manifest.legal, legal)
      || !sameJson(manifest.sandbox, sandbox)
      || manifest.provenance?.source !== 'runner-temp-current-run'
      || !/^\d+$/u.test(manifest.provenance?.runId ?? '')
      || !/^\d+$/u.test(manifest.provenance?.runAttempt ?? '')
      || manifest.signer?.timestamped !== true
      || !sameJson(manifest.signer?.signedFiles, WINDOWS_SIGNED_RESOURCE_FILES)
      || !sameJson(manifest.files, Object.keys(hashes))
      || !sameJson(manifest.hashes, hashes)
    ) {
      fail('Windows CEF stage manifest does not cover the exact signed runtime inventory');
    }
  }
  return {
    schemaVersion: RELEASE_INVENTORY_SCHEMA_VERSION,
    platform: 'x86_64-pc-windows-msvc',
    appVersion: version,
    sourceCommit,
    mode2Included: true,
    cefRuntimeVersion: CEF_FULL_VERSION,
    cefSourcePin: expectedSourcePin,
    sandboxEnabled: true,
    sameExecutableSubprocesses: true,
    sandboxBootstrapExecutable: WINDOWS_MAIN_EXECUTABLE_NAME,
    sandboxClientLibrary: WINDOWS_SANDBOX_CLIENT_NAME,
    sandboxEntryPoint: WINDOWS_SANDBOX_ENTRY_POINT,
    bootstrapCanonicalSha256,
    clientCanonicalSha256,
    helperBundles: [],
    stableCefResources: hashes,
    cefLegal: legal,
  };
}

function windowsPathIdentity(candidate, label) {
  if (
    typeof candidate !== 'string'
    || candidate.length === 0
    || candidate.includes('\0')
    || !path.win32.isAbsolute(candidate)
  ) {
    fail(`${label} must be an absolute Windows path`);
  }
  return path.win32.normalize(candidate).toLowerCase();
}

export function createWindowsAuthenticodeCandidatePaths({
  runtimeRoot,
  mainExecutablePath,
  installerPath,
}) {
  const candidates = [
    mainExecutablePath,
    ...WINDOWS_SIGNED_RESOURCE_FILES.map((name) => path.join(runtimeRoot, name)),
  ];
  if (installerPath) candidates.push(installerPath);
  return candidates;
}

export function validateWindowsAuthenticodeResults(results, signing, expectedPaths, label) {
  if (!Array.isArray(results) || !Array.isArray(expectedPaths) || expectedPaths.length === 0) {
    fail(`Authenticode inspection inputs are invalid for ${label}`);
  }
  const expectedByPath = new Map();
  for (const expectedPath of expectedPaths) {
    const identity = windowsPathIdentity(expectedPath, `expected ${label} path`);
    if (expectedByPath.has(identity)) {
      fail(`Authenticode expectation contains a duplicate path: ${expectedPath}`);
    }
    expectedByPath.set(identity, expectedPath);
  }
  if (results.length !== expectedByPath.size) {
    fail(`Authenticode inspection did not cover every ${label}`);
  }

  const observedPaths = new Set();
  for (const result of results) {
    const identity = windowsPathIdentity(result?.Path, `observed ${label} path`);
    if (!expectedByPath.has(identity)) {
      fail(`Authenticode inspection returned an unexpected ${label} path: ${result.Path}`);
    }
    if (observedPaths.has(identity)) {
      fail(`Authenticode inspection returned a duplicate ${label} path: ${result.Path}`);
    }
    observedPaths.add(identity);
    if (result.Status !== 'Valid') fail(`invalid Authenticode signature: ${result.Path}`);
    if (normalizeThumbprint(result.SignerThumbprint ?? '') !== signing.thumbprint) {
      fail(`Authenticode thumbprint mismatch: ${result.Path}`);
    }
    if (result.SignerSubject !== signing.publisher) {
      fail(`Authenticode publisher mismatch: ${result.Path}`);
    }
    const timestampThumbprint = typeof result.TimestampThumbprint === 'string'
      ? result.TimestampThumbprint.replaceAll(/\s/g, '').toUpperCase()
      : '';
    if (!/^[A-F0-9]{40}$/u.test(timestampThumbprint)) {
      fail(`Authenticode timestamp certificate thumbprint is invalid: ${result.Path}`);
    }
  }
  for (const [identity, expectedPath] of expectedByPath) {
    if (!observedPaths.has(identity)) {
      fail(`Authenticode inspection omitted ${label} path: ${expectedPath}`);
    }
  }
}
