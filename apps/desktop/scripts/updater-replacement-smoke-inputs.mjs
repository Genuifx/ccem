import path from 'node:path';

import {
  readRegularJson,
  sha256File,
} from './updater-replacement-smoke-runner-core.mjs';
import {
  validateWindowsInstalledTreeInventory,
} from './windows-mode2-production-smoke-contract.mjs';

function fail(message) {
  throw new Error(`[run-updater-replacement-smoke] ${message}`);
}

export async function validateUpdaterReplacementPayload(payloadRoot, target, sourceCommit) {
  const root = path.resolve(payloadRoot);
  const [manifest, inventory] = await Promise.all([
    readRegularJson(path.join(root, 'payload-manifest.json'), 'immutable payload manifest'),
    readRegularJson(path.join(root, 'inventory.json'), 'immutable release inventory'),
  ]);
  if (
    manifest.schemaVersion !== 1
    || manifest.target !== target
    || manifest.sourceCommit !== sourceCommit
    || inventory.platform !== target
    || inventory.sourceCommit !== sourceCommit
    || inventory.appVersion !== manifest.appVersion
    || inventory.mode2Included !== true
  ) {
    fail('immutable payload manifest and inventory identity mismatch');
  }
  const updater = manifest.assets?.updater;
  const signature = manifest.assets?.updaterSignature;
  if (!updater || !signature || signature.fileName !== `${updater.fileName}.sig`) {
    fail('immutable payload lacks exact updater and signature roles');
  }
  const artifactPath = path.join(root, ...updater.relativePath.split('/'));
  const signaturePath = path.join(root, ...signature.relativePath.split('/'));
  if (
    await sha256File(artifactPath) !== updater.sha256
    || await sha256File(signaturePath) !== signature.sha256
    || inventory.artifacts?.updater?.sha256 !== updater.sha256
    || inventory.artifacts?.updaterSignature?.sha256 !== signature.sha256
  ) {
    fail('immutable payload updater bytes differ from inventory');
  }
  if (target.endsWith('pc-windows-msvc')) {
    validateWindowsInstalledTreeInventory(
      inventory.installedTree,
      'immutable payload Windows installed tree',
    );
  }
  return { root, manifest, inventory, updater, signature, artifactPath, signaturePath };
}

export async function loadUpdaterPublicKeyConfig(tauriConfigPath) {
  const config = await readRegularJson(tauriConfigPath, 'current tauri config');
  const publicKey = config?.plugins?.updater?.pubkey;
  const productName = config?.productName;
  const bundleIdentifier = config?.identifier;
  if (!publicKey || publicKey.trim() !== publicKey || !productName || !bundleIdentifier) {
    fail('current tauri config lacks exact updater pubkey/productName/identifier');
  }
  return { publicKey, productName, bundleIdentifier };
}
