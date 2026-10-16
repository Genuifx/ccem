import fs from 'node:fs/promises';
import path from 'node:path';

// The real SDK invokes its executable with `exec` as the first argument. Run the
// real Node binary with an `exec` script in the helper's temporary cwd. This keeps
// SDK spawning, argv, environment and stdio real on Windows as well as Unix,
// without requiring shebang support, executable mode bits or a shell wrapper.
// Callers must spawn the helper with cwd: directory (the SDK inherits that cwd).
export async function createCodexExecutableFixture(directory, source) {
  await fs.writeFile(path.join(directory, 'package.json'), '{"type":"commonjs"}\n');
  await fs.writeFile(path.join(directory, 'exec'), source);
  return process.execPath;
}
