import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTauriUpdaterSignatureBytes } from '../../apps/desktop/scripts/verify-tauri-updater-signature.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releasePrefix = 'https://github.com/Genuifx/ccem/releases/download/';
const archiveName = 'hermes-macos-aarch64.zip';
const keyId = 'ccem-hermes-runtime-2026-01';
const fail = (message) => { throw new Error(`[hermes-release] ${message}`); };

export async function loadReleaseConfig(root = repoRoot) {
  const source = JSON.parse(await fs.readFile(path.join(root, 'apps/desktop/src-tauri/hermes-runtime-source.json'), 'utf8'));
  if (source.schemaVersion !== 1 || !/^\d+\.\d+\.\d+\.\d+$/u.test(source.version)
      || !Number.isSafeInteger(source.sequence) || source.sequence < 1
      || source.manifestUrl !== `${releasePrefix}${source.version}/manifest.json`) {
    fail('expected an immutable numeric component version and its exact GitHub manifest URL');
  }
  const config = JSON.parse(await fs.readFile(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const encodedPublicKey = config.plugins?.updater?.pubkey;
  if (typeof encodedPublicKey !== 'string') fail('the existing publisher public key is required');
  const publicKey = Buffer.from(encodedPublicKey, 'base64').toString('utf8');
  const lines = publicKey.trim().split(/\r?\n/u);
  const packet = Buffer.from(lines[1] ?? '', 'base64');
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment: ') || packet.length !== 42
      || packet[0] !== 0x45 || ![0x44, 0x64].includes(packet[1])) fail('invalid pinned publisher public key');
  return { ...source, encodedPublicKey, publicKey };
}

export function isGitHubReleaseAsset(value) {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'github.com' && (!url.port || url.port === '443')
    && !url.username && !url.password && !url.search && !url.hash
    && /^\/Genuifx\/ccem\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(url.pathname);
}

export function allowedRedirect(initial, destination, hops) {
  const url = new URL(destination);
  return isGitHubReleaseAsset(initial) && hops <= 3
    && url.protocol === 'https:' && url.hostname === 'release-assets.githubusercontent.com'
    && (!url.port || url.port === '443') && !url.username && !url.password && !url.hash;
}

export async function fetchReleaseAsset(url, { fetchImpl = fetch, maximum = 1024 * 1024, range = false } = {}) {
  if (!isGitHubReleaseAsset(url)) fail('download must start at the pinned CCEM GitHub Release');
  const initial = url;
  const signal = AbortSignal.timeout(30_000);
  for (let hops = 0; hops <= 3; hops += 1) {
    const response = await fetchImpl(url, { redirect: 'manual', signal,
      headers: range ? { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' } : { 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) fail('missing Release asset redirect');
      const next = new URL(location, url).href;
      if (!allowedRedirect(initial, next, hops + 1)) fail('untrusted Release asset redirect');
      url = next;
      continue;
    }
    if (response.status !== (range ? 206 : 200)) {
      await response.body?.cancel();
      fail(`Release asset is unavailable (HTTP ${response.status})`);
    }
    if (Number(response.headers.get('content-length')) > maximum) {
      await response.body?.cancel();
      fail('Release asset exceeds its size limit');
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximum) fail('Release asset exceeds its size limit');
      chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), headers: response.headers };
  }
  fail('too many Release asset redirects');
}

export function verifyManifest(config, bytes, signature) {
  if (!bytes.length || bytes.length > 1024 * 1024 || signature.length > 16 * 1024) fail('manifest size limit');
  verifyTauriUpdaterSignatureBytes({ artifactDigest: createHash('blake2b512').update(bytes).digest(),
    encodedSignature: signature, encodedPublicKey: config.encodedPublicKey });
  const manifest = JSON.parse(bytes.toString('utf8'));
  const artifact = manifest.artifact;
  if (manifest.schema_version !== 1 || manifest.signing_key_id !== keyId
      || manifest.sequence !== config.sequence || manifest.minimum_protocol_version !== 1
      || artifact?.platform !== 'macos' || artifact.architecture !== 'aarch64'
      || artifact.version !== config.version || artifact.minimum_os_version !== '14.0'
      || artifact.source_url !== `${releasePrefix}${config.version}/${archiveName}`
      || artifact.product_identity?.product_name !== 'CCEM Hermes Runtime'
      || artifact.product_identity.product_version !== config.version
      || artifact.layout?.root_directory !== 'hermes-runtime'
      || artifact.layout.executable?.relative_path !== 'python/bin/python3.11'
      || !/^[a-f0-9]{64}$/u.test(artifact.archive?.sha256 ?? '')
      || !/^[a-f0-9]{64}$/u.test(artifact.layout.executable.sha256 ?? '')
      || !Number.isSafeInteger(artifact.archive.byte_size) || artifact.archive.byte_size < 1
      || artifact.archive.byte_size > 1024 * 1024 * 1024
      || !Number.isSafeInteger(artifact.layout.executable.byte_size) || artifact.layout.executable.byte_size < 1
      || artifact.archive.format !== 'zip'
      || !Number.isSafeInteger(artifact.archive.max_entries) || artifact.archive.max_entries < 1 || artifact.archive.max_entries > 60_000
      || !Number.isSafeInteger(artifact.archive.max_unpacked_bytes) || artifact.archive.max_unpacked_bytes < artifact.archive.byte_size
      || artifact.archive.max_unpacked_bytes > 4 * 1024 * 1024 * 1024
      || !Number.isSafeInteger(artifact.archive.max_file_bytes) || artifact.archive.max_file_bytes < artifact.layout.executable.byte_size
      || artifact.archive.max_file_bytes > artifact.archive.max_unpacked_bytes) {
    fail('signed manifest does not match the reviewed component release');
  }
  return manifest;
}

export async function verifyLocalRelease(config, directory) {
  const bytes = await fs.readFile(path.join(directory, 'manifest.json'));
  const signature = await fs.readFile(path.join(directory, 'manifest.json.sig'), 'utf8');
  const manifest = verifyManifest(config, bytes, signature);
  const candidate = path.join(directory, archiveName);
  const handle = await fs.open(candidate, 'r');
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of handle.createReadStream()) { size += chunk.length; hash.update(chunk); }
  } finally { await handle.close().catch(() => {}); }
  if (size !== manifest.artifact.archive.byte_size || hash.digest('hex') !== manifest.artifact.archive.sha256) {
    fail('runtime archive does not match the signed manifest');
  }
  return manifest;
}
