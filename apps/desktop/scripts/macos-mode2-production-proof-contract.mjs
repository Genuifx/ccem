import path from 'node:path';

export const MACOS_MODE2_PRODUCTION_PROOF_SCHEMA_VERSION = 3;

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

function exactSessionId(value, label) {
  if (!/^login-session-[a-f0-9]{32}$/u.test(value ?? '')) {
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

function validateProfileStorage(proof) {
  exactKeys(proof, [
    'defaultProfileSharedAcrossWorkspaces', 'defaultCookieShared',
    'defaultLocalStorageShared', 'defaultCookiePersisted',
    'defaultLocalStoragePersisted', 'explicitProfileIsolated',
    'explicitProfileInitiallyEmpty', 'explicitCookieIsolated',
    'explicitLocalStorageIsolated', 'explicitCookiePersisted',
    'explicitLocalStoragePersisted', 'defaultUnchangedAfterExplicit',
  ], 'production profile storage proof');
  requireTrueFields(proof, Object.keys(proof), 'production profile storage proof');
}

function validateCleanup(proof, phase) {
  exactKeys(proof, [
    'activeSurfaceCount', 'activeSessionCount', 'ownerRecordCount',
    'persistedProfileCount', 'workspaceCount', 'profileLocksAvailable',
  ], 'production cleanup proof');
  if (
    proof.activeSurfaceCount !== 0
    || proof.activeSessionCount !== 0
    || proof.ownerRecordCount !== 0
    || proof.persistedProfileCount !== (phase === 'prime' ? 2 : 3)
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
    'secondaryWorkspaceRoot', 'defaultProfileId', 'defaultSessionId',
    'crossWorkspaceDefaultProfileId', 'crossWorkspaceDefaultSessionId',
    'explicitProfileId', 'explicitSessionId', 'reopenedExplicitProfileId',
    'reopenedExplicitSessionId', 'finalDefaultProfileId', 'finalDefaultSessionId',
    'semantic', 'profileStorage', 'cleanup',
  ], 'production path proof');
  const expected = expectedMacosProductionPaths(scenarioPlan, phase);
  const defaultProfile = exactProfileId(proof.defaultProfileId, 'Default profile id');
  const explicitProfile = exactProfileId(proof.explicitProfileId, 'Explicit New profile id');
  const defaultSession = exactSessionId(proof.defaultSessionId, 'Default workspace A session id');
  const crossWorkspaceDefaultSession = exactSessionId(
    proof.crossWorkspaceDefaultSessionId,
    'Default workspace B session id',
  );
  const explicitSession = exactSessionId(proof.explicitSessionId, 'Explicit New session id');
  const reopenedExplicitSession = exactSessionId(
    proof.reopenedExplicitSessionId,
    'reopened Explicit New session id',
  );
  const finalDefaultSession = exactSessionId(
    proof.finalDefaultSessionId,
    'final Default session id',
  );
  if (
    proof.schemaVersion !== MACOS_MODE2_PRODUCTION_PROOF_SCHEMA_VERSION
    || proof.verified !== true
    || proof.manager !== MANAGER
    || proof.sessionRoot !== expected.sessionRoot
    || proof.workspaceRoot !== expected.workspaceRoot
    || proof.secondaryWorkspaceRoot !== expected.secondaryWorkspaceRoot
    || proof.crossWorkspaceDefaultProfileId !== defaultProfile
    || proof.finalDefaultProfileId !== defaultProfile
    || explicitProfile === defaultProfile
    || proof.reopenedExplicitProfileId !== explicitProfile
  ) {
    fail('production path proof does not bind shared Default and isolated Explicit New profiles');
  }
  if (new Set([defaultSession, crossWorkspaceDefaultSession, finalDefaultSession]).size !== 3) {
    fail('shared Default profile did not use distinct browser sessions');
  }
  if (explicitSession === reopenedExplicitSession) {
    fail('Explicit New reopen did not create a distinct browser session');
  }
  validateSemantic(proof.semantic, scenarioPlan.root);
  validateProfileStorage(proof.profileStorage);
  validateCleanup(proof.cleanup, phase);
  return proof;
}
