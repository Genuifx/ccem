import { fail } from './verify-mode2-release-inventory-shared.mjs';

export const CODESIGN_PATH = '/usr/bin/codesign';
export const XCRUN_PATH = '/usr/bin/xcrun';
export const SPCTL_PATH = '/usr/sbin/spctl';

export function createMacAppTrustPlan(appDir) {
  return [
    { program: CODESIGN_PATH, args: ['--verify', '--deep', '--strict', '--verbose=4', appDir] },
    { program: CODESIGN_PATH, args: ['--display', '--verbose=4', appDir] },
    { program: XCRUN_PATH, args: ['stapler', 'validate', appDir] },
    { program: SPCTL_PATH, args: ['--assess', '--type', 'execute', '--verbose=4', appDir] },
  ];
}

export function createDmgNotarizationPlan({ dmgPath, keyPath, keyId, issuer }) {
  return [
    {
      program: XCRUN_PATH,
      args: [
        'notarytool', 'submit', dmgPath,
        '--key', keyPath,
        '--key-id', keyId,
        '--issuer', issuer,
        '--wait',
        '--output-format', 'json',
      ],
    },
    { program: XCRUN_PATH, args: ['stapler', 'staple', dmgPath] },
  ];
}

export function createMacVerificationPlan({ appDir, dmgPath }) {
  return [
    ...createMacAppTrustPlan(appDir),
    { program: XCRUN_PATH, args: ['stapler', 'validate', dmgPath] },
    {
      program: SPCTL_PATH,
      args: [
        '--assess',
        '--type', 'open',
        '--context', 'context:primary-signature',
        '--verbose=4',
        dmgPath,
      ],
    },
  ];
}

export function assertNotaryAccepted(output) {
  let result;
  try {
    result = JSON.parse(output.trim());
  } catch (error) {
    fail(`notarytool did not return JSON: ${error.message}`);
  }
  if (
    result.status !== 'Accepted'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu
      .test(result.id ?? '')
  ) {
    fail(`DMG notarization was not Accepted: ${result.status ?? 'missing status'}`);
  }
  return result;
}
