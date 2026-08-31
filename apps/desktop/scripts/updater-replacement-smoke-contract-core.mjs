import { createHash } from 'node:crypto';
import path from 'node:path';

export const UPDATER_REPLACEMENT_PROOF_CLASS = 'instrumented-previous-source';
export const UPDATER_REPLACEMENT_TARGETS = Object.freeze({
  macos: Object.freeze(['aarch64-apple-darwin', 'x86_64-apple-darwin']),
  windows: Object.freeze(['aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc']),
});

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const UTC_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

export function fail(message) {
  throw new Error(`[updater-replacement-smoke] ${message}`);
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('evidence contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail('evidence contains a sparse array');
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null)
      || Object.getOwnPropertySymbols(value).length > 0
    ) {
      fail('evidence contains a non-plain object');
    }
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  fail('evidence contains a non-JSON value');
}

export function hashUpdaterReplacementSmokeJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function exactKeys(value, expectedKeys, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length > 0
  ) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} fields differ: ${actual.join(', ')}`);
  }
  return value;
}

export function exactSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be an exact SHA-256`);
  }
  return value;
}

export function exactGitSha(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) {
    fail(`${label} must be an exact Git SHA`);
  }
  return value;
}

export function exactRunNumber(value, label) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) {
    fail(`${label} must be a positive GitHub run number`);
  }
  return value;
}

export function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

export function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

export function exactNonEmptyText(value, label, maximumLength = 512) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${label} must be exact non-empty text`);
  }
  return value;
}

export function exactArtifactFileName(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 255
    || value === '.'
    || value === '..'
    || value.trim() !== value
    || /[\\/\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${label} must be an exact artifact file name`);
  }
  return value;
}

export function parseSemver(value, label) {
  const match = typeof value === 'string' ? value.match(SEMVER_PATTERN) : null;
  if (!match) fail(`${label} must be an exact semantic version`);
  const numericParts = match.slice(1, 4).map(Number);
  if (numericParts.some((part) => !Number.isSafeInteger(part))) {
    fail(`${label} contains an unsafe numeric component`);
  }
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^0\d+$/u.test(part))) {
    fail(`${label} contains a zero-padded prerelease component`);
  }
  return {
    value,
    major: numericParts[0],
    minor: numericParts[1],
    patch: numericParts[2],
    prerelease,
  };
}

function compareSemverIdentifier(left, right) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) return left.length - right.length;
    return compareText(left, right);
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return compareText(left, right);
}

export function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const result = compareSemverIdentifier(left.prerelease[index], right.prerelease[index]);
    if (result !== 0) return result;
  }
  return 0;
}

export function exactUtcMilliseconds(value, label) {
  if (typeof value !== 'string' || !UTC_MILLISECONDS_PATTERN.test(value)) {
    fail(`${label} must be UTC with millisecond precision`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} is not a real UTC timestamp`);
  }
  return parsed;
}

export function exactPlatform(value) {
  if (!Object.hasOwn(UPDATER_REPLACEMENT_TARGETS, value)) {
    fail('platform must be macos or windows');
  }
  return value;
}

export function exactTarget(platform, target) {
  if (!UPDATER_REPLACEMENT_TARGETS[platform].includes(target)) {
    fail(`target ${target} does not belong to platform ${platform}`);
  }
  return target;
}

export function exactAbsolutePath(value, platform, label) {
  const implementation = platform === 'windows' ? path.win32 : path.posix;
  if (
    typeof value !== 'string'
    || !implementation.isAbsolute(value)
    || value.includes('\0')
    || implementation.normalize(value) !== value
    || (platform === 'windows' && !/^[A-Za-z]:\\/u.test(value))
  ) {
    fail(`${label} must be a normalized absolute ${platform} path`);
  }
  if (platform === 'windows') {
    const withoutRoot = value.slice(implementation.parse(value).root.length);
    for (const segment of withoutRoot.split('\\')) {
      if (
        !segment
        || segment.includes(':')
        || /[. ]$/u.test(segment)
        || WINDOWS_RESERVED_NAME.test(segment)
      ) {
        fail(`${label} contains a Windows ADS, reserved name, or trailing dot/space`);
      }
    }
  }
  return value;
}

export function samePath(left, right, platform) {
  if (platform === 'windows') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

export function pathIsInside(candidate, root, platform) {
  const implementation = platform === 'windows' ? path.win32 : path.posix;
  const relative = implementation.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !implementation.isAbsolute(relative));
}

export function assertPathInside(candidate, root, platform, label) {
  if (!pathIsInside(candidate, root, platform)) fail(`${label} must be inside the install root`);
}

export function exactRelativePath(value, platform, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 1024
    || value !== value.normalize('NFC')
    || value.includes('\\')
    || value.startsWith('/')
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    fail(`${label} must be a normalized relative path`);
  }
  if (platform === 'windows') {
    for (const segment of value.split('/')) {
      if (
        segment.includes(':')
        || /[. ]$/u.test(segment)
        || WINDOWS_RESERVED_NAME.test(segment)
      ) {
        fail(`${label} contains a Windows ADS, reserved name, or trailing dot/space`);
      }
    }
  }
  return value;
}

export function validateSortedUniqueRelativePaths(paths, platform, label) {
  if (!Array.isArray(paths)) fail(`${label} must be an array`);
  const validated = paths.map((candidate, index) => (
    exactRelativePath(candidate, platform, `${label} ${index}`)
  ));
  const folded = new Set();
  for (const candidate of validated) {
    const key = candidate.toLowerCase();
    if (folded.has(key)) fail(`${label} contains duplicate or case-colliding paths`);
    folded.add(key);
  }
  const sorted = [...validated].sort(compareText);
  if (JSON.stringify(validated) !== JSON.stringify(sorted)) {
    fail(`${label} must be sorted and duplicate-free`);
  }
  return validated;
}

function cefEntry(relativePath, sha256, platform, label) {
  return {
    relativePath: exactRelativePath(relativePath, platform, `${label} path`),
    type: 'file',
    regularFile: true,
    noLink: true,
    noReparsePoint: true,
    sha256: exactSha256(sha256, `${label} digest`),
  };
}

function normalizeCefFiles(files, platform, label) {
  if (
    !files
    || typeof files !== 'object'
    || Array.isArray(files)
    || (Object.getPrototypeOf(files) !== Object.prototype && Object.getPrototypeOf(files) !== null)
    || Object.getOwnPropertySymbols(files).length > 0
  ) {
    fail(`${label} must be a relative-path to SHA-256 object`);
  }
  const relativePaths = validateSortedUniqueRelativePaths(
    Object.keys(files).sort(compareText),
    platform,
    `${label} paths`,
  );
  if (relativePaths.length === 0) fail(`${label} must not be empty`);
  return relativePaths.map((relativePath) => cefEntry(
    relativePath,
    files[relativePath],
    platform,
    `${label} ${relativePath}`,
  ));
}

function validateCefFileArray(files, platform, label) {
  if (!Array.isArray(files) || files.length === 0) fail(`${label} must be a non-empty array`);
  const entries = files.map((entry, index) => {
    exactKeys(entry, [
      'relativePath', 'type', 'regularFile', 'noLink', 'noReparsePoint', 'sha256',
    ], `${label} ${index}`);
    if (
      entry.type !== 'file'
      || entry.regularFile !== true
      || entry.noLink !== true
      || entry.noReparsePoint !== true
    ) {
      fail(`${label} ${index} must be a regular non-link non-reparse file`);
    }
    return cefEntry(entry.relativePath, entry.sha256, platform, `${label} ${index}`);
  });
  validateSortedUniqueRelativePaths(
    entries.map((entry) => entry.relativePath),
    platform,
    `${label} paths`,
  );
  return entries;
}

export function createUpdaterReplacementCefFingerprint(files, platform = 'macos') {
  exactPlatform(platform);
  const entries = Array.isArray(files)
    ? validateCefFileArray(files, platform, 'CEF inventory')
    : normalizeCefFiles(files, platform, 'CEF inventory');
  const relativePaths = entries.map((entry) => entry.relativePath);
  return {
    pathCount: entries.length,
    pathSetSha256: hashUpdaterReplacementSmokeJson(relativePaths),
    inventorySha256: hashUpdaterReplacementSmokeJson(entries),
    relativePaths,
    files: entries,
  };
}

export function validateArtifactExpectation(value, label) {
  exactKeys(value, ['fileName', 'sha256'], label);
  return {
    fileName: exactArtifactFileName(value.fileName, `${label} file name`),
    sha256: exactSha256(value.sha256, `${label} digest`),
  };
}

export function createUpdaterReplacementProcessIdentityFingerprint(identity) {
  return hashUpdaterReplacementSmokeJson({
    pid: identity.pid,
    osStartToken: identity.osStartToken,
    canonicalImagePath: identity.canonicalImagePath,
    imageSha256: identity.imageSha256,
    runtimeVersion: identity.runtimeVersion,
    embeddedSourceCommit: identity.embeddedSourceCommit,
    challengeNonce: identity.challengeNonce,
  });
}

export function validateProcessIdentity(value, platform, challengeNonce, label) {
  exactKeys(value, [
    'pid', 'osStartToken', 'canonicalImagePath', 'imageSha256', 'runtimeVersion',
    'embeddedSourceCommit', 'challengeNonce', 'processIdentitySha256',
  ], label);
  const identity = {
    pid: positiveInteger(value.pid, `${label} PID`),
    osStartToken: exactNonEmptyText(value.osStartToken, `${label} OS start token`, 128),
    canonicalImagePath: exactAbsolutePath(value.canonicalImagePath, platform, `${label} image path`),
    imageSha256: exactSha256(value.imageSha256, `${label} image digest`),
    runtimeVersion: parseSemver(value.runtimeVersion, `${label} runtime version`).value,
    embeddedSourceCommit: exactGitSha(value.embeddedSourceCommit, `${label} embedded source commit`),
    challengeNonce: exactSha256(value.challengeNonce, `${label} challenge nonce`),
  };
  if (identity.challengeNonce !== challengeNonce) fail(`${label} challenge mismatch`);
  const processIdentitySha256 = exactSha256(
    value.processIdentitySha256,
    `${label} process identity`,
  );
  if (processIdentitySha256 !== createUpdaterReplacementProcessIdentityFingerprint(identity)) {
    fail(`${label} process identity digest mismatch`);
  }
  return { ...identity, processIdentitySha256 };
}

export function compactProcessIdentity(identity) {
  return {
    pid: identity.pid,
    osStartToken: identity.osStartToken,
    canonicalImagePath: identity.canonicalImagePath,
    imageSha256: identity.imageSha256,
    processIdentitySha256: identity.processIdentitySha256,
  };
}
