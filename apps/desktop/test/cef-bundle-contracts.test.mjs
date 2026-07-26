import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  compareMacCefFrameworkTrees,
  fingerprintMacCefFramework,
  requiredMacCefFrameworkFiles,
} from '../scripts/macos-cef-bundle-contract.mjs';
import {
  CEF_LEGAL_DIRECTORY,
  CEF_LICENSE_SHA256,
  cefArchiveSpec,
  inspectStagedCefLegalFiles,
  stageCefLegalFiles,
} from '../scripts/cef-runtime-contract.mjs';
import { inspectWindowsLocaleInventory } from '../scripts/verify-mode2-release-inventory.mjs';

const macTarget = 'aarch64-apple-darwin';

function createSignedMachOFixture({
  codeByte = 0x42,
  signature = Buffer.alloc(32, 0xa5),
} = {}) {
  const signatureOffset = 128;
  const bytes = Buffer.alloc(signatureOffset + signature.length);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(6, 12);
  bytes.writeUInt32LE(2, 16);
  bytes.writeUInt32LE(88, 20);
  const linkedit = 32;
  bytes.writeUInt32LE(0x19, linkedit);
  bytes.writeUInt32LE(72, linkedit + 4);
  bytes.write('__LINKEDIT', linkedit + 8, 'ascii');
  bytes.writeBigUInt64LE(0x1000n, linkedit + 24);
  bytes.writeBigUInt64LE(BigInt(signature.length + 0x1000), linkedit + 32);
  bytes.writeBigUInt64LE(120n, linkedit + 40);
  bytes.writeBigUInt64LE(BigInt(signature.length + 8), linkedit + 48);
  bytes.writeUInt32LE(1, linkedit + 56);
  bytes.writeUInt32LE(1, linkedit + 60);
  const codeSignature = linkedit + 72;
  bytes.writeUInt32LE(0x1d, codeSignature);
  bytes.writeUInt32LE(16, codeSignature + 4);
  bytes.writeUInt32LE(signatureOffset, codeSignature + 8);
  bytes.writeUInt32LE(signature.length, codeSignature + 12);
  bytes.fill(codeByte, 120, signatureOffset);
  signature.copy(bytes, signatureOffset);
  return bytes;
}

async function writeFramework(root, signature = Buffer.alloc(32, 0xa5)) {
  for (const relative of requiredMacCefFrameworkFiles(macTarget)) {
    const candidate = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await fs.writeFile(
      candidate,
      relative === 'Chromium Embedded Framework'
        ? createSignedMachOFixture({ signature })
        : `fixture:${relative}`,
    );
  }
  const extraLocale = path.join(root, 'Resources', 'fr.lproj', 'locale.pak');
  await fs.mkdir(path.dirname(extraLocale), { recursive: true });
  await fs.writeFile(extraLocale, 'fixture:fr');
}

test('macOS final inventory recursively binds every framework path and canonical content', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-mac-framework-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage.framework');
  const bundled = path.join(root, 'bundle.framework');
  await writeFramework(stage);
  await fs.cp(stage, bundled, { recursive: true });
  await fs.writeFile(
    path.join(bundled, 'Chromium Embedded Framework'),
    createSignedMachOFixture({ signature: Buffer.alloc(64, 0x3c) }),
  );
  await fs.mkdir(path.join(bundled, '_CodeSignature'), { recursive: true });
  await fs.writeFile(path.join(bundled, '_CodeSignature', 'CodeResources'), 'signature metadata');
  await fs.writeFile(path.join(bundled, 'CodeResources'), 'legacy signature metadata');

  const inventory = await compareMacCefFrameworkTrees({
    stageFramework: stage,
    bundledFramework: bundled,
    target: macTarget,
  });
  assert.equal(inventory['Resources/fr.lproj/locale.pak'].type, 'file');
  assert.match(inventory['Chromium Embedded Framework'].fingerprint, /^ccem-macho-code-sha256-v1:/);
  assert.equal(inventory._CodeSignature, undefined);
  assert.equal(inventory.CodeResources, undefined);

  await fs.writeFile(path.join(bundled, 'Resources', 'fr.lproj', 'locale.pak'), 'tampered');
  await assert.rejects(
    compareMacCefFrameworkTrees({ stageFramework: stage, bundledFramework: bundled, target: macTarget }),
    /member differs from stage: Resources\/fr\.lproj\/locale\.pak/,
  );
});

test('macOS framework inventory safely binds prototype-like path names', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-mac-framework-prototype-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage.framework');
  const bundled = path.join(root, 'bundle.framework');
  await writeFramework(stage);
  await fs.writeFile(path.join(stage, 'toString'), 'runtime toString member');
  await fs.writeFile(path.join(stage, '__proto__'), 'runtime __proto__ member');
  await fs.cp(stage, bundled, { recursive: true });

  const inventory = await compareMacCefFrameworkTrees({
    stageFramework: stage,
    bundledFramework: bundled,
    target: macTarget,
  });
  assert.equal(Object.getPrototypeOf(inventory), null);
  assert.equal(Object.hasOwn(inventory, 'toString'), true);
  assert.equal(Object.hasOwn(inventory, '__proto__'), true);
  assert.equal(inventory.toString.type, 'file');
  assert.equal(inventory.__proto__.type, 'file');

  await fs.writeFile(path.join(bundled, '__proto__'), 'tampered');
  await assert.rejects(
    compareMacCefFrameworkTrees({ stageFramework: stage, bundledFramework: bundled, target: macTarget }),
    /member differs from stage: __proto__/,
  );
  await fs.copyFile(path.join(stage, '__proto__'), path.join(bundled, '__proto__'));
  await fs.rm(path.join(bundled, 'toString'));
  await assert.rejects(
    compareMacCefFrameworkTrees({ stageFramework: stage, bundledFramework: bundled, target: macTarget }),
    /bundled framework is missing toString/,
  );
});

test('macOS signing exclusions do not hide nested CodeResources tampering', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-mac-framework-code-resources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage.framework');
  const bundled = path.join(root, 'bundle.framework');
  await writeFramework(stage);
  await fs.writeFile(path.join(stage, 'Resources', 'CodeResources'), 'runtime resource');
  await fs.cp(stage, bundled, { recursive: true });
  await fs.mkdir(path.join(bundled, '_CodeSignature'), { recursive: true });
  await fs.writeFile(path.join(bundled, '_CodeSignature', 'CodeResources'), 'signature metadata');
  await fs.writeFile(path.join(bundled, 'CodeResources'), 'legacy signature metadata');

  await fs.writeFile(path.join(bundled, 'Resources', 'CodeResources'), 'tampered');
  await assert.rejects(
    compareMacCefFrameworkTrees({ stageFramework: stage, bundledFramework: bundled, target: macTarget }),
    /member differs from stage: Resources\/CodeResources/,
  );
});

test('macOS recursive inventory rejects missing, extra, and incomplete framework paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-mac-framework-negative-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage.framework');
  const bundled = path.join(root, 'bundle.framework');
  await writeFramework(stage);
  await fs.cp(stage, bundled, { recursive: true });

  await fs.rm(path.join(bundled, 'Resources', 'fr.lproj', 'locale.pak'));
  await assert.rejects(
    compareMacCefFrameworkTrees({ stageFramework: stage, bundledFramework: bundled, target: macTarget }),
    /missing Resources\/fr\.lproj\/locale\.pak/,
  );
  await fs.cp(stage, bundled, { recursive: true, force: true });
  await fs.writeFile(path.join(bundled, 'Resources', 'unexpected.pak'), 'unexpected');
  await assert.rejects(
    compareMacCefFrameworkTrees({ stageFramework: stage, bundledFramework: bundled, target: macTarget }),
    /unexpected Resources\/unexpected\.pak/,
  );
  await fs.rm(path.join(stage, 'Resources', 'gpu_shader_cache.bin'));
  const fingerprint = await fingerprintMacCefFramework(stage);
  assert.equal(fingerprint['Resources/gpu_shader_cache.bin'], undefined);
  await assert.rejects(
    compareMacCefFrameworkTrees({ stageFramework: stage, bundledFramework: stage, target: macTarget }),
    /missing required regular file Resources\/gpu_shader_cache\.bin/,
  );
});

test('Windows final inventory rejects directory, symlink, and non-pak locale entries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-windows-final-locales-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const locales = path.join(root, 'locales');
  await fs.mkdir(locales, { recursive: true });
  await fs.writeFile(path.join(locales, 'en-US.pak'), 'fixture:en-US');
  await fs.writeFile(path.join(locales, 'zh-CN.pak'), 'fixture:zh-CN');
  assert.deepEqual(await inspectWindowsLocaleInventory(root), ['en-US.pak', 'zh-CN.pak']);

  const invalidEntries = [
    ['directory.pak', (candidate) => fs.mkdir(candidate)],
    ['linked.pak', (candidate) => fs.symlink('en-US.pak', candidate)],
    ['README.txt', (candidate) => fs.writeFile(candidate, 'unexpected')],
  ];
  for (const [name, create] of invalidEntries) {
    const candidate = path.join(locales, name);
    await create(candidate);
    await assert.rejects(
      inspectWindowsLocaleInventory(root),
      new RegExp(`only regular locale \\.pak files: ${name.replace('.', '\\.')}\\b`),
    );
    await fs.rm(candidate, { recursive: true, force: true });
  }
});

test('CEF legal bundle is exact, stage-bound, and final-gated to the verified archive', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-cef-legal-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  const stage = path.join(root, 'stage');
  await fs.mkdir(runtime, { recursive: true });
  const spec = cefArchiveSpec(macTarget);
  await fs.writeFile(path.join(runtime, 'archive.json'), `${JSON.stringify({
    type: spec.type,
    name: spec.name,
    sha1: spec.sha1,
  })}\n`);
  const credits = 'fixture archive CREDITS';
  await fs.writeFile(path.join(runtime, 'CREDITS.html'), credits);
  const legal = await stageCefLegalFiles({ runtimeRoot: runtime, outputRoot: stage, target: macTarget });
  const fixtureCreditsSha256 = createHash('sha256').update(credits).digest('hex');
  assert.equal(legal.license.sha256, CEF_LICENSE_SHA256);
  assert.equal(legal.credits.sha256, fixtureCreditsSha256);
  assert.deepEqual(
    await inspectStagedCefLegalFiles(stage, macTarget, legal, {
      expectedCreditsSha256: fixtureCreditsSha256,
    }),
    legal,
  );
  await assert.rejects(
    inspectStagedCefLegalFiles(stage, macTarget, legal),
    /does not match the verified .* archive/,
  );
  await fs.writeFile(path.join(stage, ...CEF_LEGAL_DIRECTORY.split('/'), 'NOTICE.txt'), 'unexpected');
  await assert.rejects(
    inspectStagedCefLegalFiles(stage, macTarget, legal, {
      expectedCreditsSha256: fixtureCreditsSha256,
    }),
    /must contain exactly LICENSE\.txt, CREDITS\.html/,
  );
  await fs.rm(path.join(stage, ...CEF_LEGAL_DIRECTORY.split('/'), 'NOTICE.txt'));
  await fs.writeFile(path.join(stage, ...CEF_LEGAL_DIRECTORY.split('/'), 'LICENSE.txt'), 'tampered');
  await assert.rejects(
    inspectStagedCefLegalFiles(stage, macTarget, null, {
      expectedCreditsSha256: fixtureCreditsSha256,
    }),
    /LICENSE\.txt must match upstream commit 8042e43/,
  );
});
