import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

test('Mode 2 workbench fixture uses current neutral product wording', async () => {
  const fixture = await fs.readFile(
    path.join(desktopDir, 'test/fixtures/browser-workbench-smoke.html'),
    'utf8',
  );

  assert.match(fixture, /<title>CCEM Mode 2 Browser workbench probe<\/title>/u);
  assert.match(fixture, /<h1>Mode 2 Browser verification<\/h1>/u);
  assert.match(fixture, />Run browser test<\/button>/u);
  assert.doesNotMatch(fixture, />[^<]*(?:Preview Browser|Apply preview)[^<]*</u);
  assert.match(fixture, /CCEM_WORKBENCH_READY/u);
  assert.match(fixture, /result\.textContent = `Applied: \$\{input\.value\}`/u);
});

test('debug Mode 2 smoke binds canonical dev identity and cannot select system Keychain', async () => {
  const [runtime, gate] = await Promise.all([
    fs.readFile(
      path.join(desktopDir, 'src-tauri/src/browser/login/cef/debug_smoke/runtime.rs'),
      'utf8',
    ),
    fs.readFile(
      path.join(desktopDir, 'src-tauri/src/browser/login/cef/debug_smoke.rs'),
      'utf8',
    ),
  ]);

  assert.match(runtime, /CCEM_DESKTOP_DEV_INSTANCE_ID/u);
  assert.match(runtime, /expected_canonical_smoke_host_identity/u);
  assert.match(runtime, /com\.ccem\.desktop\.dev\.i/u);
  assert.match(runtime, /\/Applications\/CCEM Desktop\.app/u);
  assert.match(runtime, /private child of the system temporary directory/u);
  assert.match(runtime, /CefCredentialStorePolicy::MockKeychain/u);
  assert.match(runtime, /chromium-mock-keychain-v2/u);
  assert.doesNotMatch(runtime, /\/usr\/bin\/security|login\.keychain/u);
  assert.match(runtime, /smoke root must use its canonical path without symlinks/u);
  assert.match(runtime, /smoke root must be fresh and empty/u);
  assert.match(gate, /CCEM_MACOS_MODE2_SMOKE_ROOT/u);
});
