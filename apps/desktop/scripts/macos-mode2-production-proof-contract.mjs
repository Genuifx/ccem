import path from 'node:path';

export const MACOS_MODE2_PRODUCTION_PROOF_SCHEMA_VERSION = 2;

const MANAGER = 'LoginBrowserSurfaceManager/SessionManager';
const MAX_SCREENSHOT_BYTES = 24 * 1024 * 1024;

function fail(message) {
  throw new Error(`[macos-mode2-production-proof-contract] ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields differ: ${actual.join(', ')}`);
  }
  return value;
}

function normalizedAbsolute(value, label) {
  if (
    typeof value !== 'string'
    || !path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.includes('\0')
  ) {
    fail(`${label} must be a normalized absolute path`);
  }
  return value;
}

function pathInside(root, candidate) {
  const relative = path.posix.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith('../')
    && !path.posix.isAbsolute(relative);
}

function exactProfileId(value, label) {
  if (
    typeof value !== 'string'
    || value.length < 8
    || value.length > 128
    || !/^[A-Za-z0-9._-]+$/u.test(value)
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function requireTrueFields(value, fields, label) {
  for (const field of fields) {
    if (value[field] !== true) fail(`${label} did not prove ${field}`);
  }
}

function validateScreenshot(proof, scenarioRoot) {
  exactKeys(proof, [
    'canonicalPath', 'byteSize', 'sha256', 'pngMagicVerified',
    'pngStructureVerified', 'pngDecodedVerified', 'byteSizeVerified',
    'sha256Verified', 'appOwnedCanonicalPathVerified',
  ], 'production screenshot proof');
  const canonicalPath = normalizedAbsolute(proof.canonicalPath, 'screenshot canonical path');
  if (
    !pathInside(scenarioRoot, canonicalPath)
    || path.posix.extname(canonicalPath) !== '.png'
    || !Number.isSafeInteger(proof.byteSize)
    || proof.byteSize <= 8
    || proof.byteSize > MAX_SCREENSHOT_BYTES
    || !/^[a-f0-9]{64}$/u.test(proof.sha256 ?? '')
  ) {
    fail('screenshot proof does not bind a bounded app-owned PNG artifact');
  }
  requireTrueFields(proof, [
    'pngMagicVerified', 'pngStructureVerified', 'pngDecodedVerified',
    'byteSizeVerified', 'sha256Verified',
    'appOwnedCanonicalPathVerified',
  ], 'production screenshot proof');
}

function validateSemantic(proof, scenarioRoot) {
  exactKeys(proof, [
    'navigatedViaCapability', 'axSnapshotViaCapability', 'clickViaElementRef',
    'typeViaElementRef', 'screenshot', 'storageCommitViaElementRef',
    'activeEffectEntered', 'activeEffectCancelled', 'occlusionAckUnderOneSecond',
    'occlusionAckMillis', 'postPauseNoLateWrite',
  ], 'production semantic proof');
  requireTrueFields(proof, [
    'navigatedViaCapability', 'axSnapshotViaCapability', 'clickViaElementRef',
    'typeViaElementRef', 'storageCommitViaElementRef', 'activeEffectEntered',
    'activeEffectCancelled', 'occlusionAckUnderOneSecond', 'postPauseNoLateWrite',
  ], 'production semantic proof');
  if (
    !Number.isSafeInteger(proof.occlusionAckMillis)
    || proof.occlusionAckMillis < 0
    || proof.occlusionAckMillis >= 1_000
  ) {
    fail('trusted occlusion acknowledgement did not complete under one second');
  }
  validateScreenshot(proof.screenshot, scenarioRoot);
}

function validateIsolation(proof) {
  exactKeys(proof, [
    'distinctWorkspaceProfiles', 'primaryCookiePersisted',
    'primaryLocalStoragePersisted', 'secondaryProfileInitiallyEmpty',
    'secondaryCookieIsolated', 'secondaryLocalStorageIsolated',
    'primaryUnchangedAfterSecondary', 'secondaryUnchangedAfterPrimary',
  ], 'production profile isolation proof');
  requireTrueFields(proof, Object.keys(proof), 'production profile isolation proof');
}

function validateCleanup(proof) {
  exactKeys(proof, [
    'activeSurfaceCount', 'activeSessionCount', 'ownerRecordCount',
    'persistedProfileCount', 'workspaceCount', 'profileLocksAvailable',
  ], 'production cleanup proof');
  if (
    proof.activeSurfaceCount !== 0
    || proof.activeSessionCount !== 0
    || proof.ownerRecordCount !== 0
    || proof.persistedProfileCount !== 2
    || proof.workspaceCount !== 2
    || proof.profileLocksAvailable !== true
  ) {
    fail('production managers, owner records, or profile locks were not cleaned up');
  }
}

export function expectedMacosProductionPaths(scenarioPlan, phase) {
  const sessionRoot = path.posix.join(scenarioPlan.root, 'data', 'login');
  return {
    sessionRoot,
    workspaceRoot: path.posix.join(scenarioPlan.root, `workspace-${phase}`),
    secondaryWorkspaceRoot: path.posix.join(
      scenarioPlan.root,
      `workspace-${phase}-secondary`,
    ),
  };
}

export function validateMacosMode2ProductionProof(proof, scenarioPlan, phase) {
  exactKeys(proof, [
    'schemaVersion', 'verified', 'manager', 'sessionRoot', 'workspaceRoot',
    'secondaryWorkspaceRoot', 'primaryProfileId', 'reopenedPrimaryProfileId',
    'finalPrimaryProfileId', 'secondaryProfileId', 'finalSecondaryProfileId',
    'semantic', 'profileIsolation', 'cleanup',
  ], 'production path proof');
  const expected = expectedMacosProductionPaths(scenarioPlan, phase);
  const primary = exactProfileId(proof.primaryProfileId, 'primary profile id');
  const secondary = exactProfileId(proof.secondaryProfileId, 'secondary profile id');
  if (
    proof.schemaVersion !== MACOS_MODE2_PRODUCTION_PROOF_SCHEMA_VERSION
    || proof.verified !== true
    || proof.manager !== MANAGER
    || proof.sessionRoot !== expected.sessionRoot
    || proof.workspaceRoot !== expected.workspaceRoot
    || proof.secondaryWorkspaceRoot !== expected.secondaryWorkspaceRoot
    || primary === secondary
    || proof.reopenedPrimaryProfileId !== primary
    || proof.finalPrimaryProfileId !== primary
    || proof.finalSecondaryProfileId !== secondary
  ) {
    fail('production path proof does not bind this exact phase and two-profile manager run');
  }
  validateSemantic(proof.semantic, scenarioPlan.root);
  validateIsolation(proof.profileIsolation);
  validateCleanup(proof.cleanup);
  return proof;
}
