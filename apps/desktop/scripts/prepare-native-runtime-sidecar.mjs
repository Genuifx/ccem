import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const helperRoot = path.join(repoRoot, 'packages', 'native-runtime-helper');
const helperDist = path.join(helperRoot, 'dist', 'native-runtime-helper.mjs');
const resourceTarget = path.join(desktopRoot, 'src-tauri', 'resources', 'native-runtime-helper.mjs');
const binariesDir = path.join(desktopRoot, 'src-tauri', 'binaries');

// ---------------------------------------------------------------------------
// Node.js version gate — zstd (node:zlib zstdCompress) requires >= 22.15.0
// ---------------------------------------------------------------------------
const NODE_VERSION_FLOOR = [22, 15, 0];
{
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const current = [major, minor, patch];
  for (let i = 0; i < 3; i++) {
    if (current[i] > NODE_VERSION_FLOOR[i]) break;
    if (current[i] < NODE_VERSION_FLOOR[i]) {
      process.stderr.write(
        `FATAL: prepare-native-runtime-sidecar requires Node.js >= ${NODE_VERSION_FLOOR.join('.')} ` +
        `(for zstd support in DSH history helper). Current: ${process.versions.node}\n`
      );
      process.exit(1);
    }
  }
}

function getTargetTriple() {
  try {
    return execFileSync('rustc', ['--print', 'host-tuple'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    const verbose = execFileSync('rustc', ['-vV'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = verbose.match(/^host:\s+(\S+)$/m);
    if (!match) throw new Error('Failed to determine Rust host target triple.');
    return match[1];
  }
}

function resolveBundledNodeBinary() {
  if (!process.execPath || !fs.existsSync(process.execPath)) {
    throw new Error('Unable to locate the current Node.js executable for sidecar packaging.');
  }
  return process.execPath;
}
function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
}

function stripTrailingWhitespace(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const normalized = content.replace(/[ \t]+$/gm, '');
  if (normalized !== content) fs.writeFileSync(filePath, normalized);
}

// ---------------------------------------------------------------------------
// Build @ccem/native-runtime-helper
// ---------------------------------------------------------------------------
execSync('pnpm --dir ../../ --filter @ccem/native-runtime-helper build', {
  cwd: desktopRoot, stdio: 'inherit',
});

if (!fs.existsSync(helperDist)) {
  throw new Error(`Expected helper output at ${helperDist}`);
}

// ---------------------------------------------------------------------------
// Copy main native-runtime-helper.mjs (session proxy)
// ---------------------------------------------------------------------------
copyFile(helperDist, resourceTarget);
stripTrailingWhitespace(resourceTarget);

// ---------------------------------------------------------------------------
// DSH History Helper — resources/dsh-history/ (exactly 2 files)
//   package.json            — valid ESM package root
//   lib/dsh-history-helper.mjs — bundled entry (--external:koffi, never reached)
// ---------------------------------------------------------------------------
const dshHelperDist = path.join(helperRoot, 'dist', 'dsh-history-helper.mjs');
if (!fs.existsSync(dshHelperDist)) {
  process.stderr.write(
    `FATAL: dsh-history-helper.mjs not found at ${dshHelperDist}\n` +
    `Run 'pnpm --filter @ccem/native-runtime-helper build' first.\n`
  );
  process.exit(1);
}

const dshResourceDir = path.join(desktopRoot, 'src-tauri', 'resources', 'dsh-history');

// Clean previous
if (fs.existsSync(dshResourceDir)) {
  fs.rmSync(dshResourceDir, { recursive: true });
}
// Remove legacy single-file resource if lingering
const legacySingleFile = path.join(desktopRoot, 'src-tauri', 'resources', 'dsh-history-helper.mjs');
if (fs.existsSync(legacySingleFile)) fs.unlinkSync(legacySingleFile);

// Create exactly 2 files
fs.mkdirSync(path.join(dshResourceDir, 'lib'), { recursive: true });

const dshPkg = { name: 'dsh-history', version: '0.1.1-rc.2', private: true, type: 'module' };
fs.writeFileSync(path.join(dshResourceDir, 'package.json'), JSON.stringify(dshPkg, null, 2) + '\n');
fs.copyFileSync(dshHelperDist, path.join(dshResourceDir, 'lib', 'dsh-history-helper.mjs'));
stripTrailingWhitespace(path.join(dshResourceDir, 'lib', 'dsh-history-helper.mjs'));

// Verify exactly 2 files
const allFiles = [];
function walk(dir, base) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(base, ent.name);
    if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
    else allFiles.push(rel);
  }
}
walk(dshResourceDir, '');
if (allFiles.length !== 2 || !allFiles.includes('package.json') || !allFiles.includes(path.join('lib', 'dsh-history-helper.mjs'))) {
  process.stderr.write(`FATAL: resources/dsh-history/ must contain exactly 2 files. Found: ${JSON.stringify(allFiles)}\n`);
  process.exit(1);
}

process.stdout.write(`Prepared resources/dsh-history/ (${allFiles.length} files: ${allFiles.join(', ')})\n`);

// ---------------------------------------------------------------------------
// Node.js sidecar binary
// ---------------------------------------------------------------------------
const ext = process.platform === 'win32' ? '.exe' : '';
const targetTriple = getTargetTriple();
const nodeBinary = resolveBundledNodeBinary();
const sidecarTarget = path.join(binariesDir, `ccem-node-${targetTriple}${ext}`);

copyFile(nodeBinary, sidecarTarget);

process.stdout.write(`Prepared native runtime sidecar for ${targetTriple}\n`);
