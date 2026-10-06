import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { allowedRedirect, fetchReleaseAsset, loadReleaseConfig, verifyManifest, verifyLocalRelease } from './release-contract.mjs';

const origin = 'https://github.com/Genuifx/ccem/releases/download/2026.10.2.1/manifest.json';
const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/1?se=expiry&sig=temporary';

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const keyText = `untrusted comment: test publisher\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`;
  const config = { version: '2026.10.2.1', sequence: 2026100201,
    encodedPublicKey: Buffer.from(keyText).toString('base64') };
  const archive = Buffer.from('signed archive fixture');
  const manifest = { schema_version: 1, signing_key_id: 'ccem-hermes-runtime-2026-01', sequence: config.sequence,
    minimum_protocol_version: 1, artifact: { platform: 'macos', architecture: 'aarch64', version: config.version,
      minimum_os_version: '14.0', source_url: origin.replace('manifest.json', 'hermes-macos-aarch64.zip'),
      archive: { format: 'zip', byte_size: archive.length, sha256: createHash('sha256').update(archive).digest('hex'),
        max_entries: 1, max_unpacked_bytes: archive.length, max_file_bytes: archive.length },
      layout: { root_directory: 'hermes-runtime', executable: { relative_path: 'python/bin/python3.11', byte_size: 1, sha256: 'a'.repeat(64) } },
      product_identity: { product_name: 'CCEM Hermes Runtime', product_version: config.version } } };
  function signed(value = manifest) {
    const bytes = Buffer.from(JSON.stringify(value));
    const signature = sign(null, createHash('blake2b512').update(bytes).digest(), privateKey);
    const comment = 'test component release';
    const packet = Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64');
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey).toString('base64');
    return { bytes, signature: Buffer.from(`untrusted comment: test signature\n${packet}\ntrusted comment: ${comment}\n${global}\n`).toString('base64') };
  }
  return { config, manifest, archive, signed };
}

test('the compiled default source uses an immutable component tag and existing publisher key', async () => {
  const config = await loadReleaseConfig();
  assert.equal(config.manifestUrl, origin);
  assert.match(config.publicKey, /^untrusted comment: minisign public key:/u);
});

test('signed manifest authenticates exact bytes and the selected version', () => {
  const item = fixture();
  const signed = item.signed();
  assert.equal(verifyManifest(item.config, signed.bytes, signed.signature).artifact.version, item.config.version);
  assert.throws(() => verifyManifest(item.config, Buffer.concat([signed.bytes, Buffer.from(' ')]), signed.signature), /signature/u);
  const wrong = item.signed({ ...item.manifest, sequence: 1 });
  assert.throws(() => verifyManifest(item.config, wrong.bytes, wrong.signature), /reviewed component/u);
  assert.throws(() => verifyManifest(fixture().config, signed.bytes, signed.signature), /key ID/u);
});

test('the signed archive hash rejects an altered or truncated Release asset', async (t) => {
  const item = fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-release-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const signed = item.signed();
  await fs.writeFile(path.join(root, 'manifest.json'), signed.bytes);
  await fs.writeFile(path.join(root, 'manifest.json.sig'), signed.signature);
  await fs.writeFile(path.join(root, 'hermes-macos-aarch64.zip'), item.archive);
  await verifyLocalRelease(item.config, root);
  await fs.writeFile(path.join(root, 'hermes-macos-aarch64.zip'), item.archive.subarray(1));
  await assert.rejects(verifyLocalRelease(item.config, root), /signed manifest/u);
});

test('GitHub to the exact official CDN preserves Range headers without persisting the temporary URL', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: cdn } })
      : new Response(Buffer.from('x'), { status: 206, headers: { 'content-range': 'bytes 0-0/150000000' } });
  };
  const result = await fetchReleaseAsset(origin, { fetchImpl, range: true, maximum: 1 });
  assert.equal(result.bytes.toString(), 'x');
  assert.equal(calls[0].url, origin);
  assert.equal(calls[1].url, cdn);
  assert.equal(calls[1].options.headers.Range, 'bytes=0-0');
  assert.equal(calls[0].options.redirect, 'manual');
});

for (const destination of [
  'http://release-assets.githubusercontent.com/file', 'https://release-assets.githubusercontent.com:444/file',
  'https://release-assets.githubusercontent.com.evil.test/file', 'https://raw.githubusercontent.com/file',
  'https://user:password@release-assets.githubusercontent.com/file', 'https://release-assets.githubusercontent.com/file#fragment',
  'https://github.com/other/repo/releases/download/tag/file',
]) {
  test(`untrusted redirect is rejected before fetching ${new URL(destination).hostname}`, async () => {
    let requests = 0;
    await assert.rejects(fetchReleaseAsset(origin, { fetchImpl: async () => {
      requests += 1;
      return new Response(null, { status: 302, headers: { location: destination } });
    } }), /untrusted/u);
    assert.equal(requests, 1);
    assert.equal(allowedRedirect(origin, destination, 1), false);
  });
}

test('missing assets, redirect loops and oversized responses fail the release check', async () => {
  await assert.rejects(fetchReleaseAsset(origin, { fetchImpl: async () => new Response(null, { status: 404 }) }), /HTTP 404/u);
  await assert.rejects(fetchReleaseAsset(origin, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: cdn } }) }), /redirect/u);
  await assert.rejects(fetchReleaseAsset(origin, { maximum: 1, fetchImpl: async () => new Response('too long') }), /size limit/u);
});
