import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';

export const CEF_UNBRANDED_SAFE_STORAGE_SERVICE = 'Chromium Safe Storage';
export const CCEM_SAFE_STORAGE_SERVICE = 'CCEM Safe Storage';
export const CEF_SAFE_STORAGE_BRANDING_METHOD = 'unique-null-padded-literal-replacement-v1';

const unbrandedBytes = Buffer.from(CEF_UNBRANDED_SAFE_STORAGE_SERVICE, 'utf8');
const brandedTextBytes = Buffer.from(CCEM_SAFE_STORAGE_SERVICE, 'utf8');

function fail(message) {
  throw new Error(`[cef-macos-safe-storage-branding] ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function allOffsets(bytes, needle) {
  const offsets = [];
  let cursor = 0;
  while (cursor <= bytes.length - needle.length) {
    const offset = bytes.indexOf(needle, cursor);
    if (offset < 0) break;
    offsets.push(offset);
    cursor = offset + needle.length;
  }
  return offsets;
}

function brandedSlot() {
  if (brandedTextBytes.length >= unbrandedBytes.length) {
    fail('branded Safe Storage service must fit inside the pinned Chromium literal');
  }
  const slot = Buffer.alloc(unbrandedBytes.length);
  brandedTextBytes.copy(slot);
  return slot;
}

export function inspectCefMacosSafeStorageBrandingBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('framework bytes must be a Buffer');
  const unbrandedOffsets = allOffsets(bytes, unbrandedBytes);
  const brandedOffsets = allOffsets(bytes, brandedTextBytes);
  return {
    unbrandedOffsets,
    brandedOffsets,
    sha256: sha256(bytes),
  };
}

export async function brandCefMacosSafeStorageService(frameworkExecutable) {
  const bytes = await fsp.readFile(frameworkExecutable);
  const before = inspectCefMacosSafeStorageBrandingBytes(bytes);
  if (before.unbrandedOffsets.length !== 1) {
    fail(
      `pinned framework must contain exactly one ${JSON.stringify(CEF_UNBRANDED_SAFE_STORAGE_SERVICE)} literal; `
      + `found ${before.unbrandedOffsets.length}`,
    );
  }
  if (before.brandedOffsets.length !== 0) {
    fail('source framework already contains the CCEM Safe Storage service');
  }

  const offset = before.unbrandedOffsets[0];
  const branded = Buffer.from(bytes);
  brandedSlot().copy(branded, offset);
  const after = inspectCefMacosSafeStorageBrandingBytes(branded);
  if (
    after.unbrandedOffsets.length !== 0
    || after.brandedOffsets.length !== 1
    || after.brandedOffsets[0] !== offset
    || after.sha256 === before.sha256
  ) {
    fail('Safe Storage branding did not produce one exact length-preserving replacement');
  }
  if (branded.length !== bytes.length) {
    fail('Safe Storage branding changed the framework executable length');
  }

  await fsp.writeFile(frameworkExecutable, branded, { flag: 'r+' });
  return {
    schemaVersion: 1,
    method: CEF_SAFE_STORAGE_BRANDING_METHOD,
    sourceService: CEF_UNBRANDED_SAFE_STORAGE_SERVICE,
    service: CCEM_SAFE_STORAGE_SERVICE,
    byteOffset: offset,
    byteLength: unbrandedBytes.length,
    sourceExecutableSha256: before.sha256,
    brandedExecutableSha256: after.sha256,
  };
}

export function validateCefMacosSafeStorageBrandingEvidence(evidence) {
  const requiredKeys = [
    'schemaVersion',
    'method',
    'sourceService',
    'service',
    'byteOffset',
    'byteLength',
    'sourceExecutableSha256',
    'brandedExecutableSha256',
  ];
  const actualKeys = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? Object.keys(evidence).sort()
    : [];
  if (JSON.stringify(actualKeys) !== JSON.stringify(requiredKeys.sort())) {
    fail('branding evidence fields are invalid');
  }
  if (
    evidence.schemaVersion !== 1
    || evidence.method !== CEF_SAFE_STORAGE_BRANDING_METHOD
    || evidence.sourceService !== CEF_UNBRANDED_SAFE_STORAGE_SERVICE
    || evidence.service !== CCEM_SAFE_STORAGE_SERVICE
    || !Number.isSafeInteger(evidence.byteOffset)
    || evidence.byteOffset < 0
    || evidence.byteLength !== unbrandedBytes.length
    || !/^[a-f0-9]{64}$/u.test(evidence.sourceExecutableSha256 ?? '')
    || !/^[a-f0-9]{64}$/u.test(evidence.brandedExecutableSha256 ?? '')
    || evidence.sourceExecutableSha256 === evidence.brandedExecutableSha256
  ) {
    fail('branding evidence values are invalid');
  }
  return evidence;
}

export async function verifyCefMacosSafeStorageBranding(
  frameworkExecutable,
  evidence,
  { allowSignedExecutable = false } = {},
) {
  validateCefMacosSafeStorageBrandingEvidence(evidence);

  const bytes = await fsp.readFile(frameworkExecutable);
  const inspection = inspectCefMacosSafeStorageBrandingBytes(bytes);
  if (
    inspection.unbrandedOffsets.length !== 0
    || inspection.brandedOffsets.length !== 1
    || inspection.brandedOffsets[0] !== evidence.byteOffset
    || (!allowSignedExecutable && inspection.sha256 !== evidence.brandedExecutableSha256)
  ) {
    fail('staged framework does not match its CCEM Safe Storage branding evidence');
  }
  const slot = bytes.subarray(evidence.byteOffset, evidence.byteOffset + evidence.byteLength);
  if (!slot.equals(brandedSlot())) {
    fail('staged framework Safe Storage literal is not null padded exactly');
  }
  return inspection;
}
