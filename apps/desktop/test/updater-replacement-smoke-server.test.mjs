import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createUpdaterManifestBytes,
  createUpdaterRequestFingerprint,
  generateUpdaterReplacementTlsMaterial,
  startUpdaterReplacementHttpsServer,
} from '../scripts/updater-replacement-smoke-server.mjs';

const NONCE = 'a'.repeat(64);
const HEADER = 'X-CCEM-Updater-Challenge';

function get(url, ca) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      ca,
      headers: { [HEADER]: NONCE },
      rejectUnauthorized: true,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        bytes: Buffer.concat(chunks),
      }));
    });
    request.once('error', reject);
  });
}

test('dynamic updater manifest binds exact version, URL, and signature', () => {
  const bytes = createUpdaterManifestBytes({
    version: '2.53.0',
    artifactUrl: 'https://127.0.0.1:43117/challenge/artifact',
    signature: 'RWQbase64signature',
  });
  assert.deepEqual(JSON.parse(bytes), {
    version: '2.53.0',
    url: 'https://127.0.0.1:43117/challenge/artifact',
    signature: 'RWQbase64signature',
  });
  assert.throws(
    () => createUpdaterManifestBytes({
      version: '2.53.0', artifactUrl: 'http://127.0.0.1/a', signature: 'x',
    }),
    /loopback HTTPS/u,
  );
});

test('request fingerprint is challenge and exact endpoint bound', () => {
  const base = {
    method: 'GET',
    url: 'https://127.0.0.1:43117/a',
    nonceHeaderName: HEADER,
    nonceHeaderValue: NONCE,
  };
  assert.equal(createUpdaterRequestFingerprint(base), createUpdaterRequestFingerprint({
    ...base, nonceHeaderName: HEADER.toLowerCase(),
  }));
  assert.notEqual(createUpdaterRequestFingerprint(base), createUpdaterRequestFingerprint({
    ...base, nonceHeaderValue: 'b'.repeat(64),
  }));
  assert.notEqual(createUpdaterRequestFingerprint(base), createUpdaterRequestFingerprint({
    ...base, url: 'https://127.0.0.1:43117/b',
  }));
});

test('pinned loopback server serves exact ordered negative then positive exchange', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ccem-updater-server-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const artifactPath = path.join(root, 'release.app.tar.gz');
  const signaturePath = `${artifactPath}.sig`;
  const badSignaturePath = `${artifactPath}.bad.sig`;
  await Promise.all([
    fsp.writeFile(artifactPath, 'exact-release-artifact'),
    fsp.writeFile(signaturePath, 'RWQ-positive-signature\n'),
    fsp.writeFile(badSignaturePath, 'RWQ-negative-signature\n'),
  ]);
  const tls = await generateUpdaterReplacementTlsMaterial(root);
  const server = await startUpdaterReplacementHttpsServer({
    tls,
    artifactPath,
    signaturePath,
    badSignaturePath,
    currentVersion: '2.53.0',
    challengeNonce: NONCE,
    nonceHeaderName: HEADER,
  });
  t.after(() => server.close().catch(() => {}));
  const ca = await fsp.readFile(tls.caCertificate);
  for (const phase of ['negative', 'positive']) {
    const manifestResponse = await get(server.endpoints[phase], ca);
    assert.equal(manifestResponse.statusCode, 200);
    const manifest = JSON.parse(manifestResponse.bytes);
    assert.equal(manifest.version, '2.53.0');
    assert.equal(manifest.url, `${server.origin}/${NONCE}/${phase}/artifact`);
    const artifactResponse = await get(manifest.url, ca);
    assert.equal(artifactResponse.statusCode, 200);
    assert.equal(artifactResponse.bytes.toString(), 'exact-release-artifact');
  }
  assert.equal(server.assertComplete(), true);
  assert.deepEqual(server.requestLedger.map(({ phase, resource }) => [phase, resource]), [
    ['negative', 'manifest'],
    ['negative', 'artifact'],
    ['positive', 'manifest'],
    ['positive', 'artifact'],
  ]);
  assert.notEqual(
    server.transportExpectation.negative.manifest.responseSha256,
    server.transportExpectation.positive.manifest.responseSha256,
  );
  assert.equal(server.manifestSemantics.negative.version, '2.53.0');
  assert.notEqual(
    server.manifestSemantics.negative.signatureTextSha256,
    server.manifestSemantics.positive.signatureTextSha256,
  );
});
