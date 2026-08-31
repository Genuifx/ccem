#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { requiredMacCefFrameworkFiles } from './macos-cef-bundle-contract.mjs';

const launcherPath = fileURLToPath(import.meta.url);
const desktopDir = path.resolve(path.dirname(launcherPath), '..');
const artifactDirName = '.artifacts/tauri-dev';
const vitePortStart = 14000;
const vitePortRange = 10000;
const mcpPortStart = 30000;
const mcpBlockSize = 100;
const mcpBlockCount = 300;
const cefFrameworkExecutableName = 'Chromium Embedded Framework';
const cefFrameworkBundleName = `${cefFrameworkExecutableName}.framework`;
const cefHelperName = 'ccem-cef-helper';
const cefCargoOutputLimit = 64 * 1024 * 1024;
const cefSideBySideRuntimeNames = Object.freeze([
  'libEGL.dylib',
  'libGLESv2.dylib',
  'libvk_swiftshader.dylib',
  'vk_swiftshader_icd.json',
]);

function parseArguments(argv) {
  let describe = false;
  let worktreeRoot;
  const tauriArguments = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--describe') {
      describe = true;
      continue;
    }
    if (argument === '--worktree-root') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--worktree-root requires a path');
      }
      worktreeRoot = value;
      index += 1;
      continue;
    }
    tauriArguments.push(argument);
  }

  return { describe, worktreeRoot, tauriArguments };
}

function discoverWorktreeRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: desktopDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Unable to determine the Git worktree root');
  }
  return path.resolve(result.stdout.trim());
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'worktree';
}

function environmentFlagEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase());
}

function deriveInstance(worktreeRoot, environment = process.env) {
  const normalizedRoot = path.resolve(worktreeRoot);
  const hash = createHash('sha256').update(normalizedRoot).digest('hex');
  const slug = slugify(path.basename(normalizedRoot));
  const instanceId = `${slug}-${hash.slice(0, 8)}`;
  const vitePort = vitePortStart + (Number.parseInt(hash.slice(0, 8), 16) % vitePortRange);
  // The bridge scans base_port..base_port+99. Allocate aligned blocks so
  // neighboring worktrees do not accidentally scan through one another.
  const mcpPort =
    mcpPortStart +
    (Number.parseInt(hash.slice(8, 16), 16) % mcpBlockCount) * mcpBlockSize;
  const productName = `CCEM Desktop Dev ${slug}`;
  const identifier = `com.ccem.desktop.dev.i${hash.slice(0, 8)}`;
  const devUrl = `http://127.0.0.1:${vitePort}`;
  const explicitBrowserDataRoot = environment.CCEM_BROWSER_DATA_ROOT?.trim();
  const browserDataRoot = explicitBrowserDataRoot || path.join(
    os.homedir(),
    '.ccem',
    'browser-dev',
    instanceId,
  );
  const browserDataRootSource = explicitBrowserDataRoot
    ? 'explicit override'
    : 'worktree default';
  const backgroundServices = environmentFlagEnabled(
    environment.CCEM_DESKTOP_DEV_BACKGROUND_SERVICES,
  )
    ? '1'
    : '0';

  return {
    instanceId,
    worktreeRoot: normalizedRoot,
    vitePort,
    mcpPort,
    productName,
    identifier,
    browserDataRoot,
    browserDataRootSource,
    tauriConfig: {
      productName,
      identifier,
      build: {
        beforeDevCommand: `pnpm dev --host 127.0.0.1 --port ${vitePort} --strictPort`,
        devUrl,
      },
    },
    environment: {
      CCEM_DESKTOP_DEV_INSTANCE_ID: instanceId,
      CCEM_TAURI_MCP_PORT: String(mcpPort),
      CCEM_DESKTOP_DEV_BACKGROUND_SERVICES: backgroundServices,
      CCEM_BROWSER_DATA_ROOT: browserDataRoot,
    },
  };
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireLauncherLock(lockPath, instance) {
  const ownerToken = randomUUID();
  const payload = {
    pid: process.pid,
    ownerToken,
    instanceId: instance.instanceId,
    worktreeRoot: instance.worktreeRoot,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await fs.open(lockPath, 'wx', 0o600);
      await file.writeFile(`${JSON.stringify(payload, null, 2)}\n`);
      await file.close();
      return {
        async setChildPid(childPid) {
          payload.childPid = childPid;
          const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
          if (current.ownerToken !== ownerToken) {
            throw new Error(`Launcher lock ownership changed unexpectedly at ${lockPath}`);
          }
          const temporaryPath = `${lockPath}.${ownerToken}.tmp`;
          try {
            await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
              mode: 0o600,
            });
            await fs.rename(temporaryPath, lockPath);
          } finally {
            await fs.unlink(temporaryPath).catch((error) => {
              if (error?.code !== 'ENOENT') {
                throw error;
              }
            });
          }
        },
        async release() {
          try {
            const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
            if (current.ownerToken === ownerToken) {
              await fs.unlink(lockPath);
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              console.warn(`[tauri:dev] Failed to release launcher lock: ${error.message}`);
            }
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      let existing;
      try {
        existing = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      } catch (readError) {
        throw new Error(
          `Launcher lock ${lockPath} is unreadable (${readError.message}). ` +
            'Inspect it before removing anything.',
        );
      }
      const liveOwnerPid = [existing?.pid, existing?.childPid].find(isProcessAlive);
      if (liveOwnerPid) {
        throw new Error(
          `Tauri dev is already running for this worktree (pid ${liveOwnerPid}). ` +
            'Stop that exact process instead of killing another CCEM instance.',
        );
      }
      await fs.unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== 'ENOENT') {
          throw unlinkError;
        }
      });
    }
  }

  throw new Error(`Unable to acquire launcher lock at ${lockPath}`);
}

function canListen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function firstAvailablePort(start, step, attempts, min, span, host) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = min + ((start - min + offset * step) % span);
    if (await canListen(candidate, host)) {
      return candidate;
    }
  }
  return undefined;
}

async function resolveAvailablePorts(instance) {
  const vitePort = await firstAvailablePort(
    instance.vitePort,
    1,
    vitePortRange,
    vitePortStart,
    vitePortRange,
  );
  const mcpPort = await firstAvailablePort(
    instance.mcpPort,
    mcpBlockSize,
    mcpBlockCount,
    mcpPortStart,
    mcpBlockSize * mcpBlockCount,
    '0.0.0.0',
  );
  if (vitePort === undefined || mcpPort === undefined) {
    throw new Error(
      `No free development port range is available for ${instance.instanceId}; ` +
        'this launcher will not terminate an existing process.',
    );
  }

  const devUrl = `http://127.0.0.1:${vitePort}`;
  return {
    ...instance,
    vitePort,
    mcpPort,
    tauriConfig: {
      ...instance.tauriConfig,
      build: {
        beforeDevCommand: `pnpm dev --host 127.0.0.1 --port ${vitePort} --strictPort`,
        devUrl,
      },
    },
    environment: {
      ...instance.environment,
      CCEM_TAURI_MCP_PORT: String(mcpPort),
    },
  };
}

function pnpmCommand() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /\.(?:c?js|mjs)$/i.test(npmExecPath)) {
    return { command: process.execPath, prefix: [npmExecPath] };
  }
  return { command: 'pnpm', prefix: [] };
}

function isCefDllSysPackageId(packageId) {
  if (typeof packageId !== 'string') return false;
  const fragmentIndex = packageId.lastIndexOf('#');
  const packageFragment = fragmentIndex >= 0 ? packageId.slice(fragmentIndex + 1) : packageId;
  return packageFragment.startsWith('cef-dll-sys@') || packageFragment.startsWith('cef-dll-sys ');
}

export function parseCefOutDirFromCargoJson(output) {
  const outDirs = new Set();
  for (const [index, line] of String(output).split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      throw new Error(`Cargo emitted invalid JSON on stdout line ${index + 1}: ${error.message}`);
    }
    if (
      message.reason !== 'build-script-executed' ||
      !isCefDllSysPackageId(message.package_id)
    ) {
      continue;
    }
    if (typeof message.out_dir !== 'string' || !path.isAbsolute(message.out_dir)) {
      throw new Error('Cargo reported an invalid cef-dll-sys OUT_DIR');
    }
    outDirs.add(path.resolve(message.out_dir));
  }

  if (outDirs.size !== 1) {
    throw new Error(
      `Expected exactly one cef-dll-sys OUT_DIR from the current Cargo build; found ${outDirs.size}`,
    );
  }
  return [...outDirs][0];
}

async function requireDirectory(candidate, label) {
  let stats;
  try {
    stats = await fs.stat(candidate);
  } catch (error) {
    throw new Error(`${label} is unavailable at ${candidate}: ${error.message}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${candidate}`);
  }
  return fs.realpath(candidate);
}

async function requireRegularFile(
  candidate,
  label,
  { executable = false, platform = process.platform } = {},
) {
  let stats;
  try {
    stats = await fs.stat(candidate);
  } catch (error) {
    throw new Error(`${label} is unavailable at ${candidate}: ${error.message}`);
  }
  if (!stats.isFile()) {
    throw new Error(`${label} is not a regular file: ${candidate}`);
  }
  if (executable && platform !== 'win32' && (stats.mode & 0o111) === 0) {
    throw new Error(`${label} is not executable: ${candidate}`);
  }
  return fs.realpath(candidate);
}

function cefRuntimeArchitecture(architecture) {
  if (architecture === 'arm64') return 'aarch64';
  if (architecture === 'x64') return 'x86_64';
  throw new Error(`Unsupported macOS CEF development architecture: ${architecture}`);
}

async function requireMacCefFrameworkMember(candidate, relative) {
  let stats;
  try {
    stats = await fs.lstat(candidate);
  } catch (error) {
    throw new Error(`CEF framework member ${relative} is unavailable at ${candidate}: ${error.message}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`CEF framework member ${relative} must be a regular non-symlink file`);
  }
  return stats;
}

async function stageMacosCefRuntimeFile(source, destination) {
  const sourceStats = await fs.lstat(source);
  if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
    throw new Error(`CEF side-by-side runtime source must be a regular file: ${source}`);
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(source, temporary, fsSync.constants.COPYFILE_EXCL);
    await fs.chmod(temporary, sourceStats.mode & 0o777);
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
  const destinationStats = await fs.lstat(destination);
  if (
    destinationStats.isSymbolicLink()
    || !destinationStats.isFile()
    || destinationStats.size !== sourceStats.size
    || (destinationStats.mode & 0o777) !== (sourceStats.mode & 0o777)
  ) {
    throw new Error(`CEF side-by-side runtime copy is inconsistent: ${destination}`);
  }
  return destination;
}

function defaultCefCargoRunner({ args, environment, cwd }) {
  return spawnSync('cargo', args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    maxBuffer: cefCargoOutputLimit,
    stdio: ['inherit', 'pipe', 'inherit'],
  });
}

export async function prepareBrowserDataRoot(
  browserDataRoot,
  { platform = process.platform } = {},
) {
  const resolvedRoot = path.resolve(browserDataRoot);
  await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  const metadata = await fs.lstat(resolvedRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Tauri dev browser data root must be a real directory, not a symlink');
  }
  if (platform !== 'win32') {
    await fs.chmod(resolvedRoot, 0o700);
    const hardened = await fs.lstat(resolvedRoot);
    if ((hardened.mode & 0o077) !== 0) {
      throw new Error('Tauri dev browser data root must be private (mode 0700)');
    }
  }
  return resolvedRoot;
}

export async function prepareMacosCefDevelopmentRuntime({
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
  cargoRunner = defaultCefCargoRunner,
} = {}) {
  if (platform !== 'darwin') {
    return { environment: {}, frameworkPath: null, source: null, stagedRuntimeFiles: [] };
  }

  const cargoArgs = [
    'build',
    '--locked',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--bin',
    cefHelperName,
    '--message-format=json',
  ];
  const build = cargoRunner({ args: cargoArgs, environment, cwd: desktopDir });
  if (build?.error) {
    throw new Error(`Unable to build the CEF development helper: ${build.error.message}`);
  }
  if (build?.status !== 0) {
    throw new Error(`CEF development helper build failed with status ${build?.status ?? 'unknown'}`);
  }

  const outDir = await requireDirectory(
    parseCefOutDirFromCargoJson(build.stdout),
    'cef-dll-sys OUT_DIR',
  );
  const buildDirectory = path.dirname(path.dirname(outDir));
  if (path.basename(buildDirectory) !== 'build') {
    throw new Error(`cef-dll-sys OUT_DIR is outside the expected Cargo profile layout: ${outDir}`);
  }
  const profileDirectory = path.dirname(buildDirectory);
  await requireRegularFile(
    path.join(profileDirectory, cefHelperName),
    'CEF development helper',
    { executable: true, platform },
  );

  const explicitOverride = environment.CCEM_CEF_FRAMEWORK_PATH?.trim();
  const frameworkCandidate = explicitOverride || path.join(
    outDir,
    `cef_macos_${cefRuntimeArchitecture(architecture)}`,
    cefFrameworkBundleName,
    cefFrameworkExecutableName,
  );
  if (
    path.basename(frameworkCandidate) !== cefFrameworkExecutableName ||
    path.basename(path.dirname(frameworkCandidate)) !== cefFrameworkBundleName
  ) {
    throw new Error(
      `CEF framework override must name ${cefFrameworkBundleName}/${cefFrameworkExecutableName}`,
    );
  }
  const frameworkPath = await requireRegularFile(
    path.resolve(frameworkCandidate),
    explicitOverride ? 'explicit CEF framework override' : 'Cargo CEF framework',
  );
  const frameworkRoot = path.dirname(frameworkPath);
  const target = `${cefRuntimeArchitecture(architecture)}-apple-darwin`;
  for (const relative of requiredMacCefFrameworkFiles(target)) {
    await requireMacCefFrameworkMember(
      path.join(frameworkRoot, ...relative.split('/')),
      relative,
    );
  }
  const stagedRuntimeFiles = [];
  for (const name of cefSideBySideRuntimeNames) {
    stagedRuntimeFiles.push(await stageMacosCefRuntimeFile(
      path.join(frameworkRoot, 'Libraries', name),
      path.join(profileDirectory, name),
    ));
  }

  return {
    environment: { CCEM_CEF_FRAMEWORK_PATH: frameworkPath },
    frameworkPath,
    source: explicitOverride ? 'explicit override' : 'Cargo OUT_DIR',
    stagedRuntimeFiles,
  };
}

async function run() {
  const options = parseArguments(process.argv.slice(2));
  const worktreeRoot = options.worktreeRoot
    ? path.resolve(options.worktreeRoot)
    : discoverWorktreeRoot();
  const derivedInstance = deriveInstance(worktreeRoot);

  if (options.describe) {
    process.stdout.write(`${JSON.stringify(derivedInstance, null, 2)}\n`);
    return;
  }

  if (worktreeRoot !== discoverWorktreeRoot()) {
    throw new Error('--worktree-root may only override the path together with --describe');
  }

  const artifactDir = path.join(worktreeRoot, artifactDirName);
  await fs.mkdir(artifactDir, { recursive: true });
  const configPath = path.join(artifactDir, `${derivedInstance.instanceId}.conf.json`);
  const manifestPath = path.join(artifactDir, `${derivedInstance.instanceId}.json`);
  const lockPath = path.join(artifactDir, `${derivedInstance.instanceId}.launcher.lock`);
  const launcherLock = await acquireLauncherLock(lockPath, derivedInstance);

  try {
    let instance = await resolveAvailablePorts(derivedInstance);
    const browserDataRoot = await prepareBrowserDataRoot(instance.browserDataRoot);
    instance = {
      ...instance,
      browserDataRoot,
      environment: {
        ...instance.environment,
        CCEM_BROWSER_DATA_ROOT: browserDataRoot,
      },
    };
    const cefRuntime = await prepareMacosCefDevelopmentRuntime();
    instance = {
      ...instance,
      cefRuntime: cefRuntime.frameworkPath
        ? {
            frameworkPath: cefRuntime.frameworkPath,
            source: cefRuntime.source,
            stagedRuntimeFiles: cefRuntime.stagedRuntimeFiles,
          }
        : null,
      environment: {
        ...instance.environment,
        ...cefRuntime.environment,
      },
    };
    if (
      instance.vitePort !== derivedInstance.vitePort ||
      instance.mcpPort !== derivedInstance.mcpPort
    ) {
      console.warn(
        `[tauri:dev] preferred ports were occupied; selected Vite ${instance.vitePort} ` +
          `and MCP block ${instance.mcpPort}-${instance.mcpPort + mcpBlockSize - 1}`,
      );
    }
    await fs.writeFile(configPath, `${JSON.stringify(instance.tauriConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...instance,
          launcherPid: process.pid,
          configPath,
          status: 'starting',
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    console.log(`[tauri:dev] instance: ${instance.instanceId}`);
    console.log(`[tauri:dev] worktree: ${instance.worktreeRoot}`);
    console.log(`[tauri:dev] Vite: ${instance.tauriConfig.build.devUrl}`);
    console.log(`[tauri:dev] MCP base port: ${instance.mcpPort}`);
    console.log(`[tauri:dev] bundle id: ${instance.identifier}`);
    console.log(
      `[tauri:dev] browser data (${instance.browserDataRootSource}): ${instance.browserDataRoot}`,
    );
    if (cefRuntime.frameworkPath) {
      console.log(
        `[tauri:dev] CEF framework (${cefRuntime.source}): ${cefRuntime.frameworkPath}`,
      );
    }
    console.log(
      `[tauri:dev] automatic shared background services: ${
        instance.environment.CCEM_DESKTOP_DEV_BACKGROUND_SERVICES === '1' ? 'enabled' : 'disabled'
      }`,
    );
    console.log(`[tauri:dev] manifest: ${manifestPath}`);

    const pnpm = pnpmCommand();
    const child = spawn(
      pnpm.command,
      [
        ...pnpm.prefix,
        'exec',
        'tauri',
        'dev',
        '--config',
        'src-tauri/tauri.dev.conf.json',
        '--config',
        configPath,
        ...options.tauriArguments,
        '--',
        '--locked',
      ],
      {
        cwd: desktopDir,
        env: { ...process.env, ...instance.environment },
        stdio: 'inherit',
      },
    );
    await launcherLock.setChildPid(child.pid);

    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...instance,
          launcherPid: process.pid,
          childPid: child.pid,
          configPath,
          status: 'running',
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    let forwardedSignal;
    const forwardSignal = (signal) => {
      forwardedSignal = signal;
      try {
        fsSync.writeFileSync(
          manifestPath,
          `${JSON.stringify(
            {
              ...instance,
              launcherPid: process.pid,
              childPid: child.pid,
              configPath,
              status: 'stopping',
              signal,
              updatedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        console.warn(`[tauri:dev] Failed to update stopping manifest: ${error.message}`);
      }
      if (!child.killed) {
        child.kill(signal);
      }
    };
    const forwardSigint = () => forwardSignal('SIGINT');
    const forwardSigterm = () => forwardSignal('SIGTERM');
    process.once('SIGINT', forwardSigint);
    process.once('SIGTERM', forwardSigterm);

    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    process.removeListener('SIGINT', forwardSigint);
    process.removeListener('SIGTERM', forwardSigterm);

    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...instance,
          launcherPid: process.pid,
          childPid: child.pid,
          configPath,
          status: 'stopped',
          exitCode: result.code,
          signal: result.signal ?? forwardedSignal ?? null,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    if (result.signal || forwardedSignal) {
      process.exitCode = 130;
    } else {
      process.exitCode = result.code ?? 1;
    }
  } finally {
    await launcherLock.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === launcherPath) {
  run().catch((error) => {
    console.error(`[tauri:dev] ${error.message}`);
    process.exitCode = 1;
  });
}
