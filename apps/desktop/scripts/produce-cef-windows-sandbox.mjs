import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  WINDOWS_SANDBOX_CLIENT_NAME,
  WINDOWS_SANDBOX_MARKER_NAME,
  WINDOWS_SOURCE_BOOTSTRAP_NAME,
  WINDOWS_SOURCE_CLIENT_NAME,
  WINDOWS_TARGET,
  WINDOWS_CEF_SOURCE_PIN,
  assertRunWinMainExport,
  assertX64PeHeaders,
  createWindowsSandboxHeadersInspectionPlan,
  createWindowsSandboxInspectionPlan,
  createWindowsSandboxMarker,
  inspectOfficialWindowsCefSource,
} from './stage-cef-windows.mjs';
import {
  assertPeX64,
  canonicalPeSha256,
  patchTauriBundleTypeNsis,
} from './windows-pe-contract.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const desktopDir = path.resolve(path.dirname(scriptPath), '..');
const tauriDir = path.join(desktopDir, 'src-tauri');
const defaultReleaseRoot = path.join(tauriDir, 'target', WINDOWS_TARGET, 'release');

function fail(message) {
  throw new Error(`[cef-windows-producer] ${message}`);
}

async function pathType(candidate) {
  try {
    const stat = await fsp.lstat(candidate);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    if (stat.isFile()) return 'file';
    return 'other';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function requireFile(candidate, label) {
  if (await pathType(candidate) !== 'file') fail(`${label} must be a regular file: ${candidate}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireEnvironment(environment, name, pattern) {
  const value = environment[name]?.trim();
  if (!value || (pattern && !pattern.test(value))) fail(`${name} is missing or invalid`);
  return value;
}

export function expectedWindowsSandboxRoot(environment = process.env) {
  const runnerTemp = requireEnvironment(environment, 'RUNNER_TEMP');
  const runId = requireEnvironment(environment, 'GITHUB_RUN_ID', /^\d+$/u);
  const runAttempt = requireEnvironment(environment, 'GITHUB_RUN_ATTEMPT', /^\d+$/u);
  return path.resolve(
    runnerTemp,
    'ccem-cef-sandbox',
    `${runId}-${runAttempt}`,
    WINDOWS_TARGET,
  );
}

function resolveDumpbin(environment = process.env) {
  const configured = environment.CCEM_DUMPBIN_PATH;
  if (!configured || !path.win32.isAbsolute(configured)) {
    fail('CCEM_DUMPBIN_PATH must be an absolute Visual Studio dumpbin.exe path');
  }
  const normalized = path.win32.normalize(configured);
  if (
    path.win32.basename(normalized).toLowerCase() !== 'dumpbin.exe'
    || !/^C:\\Program Files(?: \(x86\))?\\Microsoft Visual Studio\\2022\\[^\\]+\\VC\\Tools\\MSVC\\[^\\]+\\bin\\Hostx64\\x64\\dumpbin\.exe$/iu.test(normalized)
  ) {
    fail('CCEM_DUMPBIN_PATH is outside the pinned Visual Studio 2022 x64 tool boundary');
  }
  return normalized;
}

function runCommand(command) {
  const result = spawnSync(command.program, command.args, {
    cwd: desktopDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) fail(`cannot execute ${command.program}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command.program} ${command.args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function assertProducerAuthorization(environment = process.env) {
  if (
    environment.GITHUB_ACTIONS !== 'true'
    || environment.RUNNER_OS !== 'Windows'
    || process.platform !== 'win32'
  ) {
    fail('Windows sandbox production is allowed only on a GitHub Actions Windows runner');
  }
}

export async function produceWindowsSandboxArtifacts({
  releaseRoot,
  outputRoot,
  gitSha,
  inspectNative,
  expectedSourcePin = WINDOWS_CEF_SOURCE_PIN,
}) {
  if (!/^[a-f0-9]{40}$/u.test(gitSha ?? '')) fail('gitSha must be an exact commit SHA');
  if (await pathType(outputRoot) !== 'missing') fail(`producer output must not pre-exist: ${outputRoot}`);
  const source = await inspectOfficialWindowsCefSource(releaseRoot, { expectedSourcePin });
  const { archive, sourcePin } = source;
  const sourceBootstrap = path.join(releaseRoot, WINDOWS_SOURCE_BOOTSTRAP_NAME);
  const sourceClient = path.join(releaseRoot, WINDOWS_SOURCE_CLIENT_NAME);
  await requireFile(sourceBootstrap, 'official CEF bootstrap');
  await requireFile(sourceClient, 'Cargo cdylib client');

  const bootstrap = await fsp.readFile(sourceBootstrap);
  const client = await fsp.readFile(sourceClient);
  const bootstrapPe = assertPeX64(bootstrap, 'official CEF bootstrap');
  const clientPe = assertPeX64(client, 'Cargo cdylib client');
  if (bootstrapPe.certificateSize !== 0 || clientPe.certificateSize !== 0) {
    fail('producer inputs must be unsigned so release signing creates exactly one signature');
  }
  const patchedClient = patchTauriBundleTypeNsis(client).bytes;

  const marker = createWindowsSandboxMarker({
    gitSha,
    cefArchiveName: archive.name,
    cefArchiveSha1: archive.sha1,
    sourcePin,
    unsignedBootstrapSha256: sha256(bootstrap),
    unsignedClientLibrarySha256: sha256(patchedClient),
    bootstrapCanonicalSha256: canonicalPeSha256(bootstrap),
    clientCanonicalSha256: canonicalPeSha256(patchedClient),
  });

  const parent = path.dirname(outputRoot);
  const temporary = path.join(
    parent,
    `.${path.basename(outputRoot)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  await fsp.mkdir(parent, { recursive: true });
  await fsp.mkdir(temporary, { recursive: false });
  try {
    await fsp.writeFile(path.join(temporary, WINDOWS_SOURCE_BOOTSTRAP_NAME), bootstrap);
    await fsp.writeFile(path.join(temporary, WINDOWS_SANDBOX_CLIENT_NAME), patchedClient);
    await fsp.writeFile(
      path.join(temporary, WINDOWS_SANDBOX_MARKER_NAME),
      `${JSON.stringify(marker, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (inspectNative) await inspectNative(temporary);
    await fsp.rename(temporary, outputRoot);
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { archive, marker, outputRoot };
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    releaseRoot: defaultReleaseRoot,
    outputRoot: null,
    target: WINDOWS_TARGET,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (['--release-root', '--output', '--target'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      index += 1;
      if (argument === '--release-root') options.releaseRoot = path.resolve(value);
      if (argument === '--output') options.outputRoot = path.resolve(value);
      if (argument === '--target') options.target = value;
    } else if (argument === '--help') options.help = true;
    else fail(`unknown argument: ${argument}`);
  }
  return options;
}

export async function run(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: node scripts/produce-cef-windows-sandbox.mjs [--dry-run] --release-root <dir> --output <current-run-dir> --target x86_64-pc-windows-msvc\n');
    return { status: 'help' };
  }
  if (options.target !== WINDOWS_TARGET) fail(`unsupported Windows Mode 2 target ${options.target}`);
  const gitSha = requireEnvironment(environment, 'GITHUB_SHA', /^[a-f0-9]{40}$/u);
  const expectedOutput = expectedWindowsSandboxRoot(environment);
  if (!options.outputRoot || options.outputRoot !== expectedOutput) {
    fail(`producer output must be the isolated current-run path ${expectedOutput}`);
  }
  const dumpbinPath = options.dryRun ? environment.CCEM_DUMPBIN_PATH : resolveDumpbin(environment);
  const plan = {
    build: {
      program: 'cargo',
      args: [
        'rustc', '--locked', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml',
        '--lib', '--crate-type', 'cdylib', '--target', WINDOWS_TARGET, '--release',
      ],
    },
    releaseRoot: options.releaseRoot,
    outputRoot: options.outputRoot,
    sourceClient: WINDOWS_SOURCE_CLIENT_NAME,
    clientLibrary: WINDOWS_SANDBOX_CLIENT_NAME,
    bootstrapExecutable: WINDOWS_SOURCE_BOOTSTRAP_NAME,
    dumpbinPath,
  };
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return { status: 'dry-run', plan };
  }

  assertProducerAuthorization(environment);
  const inspectNative = async (sandboxRoot) => {
    assertRunWinMainExport(runCommand(createWindowsSandboxInspectionPlan({
      sandboxRoot,
      dumpbinPath,
    })));
    for (const command of createWindowsSandboxHeadersInspectionPlan({ sandboxRoot, dumpbinPath })) {
      assertX64PeHeaders(runCommand(command));
    }
  };
  const result = await produceWindowsSandboxArtifacts({
    releaseRoot: options.releaseRoot,
    outputRoot: options.outputRoot,
    gitSha,
    inspectNative,
  });
  process.stdout.write(`[cef-windows-producer] wrote ${result.outputRoot}\n`);
  return { status: 'produced', ...result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  run().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
