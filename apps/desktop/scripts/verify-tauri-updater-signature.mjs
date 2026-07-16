import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const desktopDir = path.resolve(path.dirname(scriptPath), '..');
const defaultTauriConfig = path.join(desktopDir, 'src-tauri', 'tauri.conf.json');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function fail(message) {
  throw new Error(`[tauri-updater-signature] ${message}`);
}

function decodeBase64(value, label) {
  const normalized = value.trim();
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) {
    fail(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(normalized, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/u, '');
  if (canonical !== normalized.replace(/=+$/u, '')) fail(`${label} is not canonical base64`);
  return decoded;
}

function decodeUtf8Base64(value, label) {
  const decoded = decodeBase64(value, label);
  const text = decoded.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(decoded)) fail(`${label} is not valid UTF-8`);
  return text;
}

function nonEmptyLines(value, label) {
  const lines = value.trim().split(/\r?\n/u);
  if (lines.some((line) => line.length === 0)) fail(`${label} contains an empty line`);
  return lines;
}

function parsePublicKey(encodedPublicKey) {
  const lines = nonEmptyLines(decodeUtf8Base64(encodedPublicKey, 'pinned updater public key'), 'updater public key');
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment: ')) {
    fail('pinned updater public key must use the two-line minisign format');
  }
  const packet = decodeBase64(lines[1], 'minisign public key packet');
  if (packet.length !== 42 || packet[0] !== 0x45 || ![0x44, 0x64].includes(packet[1])) {
    fail('pinned updater public key has an unsupported packet');
  }
  return {
    keyId: packet.subarray(2, 10),
    key: createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, packet.subarray(10, 42)]),
      format: 'der',
      type: 'spki',
    }),
  };
}

function parseSignature(encodedSignature) {
  const lines = nonEmptyLines(decodeUtf8Base64(encodedSignature, 'updater signature'), 'updater signature');
  if (
    lines.length !== 4
    || !lines[0].startsWith('untrusted comment: ')
    || !lines[2].startsWith('trusted comment: ')
  ) {
    fail('updater signature must use the four-line minisign format');
  }
  const packet = decodeBase64(lines[1], 'minisign signature packet');
  const globalSignature = decodeBase64(lines[3], 'minisign global signature');
  if (packet.length !== 74 || globalSignature.length !== 64) {
    fail('updater signature packet has an invalid length');
  }
  // Tauri's current signer emits the pre-hashed ED form. Rejecting legacy Ed
  // keeps verification streaming and fail-closed for release-sized artifacts.
  if (packet[0] !== 0x45 || packet[1] !== 0x44) {
    fail('updater signature must use pre-hashed minisign ED');
  }
  return {
    keyId: packet.subarray(2, 10),
    signature: packet.subarray(10, 74),
    trustedComment: lines[2].slice('trusted comment: '.length),
    globalSignature,
  };
}

export function verifyTauriUpdaterSignatureBytes({ artifactDigest, encodedSignature, encodedPublicKey }) {
  if (!Buffer.isBuffer(artifactDigest) || artifactDigest.length !== 64) {
    fail('artifactDigest must be a 64-byte BLAKE2b-512 digest');
  }
  const publicKey = parsePublicKey(encodedPublicKey);
  const signature = parseSignature(encodedSignature);
  if (!publicKey.keyId.equals(signature.keyId)) fail('updater signature key ID does not match the pinned public key');
  if (!verifyEd25519(null, artifactDigest, publicKey.key, signature.signature)) {
    fail('updater artifact signature is invalid');
  }
  const globalMessage = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, 'utf8'),
  ]);
  if (!verifyEd25519(null, globalMessage, publicKey.key, signature.globalSignature)) {
    fail('updater trusted-comment signature is invalid');
  }
  return { algorithm: 'minisign-ed25519-blake2b', trustedComment: signature.trustedComment };
}

async function blake2b512(candidate) {
  const hash = createHash('blake2b512');
  const handle = await fsp.open(candidate, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest();
}

export async function verifyTauriUpdaterSignature({
  artifactPath,
  signaturePath,
  tauriConfigPath = defaultTauriConfig,
}) {
  let config;
  try {
    config = JSON.parse(await fsp.readFile(tauriConfigPath, 'utf8'));
  } catch (error) {
    fail(`cannot read Tauri updater config: ${error.message}`);
  }
  const encodedPublicKey = config.plugins?.updater?.pubkey;
  if (typeof encodedPublicKey !== 'string' || !encodedPublicKey.trim()) {
    fail('Tauri config does not contain a pinned updater public key');
  }
  const encodedSignature = await fsp.readFile(signaturePath, 'utf8');
  return verifyTauriUpdaterSignatureBytes({
    artifactDigest: await blake2b512(artifactPath),
    encodedSignature,
    encodedPublicKey,
  });
}
