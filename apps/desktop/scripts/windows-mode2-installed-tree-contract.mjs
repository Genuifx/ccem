import { createHash } from 'node:crypto';

const WINDOWS_MODE2_MAIN_EXECUTABLE = 'ccem-desktop.exe';

function fail(message) {
  throw new Error(`[windows-mode2-smoke] ${message}`);
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('installed tree contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  fail('installed tree contains a non-JSON value');
}

function hashJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function exactSha256(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? '')) fail(`${label} must be an exact SHA-256`);
  return value;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields differ: ${actual.join(', ')}`);
  }
  return value;
}

function compareWindowsRelativePaths(left, right) {
  const foldedLeft = left.toUpperCase();
  const foldedRight = right.toUpperCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateInstalledTreeRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 32_000
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes('\0')
  ) fail(`${label} must be a canonical installed-tree relative path`);
  const segments = value.split('/');
  for (const segment of segments) {
    if (
      segment.length === 0
      || segment === '.'
      || segment === '..'
      || /[\u0000-\u001f<>:"\\|?*]/u.test(segment)
      || /[ .]$/u.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
    ) fail(`${label} contains an unsupported Windows path segment`);
  }
  return value;
}

function canonicalInstalledTreePaths(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array`);
  const paths = values.map((value) => validateInstalledTreeRelativePath(value, label));
  const sorted = [...paths].sort(compareWindowsRelativePaths);
  if (JSON.stringify(paths) !== JSON.stringify(sorted)) fail(`${label} must be sorted`);
  const identities = new Set();
  for (const candidate of paths) {
    const identity = candidate.toUpperCase();
    if (identities.has(identity)) fail(`${label} contains a case-insensitive duplicate`);
    identities.add(identity);
  }
  return paths;
}

export function createWindowsInstalledTreeInventory({ directories, files }) {
  const canonicalDirectories = canonicalInstalledTreePaths(
    [...(directories ?? [])].sort(compareWindowsRelativePaths),
    'installed-tree directories',
  );
  if (!Array.isArray(files)) fail('installed-tree files must be an array');
  const canonicalFiles = files.map((file) => {
    exactKeys(file, ['relativePath', 'size', 'sha256'], 'installed-tree file');
    const relativePath = validateInstalledTreeRelativePath(file.relativePath, 'installed-tree file path');
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      fail(`installed-tree file size is invalid: ${relativePath}`);
    }
    return {
      relativePath,
      size: file.size,
      sha256: exactSha256(file.sha256, `installed-tree file ${relativePath}`),
    };
  }).sort((left, right) => compareWindowsRelativePaths(left.relativePath, right.relativePath));
  canonicalInstalledTreePaths(canonicalFiles.map((file) => file.relativePath), 'installed-tree file paths');
  const allIdentities = new Set(canonicalDirectories.map((candidate) => candidate.toUpperCase()));
  for (const file of canonicalFiles) {
    const identity = file.relativePath.toUpperCase();
    if (allIdentities.has(identity)) fail('installed tree aliases a directory and file path');
    allIdentities.add(identity);
  }
  const directoriesByIdentity = new Set(canonicalDirectories.map((candidate) => candidate.toUpperCase()));
  for (const candidate of [...canonicalDirectories, ...canonicalFiles.map((file) => file.relativePath)]) {
    const separator = candidate.lastIndexOf('/');
    if (separator > 0 && !directoriesByIdentity.has(candidate.slice(0, separator).toUpperCase())) {
      fail(`installed tree is missing parent directory for ${candidate}`);
    }
  }
  if (!canonicalFiles.some((file) => file.relativePath.toUpperCase() === WINDOWS_MODE2_MAIN_EXECUTABLE.toUpperCase())) {
    fail('installed tree must include the installed main executable');
  }
  const inventory = {
    schemaVersion: 1,
    pathCount: canonicalDirectories.length + canonicalFiles.length,
    directoryCount: canonicalDirectories.length,
    fileCount: canonicalFiles.length,
    pathSetSha256: hashJson({
      directories: canonicalDirectories,
      files: canonicalFiles.map((file) => file.relativePath),
    }),
    directories: canonicalDirectories,
    files: canonicalFiles,
  };
  return { ...inventory, inventorySha256: hashJson(inventory) };
}

export function validateWindowsInstalledTreeInventory(value, label = 'installed tree') {
  exactKeys(value, [
    'schemaVersion', 'pathCount', 'directoryCount', 'fileCount', 'pathSetSha256',
    'inventorySha256', 'directories', 'files',
  ], label);
  if (value.schemaVersion !== 1) fail(`${label} schema version mismatch`);
  const canonical = createWindowsInstalledTreeInventory({
    directories: canonicalInstalledTreePaths(value.directories, `${label} directories`),
    files: value.files,
  });
  if (canonicalJson(value) !== canonicalJson(canonical)) {
    fail(`${label} counts or fingerprints do not bind its exact path inventory`);
  }
  return value;
}
