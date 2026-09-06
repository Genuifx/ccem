import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../../../scripts/ci/check-tauri-versions.mjs', import.meta.url));

function fixture(t, { rust = '2.11.5', api = '2.11.1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccem-tauri-versions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cargoLock = join(root, 'apps/desktop/src-tauri/Cargo.lock');
  const apiPackage = join(root, 'apps/desktop/node_modules/@tauri-apps/api/package.json');
  mkdirSync(join(root, 'apps/desktop/src-tauri'), { recursive: true });
  mkdirSync(join(root, 'apps/desktop/node_modules/@tauri-apps/api'), { recursive: true });
  writeFileSync(cargoLock, `version = 4\n\n[[package]]\nname = "tauri"\nversion = "${rust}"\n`);
  writeFileSync(apiPackage, JSON.stringify({ name: '@tauri-apps/api', version: api }));
  return {
    cargoLock,
    apiPackage,
    run: () => spawnSync(process.execPath, [script, root], { encoding: 'utf8' }),
  };
}

test('rejects the released Rust 2.11.5 / installed API 2.9.1 mismatch', (t) => {
  const result = fixture(t, { api: '2.9.1' }).run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tauri \(v2\.11\.5\) : @tauri-apps\/api \(v2\.9\.1\)/u);
  assert.match(result.stderr, /major\/minor releases must match/u);
});

test('accepts matching major/minor with different patch versions', (t) => {
  const result = fixture(t).run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tauri 2\.11\.5, @tauri-apps\/api 2\.11\.1/u);
});

test('rejects a different major even when minor versions match', (t) => {
  const result = fixture(t, { api: '3.11.1' }).run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /major\/minor releases must match/u);
});

for (const missing of ['cargoLock', 'apiPackage']) {
  test(`fails closed when ${missing} is missing`, (t) => {
    const project = fixture(t);
    rmSync(project[missing]);
    const result = project.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Tauri version check failed:.*ENOENT/u);
  });
}

test('fails closed when Cargo.lock has no tauri package', (t) => {
  const project = fixture(t);
  writeFileSync(project.cargoLock, 'version = 4\n');
  const result = project.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one tauri package/u);
});

test('fails closed when the installed API has no version', (t) => {
  const project = fixture(t);
  writeFileSync(project.apiPackage, '{}');
  const result = project.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@tauri-apps\/api has no valid installed version/u);
});
