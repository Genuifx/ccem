import path from 'node:path';

export const WINDOWS_MODE2_SMOKE_SCHEMA_VERSION = 9;

export const WINDOWS_MODE2_REQUIRED_STAGES = Object.freeze([
  'direct_ready',
  'direct_cdp',
  'direct_closed',
  'production_acquired_hidden_ready',
  'production_shown',
  'production_hidden',
  'production_reshown',
  'production_handoff',
  'production_semantic_chain_started',
  'production_active_effect_entered',
  'production_occluded',
  'production_active_effect_cancelled',
  'production_restored',
  'production_rehandoff',
  'production_post_pause_no_late_write',
  'production_paused',
  'production_takeover',
  'production_released',
  'production_reopened_ready',
  'production_reopened_shown',
  'production_reopened_handoff',
  'production_profile_persistence_verified',
  'production_reclosed',
  'production_secondary_acquired',
  'production_secondary_shown',
  'production_secondary_handoff',
  'production_secondary_isolation_verified',
  'production_secondary_released',
  'production_secondary_reopened_ready',
  'production_secondary_reopened_shown',
  'production_secondary_reopened_handoff',
  'production_secondary_persistence_verified',
  'production_secondary_reclosed',
  'production_primary_final_reopened',
  'production_primary_final_handoff',
  'production_primary_unchanged_verified',
  'production_primary_final_released',
  'production_cleanup_verified',
]);

function fail(message) {
  throw new Error(`[windows-mode2-smoke] ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} fields are not exact`);
}

function exactProfileId(value, label) {
  if (!/^profile-[a-f0-9]{32}$/u.test(value ?? '')) fail(`${label} is invalid`);
  return value;
}

function sameWindowsPath(left, right) {
  return comparableWindowsPath(left) === comparableWindowsPath(right);
}

function comparableWindowsPath(value) {
  const normalized = path.win32.normalize(value);
  const withoutDevicePrefix = normalized.startsWith('\\\\?\\UNC\\')
    ? `\\\\${normalized.slice(8)}`
    : normalized.startsWith('\\\\?\\') ? normalized.slice(4) : normalized;
  return withoutDevicePrefix.toLowerCase();
}

function exactWindowsPath(value, label) {
  if (
    typeof value !== 'string'
    || !path.win32.isAbsolute(value)
    || value.includes('\0')
    || path.win32.normalize(value) !== value
  ) fail(`${label} must be a normalized absolute Windows path`);
  return value;
}

export function validateWindowsMode2SemanticAndProfileProof(productionPath, smokeRoot) {
  exactKeys(productionPath.semantic, [
    'navigatedViaCapability',
    'axSnapshotViaCapability',
    'clickViaElementRef',
    'typeViaElementRef',
    'screenshot',
    'storageCommitViaElementRef',
    'activeEffectEntered',
    'activeEffectCancelled',
    'occlusionAckUnderOneSecond',
    'occlusionAckMillis',
    'postPauseNoLateWrite',
  ], 'production semantic proof');
  for (const [name, value] of Object.entries(productionPath.semantic)) {
    if (name === 'occlusionAckMillis') {
      if (!Number.isSafeInteger(value) || value < 0 || value >= 1_000) {
        fail('production occlusion acknowledgement did not complete in under one second');
      }
    } else if (name !== 'screenshot' && value !== true) {
      fail(`production semantic proof ${name} is not true`);
    }
  }
  exactKeys(productionPath.semantic.screenshot, [
    'canonicalPath',
    'byteSize',
    'sha256',
    'pngMagicVerified',
    'pngStructureVerified',
    'pngDecodedVerified',
    'byteSizeVerified',
    'sha256Verified',
    'appOwnedCanonicalPathVerified',
  ], 'production screenshot proof');
  const screenshot = productionPath.semantic.screenshot;
  const screenshotPath = exactWindowsPath(screenshot.canonicalPath, 'screenshot canonical path');
  const artifactPrefix = `${comparableWindowsPath(path.win32.join(
    smokeRoot,
    'data',
    'login',
    'sessions',
  ))}\\`;
  if (
    !comparableWindowsPath(screenshotPath).startsWith(artifactPrefix)
    || !/\\login-session-[a-f0-9]{32}\\artifacts\\shot-[a-f0-9]{32}\.png$/u
      .test(comparableWindowsPath(screenshotPath))
  ) fail('screenshot canonical path escaped the app-owned session artifact root');
  if (
    !Number.isSafeInteger(screenshot.byteSize)
    || screenshot.byteSize <= 8
    || screenshot.byteSize > 24 * 1024 * 1024
    || !/^[a-f0-9]{64}$/u.test(screenshot.sha256 ?? '')
    || screenshot.pngMagicVerified !== true
    || screenshot.pngStructureVerified !== true
    || screenshot.pngDecodedVerified !== true
    || screenshot.byteSizeVerified !== true
    || screenshot.sha256Verified !== true
    || screenshot.appOwnedCanonicalPathVerified !== true
  ) fail('screenshot PNG, size, digest, or ownership proof is incomplete');

  const primaryProfileId = exactProfileId(productionPath.profileId, 'primary profile id');
  if (
    productionPath.reopenedProfileId !== primaryProfileId
    || productionPath.finalReopenedProfileId !== primaryProfileId
  ) fail('production path did not reopen the exact primary profile twice');

  exactKeys(productionPath.profileIsolation, [
    'secondaryWorkspaceRoot',
    'secondaryProfileId',
    'distinctWorkspaceProfiles',
    'primaryCookiePersisted',
    'primaryLocalStoragePersisted',
    'secondaryProfileInitiallyEmpty',
    'secondaryCookieIsolated',
    'secondaryLocalStorageIsolated',
    'secondaryCookiePersisted',
    'secondaryLocalStoragePersisted',
    'primaryUnchangedAfterSecondary',
  ], 'production profile isolation proof');
  const isolation = productionPath.profileIsolation;
  const secondaryProfileId = exactProfileId(isolation.secondaryProfileId, 'secondary profile id');
  if (secondaryProfileId === primaryProfileId) fail('production profiles are not distinct');
  if (productionPath.secondaryReopenedProfileId !== secondaryProfileId) {
    fail('production path did not reopen the exact secondary profile');
  }
  const secondaryRoot = exactWindowsPath(
    isolation.secondaryWorkspaceRoot,
    'secondary workspace root',
  );
  if (!sameWindowsPath(secondaryRoot, path.win32.join(smokeRoot, 'workspace-secondary'))) {
    fail('secondary workspace escaped the isolated current-run root');
  }
  for (const [name, value] of Object.entries(isolation)) {
    if (!['secondaryWorkspaceRoot', 'secondaryProfileId'].includes(name) && value !== true) {
      fail(`production profile isolation proof ${name} is not true`);
    }
  }

  exactKeys(productionPath.cleanup, [
    'activeSurfaceCount',
    'activeSessionCount',
    'ownerRecordCount',
    'persistedProfileCount',
    'workspaceCount',
    'profileLocksAvailable',
  ], 'production cleanup proof');
  const cleanup = productionPath.cleanup;
  if (
    cleanup.activeSurfaceCount !== 0
    || cleanup.activeSessionCount !== 0
    || cleanup.ownerRecordCount !== 0
    || cleanup.persistedProfileCount !== 2
    || cleanup.workspaceCount !== 2
    || cleanup.profileLocksAvailable !== true
  ) fail('production path did not prove two-profile owner, session, and lock cleanup');
}

export function validateWindowsMode2ProductionPath(
  productionPath,
  smokeRoot,
  validateNativeWindowObservation,
) {
  exactKeys(productionPath, [
    'verified', 'manager', 'dataRoot', 'workspaceRoot', 'ownerRecordRoot',
    'profileStateRoot', 'cefCacheRoot', 'profileId', 'nativeWindow',
    'semantic', 'reopenedProfileId', 'secondaryReopenedProfileId',
    'finalReopenedProfileId', 'profileIsolation', 'cleanup',
  ], 'production path receipt');
  if (productionPath.verified !== true || productionPath.manager !== 'LoginBrowserSurfaceManager') {
    fail('runtime receipt did not exercise the production LoginBrowserSurfaceManager path');
  }
  const expectedRoots = {
    dataRoot: path.win32.join(smokeRoot, 'data'),
    workspaceRoot: path.win32.join(smokeRoot, 'workspace'),
    ownerRecordRoot: path.win32.join(smokeRoot, 'data', 'login', 'embedded-owners'),
    profileStateRoot: path.win32.join(smokeRoot, 'data', 'login', 'profile-state'),
    cefCacheRoot: path.win32.join(smokeRoot, 'data', 'login', 'cef'),
  };
  for (const [field, wanted] of Object.entries(expectedRoots)) {
    exactWindowsPath(productionPath[field], `production path ${field}`);
    if (!sameWindowsPath(productionPath[field], wanted)) {
      fail(`production path ${field} escaped the isolated current-run root`);
    }
  }
  exactProfileId(productionPath.profileId, 'production path primary profile id');
  validateNativeWindowObservation(productionPath.nativeWindow);
  validateWindowsMode2SemanticAndProfileProof(productionPath, smokeRoot);
}
