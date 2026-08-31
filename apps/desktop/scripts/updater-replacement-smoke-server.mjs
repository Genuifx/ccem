import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';

import { hashUpdaterReplacementSmokeJson } from './updater-replacement-smoke-contract.mjs';
import { sha256File } from './updater-replacement-smoke-runner-core.mjs';

const execFileAsync = promisify(execFile);
const HEADER_NAME_PATTERN = /^X-[A-Za-z0-9-]+$/u;

function fail(message) {
  throw new Error(`[updater-replacement-smoke-server] ${message}`);
}

function exactSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${label} must be an exact SHA-256`);
  }
  return value;
}

function spkiSha256(certificatePem) {
  const certificate = new X509Certificate(certificatePem);
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

async function runOpenSsl(args) {
  try {
    await execFileAsync('openssl', args, { maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    fail(`openssl ${args[0]} failed: ${error.stderr?.trim() || error.message}`);
  }
}

export async function generateUpdaterReplacementTlsMaterial(sharedRoot) {
  const exactRoot = path.resolve(sharedRoot);
  const tlsRoot = path.join(exactRoot, 'tls');
  await fsp.mkdir(tlsRoot, { recursive: false, mode: 0o700 });
  const paths = {
    caKey: path.join(tlsRoot, 'ca-key.pem'),
    caCertificate: path.join(tlsRoot, 'ca.pem'),
    serverKey: path.join(tlsRoot, 'server-key.pem'),
    serverRequest: path.join(tlsRoot, 'server.csr'),
    serverCertificate: path.join(tlsRoot, 'server.pem'),
    extensions: path.join(tlsRoot, 'server.ext'),
    serial: path.join(tlsRoot, 'ca.srl'),
  };
  await runOpenSsl([
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-subj', '/CN=CCEM Updater Replacement Smoke CA',
    '-days', '1', '-keyout', paths.caKey, '-out', paths.caCertificate,
  ]);
  await runOpenSsl([
    'req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-subj', '/CN=127.0.0.1',
    '-keyout', paths.serverKey, '-out', paths.serverRequest,
  ]);
  await fsp.writeFile(
    paths.extensions,
    'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
    { flag: 'wx', mode: 0o600 },
  );
  await runOpenSsl([
    'x509', '-req', '-sha256', '-days', '1',
    '-in', paths.serverRequest,
    '-CA', paths.caCertificate,
    '-CAkey', paths.caKey,
    '-CAcreateserial',
    '-out', paths.serverCertificate,
    '-extfile', paths.extensions,
  ]);
  await Promise.all([
    fsp.chmod(paths.caKey, 0o600),
    fsp.chmod(paths.serverKey, 0o600),
    fsp.chmod(paths.caCertificate, 0o600),
    fsp.chmod(paths.serverCertificate, 0o600),
  ]);
  const [caPem, serverPem] = await Promise.all([
    fsp.readFile(paths.caCertificate, 'utf8'),
    fsp.readFile(paths.serverCertificate, 'utf8'),
  ]);
  return {
    ...paths,
    caSpkiSha256: spkiSha256(caPem),
    serverSpkiSha256: spkiSha256(serverPem),
  };
}

export function createUpdaterManifestBytes({ version, artifactUrl, signature }) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    fail('updater manifest version must be semantic');
  }
  let parsed;
  try {
    parsed = new URL(artifactUrl);
  } catch {
    fail('updater manifest artifact URL is invalid');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== '127.0.0.1'
    || !parsed.port
    || parsed.hash
    || parsed.search
  ) {
    fail('updater manifest artifact URL must be exact loopback HTTPS');
  }
  if (typeof signature !== 'string' || signature.trim() !== signature || signature.length === 0) {
    fail('updater manifest signature must be exact non-empty text');
  }
  return Buffer.from(`${JSON.stringify({ version, url: parsed.href, signature })}\n`, 'utf8');
}

export function createUpdaterRequestFingerprint({
  method,
  url,
  nonceHeaderName,
  nonceHeaderValue,
}) {
  return hashUpdaterReplacementSmokeJson({
    method,
    url,
    nonceHeaderName: nonceHeaderName.toLowerCase(),
    nonceHeaderValue,
  });
}

function exactHeader(req, headerName, expectedValue) {
  const matches = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === headerName.toLowerCase()) {
      matches.push(req.rawHeaders[index + 1]);
    }
  }
  return matches.length === 1 && matches[0] === expectedValue;
}

function responseSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function startUpdaterReplacementHttpsServer({
  tls,
  artifactPath,
  signaturePath,
  badSignaturePath,
  currentVersion,
  challengeNonce,
  nonceHeaderName,
}) {
  exactSha256(challengeNonce, 'challenge nonce');
  if (!HEADER_NAME_PATTERN.test(nonceHeaderName ?? '')) fail('nonce header name is invalid');
  const [artifactBytes, signatureBytes, badSignatureBytes, key, cert] = await Promise.all([
    fsp.readFile(artifactPath),
    fsp.readFile(signaturePath),
    fsp.readFile(badSignaturePath),
    fsp.readFile(tls.serverKey),
    fsp.readFile(tls.serverCertificate),
  ]);
  const signature = signatureBytes.toString('utf8').trim();
  const badSignature = badSignatureBytes.toString('utf8').trim();
  if (!signature || !badSignature || signature === badSignature) {
    fail('positive and bad updater signatures must be non-empty and byte-distinct');
  }
  const artifactSha256 = await sha256File(artifactPath);
  const signatureSha256 = await sha256File(signaturePath);
  const badSignatureSha256 = await sha256File(badSignaturePath);
  const routes = new Map();
  const ledger = [];
  let origin;

  const server = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, (req, res) => {
    const requestUrl = `${origin}${req.url}`;
    const route = routes.get(req.url);
    if (
      req.method !== 'GET'
      || !route
      || !exactHeader(req, nonceHeaderName, challengeNonce)
      || req.headers.host !== new URL(origin).host
    ) {
      res.writeHead(404, { 'content-type': 'text/plain', connection: 'close' });
      res.end('not found\n');
      return;
    }
    const requestSha256 = createUpdaterRequestFingerprint({
      method: 'GET',
      url: requestUrl,
      nonceHeaderName,
      nonceHeaderValue: challengeNonce,
    });
    ledger.push({
      sequence: ledger.length + 1,
      phase: route.phase,
      resource: route.resource,
      method: 'GET',
      url: requestUrl,
      nonceHeaderName,
      nonceHeaderValue: challengeNonce,
      requestSha256,
      responseSha256: route.responseSha256,
      statusCode: 200,
      redirectsFollowed: 0,
    });
    res.writeHead(200, {
      'content-type': route.resource === 'manifest'
        ? 'application/json'
        : 'application/octet-stream',
      'content-length': route.bytes.length,
      'cache-control': 'no-store',
      connection: 'close',
    });
    res.end(route.bytes);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') fail('loopback HTTPS server did not bind a TCP port');
  origin = `https://127.0.0.1:${address.port}`;

  const endpoint = (phase, resource) => `/${challengeNonce}/${phase}/${resource}`;
  const routeUrl = (phase, resource) => `${origin}${endpoint(phase, resource)}`;
  for (const [phase, manifestSignature] of [
    ['negative', badSignature],
    ['positive', signature],
  ]) {
    const artifactUrl = routeUrl(phase, 'artifact');
    const manifestBytes = createUpdaterManifestBytes({
      version: currentVersion,
      artifactUrl,
      signature: manifestSignature,
    });
    routes.set(endpoint(phase, 'manifest'), {
      phase,
      resource: 'manifest',
      bytes: manifestBytes,
      responseSha256: responseSha256(manifestBytes),
      semantics: {
        version: currentVersion,
        artifactUrl,
        signatureTextSha256: responseSha256(Buffer.from(manifestSignature, 'utf8')),
      },
    });
    routes.set(endpoint(phase, 'artifact'), {
      phase,
      resource: 'artifact',
      bytes: artifactBytes,
      responseSha256: artifactSha256,
    });
  }

  const exchange = (phase, resource) => {
    const route = routes.get(endpoint(phase, resource));
    const url = routeUrl(phase, resource);
    return {
      url,
      requestSha256: createUpdaterRequestFingerprint({
        method: 'GET',
        url,
        nonceHeaderName,
        nonceHeaderValue: challengeNonce,
      }),
      responseSha256: route.responseSha256,
      statusCode: 200,
    };
  };
  const transportExpectation = {
    origin,
    caSpkiSha256: exactSha256(tls.caSpkiSha256, 'CA SPKI SHA-256'),
    serverSpkiSha256: exactSha256(tls.serverSpkiSha256, 'server SPKI SHA-256'),
    nonceHeaderName,
    negative: {
      manifest: exchange('negative', 'manifest'),
      artifact: exchange('negative', 'artifact'),
    },
    positive: {
      manifest: exchange('positive', 'manifest'),
      artifact: exchange('positive', 'artifact'),
    },
  };
  const manifestSemantics = Object.fromEntries(['negative', 'positive'].map((phase) => [
    phase,
    routes.get(endpoint(phase, 'manifest')).semantics,
  ]));
  return {
    origin,
    endpoints: {
      negative: routeUrl('negative', 'manifest'),
      positive: routeUrl('positive', 'manifest'),
    },
    identities: {
      artifactSha256,
      signatureSha256,
      badSignatureSha256,
    },
    transportExpectation,
    manifestSemantics,
    requestLedger: ledger,
    assertComplete() {
      const expected = [
        ['negative', 'manifest'],
        ['negative', 'artifact'],
        ['positive', 'manifest'],
        ['positive', 'artifact'],
      ];
      if (
        ledger.length !== expected.length
        || ledger.some((entry, index) => (
          entry.sequence !== index + 1
          || entry.phase !== expected[index][0]
          || entry.resource !== expected[index][1]
        ))
      ) {
        fail('updater transport did not perform the exact ordered four-request exchange');
      }
      return true;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
