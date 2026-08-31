import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WINDOWS_TARGET } from './stage-cef-windows.mjs';

const scriptPath = fileURLToPath(import.meta.url);

export async function run(environment = process.env) {
  const target = environment.CCEM_CEF_TARGET_TRIPLE?.trim();
  if (target === WINDOWS_TARGET) {
    const { run: activateWindows } = await import('./activate-cef-windows-host.mjs');
    return activateWindows(environment);
  }

  const { run: stageMacOS } = await import('./stage-cef-macos.mjs');
  return stageMacOS();
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
