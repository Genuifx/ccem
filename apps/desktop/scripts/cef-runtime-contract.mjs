import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CEF_CRATE_VERSION = '150.0.0';
export const CEF_RUNTIME_VERSION = '150.0.10';
export const CEF_FULL_VERSION = '150.0.10+g8042e43+chromium-150.0.7871.101';
export const CEF_LICENSE_SOURCE_COMMIT = '8042e43';
export const CEF_LICENSE_SHA256 = '058c3827ffb827ff3edda471ae7e1bb1d1aa5931985f0126043ccd33409e792f';
export const CEF_LEGAL_DIRECTORY = 'third-party/cef';
export const CEF_LEGAL_FILES = Object.freeze(['LICENSE.txt', 'CREDITS.html']);
export const CEF_SOURCE_TREE_HASH_ALGORITHM = 'ccem-cef-source-tree-sha256-v1';
export const CEF_SOURCE_FILE_SET_HASH_ALGORITHM = 'ccem-cef-source-file-set-sha256-v1';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptsDir, '..');
export const CEF_LICENSE_SOURCE_PATH = path.join(desktopDir, 'third-party', 'cef', 'LICENSE.txt');

// Archive names/SHA-1 values and CREDITS hashes are pinned from the official
// CEF build index and the corresponding minimal archives for CEF 8042e43.
// CREDITS differs between macOS and Windows, so the final bundle gate is
// deliberately target-specific instead of assuming one cross-platform file.
const archivePrefix = `cef_binary_${CEF_FULL_VERSION}`;
export const CEF_ARCHIVE_SPECS = Object.freeze({
  'aarch64-apple-darwin': Object.freeze({
    type: 'minimal',
    name: `${archivePrefix}_macosarm64_minimal.tar.bz2`,
    sha1: 'e73f7ce767420791b1965e15816a955d88cf1f9a',
    sha256: 'ef5fe464184e2e00381a2cc73e911bb4b8cc219f0e6f9fd610af0bc89d0ea58d',
    frameworkExecutableSha256: '63ee61031db37123461871aacb6845f85a17176dd75287a003976e0bad118453',
    brandedFrameworkExecutableSha256: 'ee0b6a00537864190ac9e20b08d614bb1541d400fbba5f98913db2959ef32661',
    frameworkTreeSha256: '089929d35faffa2aebe860f8135dc19e1f0579cde931afa62377b1a5990052e4',
    brandedFrameworkTreeSha256: '36cb7e699c3258006025b5d3cc7a282a46dcb231845f657f85f318869fa0c4a6',
    safeStorageByteOffset: 187863145,
    creditsSha256: '496533b09217fe29c4b142e23e796b9d6b95bfdb3208d02d54b487535b341480',
  }),
  'x86_64-apple-darwin': Object.freeze({
    type: 'minimal',
    name: `${archivePrefix}_macosx64_minimal.tar.bz2`,
    sha1: '13e95f8bd0e13abe5283f67537d18b1b22f38ce7',
    sha256: '2edf0d7deef879ccbffd5d1cae5924b1243f26a7b862cbfcac801dcb4fbba46b',
    frameworkExecutableSha256: '5c22cd97fe1e1a4daa43b62821934a66bda4090d26942c1d7106c8676770865c',
    brandedFrameworkExecutableSha256: '4c5f04ba865c74d476ea8309f14c20f674f3fd738b7076ca49e439651079e2b9',
    frameworkTreeSha256: '7f5e1d36185d9d4502ae914736904fdb113a8aaa448dd711f06a4f9e355191d8',
    brandedFrameworkTreeSha256: 'e13008ce35fedd741a0f38ae9c279771b23ef6a511d2deba2bdd277e7b0eda67',
    safeStorageByteOffset: 210114784,
    creditsSha256: '496533b09217fe29c4b142e23e796b9d6b95bfdb3208d02d54b487535b341480',
  }),
  'x86_64-pc-windows-msvc': Object.freeze({
    type: 'minimal',
    name: `${archivePrefix}_windows64_minimal.tar.bz2`,
    sha1: 'bce95ec52696c6725447fd0bf993cc928aefecd4',
    sha256: 'ff10d09944e976e281b2eaed17a20eaecb60ae5142ee2bd06fe2f7b38a23bf73',
    runtimeFileSetSha256: 'f8f382c4f9c19787574d989eb6a1367f76ec5fdc12b518d208888218dd4c6776',
    runtimeLocaleCount: 220,
    bootstrapSha256: 'eab5d939293a666b210b8f5faec191324a017d6105485cfc45150863607bd367',
    creditsSha256: '333620129bfec11001385ea24d68de049ce0eeb8d012d2a1382b5340d7d62daf',
  }),
});

function fail(message) {
  throw new Error(`[cef-runtime-contract] ${message}`);
}

async function pathType(candidate) {
  try {
    const stat = await fsp.lstat(candidate);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function requireFile(candidate, label) {
  const type = await pathType(candidate);
  if (type !== 'file') fail(`${label} must be a regular file: ${candidate} (${type})`);
}

async function requireDirectory(candidate, label) {
  const type = await pathType(candidate);
  if (type !== 'directory') fail(`${label} must be a real directory: ${candidate} (${type})`);
}

export async function cefFileSha256(candidate) {
  await requireFile(candidate, 'CEF file');
  const hash = createHash('sha256');
  const handle = await fsp.open(candidate, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
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

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function updateHashWithRegularFile(hash, candidate, relative) {
  const metadata = await fsp.lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`CEF source member must be a regular non-symlink file: ${relative}`);
  }
  const relativeBytes = Buffer.from(relative, 'utf8');
  hash.update(encodeU32(relativeBytes.length));
  hash.update(relativeBytes);
  hash.update(encodeU64(metadata.size));
  const handle = await fsp.open(candidate, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function cefDirectoryTreeSha256(root) {
  await requireDirectory(root, 'CEF source tree');
  const hash = createHash('sha256');
  hash.update(`${CEF_SOURCE_TREE_HASH_ALGORITHM}\0`);

  async function visit(current = '') {
    const absolute = current ? path.join(root, ...current.split('/')) : root;
    const entries = await fsp.readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const relative = current ? `${current}/${entry.name}` : entry.name;
      const candidate = path.join(root, ...relative.split('/'));
      const metadata = await fsp.lstat(candidate);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        hash.update(Buffer.from([0x64]));
        const relativeBytes = Buffer.from(relative, 'utf8');
        hash.update(encodeU32(relativeBytes.length));
        hash.update(relativeBytes);
        await visit(relative);
      } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
        hash.update(Buffer.from([0x66]));
        await updateHashWithRegularFile(hash, candidate, relative);
      } else {
        fail(`CEF source tree contains an unsafe member: ${relative}`);
      }
    }
  }

  await visit();
  return hash.digest('hex');
}

export async function cefFileSetSha256(root, relatives) {
  await requireDirectory(root, 'CEF source file-set root');
  if (!Array.isArray(relatives) || relatives.length === 0) {
    fail('CEF source file set must contain at least one path');
  }
  const normalized = [...new Set(relatives)].sort(compareUtf8);
  if (normalized.length !== relatives.length) fail('CEF source file set contains duplicate paths');
  const hash = createHash('sha256');
  hash.update(`${CEF_SOURCE_FILE_SET_HASH_ALGORITHM}\0`);
  for (const relative of normalized) {
    if (
      typeof relative !== 'string'
      || relative.length === 0
      || path.posix.normalize(relative) !== relative
      || path.posix.isAbsolute(relative)
      || relative.split('/').includes('..')
    ) {
      fail(`CEF source file set contains an unsafe path: ${relative}`);
    }
    await updateHashWithRegularFile(
      hash,
      path.join(root, ...relative.split('/')),
      relative,
    );
  }
  return hash.digest('hex');
}

export async function verifyPinnedCefArchive(candidate, target) {
  const expected = cefArchiveSpec(target);
  await requireFile(candidate, 'pinned CEF archive');
  const actual = await cefFileSha256(candidate);
  if (actual !== expected.sha256) {
    fail(`CEF archive SHA-256 mismatch for ${target}: expected ${expected.sha256}, found ${actual}`);
  }
  return { name: expected.name, sha1: expected.sha1, sha256: actual };
}

export function cefArchiveSpec(target) {
  const spec = CEF_ARCHIVE_SPECS[target];
  if (!spec) fail(`unsupported CEF release target ${target}`);
  return spec;
}

export async function readPinnedCefArchiveIdentity(runtimeRoot, target) {
  const candidate = path.join(runtimeRoot, 'archive.json');
  await requireFile(candidate, 'CEF archive identity');
  let archive;
  try {
    archive = JSON.parse(await fsp.readFile(candidate, 'utf8'));
  } catch (error) {
    fail(`CEF archive identity is invalid JSON: ${error.message}`);
  }
  const expected = cefArchiveSpec(target);
  const actualKeys = archive && typeof archive === 'object' && !Array.isArray(archive)
    ? Object.keys(archive).sort()
    : [];
  if (
    JSON.stringify(actualKeys) !== JSON.stringify(['name', 'sha1', 'type'])
    || archive.type !== expected.type
    || archive.name !== expected.name
    || archive.sha1 !== expected.sha1
  ) {
    fail(`CEF archive identity must exactly match ${expected.name} (${expected.sha1})`);
  }
  return { ...archive };
}

async function validateLicenseSource() {
  await requireFile(CEF_LICENSE_SOURCE_PATH, 'pinned CEF LICENSE.txt source');
  const sha256 = await cefFileSha256(CEF_LICENSE_SOURCE_PATH);
  if (sha256 !== CEF_LICENSE_SHA256) {
    fail(`CEF LICENSE.txt must match upstream commit ${CEF_LICENSE_SOURCE_COMMIT}`);
  }
  return sha256;
}

export async function inspectCefArchiveLegalSource(runtimeRoot, target, {
  requirePinnedCredits = false,
} = {}) {
  await requireDirectory(runtimeRoot, 'CEF archive root');
  const archive = await readPinnedCefArchiveIdentity(runtimeRoot, target);
  const creditsPath = path.join(runtimeRoot, 'CREDITS.html');
  await requireFile(creditsPath, 'CEF archive CREDITS.html');
  const creditsSha256 = await cefFileSha256(creditsPath);
  const expectedCreditsSha256 = cefArchiveSpec(target).creditsSha256;
  if (requirePinnedCredits && creditsSha256 !== expectedCreditsSha256) {
    fail(`CEF CREDITS.html does not match the verified ${archive.name} archive`);
  }
  return {
    archive,
    licenseSha256: await validateLicenseSource(),
    creditsPath,
    creditsSha256,
  };
}

export async function stageCefLegalFiles({ runtimeRoot, outputRoot, target }) {
  const source = await inspectCefArchiveLegalSource(runtimeRoot, target);
  const destination = path.join(outputRoot, ...CEF_LEGAL_DIRECTORY.split('/'));
  await fsp.mkdir(destination, { recursive: true });
  await fsp.copyFile(CEF_LICENSE_SOURCE_PATH, path.join(destination, 'LICENSE.txt'));
  await fsp.copyFile(source.creditsPath, path.join(destination, 'CREDITS.html'));
  return {
    directory: CEF_LEGAL_DIRECTORY,
    license: {
      file: 'LICENSE.txt',
      sourceCommit: CEF_LICENSE_SOURCE_COMMIT,
      sha256: source.licenseSha256,
    },
    credits: {
      file: 'CREDITS.html',
      archiveName: source.archive.name,
      archiveSha1: source.archive.sha1,
      sha256: source.creditsSha256,
    },
  };
}

export async function inspectStagedCefLegalFiles(root, target, expectedLegal, {
  expectedCreditsSha256 = cefArchiveSpec(target).creditsSha256,
} = {}) {
  const thirdPartyRoot = path.join(root, 'third-party');
  await requireDirectory(thirdPartyRoot, 'bundled third-party directory');
  const thirdPartyEntries = await fsp.readdir(thirdPartyRoot, { withFileTypes: true });
  if (
    thirdPartyEntries.length !== 1
    || thirdPartyEntries[0].name !== 'cef'
    || !thirdPartyEntries[0].isDirectory()
    || thirdPartyEntries[0].isSymbolicLink()
  ) {
    fail('bundled third-party directory must contain exactly the real cef directory');
  }
  const legalRoot = path.join(root, ...CEF_LEGAL_DIRECTORY.split('/'));
  await requireDirectory(legalRoot, 'bundled CEF legal directory');
  const entries = await fsp.readdir(legalRoot, { withFileTypes: true });
  const actualNames = entries.map(({ name }) => name).sort();
  if (
    JSON.stringify(actualNames) !== JSON.stringify([...CEF_LEGAL_FILES].sort())
    || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    fail(`CEF legal directory must contain exactly ${CEF_LEGAL_FILES.join(', ')}`);
  }
  const licenseSha256 = await cefFileSha256(path.join(legalRoot, 'LICENSE.txt'));
  const creditsSha256 = await cefFileSha256(path.join(legalRoot, 'CREDITS.html'));
  const spec = cefArchiveSpec(target);
  const actual = {
    directory: CEF_LEGAL_DIRECTORY,
    license: {
      file: 'LICENSE.txt',
      sourceCommit: CEF_LICENSE_SOURCE_COMMIT,
      sha256: licenseSha256,
    },
    credits: {
      file: 'CREDITS.html',
      archiveName: spec.name,
      archiveSha1: spec.sha1,
      sha256: creditsSha256,
    },
  };
  if (licenseSha256 !== CEF_LICENSE_SHA256) {
    fail(`bundled CEF LICENSE.txt must match upstream commit ${CEF_LICENSE_SOURCE_COMMIT}`);
  }
  if (creditsSha256 !== expectedCreditsSha256) {
    fail(`bundled CEF CREDITS.html does not match the verified ${spec.name} archive`);
  }
  if (expectedLegal && JSON.stringify(actual) !== JSON.stringify(expectedLegal)) {
    fail('bundled CEF legal files do not match the pinned staging manifest');
  }
  return actual;
}
