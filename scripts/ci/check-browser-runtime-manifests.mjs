#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const repoRoot = new URL('../../', import.meta.url);
const manifestRoot = new URL('apps/desktop/src-tauri/runtime-manifests/', repoRoot);
const sha256Pattern = /^[0-9a-f]{64}$/;
const expected = [
  {
    file: 'macos-aarch64.json',
    platform: 'macos',
    architecture: 'aarch64',
    downloadPlatform: 'mac-arm64',
  },
  {
    file: 'macos-x86_64.json',
    platform: 'macos',
    architecture: 'x86_64',
    downloadPlatform: 'mac-x64',
  },
  {
    file: 'windows-x86_64.json',
    platform: 'windows',
    architecture: 'x86_64',
    downloadPlatform: 'win64',
  },
];

function fail(message) {
  throw new Error(`Browser runtime manifest check failed: ${message}`);
}

function readText(file) {
  return readFileSync(new URL(file, manifestRoot), 'utf8');
}

function assertRelativePath(value, label, { allowParent = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    fail(`${label} must be a non-empty forward-slash relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.')) {
    fail(`${label} contains an empty or current-directory segment`);
  }
  if (!allowParent && parts.includes('..')) {
    fail(`${label} may not contain parent-directory segments`);
  }
  let depth = 0;
  for (const part of parts) {
    if (part === '..') {
      depth -= 1;
    } else {
      depth += 1;
    }
    if (depth < 0) {
      fail(`${label} escapes its candidate root`);
    }
  }
}

function validateSignature(file) {
  const encoded = readText(`${file}.sig`).trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded) || encoded.length > 16_384) {
    fail(`${file}.sig is not a bounded Tauri/minisign envelope`);
  }
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  if (
    !decoded.startsWith('untrusted comment: signature from tauri secret key\n') ||
    !decoded.includes('\ntrusted comment: timestamp:')
  ) {
    fail(`${file}.sig does not decode to a minisign signature`);
  }
}

const publicKey = readText('public-key.pub');
if (
  !publicKey.startsWith('untrusted comment: minisign public key: ') ||
  publicKey.trim().split('\n').length !== 2
) {
  fail('public-key.pub is not a two-line minisign public key');
}

const manifests = expected.map((target) => {
  const manifest = JSON.parse(readText(target.file));
  const artifact = manifest.artifact;
  if (manifest.schema_version !== 1 || manifest.minimum_protocol_version !== 1) {
    fail(`${target.file} uses an unsupported schema or protocol`);
  }
  if (
    !Number.isSafeInteger(manifest.sequence) ||
    manifest.sequence < 1 ||
    manifest.signing_key_id !== 'ccem-browser-runtime-2026-01'
  ) {
    fail(`${target.file} has an invalid signing identity or sequence`);
  }
  if (
    artifact?.platform !== target.platform ||
    artifact?.architecture !== target.architecture
  ) {
    fail(`${target.file} does not match its release target`);
  }
  const expectedUrl =
    `https://storage.googleapis.com/chrome-for-testing-public/${artifact.version}/` +
    `${target.downloadPlatform}/chrome-${target.downloadPlatform}.zip`;
  if (artifact.source_url !== expectedUrl) {
    fail(`${target.file} must use the exact immutable Chrome for Testing URL`);
  }
  if (
    !sha256Pattern.test(artifact.archive?.sha256 ?? '') ||
    !sha256Pattern.test(artifact.layout?.executable?.sha256 ?? '') ||
    !Number.isSafeInteger(artifact.archive?.byte_size) ||
    artifact.archive.byte_size < 1 ||
    !Number.isSafeInteger(artifact.layout?.executable?.byte_size) ||
    artifact.layout.executable.byte_size < 1
  ) {
    fail(`${target.file} is missing exact archive or executable identity`);
  }
  assertRelativePath(artifact.layout.root_directory, `${target.file} root_directory`);
  assertRelativePath(
    artifact.layout.executable.relative_path,
    `${target.file} executable.relative_path`,
  );
  const seenLinks = new Set();
  for (const [index, link] of (artifact.layout.symlinks ?? []).entries()) {
    assertRelativePath(link.path, `${target.file} symlinks[${index}].path`);
    assertRelativePath(link.target, `${target.file} symlinks[${index}].target`, {
      allowParent: true,
    });
    if (seenLinks.has(link.path)) {
      fail(`${target.file} contains a duplicate declared symlink`);
    }
    seenLinks.add(link.path);
  }
  validateSignature(target.file);
  return manifest;
});

const versions = new Set(manifests.map((manifest) => manifest.artifact.version));
const sequences = new Set(manifests.map((manifest) => manifest.sequence));
if (versions.size !== 1 || sequences.size !== 1) {
  fail('all release targets must pin the same browser version and manifest sequence');
}

console.log(
  `Browser runtime manifests pin Chrome for Testing ${[...versions][0]} ` +
    `at sequence ${[...sequences][0]} for ${manifests.length} release targets.`,
);
