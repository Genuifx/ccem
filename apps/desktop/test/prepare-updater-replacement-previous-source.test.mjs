import assert from 'node:assert/strict';
import test from 'node:test';

import {
  patchPreviousAppUpdatesRs,
  patchPreviousCargoToml,
  patchPreviousMainRs,
} from '../scripts/prepare-updater-replacement-previous-source.mjs';

const PREVIOUS_CARGO = `[package]
name = "ccem-desktop"
version = "2.52.1"

[dependencies]
chrono = "0.4"
libc = "0.2"
reqwest = "0.12"
serde = "1"
serde_json = "1"
sha2 = "0.10"
tauri = "2"
tauri-plugin-updater = "2"

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
`;

test('previous Cargo patch adds only the explicit harness feature and boot clock dependency', () => {
  const patched = patchPreviousCargoToml(PREVIOUS_CARGO);
  assert.match(patched, /^updater-replacement-smoke-harness = \[\]$/mu);
  assert.match(patched, /^\[target\.'cfg\(windows\)'\.dependencies\]$/mu);
  assert.match(patched, /Win32_System_SystemInformation/u);
  assert.equal(patchPreviousCargoToml(patched), patched);
});

test('previous Cargo patch refuses a source missing a dependency used by instrumentation', () => {
  assert.throws(
    () => patchPreviousCargoToml(PREVIOUS_CARGO.replace(/^tauri-plugin-updater.*\n/mu, '')),
    /lacks required existing dependency tauri-plugin-updater/u,
  );
});

const PREVIOUS_APP_UPDATES = `use std::time::Duration;
pub struct AppUpdateMetadata {
    version: String,
}
pub struct AppUpdateProgressEvent {
    version: String,
}
pub async fn check_app_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}
pub async fn install_app_update() -> Result<(), String> {
    update
        .download_and_install(
            move |chunk_length, content_length| {
                consume(chunk_length, content_length);
            },
            move || {
                finished();
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}
`;

test('previous app patch keeps the production commands and injects only builder and verified-download hooks', () => {
  const patched = patchPreviousAppUpdatesRs(PREVIOUS_APP_UPDATES);
  assert.match(patched, /pub async fn check_app_update/u);
  assert.match(patched, /pub async fn install_app_update/u);
  assert.match(patched, /configure_updater_builder\(&app, updater_builder\)/u);
  assert.match(patched, /record_verified_download\(&bytes\)/u);
  assert.match(patched, /#\[cfg\(not\(feature = "updater-replacement-smoke-harness"\)\)\][\s\S]*\.download_and_install\(/u);
  assert.match(patched, /#\[cfg\(feature = "updater-replacement-smoke-harness"\)\][\s\S]*\.download\(/u);
  assert.throws(
    () => patchPreviousAppUpdatesRs(patched),
    /anchor must occur exactly once/u,
  );
});

test('previous main patch preserves normal startup behind an early explicit smoke gate', () => {
  const source = `mod analytics;\nmod app_updates;\nmod bot_binding;\nfn main() {\n    normal_startup();\n}\n`;
  const patched = patchPreviousMainRs(source);
  assert.match(patched, /mod updater_replacement_smoke;/u);
  assert.match(patched, /if updater_replacement_smoke::is_requested\(\)/u);
  assert.match(patched, /normal_startup\(\)/u);
});
