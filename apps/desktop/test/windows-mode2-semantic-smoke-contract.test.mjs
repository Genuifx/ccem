import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  WINDOWS_MODE2_REQUIRED_STAGES,
  WINDOWS_MODE2_SMOKE_SCHEMA_VERSION,
  validateWindowsMode2SemanticAndProfileProof,
} from '../scripts/windows-mode2-semantic-smoke-contract.mjs';
import { windowsSemanticProductionPathProof } from './fixtures/windows-mode2-production-smoke.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeRoot = 'D:\\a\\_temp\\ccem-mode2-production-smoke\\12345-2';
const primaryProfileId = `profile-${'5'.repeat(32)}`;

function fixture() {
  return {
    profileId: primaryProfileId,
    ...windowsSemanticProductionPathProof(smokeRoot, primaryProfileId),
  };
}

test('schema binds the full semantic race, shared Default, and Explicit New stage order', () => {
  assert.equal(WINDOWS_MODE2_SMOKE_SCHEMA_VERSION, 10);
  assert.deepEqual(WINDOWS_MODE2_REQUIRED_STAGES.slice(8, 15), [
    'production_semantic_chain_started',
    'production_active_effect_entered',
    'production_occluded',
    'production_active_effect_cancelled',
    'production_restored',
    'production_rehandoff',
    'production_post_pause_no_late_write',
  ]);
  assert.deepEqual(WINDOWS_MODE2_REQUIRED_STAGES.slice(18), [
    'production_cross_workspace_default_ready',
    'production_cross_workspace_default_shown',
    'production_cross_workspace_default_handoff',
    'production_cross_workspace_default_storage_shared_verified',
    'production_cross_workspace_default_released',
    'production_explicit_new_acquired',
    'production_explicit_new_shown',
    'production_explicit_new_handoff',
    'production_explicit_new_isolation_verified',
    'production_explicit_new_released',
    'production_explicit_reopened_ready',
    'production_explicit_reopened_shown',
    'production_explicit_reopened_handoff',
    'production_explicit_persistence_verified',
    'production_explicit_reclosed',
    'production_default_final_reopened',
    'production_default_final_handoff',
    'production_default_unchanged_verified',
    'production_default_final_released',
    'production_cleanup_verified',
  ]);
});

test('every semantic proof and the sub-second acknowledgement fail closed', () => {
  validateWindowsMode2SemanticAndProfileProof(fixture(), smokeRoot);
  for (const field of Object.keys(fixture().semantic)
    .filter((name) => !['occlusionAckMillis', 'screenshot'].includes(name))) {
    const mutated = fixture();
    mutated.semantic[field] = false;
    assert.throws(
      () => validateWindowsMode2SemanticAndProfileProof(mutated, smokeRoot),
      /semantic proof|acknowledgement/u,
    );
  }
  for (const value of [-1, 1_000, 1.5]) {
    const mutated = fixture();
    mutated.semantic.occlusionAckMillis = value;
    assert.throws(
      () => validateWindowsMode2SemanticAndProfileProof(mutated, smokeRoot),
      /under one second/u,
    );
  }
  for (const [field, value] of [
    ['pngMagicVerified', false],
    ['pngStructureVerified', false],
    ['pngDecodedVerified', false],
    ['byteSizeVerified', false],
    ['sha256Verified', false],
    ['appOwnedCanonicalPathVerified', false],
    ['byteSize', 0],
    ['sha256', 'bad'],
    ['canonicalPath', 'D:\\escape\\shot.png'],
  ]) {
    const mutated = fixture();
    mutated.semantic.screenshot[field] = value;
    assert.throws(
      () => validateWindowsMode2SemanticAndProfileProof(mutated, smokeRoot),
      /screenshot/u,
    );
  }
});

test('profile storage binds cross-workspace Default sharing and Explicit New isolation', () => {
  for (const field of Object.keys(fixture().profileStorage)
    .filter((name) => name !== 'secondaryWorkspaceRoot')) {
    const mutated = fixture();
    mutated.profileStorage[field] = false;
    assert.throws(
      () => validateWindowsMode2SemanticAndProfileProof(mutated, smokeRoot),
      /profile storage proof/u,
    );
  }
  const splitDefault = fixture();
  splitDefault.crossWorkspaceDefaultProfileId = `profile-${'4'.repeat(32)}`;
  assert.throws(
    () => validateWindowsMode2SemanticAndProfileProof(splitDefault, smokeRoot),
    /same app-global Default profile/u,
  );
  const reusedDefaultSession = fixture();
  reusedDefaultSession.crossWorkspaceDefaultSessionId = reusedDefaultSession.defaultSessionId;
  assert.throws(
    () => validateWindowsMode2SemanticAndProfileProof(reusedDefaultSession, smokeRoot),
    /distinct browser sessions/u,
  );
  const sameExplicitProfile = fixture();
  sameExplicitProfile.explicitProfileId = primaryProfileId;
  assert.throws(
    () => validateWindowsMode2SemanticAndProfileProof(sameExplicitProfile, smokeRoot),
    /Explicit New profile is not isolated/u,
  );
  const wrongExplicitReopen = fixture();
  wrongExplicitReopen.reopenedExplicitProfileId = `profile-${'4'.repeat(32)}`;
  assert.throws(
    () => validateWindowsMode2SemanticAndProfileProof(wrongExplicitReopen, smokeRoot),
    /exact Explicit New profile/u,
  );
  const escaped = fixture();
  escaped.profileStorage.secondaryWorkspaceRoot = 'D:\\escape';
  assert.throws(
    () => validateWindowsMode2SemanticAndProfileProof(escaped, smokeRoot),
    /escaped/u,
  );
  for (const [field, value] of [
    ['persistedProfileCount', 1],
    ['workspaceCount', 1],
    ['profileLocksAvailable', false],
    ['ownerRecordCount', 1],
  ]) {
    const mutated = fixture();
    mutated.cleanup[field] = value;
    assert.throws(
      () => validateWindowsMode2SemanticAndProfileProof(mutated, smokeRoot),
      /two-profile owner/u,
    );
  }
});

test('release smoke source retains semantic-only capability and active page-effect barriers', async () => {
  const [service, runtime] = await Promise.all([
    fs.readFile(
      path.join(desktopDir, 'src-tauri/src/browser/login/surface_commands/production_smoke.rs'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src-tauri/src/browser/login/cef/ci_smoke/production_runtime.rs'),
      'utf8',
    ),
  ]);
  for (const tool of ['navigate', 'snapshot', 'click', 'type', 'screenshot']) {
    assert.match(service, new RegExp(`tool: "${tool}"\\.to_string\\(\\)`));
  }
  assert.doesNotMatch(service, /raw_cdp|Runtime\.evaluate/u);
  assert.match(runtime, /wait_for_effect_entry\(Duration::from_secs\(5\)\)/u);
  assert.match(runtime, /BrowserSurfaceControlActionArg::Occlude/u);
  assert.match(runtime, /active_effect\.require_cancelled\(Duration::from_secs\(2\)\)/u);
  assert.match(runtime, /request\.open\('GET','\{effect_path\}',false\)/u);
  assert.match(runtime, /document\.cookie=.*localStorage\.setItem/u);
  assert.match(runtime, /secondary_workspace_root/u);
  assert.match(runtime, /production_cross_workspace_default_storage_shared_verified/u);
  assert.match(runtime, /production_explicit_persistence_verified/u);
  assert.match(runtime, /production_default_unchanged_verified/u);
  assert.match(
    runtime,
    /primary_profiles\.len\(\) != 1[\s\S]*!primary_profiles\[0\]\.is_default/u,
  );
  assert.match(
    runtime,
    /secondary_profiles\.len\(\) != 2[\s\S]*secondary_profiles\[0\]\.profile_id != primary_profile_id[\s\S]*secondary_profiles\[1\]\.profile_id != secondary_profile_id/u,
  );
});
