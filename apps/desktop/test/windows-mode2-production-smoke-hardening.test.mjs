import assert from 'node:assert/strict';
import test from 'node:test';

import { validateWindowsMode2ProductionSmokeAttestation } from '../scripts/windows-mode2-production-smoke-contract.mjs';
import { windowsSmokeFixture } from './fixtures/windows-mode2-production-smoke.mjs';

function validateFixture(fixture) {
  return validateWindowsMode2ProductionSmokeAttestation(
    fixture.attestation,
    fixture.expected,
  );
}

test('internal CEF feature proof cannot be substituted by a forged WMI command line', () => {
  for (const field of ['networkServiceSandboxRequested', 'networkServiceLpacRequested']) {
    const fixture = windowsSmokeFixture();
    fixture.attestation.runtime.processes[0].commandLine += ' --enable-features=NetworkServiceSandbox,WinSboxNetworkServiceSandboxIsLPAC';
    fixture.attestation.runtime.receipt[field] = false;
    assert.throws(
      () => validateFixture(fixture),
      /internal CEF NetworkServiceSandbox request/,
    );
  }
});

test('NetworkService proof requires exact subtype, LPAC token class, and LPAC authority SID', () => {
  const wrongSubtype = windowsSmokeFixture();
  const executable = wrongSubtype.expected.installedExecutablePath;
  wrongSubtype.attestation.runtime.processes[3].utilitySubtype = 'audio.mojom.AudioService';
  wrongSubtype.attestation.runtime.processes[3].commandLine = `"${executable}" --type=utility --utility-sub-type=audio.mojom.AudioService`;
  assert.throws(() => validateFixture(wrongSubtype), /exactly one AppContainer NetworkService/);

  const ordinaryAppContainer = windowsSmokeFixture();
  ordinaryAppContainer.attestation.runtime.processes[3]
    .token.isLessPrivilegedAppContainer = false;
  assert.throws(
    () => validateFixture(ordinaryAppContainer),
    /explicitly enabled AppContainer sandbox/,
  );

  const missingLpacSid = windowsSmokeFixture();
  missingLpacSid.attestation.runtime.processes[3].token.groupSids = ['S-1-5-32-545'];
  missingLpacSid.attestation.runtime.processes[3].token.groupSidCount = 1;
  assert.throws(
    () => validateFixture(missingLpacSid),
    /not the LPAC principal granted installed-tree read-execute/,
  );
});

test('full descendant closure rejects indirect CEF children, omitted CEF evidence, and a second broker', () => {
  const grandchild = windowsSmokeFixture();
  grandchild.attestation.runtime.processClosure[2].parentPid = 4101;
  grandchild.attestation.runtime.processes[2].parentPid = 4101;
  assert.throws(
    () => validateFixture(grandchild),
    /same-executable CEF descendant 4102 is not a direct browser child/,
  );

  const omittedCefEvidence = windowsSmokeFixture();
  omittedCefEvidence.attestation.runtime.processClosure.push({
    pid: 4105,
    nativePid: 4105,
    parentPid: 4100,
    creationTime100ns: '133800000000000005',
    nativeImagePath: omittedCefEvidence.expected.installedExecutablePath,
    runtimeKind: 'cef',
    signerThumbprint: null,
    signerSubject: null,
  });
  assert.throws(
    () => validateFixture(omittedCefEvidence),
    /does not cover the exact same-executable descendant set/,
  );

  const secondBroker = windowsSmokeFixture();
  const broker = structuredClone(secondBroker.attestation.runtime.processes[0]);
  Object.assign(broker, {
    pid: 4105,
    nativePid: 4105,
    parentPid: 4100,
    creationTime100ns: '133800000000000005',
  });
  secondBroker.attestation.runtime.processes.push(broker);
  secondBroker.attestation.runtime.processClosure.push({
    pid: 4105,
    nativePid: 4105,
    parentPid: 4100,
    creationTime100ns: '133800000000000005',
    nativeImagePath: secondBroker.expected.installedExecutablePath,
    runtimeKind: 'cef',
    signerThumbprint: null,
    signerSubject: null,
  });
  assert.throws(
    () => validateFixture(secondBroker),
    /browser process observation does not bind the runtime receipt PID/,
  );
});

test('full descendant closure rejects unknown and unsigned Wry runtime identities', () => {
  const unknownRuntime = windowsSmokeFixture();
  unknownRuntime.attestation.runtime.processClosure[4].runtimeKind = 'foreign';
  assert.throws(() => validateFixture(unknownRuntime), /unknown host runtime classification/);

  const unsignedWry = windowsSmokeFixture();
  unsignedWry.attestation.runtime.processClosure[4].signerThumbprint = null;
  assert.throws(() => validateFixture(unsignedWry), /Wry runtime identity is invalid/);
});
