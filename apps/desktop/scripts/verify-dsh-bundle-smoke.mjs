import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { zstdCompress } from 'node:zlib';

const compress = promisify(zstdCompress);
const desktopRoot = path.resolve(import.meta.dirname, '..');
const expectedDshVersion = '0.1.1-rc.2';

function fail(message) {
  throw new Error(`DSH bundle smoke failed: ${message}`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length) {
      fail(`invalid argument list near ${JSON.stringify(key)}`);
    }
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function hostTriple() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  fail(`unsupported local staged-smoke host ${process.platform}/${process.arch}`);
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(root);
  return files;
}

function uniqueFile(root, predicate, label) {
  const matches = walkFiles(root).filter(predicate);
  if (matches.length !== 1) {
    fail(`expected exactly one ${label} under ${root}, found ${JSON.stringify(matches)}`);
  }
  return matches[0];
}

function resolveBundleRoot(bundleRoot, mode) {
  const nodeName = process.platform === 'win32' ? 'ccem-node.exe' : 'ccem-node';
  const nodeBin = uniqueFile(bundleRoot, (file) => path.basename(file) === nodeName, nodeName);
  const helper = uniqueFile(
    bundleRoot,
    (file) => path.basename(file) === 'dsh-history-helper.mjs'
      && path.basename(path.dirname(file)) === 'lib'
      && path.basename(path.dirname(path.dirname(file))) === 'dsh-history',
    'dsh-history/lib/dsh-history-helper.mjs',
  );
  return { nodeBin, resourceRoot: path.dirname(path.dirname(helper)), mode };
}

function resolveInputs(args, cleanupRoots) {
  if (args['app-bundle']) {
    const bundleRoot = path.resolve(args['app-bundle']);
    if (!fs.statSync(bundleRoot, { throwIfNoEntry: false })?.isDirectory()) {
      fail(`app bundle is not a directory: ${bundleRoot}`);
    }
    return resolveBundleRoot(bundleRoot, 'final-app-bundle');
  }

  if (args['nsis-installer']) {
    if (process.platform !== 'win32') fail('--nsis-installer is only supported on Windows');
    const installer = path.resolve(args['nsis-installer']);
    if (!fs.statSync(installer, { throwIfNoEntry: false })?.isFile()) {
      fail(`NSIS installer is not a file: ${installer}`);
    }
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-dsh-nsis-smoke-'));
    cleanupRoots.push(installRoot);
    const installed = spawnSync(installer, ['/S', '/NS', `/D=${installRoot}`], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });
    if (installed.error || installed.status !== 0) {
      fail(`NSIS install failed (${installed.status ?? 'no status'}): ${installed.error?.message ?? installed.stderr}`);
    }
    return resolveBundleRoot(installRoot, 'final-nsis-install');
  }

  if (args.node || args.resource) {
    if (!args.node || !args.resource) fail('--node and --resource must be provided together');
    return {
      nodeBin: path.resolve(args.node),
      resourceRoot: path.resolve(args.resource),
      mode: 'explicit-paths',
    };
  }

  const triple = hostTriple();
  const extension = process.platform === 'win32' ? '.exe' : '';
  return {
    nodeBin: path.join(desktopRoot, 'src-tauri', 'binaries', `ccem-node-${triple}${extension}`),
    resourceRoot: path.join(desktopRoot, 'src-tauri', 'resources', 'dsh-history'),
    mode: 'staged-current-platform',
  };
}

function projectKey(cwd) {
  let readable = '';
  let separatorRun = false;
  for (const char of cwd) {
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char;
      separatorRun = false;
    } else {
      readable += `~${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

async function writeFixture(sessionsRoot) {
  const cwd = path.join(path.dirname(sessionsRoot), 'project');
  const sessionId = 'session-bundle-smoke';
  const callId = 'tool-bundle-smoke';
  const now = Date.now();
  const events = [
    { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
    {
      type: 'user/message', seq: 1, time: now + 1, surfaceOp: 'append',
      data: {
        id: randomUUID(), role: 'user', source: { kind: 'terminal' },
        content: [{ type: 'text', text: 'bundle smoke' }],
      },
    },
    { type: 'step/start', seq: 2, time: now + 2, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message', seq: 3, time: now + 3, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: randomUUID(), role: 'assistant',
          source: { kind: 'model', provider: 'bundle-smoke-provider', model: 'bundle-smoke-model' },
          content: [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"/fixture"}' }],
        },
      },
    },
    {
      type: 'tool/result', seq: 4, time: now + 4, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: randomUUID(), role: 'user', source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'fixture content' }] }],
        },
      },
    },
    {
      type: 'assistant/message', seq: 5, time: now + 5, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: {
          id: randomUUID(), role: 'assistant',
          source: { kind: 'model', provider: 'bundle-smoke-provider', model: 'bundle-smoke-model' },
          content: [{ type: 'text', text: 'bundle smoke ok' }],
        },
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      },
    },
    { type: 'step/end', seq: 6, time: now + 6, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 7, time: now + 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const header = { type: 'session', version: 0, id: sessionId, createdAt: now, cwd, delegationDepth: 0 };
  const sessionDir = path.join(sessionsRoot, projectKey(cwd), sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const headerFrame = await compress(Buffer.from(`${JSON.stringify(header)}\n`));
  const eventFrame = await compress(Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`));
  const artifact = path.join(sessionDir, 'session.jsonl.zstd');
  fs.writeFileSync(artifact, Buffer.concat([headerFrame, eventFrame]));
  return { artifact, cwd, sessionId };
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function cleanEnvironment(tempRoot) {
  const environment = {
    HOME: path.join(tempRoot, 'home'),
    USERPROFILE: path.join(tempRoot, 'home'),
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
    NODE_PATH: '',
    PATH: process.platform === 'win32' ? path.dirname(process.execPath) : '/usr/bin:/bin',
  };
  if (process.platform === 'win32') {
    if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
    if (process.env.ComSpec) environment.ComSpec = process.env.ComSpec;
  }
  fs.mkdirSync(environment.HOME, { recursive: true });
  return environment;
}

function probeBundledNode(nodeBin, environment) {
  const raw = execFileSync(nodeBin, [
    '-p',
    'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,execPath:process.execPath})',
  ], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true, env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const probe = JSON.parse(raw.trim());
  const [major, minor] = probe.version.split('.').map(Number);
  assert(major > 22 || (major === 22 && minor >= 15), `bundled Node ${probe.version} is below 22.15.0`);
  assert(probe.platform === process.platform, `bundled Node platform ${probe.platform} does not match runner ${process.platform}`);
  assert(probe.arch === process.arch, `bundled Node arch ${probe.arch} does not match runner ${process.arch}`);
  const normalize = (value) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase()
    : fs.realpathSync(value);
  assert(normalize(probe.execPath) === normalize(nodeBin), `bundled Node execPath mismatch: ${probe.execPath}`);
  return probe;
}

function invokeHelper(nodeBin, helper, request, environment, roots) {
  const stdout = execFileSync(nodeBin, [helper], {
    cwd: path.dirname(path.dirname(helper)),
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    env: roots ? { ...environment, __DSH_HISTORY_ROOTS: JSON.stringify(roots) } : environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout.trim());
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function main() {
  const cleanupRoots = [];
  try {
    const args = parseArgs(process.argv.slice(2));
    const { nodeBin, resourceRoot, mode } = resolveInputs(args, cleanupRoots);
    const helper = path.join(resourceRoot, 'lib', 'dsh-history-helper.mjs');
    const packageJson = path.join(resourceRoot, 'package.json');
    assert(fs.statSync(nodeBin, { throwIfNoEntry: false })?.isFile(), `bundled ccem-node missing: ${nodeBin}`);
    assert(fs.statSync(helper, { throwIfNoEntry: false })?.isFile(), `bundled helper missing: ${helper}`);
    assert(fs.statSync(packageJson, { throwIfNoEntry: false })?.isFile(), `bundled package.json missing: ${packageJson}`);

    const resourceFiles = walkFiles(resourceRoot).map((file) => path.relative(resourceRoot, file)).sort();
    assert(JSON.stringify(resourceFiles) === JSON.stringify(['lib/dsh-history-helper.mjs', 'package.json'].map((file) => path.normalize(file)).sort()), `unexpected resource closure: ${JSON.stringify(resourceFiles)}`);
    const packageMetadata = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    assert(packageMetadata.version === expectedDshVersion, `expected DSH ${expectedDshVersion}, got ${packageMetadata.version}`);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-dsh-bundle-smoke-'));
    cleanupRoots.push(tempRoot);
    const sessionsRoot = path.join(tempRoot, 'dsh-home', 'sessions');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const fixture = await writeFixture(sessionsRoot);
    const environment = cleanEnvironment(tempRoot);
    const nodeProbe = probeBundledNode(nodeBin, environment);
    const before = fs.statSync(fixture.artifact);
    const hashBefore = sha256(fixture.artifact);

    const list = invokeHelper(nodeBin, helper, { op: 'list', roots: [sessionsRoot], limit: 10 }, environment);
    assert(list.ok === true && list.schemaVersion === 1, `list failed: ${JSON.stringify(list)}`);
    assert(list.dshVersion === expectedDshVersion, `list reported unexpected DSH version ${list.dshVersion}`);
    const session = list.data.find((item) => item.sessionId === fixture.sessionId);
    assert(session?.provider === 'bundle-smoke-provider', 'list provider projection failed');
    assert(session?.model === 'bundle-smoke-model', 'list model projection failed');

    const detail = invokeHelper(nodeBin, helper, { op: 'detail', sourceInstanceId: session.sourceInstanceId, sessionId: fixture.sessionId }, environment, [sessionsRoot]);
    assert(detail.ok === true, `detail failed: ${JSON.stringify(detail)}`);
    assert(detail.data.events.some((event) => event.content?.some((block) => block.type === 'tool-call' && block.id === 'tool-bundle-smoke')), 'detail tool-call content missing');
    assert(detail.data.events.some((event) => event.type === 'tool/result'), 'detail tool-result projection missing');
    assert(detail.data.events.some((event) => event.content?.some((block) => block.type === 'tool-result' && block.toolCallId === 'tool-bundle-smoke')), 'detail tool-result content missing');

    const usage = invokeHelper(nodeBin, helper, { op: 'usage', roots: [sessionsRoot] }, environment);
    assert(usage.ok === true, `usage failed: ${JSON.stringify(usage)}`);
    const usageSession = usage.data.find((item) => item.sessionId === fixture.sessionId);
    assert(usageSession?.steps?.length === 1, 'usage step missing or duplicated');
    const step = usageSession.steps[0];
    assert(step.inputTokens === 100 && step.outputTokens === 50 && step.cacheReadTokens === 10 && step.cacheWriteTokens === 5, `usage tokens mismatch: ${JSON.stringify(step)}`);

    const after = fs.statSync(fixture.artifact);
    assert(hashBefore === sha256(fixture.artifact), 'source SHA-256 changed');
    assert(before.size === after.size, 'source size changed');
    assert(before.mtimeMs === after.mtimeMs, 'source mtime changed');

    const evidence = {
      ok: true,
      mode,
      platform: `${process.platform}-${process.arch}`,
      nodeBin,
      nodeVersion: nodeProbe.version,
      nodeExecPath: nodeProbe.execPath,
      resourceRoot,
      dshVersion: list.dshVersion,
      operations: ['list', 'detail', 'usage'],
      zstd: true,
      sourceUnchanged: true,
      toolCallProjected: true,
      toolResultProjected: true,
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      source: { sha256: hashBefore, size: before.size, mtimeMs: before.mtimeMs },
    };
    if (args.evidence) {
      const evidencePath = path.resolve(args.evidence);
      fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
      fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    for (const cleanupRoot of cleanupRoots.reverse()) {
      if (process.platform === 'win32' && fs.existsSync(cleanupRoot)) {
        const uninstallers = walkFiles(cleanupRoot).filter((file) => path.basename(file).toLowerCase() === 'uninstall.exe');
        if (uninstallers.length === 1) {
          spawnSync(uninstallers[0], ['/S'], { timeout: 60_000, windowsHide: true, stdio: 'ignore' });
        }
      }
      fs.rmSync(cleanupRoot, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
