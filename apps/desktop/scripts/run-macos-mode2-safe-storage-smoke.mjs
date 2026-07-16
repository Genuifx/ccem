import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CCEM_SAFE_STORAGE_SERVICE,
  inspectCefMacosSafeStorageBrandingBytes,
} from './cef-macos-safe-storage-branding.mjs';
import {
  CHROMIUM_SAFE_STORAGE_SERVICE,
  MACOS_SAFE_STORAGE_PHASES,
  MACOS_SAFE_STORAGE_SCENARIOS,
  MACOS_SAFE_STORAGE_SMOKE_ALLOW_ENV,
  MACOS_SAFE_STORAGE_SMOKE_ATTESTATION_ENV,
  MACOS_SAFE_STORAGE_SMOKE_NONCE_ENV,
  MACOS_SAFE_STORAGE_SMOKE_ROOT_ENV,
  createMacosSafeStorageSmokePlan,
  validateMacosSafeStorageRuntimeReceipt,
  validateMacosSafeStorageSmokeAttestation,
} from './macos-mode2-safe-storage-smoke-contract.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SECURITY = '/usr/bin/security';
const CODESIGN = '/usr/bin/codesign';
const DITTO = '/usr/bin/ditto';
const PS = '/bin/ps';

function fail(message) {
  throw new Error(`[macos-mode2-safe-storage-smoke-runner] ${message}`);
}

function parseArguments(argv) {
  const options = { dryRun: false, sourceApp: undefined, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--app') {
      options.sourceApp = argv[index += 1];
    } else if (argument === '--timeout-ms') {
      options.timeoutMs = Number(argv[index += 1]);
    } else {
      fail(`unknown argument ${argument}`);
    }
  }
  if (!options.sourceApp) fail('--app is required');
  if (
    !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 30_000
    || options.timeoutMs > 600_000
  ) {
    fail('--timeout-ms must be between 30000 and 600000');
  }
  return options;
}

export function assertMacosSafeStorageSmokeAuthorization(
  environment = process.env,
  platform = process.platform,
) {
  if (
    platform !== 'darwin'
    || environment.GITHUB_ACTIONS !== 'true'
    || environment.CI !== 'true'
    || environment.RUNNER_OS !== 'macOS'
    || environment[MACOS_SAFE_STORAGE_SMOKE_ALLOW_ENV] !== '1'
  ) {
    fail('real smoke is allowed only on an explicitly authorized GitHub Actions macOS runner');
  }
  return true;
}

function assertRunnerOwnedSource(plan, environment) {
  const source = path.resolve(plan.paths.sourceApp);
  const allowedRoots = [environment.RUNNER_TEMP, environment.GITHUB_WORKSPACE]
    .filter(Boolean)
    .map((root) => `${path.resolve(root)}${path.sep}`);
  if (!allowedRoots.some((root) => source.startsWith(root))) {
    fail('source app must be under RUNNER_TEMP or GITHUB_WORKSPACE');
  }
}

function collectOutput(stream, chunks, size) {
  stream?.on('data', (chunk) => {
    const bytes = Buffer.from(chunk);
    size.value += bytes.length;
    if (size.value <= MAX_OUTPUT_BYTES) chunks.push(bytes);
  });
}

export async function runCommand(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      detached: options.detached ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const size = { value: 0 };
    collectOutput(child.stdout, stdout, size);
    collectOutput(child.stderr, stderr, size);
    let timedOut = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        try {
          process.kill(options.detached ? -child.pid : child.pid, 'SIGKILL');
        } catch {
          // The process may have exited between the timeout and signal.
        }
      }, options.timeoutMs)
      : undefined;
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      const result = {
        code: code ?? -1,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (size.value > MAX_OUTPUT_BYTES) {
        reject(new Error(`${program} output exceeded ${MAX_OUTPUT_BYTES} bytes`));
      } else if (timedOut) {
        reject(new Error(`${program} timed out; a Safe Storage authorization prompt may be blocking CEF`));
      } else if (!options.allowFailure && result.code !== 0) {
        reject(new Error(
          `${program} exited ${result.code}${result.stderr ? `: ${result.stderr.trim()}` : ''}`,
        ));
      } else {
        resolve(result);
      }
    });
  });
}

function parseKeychainPaths(output) {
  const paths = [];
  for (const match of output.matchAll(/"([^"]+)"/gu)) paths.push(match[1]);
  return paths;
}

async function snapshotKeychainState(command) {
  const search = await command(SECURITY, ['list-keychains', '-d', 'user']);
  const defaultResult = await command(SECURITY, ['default-keychain', '-d', 'user'], {
    allowFailure: true,
  });
  const searchList = parseKeychainPaths(search.stdout);
  const defaultKeychain = defaultResult.code === 0
    ? parseKeychainPaths(defaultResult.stdout)[0] ?? null
    : null;
  if (searchList.length === 0) fail('refusing to replace an unreadable user Keychain search list');
  if (!defaultKeychain) fail('refusing to replace an unreadable user default Keychain');
  return { searchList, defaultKeychain };
}

async function verifyExclusiveKeychain(command, keychain) {
  const search = parseKeychainPaths(
    (await command(SECURITY, ['list-keychains', '-d', 'user'])).stdout,
  );
  const currentDefault = parseKeychainPaths(
    (await command(SECURITY, ['default-keychain', '-d', 'user'])).stdout,
  );
  if (
    search.length !== 1
    || path.resolve(search[0]) !== path.resolve(keychain)
    || currentDefault.length !== 1
    || path.resolve(currentDefault[0]) !== path.resolve(keychain)
  ) {
    fail('temporary Keychain is not the exclusive search list and default');
  }
}

async function createExclusiveTemporaryKeychain(command, keychain, password) {
  await command(SECURITY, ['create-keychain', '-p', password, keychain]);
  await command(SECURITY, ['set-keychain-settings', '-lut', '21600', keychain]);
  await command(SECURITY, ['unlock-keychain', '-p', password, keychain]);
  await command(SECURITY, ['list-keychains', '-d', 'user', '-s', keychain]);
  await command(SECURITY, ['default-keychain', '-d', 'user', '-s', keychain]);
  await verifyExclusiveKeychain(command, keychain);
}

async function restoreKeychainState(command, snapshot) {
  await command(SECURITY, ['list-keychains', '-d', 'user', '-s', ...snapshot.searchList]);
  await command(SECURITY, [
    'default-keychain', '-d', 'user', '-s', snapshot.defaultKeychain,
  ]);
  const restored = await snapshotKeychainState(command);
  if (
    JSON.stringify(restored.searchList) !== JSON.stringify(snapshot.searchList)
    || restored.defaultKeychain !== snapshot.defaultKeychain
  ) {
    fail('original user Keychain search list/default was not restored exactly');
  }
}

async function restoreKeychainStateWithRetry(command, snapshot) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await restoreKeychainState(command, snapshot);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `failed to restore original Keychain state after three attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function keychainItemPresent(command, keychain, service) {
  const result = await command(SECURITY, [
    'find-generic-password', '-a', 'Chromium', '-s', service, keychain,
  ], { allowFailure: true });
  if (result.code === 0) return true;
  if (result.code === 44) return false;
  fail(`inspect temporary Keychain item ${service}: ${result.stderr.trim() || result.code}`);
}

async function seedGenericChromiumItem(command, keychain) {
  const secret = randomBytes(32).toString('hex');
  await command(SECURITY, [
    'add-generic-password', '-a', 'Chromium', '-s', CHROMIUM_SAFE_STORAGE_SERVICE,
    '-w', secret, keychain,
  ]);
  return secret;
}

async function readTemporaryGenericSecret(command, keychain) {
  const result = await command(SECURITY, [
    'find-generic-password', '-w', '-a', 'Chromium',
    '-s', CHROMIUM_SAFE_STORAGE_SERVICE, keychain,
  ]);
  return result.stdout.replace(/\r?\n$/u, '');
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(file);
    input.once('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

async function inspectOwnedProcesses(command, appBundle) {
  const result = await command(PS, ['-axo', 'pid=,ppid=,command=']);
  const needle = `${appBundle}/`;
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match || !match[3].includes(needle)) return [];
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }];
  });
}

async function waitForOwnedProcessCleanup(command, appBundle) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const processes = await inspectOwnedProcesses(command, appBundle);
    if (processes.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return inspectOwnedProcesses(command, appBundle);
}

async function terminateOwnedProcesses(command, appBundle) {
  const processes = await inspectOwnedProcesses(command, appBundle);
  for (const processEntry of processes) {
    try {
      process.kill(processEntry.pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }
  return processes;
}

async function writePrivateJson(file, value, flag = 'wx') {
  await fsp.writeFile(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag, mode: 0o600 });
}

function runtimeEnvironment(plan, scenario, phase) {
  const ticket = path.join(scenario.root, 'tickets', `${phase}.ticket`);
  const environment = {};
  for (const name of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'USER',
    'LOGNAME',
    'SHELL',
    '__CF_USER_TEXT_ENCODING',
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return Object.assign(environment, {
    GITHUB_ACTIONS: 'true',
    CI: 'true',
    RUNNER_OS: 'macOS',
    RUNNER_TEMP: path.dirname(path.dirname(plan.paths.smokeRoot)),
    GITHUB_SHA: plan.sourceCommit,
    GITHUB_RUN_ID: plan.run.id,
    GITHUB_RUN_ATTEMPT: plan.run.attempt,
    [MACOS_SAFE_STORAGE_SMOKE_ALLOW_ENV]: '1',
    [MACOS_SAFE_STORAGE_SMOKE_NONCE_ENV]: plan.nonce,
    [MACOS_SAFE_STORAGE_SMOKE_ROOT_ENV]: plan.paths.smokeRoot,
    CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_SCENARIO: scenario.name,
    CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_PHASE: phase,
    CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_SCENARIO_ROOT: scenario.root,
    CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_RECEIPT_PATH: scenario.receipts[phase],
    CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_TICKET_PATH: ticket,
    CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_EXPECTED_EXE: plan.paths.executable,
    CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_KEYCHAIN_PATH: scenario.keychain,
    CCEM_MACOS_MODE2_SAFE_STORAGE_SMOKE_ISOLATION_RECEIPT:
      path.join(scenario.root, 'keychain', 'isolation.json'),
  });
}

async function requirePrivateRealDirectory(directory) {
  await fsp.chmod(directory, 0o700);
  const [metadata, canonical] = await Promise.all([
    fsp.lstat(directory),
    fsp.realpath(directory),
  ]);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || canonical !== path.resolve(directory)
    || metadata.uid !== process.geteuid()
    || (metadata.mode & 0o077) !== 0
  ) {
    fail(`smoke directory is not a private real current-user directory: ${directory}`);
  }
}

async function runScenario(plan, scenario, timeoutMs, dependencies) {
  const { command } = dependencies;
  const password = randomBytes(32).toString('hex');
  let keychainSnapshot;
  let keychainCreated = false;
  let restored = false;
  let genericSecret;
  const receipts = {};
  await fsp.mkdir(path.join(scenario.root, 'keychain'), { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(scenario.root, 'data', 'login', 'cef'), {
    recursive: true,
    mode: 0o700,
  });
  await fsp.mkdir(path.join(scenario.root, 'evidence'), { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(scenario.root, 'tickets'), { recursive: true, mode: 0o700 });
  try {
    keychainSnapshot = await snapshotKeychainState(command);
    keychainCreated = true;
    await createExclusiveTemporaryKeychain(command, scenario.keychain, password);
    await writePrivateJson(path.join(scenario.root, 'keychain', 'isolation.json'), {
      schemaVersion: 1,
      nonce: plan.nonce,
      scenario: scenario.name,
      keychainPath: scenario.keychain,
      exclusiveTemporaryKeychain: true,
    });
    if (scenario.name === 'generic-conflict') {
      genericSecret = await seedGenericChromiumItem(command, scenario.keychain);
    }
    if (await keychainItemPresent(command, scenario.keychain, CCEM_SAFE_STORAGE_SERVICE)) {
      fail('temporary Keychain unexpectedly contains CCEM Safe Storage before launch');
    }
    const genericBefore = await keychainItemPresent(
      command,
      scenario.keychain,
      CHROMIUM_SAFE_STORAGE_SERVICE,
    );
    if (genericBefore !== (scenario.name === 'generic-conflict')) {
      fail(`temporary Keychain ${scenario.name} seed state is inconsistent`);
    }

    for (const phase of MACOS_SAFE_STORAGE_PHASES) {
      const ticket = path.join(scenario.root, 'tickets', `${phase}.ticket`);
      await writePrivateJson(ticket, {
        schemaVersion: 1,
        nonce: plan.nonce,
        scenario: scenario.name,
        phase,
      });
      await command(plan.paths.executable, [], {
        environment: runtimeEnvironment(plan, scenario, phase),
        detached: true,
        timeoutMs,
      });
      const receipt = JSON.parse(await fsp.readFile(scenario.receipts[phase], 'utf8'));
      validateMacosSafeStorageRuntimeReceipt(receipt, plan, scenario.name, phase);
      receipts[phase] = receipt;
      const leftovers = await waitForOwnedProcessCleanup(command, plan.paths.installedApp);
      if (leftovers.length !== 0) {
        fail(`signed app left ${leftovers.length} CCEM/CEF process(es) after ${scenario.name}/${phase}`);
      }
      if (!await keychainItemPresent(command, scenario.keychain, CCEM_SAFE_STORAGE_SERVICE)) {
        fail(`CCEM Safe Storage item is absent after ${scenario.name}/${phase}`);
      }
      if (
        genericSecret !== undefined
        && await readTemporaryGenericSecret(command, scenario.keychain) !== genericSecret
      ) {
        fail('generic Chromium Safe Storage secret changed during the CCEM launch');
      }
    }
    const genericAfter = await keychainItemPresent(
      command,
      scenario.keychain,
      CHROMIUM_SAFE_STORAGE_SERVICE,
    );
    if (genericAfter !== (scenario.name === 'generic-conflict')) {
      fail('generic Chromium Safe Storage item was created, removed, or renamed by CCEM');
    }
    return {
      entry: {
        name: scenario.name,
        genericItemSeeded: scenario.name === 'generic-conflict',
        genericItemPresentAfter: genericAfter,
        ccemItemPresentAfter: true,
        genericItemUnchanged: genericSecret === undefined
          || await readTemporaryGenericSecret(command, scenario.keychain) === genericSecret,
        exclusiveTemporaryKeychain: true,
        launchCount: 2,
        receipts,
        ownedProcessesAfter: 0,
      },
      restoreState: () => restored,
    };
  } finally {
    await terminateOwnedProcesses(command, plan.paths.installedApp).catch(() => {});
    if (keychainSnapshot) {
      await restoreKeychainStateWithRetry(command, keychainSnapshot);
      restored = true;
    }
    if (keychainCreated && restored) {
      await command(SECURITY, ['delete-keychain', scenario.keychain], { allowFailure: true });
      await fsp.rm(scenario.keychain, { force: true });
    }
  }
}

export async function executeMacosSafeStorageSmoke(plan, options = {}) {
  const command = options.command ?? runCommand;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const smokeBase = path.dirname(plan.paths.smokeRoot);
  await fsp.mkdir(smokeBase, { recursive: true, mode: 0o700 });
  await requirePrivateRealDirectory(smokeBase);
  await fsp.mkdir(plan.paths.smokeRoot, { recursive: false, mode: 0o700 });
  await requirePrivateRealDirectory(plan.paths.smokeRoot);
  await fsp.mkdir(path.dirname(plan.paths.installedApp), { recursive: false, mode: 0o700 });
  await fsp.mkdir(plan.paths.evidenceRoot, { recursive: false, mode: 0o700 });
  await fsp.mkdir(path.join(plan.paths.smokeRoot, 'scenarios'), { recursive: false, mode: 0o700 });
  await command(DITTO, ['--rsrc', '--extattr', '--acl', plan.paths.sourceApp, plan.paths.installedApp]);
  await command(CODESIGN, ['--verify', '--deep', '--strict', '--verbose=4', plan.paths.installedApp]);
  const frameworkBytes = await fsp.readFile(plan.paths.framework);
  const branding = inspectCefMacosSafeStorageBrandingBytes(frameworkBytes);
  if (branding.unbrandedOffsets.length !== 0 || branding.brandedOffsets.length !== 1) {
    fail('signed app framework does not contain one exclusive CCEM Safe Storage identity');
  }
  const expectedSlot = Buffer.alloc(Buffer.byteLength(CHROMIUM_SAFE_STORAGE_SERVICE, 'utf8'));
  Buffer.from(CCEM_SAFE_STORAGE_SERVICE, 'utf8').copy(expectedSlot);
  const brandedOffset = branding.brandedOffsets[0];
  if (!frameworkBytes.subarray(brandedOffset, brandedOffset + expectedSlot.length).equals(expectedSlot)) {
    fail('signed app framework CCEM Safe Storage identity is not the exact null-padded slot');
  }

  const scenarioEntries = [];
  let allKeychainStatesRestored = true;
  try {
    for (const scenario of plan.scenarios) {
      const result = await runScenario(plan, scenario, timeoutMs, { command });
      scenarioEntries.push(result.entry);
      allKeychainStatesRestored &&= result.restoreState();
      await fsp.rm(scenario.root, { recursive: true, force: true });
    }
    await fsp.rm(path.join(plan.paths.smokeRoot, 'scenarios'), { recursive: true, force: true });
    const executableSha256 = await sha256File(plan.paths.executable);
    const frameworkSha256 = await sha256File(plan.paths.framework);
    await fsp.rm(path.dirname(plan.paths.installedApp), { recursive: true, force: true });
    const attestation = {
      schemaVersion: 1,
      platform: 'macos',
      status: 'passed',
      sourceCommit: plan.sourceCommit,
      nonce: plan.nonce,
      run: plan.run,
      app: {
        bundlePath: plan.paths.installedApp,
        executablePath: plan.paths.executable,
        executableSha256,
        frameworkSha256,
        signatureVerified: true,
      },
      safeStorageBranding: {
        service: CCEM_SAFE_STORAGE_SERVICE,
        genericServiceAbsentFromFramework: true,
        uniqueBrandedSlot: true,
      },
      scenarios: scenarioEntries,
      cleanup: {
        originalKeychainStateRestored: allKeychainStatesRestored,
        temporaryKeychainsDeleted: plan.scenarios.every((scenario) => !fs.existsSync(scenario.keychain)),
        scenarioRootsDeleted: plan.scenarios.every((scenario) => !fs.existsSync(scenario.root)),
        installedAppDeleted: !fs.existsSync(plan.paths.installedApp),
      },
    };
    validateMacosSafeStorageSmokeAttestation(attestation, plan);
    await writePrivateJson(plan.paths.attestationPath, attestation);
    return attestation;
  } catch (error) {
    await terminateOwnedProcesses(command, plan.paths.installedApp).catch(() => {});
    await fsp.rm(path.dirname(plan.paths.installedApp), { recursive: true, force: true });
    throw error;
  }
}

export async function run(argv, dependencies = {}) {
  const options = parseArguments(argv);
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const plan = createMacosSafeStorageSmokePlan({
    environment,
    sourceApp: path.resolve(options.sourceApp),
  });
  if (options.dryRun) return plan;
  assertMacosSafeStorageSmokeAuthorization(environment, platform);
  assertRunnerOwnedSource(plan, environment);
  if (fs.existsSync(plan.paths.smokeRoot)) {
    fail('current-run smoke root must not pre-exist');
  }
  return executeMacosSafeStorageSmoke(plan, {
    command: dependencies.command,
    timeoutMs: options.timeoutMs,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  run(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

export {
  CODESIGN as MACOS_CODESIGN_PATH,
  SECURITY as MACOS_SECURITY_PATH,
};
