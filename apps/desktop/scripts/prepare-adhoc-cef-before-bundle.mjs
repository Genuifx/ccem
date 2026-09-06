import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { run as stageMacOS } from './stage-cef-macos.mjs';
import { signAdHocCefStage } from './macos-adhoc-cef-signing.mjs';

const scriptPath = fileURLToPath(import.meta.url);

export async function run({ stage = stageMacOS, sign = signAdHocCefStage } = {}) {
  if (process.platform !== 'darwin') throw new Error('Ad-hoc CEF bundling requires macOS');
  if (process.env.APPLE_SIGNING_IDENTITY || process.env.APPLE_TEAM_ID || process.env.CCEM_OFFICIAL_APPLE_TEAM_ID) {
    throw new Error('Ad-hoc CEF bundling cannot use Developer ID signing configuration');
  }
  // This hook runs before Rust compilation because tauri-build already reads
  // the framework paths. The helper must build against the base config until
  // its own framework/Helper.app stage exists, rather than inheriting those
  // still-missing paths from the parent Tauri invocation.
  const inheritedConfig = process.env.TAURI_CONFIG;
  let result;
  try {
    delete process.env.TAURI_CONFIG;
    result = await stage();
  } finally {
    if (inheritedConfig !== undefined) process.env.TAURI_CONFIG = inheritedConfig;
  }
  if (result.status !== 'staged') throw new Error(`CEF staging did not complete: ${result.status}`);
  sign(result.plan.outputDir);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
