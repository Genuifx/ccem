import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CCEM_SAFE_STORAGE_SERVICE,
  CEF_SAFE_STORAGE_BRANDING_METHOD,
  CEF_UNBRANDED_SAFE_STORAGE_SERVICE,
  brandCefMacosSafeStorageService,
  inspectCefMacosSafeStorageBrandingBytes,
  verifyCefMacosSafeStorageBranding,
} from '../scripts/cef-macos-safe-storage-branding.mjs';

async function temporaryFramework(t, bytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-safe-storage-branding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'Chromium Embedded Framework');
  await fs.writeFile(executable, bytes);
  return executable;
}

test('brands one pinned Chromium service literal without changing executable length', async (t) => {
  const source = Buffer.from(`before\0${CEF_UNBRANDED_SAFE_STORAGE_SERVICE}\0after`);
  const executable = await temporaryFramework(t, source);
  const evidence = await brandCefMacosSafeStorageService(executable);
  const branded = await fs.readFile(executable);

  assert.equal(branded.length, source.length);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.method, CEF_SAFE_STORAGE_BRANDING_METHOD);
  assert.equal(evidence.sourceService, CEF_UNBRANDED_SAFE_STORAGE_SERVICE);
  assert.equal(evidence.service, CCEM_SAFE_STORAGE_SERVICE);
  assert.notEqual(evidence.sourceExecutableSha256, evidence.brandedExecutableSha256);
  assert.equal(branded.includes(Buffer.from(CEF_UNBRANDED_SAFE_STORAGE_SERVICE)), false);

  const inspection = inspectCefMacosSafeStorageBrandingBytes(branded);
  assert.deepEqual(inspection.unbrandedOffsets, []);
  assert.deepEqual(inspection.brandedOffsets, [evidence.byteOffset]);
  assert.equal(inspection.sha256, evidence.brandedExecutableSha256);
  await verifyCefMacosSafeStorageBranding(executable, evidence);

  const slot = branded.subarray(evidence.byteOffset, evidence.byteOffset + evidence.byteLength);
  assert.equal(slot.subarray(0, Buffer.byteLength(CCEM_SAFE_STORAGE_SERVICE)).toString(), CCEM_SAFE_STORAGE_SERVICE);
  assert.equal(slot.subarray(Buffer.byteLength(CCEM_SAFE_STORAGE_SERVICE)).every((byte) => byte === 0), true);
});

test('fails closed when the source literal is absent, duplicated, or already branded', async (t) => {
  const absent = await temporaryFramework(t, Buffer.from('no safe storage literal'));
  await assert.rejects(
    brandCefMacosSafeStorageService(absent),
    /must contain exactly one .*Chromium Safe Storage.* found 0/,
  );

  const duplicated = await temporaryFramework(
    t,
    Buffer.from(`${CEF_UNBRANDED_SAFE_STORAGE_SERVICE}\0${CEF_UNBRANDED_SAFE_STORAGE_SERVICE}`),
  );
  await assert.rejects(
    brandCefMacosSafeStorageService(duplicated),
    /must contain exactly one .* found 2/,
  );

  const alreadyBranded = await temporaryFramework(
    t,
    Buffer.from(`${CEF_UNBRANDED_SAFE_STORAGE_SERVICE}\0${CCEM_SAFE_STORAGE_SERVICE}`),
  );
  await assert.rejects(
    brandCefMacosSafeStorageService(alreadyBranded),
    /already contains the CCEM Safe Storage service/,
  );
});

test('verification binds the exact branded bytes, offset, and source digest evidence', async (t) => {
  const executable = await temporaryFramework(
    t,
    Buffer.from(`header\0${CEF_UNBRANDED_SAFE_STORAGE_SERVICE}\0footer`),
  );
  const evidence = await brandCefMacosSafeStorageService(executable);

  const wrongOffset = { ...evidence, byteOffset: evidence.byteOffset + 1 };
  await assert.rejects(
    verifyCefMacosSafeStorageBranding(executable, wrongOffset),
    /does not match its CCEM Safe Storage branding evidence/,
  );

  const wrongSource = { ...evidence, sourceExecutableSha256: evidence.brandedExecutableSha256 };
  await assert.rejects(
    verifyCefMacosSafeStorageBranding(executable, wrongSource),
    /branding evidence values are invalid/,
  );

  await fs.appendFile(executable, Buffer.from('simulated-code-signature'));
  await assert.rejects(
    verifyCefMacosSafeStorageBranding(executable, evidence),
    /does not match its CCEM Safe Storage branding evidence/,
  );
  await verifyCefMacosSafeStorageBranding(
    executable,
    evidence,
    { allowSignedExecutable: true },
  );

  const bytes = await fs.readFile(executable);
  bytes[evidence.byteOffset] ^= 1;
  await fs.writeFile(executable, bytes);
  await assert.rejects(
    verifyCefMacosSafeStorageBranding(executable, evidence),
    /does not match its CCEM Safe Storage branding evidence/,
  );
});
