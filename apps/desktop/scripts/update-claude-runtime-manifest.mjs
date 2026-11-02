import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestPath = path.join(repoRoot, 'apps/desktop/src-tauri/resources/claude-runtime-manifest.json');
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;

export function packageName(platform) {
  if (!PLATFORMS.includes(platform)) throw new Error(`Unsupported runtime platform: ${platform}`);
  return `@anthropic-ai/claude-agent-sdk-${platform}`;
}

export function packageUrl(platform, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected an exact SDK version');
  return `https://registry.npmjs.org/${packageName(platform)}/-/claude-agent-sdk-${platform}-${version}.tgz`;
}

export function lockIntegrity(lockText, name, version) {
  const marker = `  '${name}@${version}':\n`;
  const start = lockText.indexOf(marker);
  if (start < 0) throw new Error(`Package missing from pnpm-lock.yaml: ${name}@${version}`);
  const match = lockText.slice(start + marker.length).match(/^    resolution: \{integrity: (sha512-[A-Za-z0-9+/]{86}==)\}/);
  if (!match) throw new Error(`Missing SHA-512 integrity in pnpm-lock.yaml: ${name}`);
  return match[1];
}

export function validateMetadata(metadata, platform, sdk, lockText) {
  const name = packageName(platform);
  if (metadata.name !== name || metadata.version !== sdk.version
      || sdk.optionalDependencies?.[name] !== sdk.version) {
    throw new Error(`SDK native package version mismatch: ${name}`);
  }
  const expectedIntegrity = lockIntegrity(lockText, name, sdk.version);
  if (metadata.dist?.tarball !== packageUrl(platform, sdk.version)
      || metadata.dist?.integrity !== expectedIntegrity) {
    throw new Error(`Registry source disagrees with the reviewed lockfile: ${name}`);
  }
  return expectedIntegrity;
}

export function validatePinnedManifest(manifest, sdk, lockText) {
  if (manifest.schemaVersion !== 1 || manifest.sdkVersion !== sdk.version
      || manifest.claudeVersion !== sdk.claudeCodeVersion
      || manifest.minimumSystemVersion !== sdk.claudeCodeVersion) {
    throw new Error('Claude runtime manifest does not match the installed Agent SDK; regenerate and review it');
  }
  if (manifest.packages?.length !== PLATFORMS.length) throw new Error('Incomplete Claude runtime platform set');
  for (const platform of PLATFORMS) {
    const entry = manifest.packages.find((item) => item.platform === platform);
    if (!entry || entry.url !== packageUrl(platform, sdk.version)
        || entry.integrity !== lockIntegrity(lockText, packageName(platform), sdk.version)
        || entry.binaryPath !== `package/claude${platform.startsWith('win32') ? '.exe' : ''}`
        || !/^[a-f0-9]{64}$/.test(entry.binarySha256 ?? '')
        || !Number.isSafeInteger(entry.archiveBytes) || entry.archiveBytes <= 0 || entry.archiveBytes > MAX_ARCHIVE_BYTES
        || !Number.isSafeInteger(entry.binaryBytes) || entry.binaryBytes <= 0 || entry.binaryBytes > MAX_BINARY_BYTES
        || (platform.startsWith('darwin') && entry.minimumOsVersion !== '13.0')) {
      throw new Error(`Invalid pinned Claude runtime source: ${platform}`);
    }
  }
}

async function hashFile(file, algorithm) {
  const hash = createHash(algorithm);
  const handle = await fs.open(file);
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash;
}

// Hash only the executable from an integrity-verified archive. No extracted file
// or downloaded script is executed by this maintainer tool.
export async function inspectArchive(file, expectedIntegrity, binaryPath) {
  const actual = `sha512-${(await hashFile(file, 'sha512')).digest('base64')}`;
  if (actual !== expectedIntegrity) throw new Error('Claude runtime archive integrity mismatch');
  if (!/^package\/claude(?:\.exe)?$/.test(binaryPath)) throw new Error('Unexpected native executable path');
  const result = await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xOzf', file, binaryPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const hash = createHash('sha256');
    let bytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BINARY_BYTES) child.kill();
      else hash.update(chunk);
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || bytes === 0 || bytes > MAX_BINARY_BYTES) reject(new Error(`Cannot inspect Claude executable: ${stderr || code}`));
      else resolve({ binarySha256: hash.digest('hex'), binaryBytes: bytes });
    });
  });
  return { ...result, archiveBytes: (await fs.stat(file)).size };
}

async function download(url, destination, integrity) {
  try {
    if (`sha512-${(await hashFile(destination, 'sha512')).digest('base64')}` === integrity) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`);
  const temporary = `${destination}.part`;
  const handle = await fs.open(temporary, 'w');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) throw new Error('Claude runtime archive exceeds size limit');
      await handle.writeFile(chunk);
    }
  } finally {
    await handle.close();
  }
  if (`sha512-${(await hashFile(temporary, 'sha512')).digest('base64')}` !== integrity) {
    await fs.rm(temporary, { force: true });
    throw new Error('Downloaded archive disagrees with pnpm-lock.yaml');
  }
  await fs.rename(temporary, destination);
}

async function main() {
  const sdk = JSON.parse(await fs.readFile(path.join(repoRoot, 'packages/native-runtime-helper/node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'));
  const lockText = await fs.readFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  if (process.argv.includes('--check')) {
    validatePinnedManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')), sdk, lockText);
    console.log(`Claude runtime manifest matches Agent SDK ${sdk.version} / Claude ${sdk.claudeCodeVersion}`);
    return;
  }
  if (process.argv.length > 2) throw new Error('Usage: node update-claude-runtime-manifest.mjs [--check]');
  const cache = path.join(repoRoot, '.artifacts/claude-runtime/source-packages');
  await fs.mkdir(cache, { recursive: true });
  const packages = [];
  for (const platform of PLATFORMS) {
    const response = await fetch(`https://registry.npmjs.org/${packageName(platform)}/${sdk.version}`, {
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Registry metadata failed: ${response.status}`);
    const metadata = await response.json();
    const integrity = validateMetadata(metadata, platform, sdk, lockText);
    const archive = path.join(cache, `${platform}-${sdk.version}.tgz`);
    const url = packageUrl(platform, sdk.version);
    await download(url, archive, integrity);
    const binaryPath = `package/claude${platform.startsWith('win32') ? '.exe' : ''}`;
    packages.push({
      platform, url, integrity, binaryPath,
      ...await inspectArchive(archive, integrity, binaryPath),
      ...(platform.startsWith('darwin') ? { minimumOsVersion: '13.0' } : {}),
    });
    console.log(`Verified ${platform}: ${packages.at(-1).archiveBytes} archive bytes`);
  }
  const manifest = {
    schemaVersion: 1, sdkVersion: sdk.version, claudeVersion: sdk.claudeCodeVersion,
    minimumSystemVersion: sdk.claudeCodeVersion, packages,
  };
  validatePinnedManifest(manifest, sdk, lockText);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updated ${path.relative(repoRoot, manifestPath)}; review hashes and platform requirements before release`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
