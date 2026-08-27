import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitUntilGone(pid, detail) {
  const deadline = Date.now() + 5_000;
  while (processExists(pid)) {
    assert.ok(Date.now() < deadline, detail);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('parent stdin EOF kills the owned helper group and stubborn descendant only', {
  skip: process.platform === 'win32',
}, async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-parent-eof-test-'));
  let sibling;
  let helper;
  t.after(async () => {
    if (helper && processExists(helper.pid)) {
      try {
        process.kill(-helper.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    if (sibling && sibling.exitCode == null) {
      sibling.kill('SIGKILL');
      await new Promise((resolve) => sibling.once('exit', resolve));
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const entry = path.join(tempDir, 'parent-eof-harness.ts');
  const outfile = path.join(tempDir, 'parent-eof-harness.mjs');
  const teardownModule = path.join(packageDir, 'src', 'parentProcessTeardown.ts');
  await fs.writeFile(entry, `
    import { spawn } from 'node:child_process';
    import { terminateOwnedProcessGroupOnParentClose } from ${JSON.stringify(teardownModule)};

    const descendant = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do /bin/sleep 1; done'], {
      stdio: 'ignore',
    });
    process.stdout.write(String(descendant.pid) + '\\n');
    process.stdin.resume();
    process.stdin.on('end', () => {
      if (!terminateOwnedProcessGroupOnParentClose()) process.exit(2);
    });
  `);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });

  sibling = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  helper = spawn(process.execPath, [outfile], {
    detached: true,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const descendantPid = await new Promise((resolve, reject) => {
    let stdout = '';
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n')[0];
      if (/^\d+$/.test(line)) resolve(Number(line));
    });
    helper.once('error', reject);
    helper.once('exit', (code, signal) => {
      reject(new Error(`helper exited before reporting descendant: ${code ?? signal}`));
    });
  });

  assert.notEqual(helper.pid, process.pid);
  helper.stdin.end();
  await waitUntilGone(helper.pid, 'helper survived parent stdin EOF');
  await waitUntilGone(descendantPid, 'stubborn descendant survived parent stdin EOF');
  assert.equal(sibling.exitCode, null, 'EOF cleanup must not touch an unrelated sibling');
});
