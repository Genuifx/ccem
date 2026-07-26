import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MACHO_CANONICAL_HASH_ALGORITHM = 'ccem-macho-code-sha256-v1';

const LC_SEGMENT = 0x01;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const MAX_FAT_ARCHITECTURES = 64;

const THIN_MAGICS = new Map([
  ['cefaedfe', { endian: 'little', is64: false }],
  ['feedface', { endian: 'big', is64: false }],
  ['cffaedfe', { endian: 'little', is64: true }],
  ['feedfacf', { endian: 'big', is64: true }],
]);

const FAT_MAGICS = new Map([
  ['cafebabe', { endian: 'big', is64: false }],
  ['bebafeca', { endian: 'little', is64: false }],
  ['cafebabf', { endian: 'big', is64: true }],
  ['bfbafeca', { endian: 'little', is64: true }],
]);

function fail(message) {
  throw new Error(`[macos-macho-integrity] ${message}`);
}

async function requireRegularFile(candidate) {
  let stat;
  try {
    stat = await fsp.lstat(candidate);
  } catch (error) {
    fail(`cannot inspect ${candidate}: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`expected a regular non-symlink file: ${candidate}`);
}

function magicHex(bytes) {
  return bytes.subarray(0, 4).toString('hex');
}

function readU32(bytes, offset, endian) {
  return endian === 'little' ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
}

function readU64(bytes, offset, endian) {
  const value = endian === 'little'
    ? bytes.readBigUInt64LE(offset)
    : bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('64-bit Mach-O offset exceeds JavaScript safe integer range');
  return Number(value);
}

function encodeU32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function encodeU64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

async function readExact(handle, offset, length, label) {
  const bytes = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(bytes, total, length - total, offset + total);
    if (bytesRead === 0) fail(`${label} is truncated`);
    total += bytesRead;
  }
  return bytes;
}

async function hashRange(hash, handle, start, length) {
  if (length === 0) return;
  const stream = handle.createReadStream({
    start,
    end: start + length - 1,
    autoClose: false,
  });
  for await (const chunk of stream) hash.update(chunk);
}

async function sha256(candidate) {
  const hash = createHash('sha256');
  const handle = await fsp.open(candidate, 'r');
  try {
    await hashRange(hash, handle, 0, (await handle.stat()).size);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}

function segmentName(command) {
  const name = command.subarray(8, 24);
  const terminator = name.indexOf(0);
  return name.subarray(0, terminator === -1 ? name.length : terminator).toString('ascii');
}

function normalizeLinkeditCommand(command, cmd, endian) {
  if (cmd === LC_SEGMENT_64) {
    if (command.length < 72) fail('LC_SEGMENT_64 command is truncated');
    if (segmentName(command) !== '__LINKEDIT') return null;
    const extent = {
      vmSize: readU64(command, 32, endian),
      fileOffset: readU64(command, 40, endian),
      fileSize: readU64(command, 48, endian),
    };
    // Code signing may resize both the on-disk and page-rounded __LINKEDIT
    // extent. The bytes outside LC_CODE_SIGNATURE remain part of the digest.
    command.fill(0, 32, 40); // vmsize
    command.fill(0, 48, 56); // filesize
    return extent;
  }
  if (command.length < 56) fail('LC_SEGMENT command is truncated');
  if (segmentName(command) !== '__LINKEDIT') return null;
  const extent = {
    vmSize: readU32(command, 28, endian),
    fileOffset: readU32(command, 32, endian),
    fileSize: readU32(command, 36, endian),
  };
  command.fill(0, 28, 32); // vmsize
  command.fill(0, 36, 40); // filesize
  return extent;
}

async function canonicalThinDigest(handle, slice) {
  const magic = await readExact(handle, slice.offset, 4, 'Mach-O magic');
  const format = THIN_MAGICS.get(magicHex(magic));
  if (!format) fail('fat architecture does not contain a supported Mach-O slice');

  const headerSize = format.is64 ? 32 : 28;
  if (slice.size < headerSize) fail('Mach-O slice is smaller than its header');
  const header = await readExact(handle, slice.offset, headerSize, 'Mach-O header');
  const commandCount = readU32(header, 16, format.endian);
  const commandBytes = readU32(header, 20, format.endian);
  if (commandCount === 0) fail('Mach-O has no load commands');
  if (commandBytes > slice.size - headerSize) fail('Mach-O load commands exceed the slice');

  const normalized = await readExact(
    handle,
    slice.offset,
    headerSize + commandBytes,
    'Mach-O header and load commands',
  );
  let cursor = headerSize;
  let signature = null;
  let linkedit = null;
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > normalized.length) fail(`Mach-O load command ${index} header is truncated`);
    const cmd = readU32(normalized, cursor, format.endian);
    const cmdsize = readU32(normalized, cursor + 4, format.endian);
    if (cmdsize < 8 || cursor + cmdsize > normalized.length) {
      fail(`Mach-O load command ${index} has an invalid size`);
    }
    const command = normalized.subarray(cursor, cursor + cmdsize);
    if (cmd === LC_SEGMENT || cmd === LC_SEGMENT_64) {
      const extent = normalizeLinkeditCommand(command, cmd, format.endian);
      if (extent) {
        if (linkedit) fail('Mach-O contains more than one __LINKEDIT segment');
        linkedit = extent;
      }
    }
    if (cmd === LC_CODE_SIGNATURE) {
      if (signature) fail('Mach-O contains more than one LC_CODE_SIGNATURE command');
      if (cmdsize !== 16) fail('LC_CODE_SIGNATURE command must be exactly 16 bytes');
      signature = {
        offset: readU32(command, 8, format.endian),
        size: readU32(command, 12, format.endian),
      };
      // dataoff and datasize describe the mutable SuperBlob. Their location is
      // framed separately, while their encoded values are removed from the
      // canonical command bytes.
      command.fill(0, 8, 16);
    }
    cursor += cmdsize;
  }
  if (cursor !== normalized.length) fail('Mach-O load command table has unclaimed bytes');
  if (!signature || signature.size === 0) fail('Mach-O is missing a non-empty LC_CODE_SIGNATURE');
  if (!linkedit) fail('Mach-O is missing the __LINKEDIT segment for LC_CODE_SIGNATURE');
  if (signature.offset < normalized.length) fail('Mach-O code signature overlaps headers or load commands');
  if (signature.offset + signature.size > slice.size) fail('Mach-O code signature exceeds the slice');
  if (linkedit.vmSize < linkedit.fileSize) fail('Mach-O __LINKEDIT virtual size is smaller than its file size');
  if (linkedit.fileOffset + linkedit.fileSize !== slice.size) {
    fail('Mach-O __LINKEDIT segment does not terminate at the slice boundary');
  }
  if (
    signature.offset < linkedit.fileOffset
    || signature.offset + signature.size !== linkedit.fileOffset + linkedit.fileSize
  ) {
    fail('Mach-O code signature is not the terminal __LINKEDIT payload');
  }

  const suffixOffset = signature.offset + signature.size;
  const suffixLength = slice.size - suffixOffset;
  const hash = createHash('sha256');
  hash.update(`${MACHO_CANONICAL_HASH_ALGORITHM}\0thin\0`);
  hash.update(encodeU64(signature.offset));
  hash.update(encodeU64(suffixLength));
  hash.update(normalized);
  await hashRange(
    hash,
    handle,
    slice.offset + normalized.length,
    signature.offset - normalized.length,
  );
  // A valid signature is checked separately with native codesign/Gatekeeper.
  // Only its declared blob is omitted; any trailing bytes remain integrity-bound.
  await hashRange(hash, handle, slice.offset + suffixOffset, suffixLength);
  return hash.digest();
}

async function parseFatSlices(handle, fileSize, format) {
  const archSize = format.is64 ? 32 : 20;
  const header = await readExact(handle, 0, 8, 'fat Mach-O header');
  const count = readU32(header, 4, format.endian);
  if (count === 0 || count > MAX_FAT_ARCHITECTURES) {
    fail(`fat Mach-O architecture count must be between 1 and ${MAX_FAT_ARCHITECTURES}`);
  }
  const table = await readExact(handle, 8, count * archSize, 'fat Mach-O architecture table');
  const slices = [];
  for (let index = 0; index < count; index += 1) {
    const cursor = index * archSize;
    const offset = format.is64
      ? readU64(table, cursor + 8, format.endian)
      : readU32(table, cursor + 8, format.endian);
    const size = format.is64
      ? readU64(table, cursor + 16, format.endian)
      : readU32(table, cursor + 12, format.endian);
    const align = readU32(table, cursor + (format.is64 ? 24 : 16), format.endian);
    if (size === 0 || offset < 8 + count * archSize || offset + size > fileSize) {
      fail(`fat Mach-O architecture ${index} has an invalid byte range`);
    }
    slices.push({
      cpuType: readU32(table, cursor, format.endian),
      cpuSubtype: readU32(table, cursor + 4, format.endian),
      align,
      reserved: format.is64 ? readU32(table, cursor + 28, format.endian) : 0,
      offset,
      size,
    });
  }
  const byOffset = [...slices].sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < byOffset.length; index += 1) {
    if (byOffset[index - 1].offset + byOffset[index - 1].size > byOffset[index].offset) {
      fail('fat Mach-O architecture slices overlap');
    }
  }
  return slices;
}

export async function canonicalMachOHash(candidate) {
  await requireRegularFile(candidate);
  const handle = await fsp.open(candidate, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 4) fail(`Mach-O file is missing or truncated: ${candidate}`);
    const magic = await readExact(handle, 0, 4, 'Mach-O magic');
    const thin = THIN_MAGICS.get(magicHex(magic));
    if (thin) {
      return (await canonicalThinDigest(handle, { offset: 0, size: stat.size })).toString('hex');
    }

    const fat = FAT_MAGICS.get(magicHex(magic));
    if (!fat) fail(`unsupported Mach-O magic ${magicHex(magic)}`);
    const slices = await parseFatSlices(handle, stat.size, fat);
    const hash = createHash('sha256');
    hash.update(`${MACHO_CANONICAL_HASH_ALGORITHM}\0fat\0`);
    hash.update(`${fat.endian}\0${fat.is64 ? '64' : '32'}\0`);
    hash.update(encodeU32(slices.length));
    for (const slice of slices) {
      hash.update(encodeU32(slice.cpuType));
      hash.update(encodeU32(slice.cpuSubtype));
      hash.update(encodeU32(slice.align));
      hash.update(encodeU32(slice.reserved));
      hash.update(await canonicalThinDigest(handle, slice));
    }
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function macReleaseFileFingerprint(candidate, { requireMachO = false } = {}) {
  await requireRegularFile(candidate);
  const handle = await fsp.open(candidate, 'r');
  let magic;
  try {
    const stat = await handle.stat();
    magic = stat.size >= 4 ? await readExact(handle, 0, 4, 'file magic') : Buffer.alloc(0);
  } finally {
    await handle.close().catch(() => {});
  }
  const isMachO = THIN_MAGICS.has(magicHex(magic)) || FAT_MAGICS.has(magicHex(magic));
  if (requireMachO && !isMachO) fail(`expected a signed Mach-O file: ${candidate}`);
  return isMachO
    ? `${MACHO_CANONICAL_HASH_ALGORITHM}:${await canonicalMachOHash(candidate)}`
    : `sha256:${await sha256(candidate)}`;
}

export async function fingerprintMacReleaseFiles(root, relatives) {
  const result = {};
  for (const relative of relatives) {
    result[relative] = await macReleaseFileFingerprint(
      path.join(root, ...relative.split('/')),
    );
  }
  return result;
}
