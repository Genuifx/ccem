import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRAMEWORK_NAME, FRAMEWORK_NESTED_CODE_RELATIVES, HELPER_SPECS } from './stage-cef-macos.mjs';

export const ADHOC_SIGNATURE_VERIFICATION = 'codesign-adhoc-deep-strict-v1';

function codesign(args) {
  const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`[cef-adhoc-signing] codesign failed: ${result.error?.message ?? result.stderr}`);
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

export function assertAdHocSignatureDetails(details, identifier) {
  const fields = new Map(details.split(/\r?\n/u).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  if (fields.get('Identifier') !== identifier || fields.get('Signature') !== 'adhoc'
      || ![undefined, 'not set'].includes(fields.get('TeamIdentifier'))
      || /flags=.*\bruntime\b/u.test(details)
      || !/^Info\.plist entries=\d+$/mu.test(details)
      || !/^Sealed Resources version=2 /mu.test(details)) {
    throw new Error(`[cef-adhoc-signing] expected a non-hardened ad-hoc signature for ${identifier}`);
  }
}

// Ad-hoc signing seals the bundle without asserting a Developer ID identity.
// Do not enable hardened-runtime library validation: CEF has no Apple Team ID
// on this distribution route. The CEF subprocess Seatbelt sandbox stays enabled.
export function signAdHocCefStage(stageDir, run = codesign) {
  const framework = path.join(stageDir, FRAMEWORK_NAME);
  const sign = (candidate, identifier) => run([
    '--force', '--sign', '-', '--timestamp=none',
    ...(identifier ? ['--identifier', identifier] : []), candidate,
  ]);
  for (const relative of FRAMEWORK_NESTED_CODE_RELATIVES) sign(path.join(framework, relative));
  sign(framework, 'org.cef.framework');
  for (const helper of HELPER_SPECS) sign(path.join(stageDir, helper.bundleName), helper.bundleIdentifier);
  verifyAdHocCefStage(stageDir, run);
}

export function verifyAdHocCefStage(stageDir, run = codesign) {
  for (const candidate of [path.join(stageDir, FRAMEWORK_NAME), ...HELPER_SPECS.map((helper) => path.join(stageDir, helper.bundleName))]) {
    run(['--verify', '--deep', '--strict', candidate]);
  }
}

export function verifyAdHocMacApp(appDir, run = codesign) {
  run(['--verify', '--deep', '--strict', appDir]);
  assertAdHocSignatureDetails(run(['--display', '--verbose=4', appDir]), 'com.ccem.desktop');
  return { verification: ADHOC_SIGNATURE_VERIFICATION };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    if (process.argv.slice(2).join(' ') !== '--verify-stage') throw new Error('Expected --verify-stage');
    verifyAdHocCefStage(path.resolve(path.dirname(scriptPath), '../src-tauri/target/cef-bundle/macos'));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
