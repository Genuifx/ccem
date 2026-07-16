import {
  exactKeys,
  exactNonEmptyText,
  exactRelativePath,
  exactSha256,
  fail,
  nonNegativeInteger,
  validateArtifactExpectation,
} from './updater-replacement-smoke-contract-core.mjs';

export const UPDATER_REPLACEMENT_FLOW = 'tauri-plugin-updater.check-download-and-install';

function exactLoopbackHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('updater transport origin must be an HTTPS loopback origin');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.origin !== value
    || !parsed.port
    || !['127.0.0.1', '[::1]'].includes(parsed.hostname)
    || parsed.username
    || parsed.password
  ) {
    fail('updater transport origin must be an HTTPS loopback origin with an explicit port');
  }
  return value;
}

function validateTransportExchange(value, origin, label) {
  exactKeys(value, ['url', 'requestSha256', 'responseSha256', 'statusCode'], label);
  let parsed;
  try {
    parsed = new URL(value.url);
  } catch {
    fail(`${label} URL is invalid`);
  }
  if (
    parsed.origin !== origin
    || parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.search
    || parsed.pathname === '/'
    || parsed.href !== value.url
  ) {
    fail(`${label} URL must be an exact path on the pinned loopback origin`);
  }
  if (value.statusCode !== 200) fail(`${label} response must be HTTP 200`);
  return {
    url: value.url,
    requestSha256: exactSha256(value.requestSha256, `${label} request`),
    responseSha256: exactSha256(value.responseSha256, `${label} response`),
    statusCode: 200,
  };
}

function validateTransportPhase(value, origin, label) {
  exactKeys(value, ['manifest', 'artifact'], label);
  const phase = {
    manifest: validateTransportExchange(value.manifest, origin, `${label} manifest exchange`),
    artifact: validateTransportExchange(value.artifact, origin, `${label} artifact exchange`),
  };
  if (phase.manifest.url === phase.artifact.url) fail(`${label} endpoints must differ`);
  return phase;
}

function validateTransportExpectation(value) {
  exactKeys(value, [
    'origin', 'caSpkiSha256', 'serverSpkiSha256', 'nonceHeaderName',
    'negative', 'positive',
  ], 'expected updater transport');
  const origin = exactLoopbackHttpsOrigin(value.origin);
  const nonceHeaderName = exactNonEmptyText(
    value.nonceHeaderName,
    'expected updater nonce header name',
    100,
  );
  if (!/^X-[A-Za-z0-9-]+$/u.test(nonceHeaderName)) {
    fail('updater nonce header name must be a private HTTP header');
  }
  const negative = validateTransportPhase(value.negative, origin, 'negative updater transport');
  const positive = validateTransportPhase(value.positive, origin, 'positive updater transport');
  const urls = [
    negative.manifest.url,
    negative.artifact.url,
    positive.manifest.url,
    positive.artifact.url,
  ];
  if (new Set(urls).size !== urls.length) fail('negative and positive updater endpoints must differ');
  if (negative.manifest.responseSha256 === positive.manifest.responseSha256) {
    fail('negative and positive updater manifests must be byte-distinct');
  }
  return {
    origin,
    caSpkiSha256: exactSha256(value.caSpkiSha256, 'expected updater CA SPKI'),
    serverSpkiSha256: exactSha256(value.serverSpkiSha256, 'expected updater server SPKI'),
    nonceHeaderName,
    negative,
    positive,
  };
}

export function validateUpdaterExpectation(value, platform) {
  exactKeys(value, [
    'publicKeySha256', 'artifact', 'signature', 'badSignature', 'transport',
  ], 'expected updater identity');
  const artifact = validateArtifactExpectation(value.artifact, 'expected updater artifact');
  const signature = validateArtifactExpectation(value.signature, 'expected updater signature');
  const badSignature = validateArtifactExpectation(
    value.badSignature,
    'expected bad updater signature',
  );
  if (signature.fileName !== `${artifact.fileName}.sig`) {
    fail('updater signature basename must bind the updater artifact');
  }
  if (badSignature.fileName === signature.fileName || badSignature.sha256 === signature.sha256) {
    fail('bad-signature negative control must use distinct bytes and a distinct file');
  }
  if (platform === 'windows' && !/^.+_\d+\.\d+\.\d+_(?:x64|arm64)-setup\.exe$/u.test(artifact.fileName)) {
    fail('Windows updater artifact must use the release setup.exe name');
  }
  if (platform === 'macos' && !artifact.fileName.endsWith('.app.tar.gz')) {
    fail('macOS updater artifact must be an app.tar.gz archive');
  }
  if (platform === 'windows') {
    for (const [fileName, label] of [
      [artifact.fileName, 'Windows updater artifact'],
      [signature.fileName, 'Windows updater signature'],
      [badSignature.fileName, 'Windows bad updater signature'],
    ]) {
      exactRelativePath(fileName, platform, label);
    }
  }
  const transport = validateTransportExpectation(value.transport);
  if (
    transport.negative.artifact.responseSha256 !== artifact.sha256
    || transport.positive.artifact.responseSha256 !== artifact.sha256
  ) {
    fail('both updater transport phases must serve the exact expected artifact bytes');
  }
  return {
    publicKeySha256: exactSha256(value.publicKeySha256, 'expected updater public key'),
    artifact,
    signature,
    badSignature,
    transport,
  };
}

function expectedRequestLedger(transport, nonceHeaderName, challengeNonce) {
  const requests = [];
  for (const phase of ['negative', 'positive']) {
    for (const resource of ['manifest', 'artifact']) {
      const exchange = transport[phase][resource];
      requests.push({
        sequence: requests.length + 1,
        phase,
        resource,
        method: 'GET',
        url: exchange.url,
        nonceHeaderName,
        nonceHeaderValue: challengeNonce,
        requestSha256: exchange.requestSha256,
        responseSha256: exchange.responseSha256,
        statusCode: exchange.statusCode,
        redirectsFollowed: 0,
      });
    }
  }
  return requests;
}

function validateRequestLedger(value, expected, challengeNonce) {
  if (!Array.isArray(value) || value.length !== 4) {
    fail('updater request ledger must contain the exact four negative/positive requests');
  }
  const validated = value.map((entry, index) => {
    exactKeys(entry, [
      'sequence', 'phase', 'resource', 'method', 'url', 'nonceHeaderName',
      'nonceHeaderValue', 'requestSha256', 'responseSha256', 'statusCode',
      'redirectsFollowed',
    ], `updater request ledger entry ${index}`);
    if (
      entry.sequence !== index + 1
      || !['negative', 'positive'].includes(entry.phase)
      || !['manifest', 'artifact'].includes(entry.resource)
      || entry.method !== 'GET'
      || entry.nonceHeaderName !== expected.nonceHeaderName
      || entry.nonceHeaderValue !== challengeNonce
      || entry.redirectsFollowed !== 0
    ) {
      fail(`updater request ledger entry ${index} is not challenge-bound or redirect-free`);
    }
    return {
      ...entry,
      requestSha256: exactSha256(entry.requestSha256, `request ledger ${index} request`),
      responseSha256: exactSha256(entry.responseSha256, `request ledger ${index} response`),
    };
  });
  const required = expectedRequestLedger(expected, expected.nonceHeaderName, challengeNonce);
  if (JSON.stringify(validated) !== JSON.stringify(required)) {
    fail('updater request ledger does not match the exact pinned negative/positive exchange set');
  }
}

function validateTransportEvidence(value, expected, challengeNonce) {
  exactKeys(value, [
    'origin', 'tlsTrustMode', 'caSpkiSha256', 'tlsPeerSpkiSha256', 'nonceHeader',
    'redirectPolicy', 'redirectsFollowed', 'requestLedger',
  ], 'updater transport evidence');
  exactKeys(value.nonceHeader, ['name', 'value'], 'updater nonce header');
  if (
    value.origin !== expected.origin
    || value.tlsTrustMode !== 'pinned-test-ca-spki'
    || value.caSpkiSha256 !== expected.caSpkiSha256
    || value.tlsPeerSpkiSha256 !== expected.serverSpkiSha256
    || value.nonceHeader.name !== expected.nonceHeaderName
    || value.nonceHeader.value !== challengeNonce
    || value.redirectPolicy !== 'error'
    || value.redirectsFollowed !== 0
  ) {
    fail('updater transport is not challenge-bound pinned loopback HTTPS without redirects');
  }
  validateRequestLedger(value.requestLedger, expected, challengeNonce);
}

function validateNegativeControl(value, expected, previousProcess) {
  exactKeys(value, [
    'result', 'processIdentitySha256', 'badSignatureFileName', 'badSignatureSha256',
    'noMutationBeforePositiveAttempt', 'installTreeBeforeSha256',
    'installTreeAfterRejectionSha256', 'positiveAttemptStartTreeSha256',
    'completedBootMonotonicMs',
  ], 'bad-signature negative control');
  const before = exactSha256(value.installTreeBeforeSha256, 'negative-control install tree before');
  const after = exactSha256(
    value.installTreeAfterRejectionSha256,
    'negative-control install tree after rejection',
  );
  const positiveStart = exactSha256(
    value.positiveAttemptStartTreeSha256,
    'positive-attempt install tree start',
  );
  if (
    value.result !== 'signature-rejected'
    || value.processIdentitySha256 !== previousProcess.processIdentitySha256
    || value.badSignatureFileName !== expected.badSignature.fileName
    || value.badSignatureSha256 !== expected.badSignature.sha256
    || value.noMutationBeforePositiveAttempt !== true
    || before !== after
    || after !== positiveStart
  ) {
    fail('bad-signature negative control did not reject before any replacement mutation');
  }
  nonNegativeInteger(
    value.completedBootMonotonicMs,
    'bad-signature negative-control completion time',
  );
  return value;
}

export function validateUpdaterEvidence(updater, expected, challengeNonce, previousProcess) {
  exactKeys(updater, [
    'flow', 'publicKeySha256', 'artifact', 'signature', 'badSignature', 'transport',
    'negativeControl', 'instrumentation',
  ], 'updater evidence');
  if (updater.flow !== UPDATER_REPLACEMENT_FLOW) fail('updater flow bypassed Tauri check/download/install');
  if (updater.publicKeySha256 !== expected.publicKeySha256) fail('updater public key digest mismatch');
  for (const [key, label] of [
    ['artifact', 'updater artifact'],
    ['badSignature', 'bad updater signature'],
  ]) {
    exactKeys(updater[key], ['fileName', 'sha256'], label);
    if (JSON.stringify(updater[key]) !== JSON.stringify(expected[key])) {
      fail(`${label} identity mismatch`);
    }
  }
  exactKeys(updater.signature, [
    'fileName', 'sha256', 'verified', 'verifiedArtifactSha256',
  ], 'updater signature');
  if (
    updater.signature.fileName !== expected.signature.fileName
    || updater.signature.sha256 !== expected.signature.sha256
    || updater.signature.verified !== true
    || updater.signature.verifiedArtifactSha256 !== expected.artifact.sha256
  ) {
    fail('updater signature did not verify the exact updater artifact');
  }
  validateTransportEvidence(updater.transport, expected.transport, challengeNonce);
  const negativeControl = validateNegativeControl(
    updater.negativeControl,
    expected,
    previousProcess,
  );
  exactKeys(updater.instrumentation, [
    'previousSourceHarness', 'runtimeEndpointOverride', 'pinnedTestCa',
    'directArtifactInstall', 'directArchiveExtraction', 'directInstallerInvocation',
    'signatureVerificationDisabled', 'tlsVerificationDisabled', 'bypasses',
  ], 'updater instrumentation');
  if (
    updater.instrumentation.previousSourceHarness !== true
    || updater.instrumentation.runtimeEndpointOverride !== true
    || updater.instrumentation.pinnedTestCa !== true
    || updater.instrumentation.directArtifactInstall !== false
    || updater.instrumentation.directArchiveExtraction !== false
    || updater.instrumentation.directInstallerInvocation !== false
    || updater.instrumentation.signatureVerificationDisabled !== false
    || updater.instrumentation.tlsVerificationDisabled !== false
    || !Array.isArray(updater.instrumentation.bypasses)
    || updater.instrumentation.bypasses.length !== 0
  ) {
    fail('updater evidence contains a bypass or missing harness guard');
  }
  return negativeControl;
}
