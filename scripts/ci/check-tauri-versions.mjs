#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = process.argv[2] ?? fileURLToPath(new URL('../../', import.meta.url));

function releaseLine(version, label) {
  const match = typeof version === 'string'
    && version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u);
  if (!match) throw new Error(`${label} has no valid installed version: ${String(version)}`);
  return `${match[1]}.${match[2]}`;
}

try {
  const cargoLock = readFileSync(join(repoRoot, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8');
  const tauriPackages = cargoLock.split(/^\[\[package\]\]\s*$/mu)
    .filter((block) => /^name\s*=\s*"tauri"\s*$/mu.test(block));
  if (tauriPackages.length !== 1) {
    throw new Error('Cargo.lock must contain exactly one tauri package');
  }
  const rustVersion = tauriPackages[0].match(/^version\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  const apiPackage = JSON.parse(readFileSync(
    join(repoRoot, 'apps/desktop/node_modules/@tauri-apps/api/package.json'), 'utf8',
  ));
  const apiVersion = apiPackage.version;
  // Tauri CLI compares major/minor, allowing the Rust and NPM patch versions to differ.
  // https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.9.6/crates/tauri-cli/src/info/plugins.rs
  if (releaseLine(rustVersion, 'tauri') !== releaseLine(apiVersion, '@tauri-apps/api')) {
    throw new Error(`tauri (v${rustVersion}) : @tauri-apps/api (v${apiVersion}); major/minor releases must match`);
  }
  console.log(`Tauri versions are aligned: tauri ${rustVersion}, @tauri-apps/api ${apiVersion}.`);
} catch (error) {
  console.error(`Tauri version check failed: ${error.message}`);
  process.exitCode = 1;
}
