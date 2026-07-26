import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const workspacePathPattern = /^[A-Za-z0-9._@/-]+$/u;

function normalizeWorkspacePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !workspacePathPattern.test(value)
    || value.includes('\\')
    || value.includes('>')
    || path.posix.isAbsolute(value)
  ) {
    throw new Error(`${label} is not a supported repository-relative path.`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.endsWith('/')
  ) {
    throw new Error(`${label} is not a canonical repository-relative path.`);
  }
  return normalized;
}

export function parseWorkspacePackagePatterns(source) {
  if (typeof source !== 'string') {
    throw new Error('pnpm-workspace.yaml must be text.');
  }
  const patterns = [];
  let insidePackages = false;
  let sawPackages = false;

  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!insidePackages) {
      if (/^packages:\s*(?:#.*)?$/u.test(line)) {
        insidePackages = true;
        sawPackages = true;
      }
      continue;
    }
    if (/^\s*(?:#.*)?$/u.test(line)) {
      continue;
    }
    if (/^\S/u.test(line)) {
      break;
    }
    const match = /^\s{2}-\s+(?:'([^']+)'|"([^"]+)"|([^#]+?))\s*(?:#.*)?$/u.exec(line);
    if (!match) {
      throw new Error(
        `pnpm-workspace.yaml packages entry on line ${index + 1} is unsupported.`,
      );
    }
    const value = (match[1] ?? match[2] ?? match[3]).trim();
    if (value.endsWith('/*')) {
      const base = normalizeWorkspacePath(
        value.slice(0, -2),
        `pnpm-workspace.yaml packages entry on line ${index + 1}`,
      );
      patterns.push(`${base}/*`);
      continue;
    }
    if (value.includes('*') || /[?![\]{}]/u.test(value)) {
      throw new Error(
        `pnpm-workspace.yaml packages entry on line ${index + 1} uses an unsupported glob.`,
      );
    }
    patterns.push(normalizeWorkspacePath(
      value,
      `pnpm-workspace.yaml packages entry on line ${index + 1}`,
    ));
  }

  if (!sawPackages || patterns.length === 0) {
    throw new Error('pnpm-workspace.yaml must contain at least one packages entry.');
  }
  if (new Set(patterns).size !== patterns.length) {
    throw new Error('pnpm-workspace.yaml contains duplicate packages entries.');
  }
  return patterns;
}

export function parseLockfileImporterPaths(source) {
  if (typeof source !== 'string') {
    throw new Error('pnpm-lock.yaml must be text.');
  }
  const importers = new Set();
  let insideImporters = false;
  let sawImporters = false;

  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!insideImporters) {
      if (/^importers:\s*(?:#.*)?$/u.test(line)) {
        insideImporters = true;
        sawImporters = true;
      }
      continue;
    }
    if (/^\s*(?:#.*)?$/u.test(line)) {
      continue;
    }
    if (/^\S/u.test(line)) {
      break;
    }
    if (!/^  \S/u.test(line)) {
      continue;
    }
    const match =
      /^  (?:'([A-Za-z0-9._@/-]+)'|"([A-Za-z0-9._@/-]+)"|([A-Za-z0-9._@/-]+)):\s*(?:#.*)?$/u
        .exec(line);
    if (!match) {
      throw new Error(`pnpm-lock.yaml importer on line ${index + 1} is unsupported.`);
    }
    const importer = normalizeWorkspacePath(
      match[1] ?? match[2] ?? match[3],
      `pnpm-lock.yaml importer on line ${index + 1}`,
    );
    if (importers.has(importer)) {
      throw new Error(`pnpm-lock.yaml contains duplicate importer ${importer}.`);
    }
    importers.add(importer);
  }

  if (!sawImporters || importers.size === 0) {
    throw new Error('pnpm-lock.yaml must contain workspace importers.');
  }
  return importers;
}

export function assertExactWorkspacePaths(observed, expected, label) {
  const missing = [...expected].filter(value => !observed.has(value)).sort();
  const unexpected = [...observed].filter(value => !expected.has(value)).sort();
  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }
  const details = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
    unexpected.length > 0 ? `unexpected: ${unexpected.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  throw new Error(`${label} do not match (${details}).`);
}

async function hasWorkspacePackage(repoRoot, workspacePath, readFileImpl) {
  const manifestPath = path.join(repoRoot, workspacePath, 'package.json');
  let source;
  try {
    source = await readFileImpl(manifestPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw new Error(`Failed to read ${workspacePath}/package.json: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(`${workspacePath}/package.json is invalid: ${error.message}`);
  }
  if (
    manifest === null
    || typeof manifest !== 'object'
    || Array.isArray(manifest)
    || typeof manifest.name !== 'string'
    || manifest.name.length === 0
  ) {
    throw new Error(`${workspacePath}/package.json must contain a package name.`);
  }
  return true;
}

export async function loadExpectedWorkspacePaths(
  repoRoot,
  {
    readFileImpl = readFile,
    readdirImpl = readdir,
  } = {},
) {
  const [workspaceSource, lockfileSource] = await Promise.all([
    readFileImpl(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'),
    readFileImpl(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8'),
  ]);
  const expected = new Set(['.']);

  for (const pattern of parseWorkspacePackagePatterns(workspaceSource)) {
    if (!pattern.endsWith('/*')) {
      if (!await hasWorkspacePackage(repoRoot, pattern, readFileImpl)) {
        throw new Error(`Configured workspace ${pattern} has no package.json.`);
      }
      expected.add(pattern);
      continue;
    }

    const base = pattern.slice(0, -2);
    let entries;
    try {
      entries = await readdirImpl(path.join(repoRoot, base), { withFileTypes: true });
    } catch (error) {
      throw new Error(`Failed to enumerate workspace pattern ${pattern}: ${error.message}`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const workspacePath = normalizeWorkspacePath(
        `${base}/${entry.name}`,
        `workspace matched by ${pattern}`,
      );
      if (await hasWorkspacePackage(repoRoot, workspacePath, readFileImpl)) {
        expected.add(workspacePath);
      }
    }
  }

  if (!await hasWorkspacePackage(repoRoot, '.', readFileImpl)) {
    throw new Error('Repository root has no package.json.');
  }
  const lockfileImporters = parseLockfileImporterPaths(lockfileSource);
  assertExactWorkspacePaths(
    lockfileImporters,
    expected,
    'pnpm-lock.yaml importers and configured workspace roots',
  );
  return expected;
}
