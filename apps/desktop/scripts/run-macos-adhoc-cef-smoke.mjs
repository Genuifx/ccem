#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateReceipt(receipt, { nonce, phase, root, executable, pid, origin }) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.smoke, 'macos-adhoc-cef-bundle');
  assert.equal(receipt.status, 'passed');
  for (const [field, expected] of Object.entries({ nonce, phase, root, executable, pid })) {
    assert.equal(receipt[field], expected, `receipt ${field} must match this invocation`);
  }
  assert.equal(receipt.eventCode, 0);
  assert.equal(receipt.error, null);
  assert.equal(receipt.normalStartupBypassed, true);
  assert.equal(receipt.releaseBuild, true);
  const facts = receipt.facts;
  for (const key of ['bundled', 'sandboxEnabled', 'persistentProfile', 'visible', 'hideShowVerified', 'closed']) {
    assert.equal(facts[key], true, `missing runtime fact: ${key}`);
  }
  assert.equal(facts.credentialStore, 'macos-system-keychain-adhoc');
  for (const [key, path, title] of [['before', 'start', 'CCEM_BUNDLE_START'], ['after', 'navigated', 'CCEM_BUNDLE_NAVIGATED']]) {
    assert.equal(facts[key].title, title);
    assert.equal(facts[key].url, `${origin}${path}`);
    assert(facts[key].cookie.split(';').map(value => value.trim()).includes(`ccem_bundle_smoke=${nonce}`));
  }
}

export async function runPhase({ executable, root, nonce, phase, origin, timeoutMs = 90_000 }) {
  await writeFile(join(root, 'smoke-config.json'), JSON.stringify({ nonce, phase, origin }), { mode: 0o600 });
  const logPath = join(root, `${phase}.log`);
  const output = openSync(logPath, 'wx', 0o600);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CCEM_') && !key.startsWith('DYLD_')));
  let child;
  try {
    child = spawn(executable, ['--cef-bundle-smoke', root], { env, stdio: ['ignore', output, output] });
  } finally {
    closeSync(output);
  }
  const exit = await new Promise((resolveExit, reject) => {
    let timedOut = false;
    let forceTimer;
    const terminate = () => {
      child.kill('SIGTERM');
      forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    process.once('SIGINT', terminate);
    process.once('SIGTERM', terminate);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      process.removeListener('SIGINT', terminate);
      process.removeListener('SIGTERM', terminate);
    };
    child.once('error', error => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolveExit({ code, signal, timedOut });
    });
  });
  assert(!exit.timedOut, `${phase} smoke timed out; only spawned PID ${child.pid} was terminated; log: ${logPath}`);
  assert.equal(exit.code, 0, `${phase} exited ${exit.code}/${exit.signal}; log: ${logPath}`);
  const receipt = JSON.parse(await readFile(join(root, `${phase}.json`), 'utf8'));
  validateReceipt(receipt, { nonce, phase, root, executable, pid: child.pid, origin });
  return receipt;
}

async function main() {
  const [appArgument, artifactArgument, ...extra] = process.argv.slice(2);
  const usage = 'Usage: node apps/desktop/scripts/run-macos-adhoc-cef-smoke.mjs <exact.app> [artifact-directory]';
  if (['--help', '-h'].includes(appArgument)) {
    console.log(usage);
    return;
  }
  if (!appArgument) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  assert(!extra.length, usage);
  assert.equal(process.platform, 'darwin', 'This smoke requires macOS');
  const app = await realpath(resolve(appArgument));
  assert(app.endsWith('.app'), 'An explicit .app bundle is required');
  assert(!app.startsWith('/Applications/'), 'Use an owned test bundle outside /Applications');
  const binary = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(basename(binary), binary, 'Bundle executable must be a basename');
  const executable = await realpath(join(app, 'Contents/MacOS', binary));
  assert.equal(dirname(executable), join(app, 'Contents/MacOS'));
  const artifacts = resolve(artifactArgument ?? '.artifacts/adhoc-cef-smoke');
  await mkdir(artifacts, { recursive: true });
  const root = await realpath(await mkdtemp(join(artifacts, 'run-')));
  const nonce = randomBytes(16).toString('hex');
  let phase = 'prime';
  const requests = [];
  const server = createServer((request, response) => {
    const path = request.url;
    if (!['/start', '/navigated'].includes(path)) { response.writeHead(404).end(); return; }
    const cookie = request.headers.cookie ?? '';
    requests.push({ phase, path, cookiePresent: cookie.split(';').map(value => value.trim()).includes(`ccem_bundle_smoke=${nonce}`) });
    const title = path === '/start' ? 'CCEM_BUNDLE_START' : 'CCEM_BUNDLE_NAVIGATED';
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    if (phase === 'prime' && path === '/start') headers['Set-Cookie'] = `ccem_bundle_smoke=${nonce}; Max-Age=3600; Path=/; SameSite=Lax`;
    response.writeHead(200, headers).end(`<!doctype html><title>${title}</title><h1>${title}</h1><p>Bundled Chromium renderer and persistent storage verification.</p>`);
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const origin = `http://127.0.0.1:${server.address().port}/`;
  console.log(`CEF smoke artifacts: ${root}`);
  try {
    const prime = await runPhase({ executable, root, nonce, phase, origin });
    phase = 'restore';
    const restore = await runPhase({ executable, root, nonce, phase, origin });
    assert.notEqual(prime.pid, restore.pid, 'Restore must use a fresh process');
    for (const path of ['/start', '/navigated']) {
      assert(requests.some(item => item.phase === 'restore' && item.path === path && item.cookiePresent), `Restore server did not observe persisted cookie at ${path}`);
    }
    const receipt = { schemaVersion: 1, smoke: 'macos-adhoc-cef-bundle', status: 'passed', app, executable, root, nonce, prime, restore, requests };
    await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(`PASS: bundled CEF initialized, rendered, navigated, hid/showed, closed, and restored its cookie across PIDs ${prime.pid} and ${restore.pid}.`);
    console.log(`Receipt: ${join(root, 'receipt.json')}`);
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
}
