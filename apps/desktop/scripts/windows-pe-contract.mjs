import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';

const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const AMD64_MACHINE = 0x8664;
const SECURITY_DIRECTORY_INDEX = 4;

function fail(message) {
  throw new Error(`[windows-pe-contract] ${message}`);
}

function checkedRange(bytes, offset, size, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0) {
    fail(`${label} has an invalid range`);
  }
  const end = offset + size;
  if (!Number.isSafeInteger(end) || end > bytes.length) {
    fail(`${label} exceeds the PE file`);
  }
  return end;
}

function readAsciiName(bytes, offset) {
  const end = checkedRange(bytes, offset, 8, 'PE section name');
  const nul = bytes.indexOf(0, offset);
  return bytes.subarray(offset, nul >= offset && nul < end ? nul : end).toString('ascii');
}

export function parsePe(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('input must be a Buffer');
  checkedRange(bytes, 0, 0x40, 'DOS header');
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) fail('DOS MZ signature is missing');

  const peOffset = bytes.readUInt32LE(0x3c);
  checkedRange(bytes, peOffset, 24, 'PE header');
  if (bytes.readUInt32LE(peOffset) !== 0x00004550) fail('PE signature is missing');

  const coffOffset = peOffset + 4;
  const machine = bytes.readUInt16LE(coffOffset);
  const sectionCount = bytes.readUInt16LE(coffOffset + 2);
  const optionalSize = bytes.readUInt16LE(coffOffset + 16);
  const optionalOffset = coffOffset + 20;
  checkedRange(bytes, optionalOffset, optionalSize, 'PE optional header');

  const magic = bytes.readUInt16LE(optionalOffset);
  if (![PE32_MAGIC, PE32_PLUS_MAGIC].includes(magic)) fail('unsupported PE optional-header magic');
  const pointerSize = magic === PE32_PLUS_MAGIC ? 8 : 4;
  const minimumOptionalSize = pointerSize === 8 ? 152 : 136;
  if (optionalSize < minimumOptionalSize) fail('PE optional header does not contain five data directories');
  const imageBaseOffset = optionalOffset + (pointerSize === 8 ? 24 : 28);
  const imageBase = pointerSize === 8
    ? bytes.readBigUInt64LE(imageBaseOffset)
    : BigInt(bytes.readUInt32LE(imageBaseOffset));
  const checksumOffset = optionalOffset + 64;
  checkedRange(bytes, checksumOffset, 4, 'PE checksum');

  const numberOfDirectoriesOffset = optionalOffset + (pointerSize === 8 ? 108 : 92);
  const numberOfDirectories = bytes.readUInt32LE(numberOfDirectoriesOffset);
  if (numberOfDirectories <= SECURITY_DIRECTORY_INDEX) {
    fail('PE optional header has no security data directory');
  }
  const directoriesOffset = optionalOffset + (pointerSize === 8 ? 112 : 96);
  const securityDirectoryOffset = directoriesOffset + (SECURITY_DIRECTORY_INDEX * 8);
  if (securityDirectoryOffset + 8 > optionalOffset + optionalSize) {
    fail('PE security directory exceeds the optional header');
  }
  checkedRange(bytes, securityDirectoryOffset, 8, 'PE security directory');
  const certificateOffset = bytes.readUInt32LE(securityDirectoryOffset);
  const certificateSize = bytes.readUInt32LE(securityDirectoryOffset + 4);
  if ((certificateOffset === 0) !== (certificateSize === 0)) {
    fail('PE certificate offset and size must both be zero or both be present');
  }
  if (certificateSize > 0) {
    if (certificateOffset % 8 !== 0) fail('PE certificate table must be 8-byte aligned');
    if (certificateSize % 8 !== 0) fail('PE certificate table size must be 8-byte aligned');
    checkedRange(bytes, certificateOffset, certificateSize, 'PE certificate table');
  }

  const sectionsOffset = optionalOffset + optionalSize;
  const sectionsEnd = checkedRange(bytes, sectionsOffset, sectionCount * 40, 'PE section table');
  const sizeOfHeaders = bytes.readUInt32LE(optionalOffset + 60);
  if (sizeOfHeaders > bytes.length) fail('PE SizeOfHeaders exceeds the PE file');
  if (sizeOfHeaders < sectionsEnd) fail('PE SizeOfHeaders does not cover the section table');
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionsOffset + (index * 40);
    const section = {
      name: readAsciiName(bytes, offset),
      virtualSize: bytes.readUInt32LE(offset + 8),
      virtualAddress: bytes.readUInt32LE(offset + 12),
      rawSize: bytes.readUInt32LE(offset + 16),
      rawOffset: bytes.readUInt32LE(offset + 20),
    };
    if (section.rawSize > 0) {
      if (section.rawOffset < sizeOfHeaders) fail(`PE section ${section.name} overlaps the image headers`);
      checkedRange(bytes, section.rawOffset, section.rawSize, `PE section ${section.name}`);
    }
    sections.push(section);
  }
  for (let left = 0; left < sections.length; left += 1) {
    if (sections[left].rawSize === 0) continue;
    for (let right = left + 1; right < sections.length; right += 1) {
      if (sections[right].rawSize === 0) continue;
      const leftEnd = sections[left].rawOffset + sections[left].rawSize;
      const rightEnd = sections[right].rawOffset + sections[right].rawSize;
      if (sections[left].rawOffset < rightEnd && leftEnd > sections[right].rawOffset) {
        fail(`PE sections ${sections[left].name} and ${sections[right].name} overlap`);
      }
    }
  }

  if (certificateSize > 0) {
    const certificateEnd = certificateOffset + certificateSize;
    if (certificateOffset < sizeOfHeaders) fail('PE certificate table overlaps the image headers');
    for (const section of sections) {
      const sectionEnd = section.rawOffset + section.rawSize;
      if (
        section.rawSize > 0
        && certificateOffset < sectionEnd
        && certificateEnd > section.rawOffset
      ) {
        fail(`PE certificate table overlaps section ${section.name}`);
      }
    }
  }

  return {
    machine,
    pointerSize,
    imageBase,
    checksumOffset,
    securityDirectoryOffset,
    certificateOffset,
    certificateSize,
    sections,
  };
}

export function assertPeX64(bytes, label = 'PE file') {
  const pe = parsePe(bytes);
  if (pe.machine !== AMD64_MACHINE || pe.pointerSize !== 8) {
    fail(`${label} must be an x86_64 PE32+ image`);
  }
  return pe;
}

function pointerTargetOffset(pe, pointer, section, size) {
  if (pointer < pe.imageBase) fail('Tauri bundle-type pointer precedes the PE image base');
  const rva = pointer - pe.imageBase;
  const sectionStart = BigInt(section.virtualAddress);
  const sectionRawSpan = BigInt(section.rawSize);
  const targetEnd = rva + BigInt(size);
  if (rva < sectionStart || targetEnd > sectionStart + sectionRawSpan) {
    fail('Tauri bundle-type pointer is outside the raw .rdata bytes');
  }
  const offset = BigInt(section.rawOffset) + (rva - sectionStart);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) fail('Tauri bundle-type file offset is too large');
  return Number(offset);
}

export function patchTauriBundleTypeNsis(bytes) {
  const pe = assertPeX64(bytes, 'Tauri client DLL');
  const tauriSection = pe.sections.find(({ name }) => name === '.taubndl');
  const rdataSection = pe.sections.find(({ name }) => name === '.rdata');
  if (!tauriSection) fail('Tauri client DLL has no .taubndl section');
  if (!rdataSection) fail('Tauri client DLL has no .rdata section');
  const descriptorSize = pe.pointerSize * 2;
  if (tauriSection.rawSize < descriptorSize) fail('.taubndl section cannot contain a Rust string descriptor');
  checkedRange(bytes, tauriSection.rawOffset, descriptorSize, '.taubndl Rust string descriptor');

  const pointer = bytes.readBigUInt64LE(tauriSection.rawOffset);
  const length = bytes.readBigUInt64LE(tauriSection.rawOffset + pe.pointerSize);
  if (length !== 3n) fail(`Tauri bundle-type length must equal 3, received ${length}`);
  const targetOffset = pointerTargetOffset(pe, pointer, rdataSection, 3);
  checkedRange(bytes, targetOffset, 3, 'Tauri bundle-type value');
  const current = bytes.subarray(targetOffset, targetOffset + 3).toString('ascii');
  if (!['UNK', 'NSS'].includes(current)) {
    fail(`Tauri bundle-type value must be UNK or NSS, received ${JSON.stringify(current)}`);
  }

  const patched = Buffer.from(bytes);
  patched.write('NSS', targetOffset, 3, 'ascii');
  return { bytes: patched, previous: current, targetOffset };
}

export function canonicalPeSha256(bytes) {
  const pe = assertPeX64(bytes);
  const canonical = Buffer.from(bytes);
  canonical.fill(0, pe.checksumOffset, pe.checksumOffset + 4);
  canonical.fill(0, pe.securityDirectoryOffset, pe.securityDirectoryOffset + 8);

  const hash = createHash('sha256');
  if (pe.certificateSize === 0) {
    hash.update(canonical);
  } else {
    hash.update(canonical.subarray(0, pe.certificateOffset));
    hash.update(canonical.subarray(pe.certificateOffset + pe.certificateSize));
  }
  return hash.digest('hex');
}

export async function canonicalPeFileSha256(candidate) {
  return canonicalPeSha256(await fsp.readFile(candidate));
}

export async function patchTauriBundleTypeNsisFile(source, destination = source) {
  const patched = patchTauriBundleTypeNsis(await fsp.readFile(source));
  await fsp.writeFile(destination, patched.bytes);
  return { previous: patched.previous, targetOffset: patched.targetOffset };
}
