import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertAdHocSignatureDetails, signAdHocCefStage, verifyAdHocMacApp } from '../scripts/macos-adhoc-cef-signing.mjs';
import { FRAMEWORK_NAME, FRAMEWORK_NESTED_CODE_RELATIVES, HELPER_SPECS } from '../scripts/stage-cef-macos.mjs';

const details = 'Identifier=com.ccem.desktop\nSignature=adhoc\nTeamIdentifier=not set\nCodeDirectory v=20400 flags=0x2(adhoc)\nInfo.plist entries=3\nSealed Resources version=2 rules=13 files=1';

test('ad-hoc verification accepts the exact bundle identity and rejects other signing modes', () => {
  assert.doesNotThrow(() => assertAdHocSignatureDetails(details, 'com.ccem.desktop'));
  for (const invalid of [
    details.replace('com.ccem.desktop', 'com.other.app'),
    details.replace('Signature=adhoc', 'Authority=Developer ID Application: Other'),
    details.replace('TeamIdentifier=not set', 'TeamIdentifier=ABCDEFGHIJ'),
    details.replace('flags=0x2(adhoc)', 'flags=0x10002(adhoc,runtime)'),
    details.replace('Info.plist entries=3', 'Info.plist=not bound'),
    details.replace('Sealed Resources version=2 rules=13 files=1', 'Sealed Resources=none'),
  ]) assert.throws(() => assertAdHocSignatureDetails(invalid, 'com.ccem.desktop'));
});

test('CEF signing seals libraries before framework and every helper without hardened runtime', () => {
  const calls = [];
  signAdHocCefStage('/stage', (args) => calls.push(args));
  const signs = calls.filter((args) => args.includes('--sign'));
  assert.equal(signs.length, FRAMEWORK_NESTED_CODE_RELATIVES.length + 1 + HELPER_SPECS.length);
  assert.deepEqual(signs.slice(0, FRAMEWORK_NESTED_CODE_RELATIVES.length).map((args) => args.at(-1)),
    FRAMEWORK_NESTED_CODE_RELATIVES.map((relative) => path.join('/stage', FRAMEWORK_NAME, relative)));
  assert.equal(signs[FRAMEWORK_NESTED_CODE_RELATIVES.length].at(-1), path.join('/stage', FRAMEWORK_NAME));
  for (const args of signs) {
    assert.equal(args[args.indexOf('--sign') + 1], '-');
    assert.ok(!args.includes('--deep') && !args.includes('--options'));
  }
  assert.equal(calls.filter((args) => args[0] === '--verify').length, 1 + HELPER_SPECS.length);
});

test('app verification fails before reading identity when the bundle seal is invalid', () => {
  const calls = [];
  assert.throws(() => verifyAdHocMacApp('/app', (args) => {
    calls.push(args);
    throw new Error('invalid code seal');
  }), /invalid code seal/u);
  assert.deepEqual(calls, [['--verify', '--deep', '--strict', '/app']]);
  assert.deepEqual(verifyAdHocMacApp('/app', () => details), { verification: 'codesign-adhoc-deep-strict-v1' });
});

test('native macOS verification accepts a sealed app and rejects tampering', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-adhoc-seal-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'CCEM Desktop.app');
  await fs.mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(app, 'Contents', 'Resources'));
  await fs.writeFile(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>com.ccem.desktop</string>
    <key>CFBundleExecutable</key><string>ccem-desktop</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    </dict></plist>`);
  const resource = path.join(app, 'Contents', 'Resources', 'payload');
  await fs.writeFile(resource, 'sealed');
  const source = path.join(root, 'main.c');
  await fs.writeFile(source, 'int main(void) { return 0; }');
  for (const [command, args] of [
    ['/usr/bin/clang', [source, '-o', path.join(app, 'Contents', 'MacOS', 'ccem-desktop')]],
    ['/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--identifier', 'com.ccem.desktop', app]],
  ]) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(verifyAdHocMacApp(app), { verification: 'codesign-adhoc-deep-strict-v1' });
  await fs.writeFile(resource, 'modified after signing');
  assert.throws(() => verifyAdHocMacApp(app), /codesign failed/u);
});
