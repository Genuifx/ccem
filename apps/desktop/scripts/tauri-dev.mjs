#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDirName = '.artifacts/tauri-dev';
const vitePortStart = 14000;
const vitePortRange = 10000;
const mcpPortStart = 30000;
const mcpBlockSize = 100;
const mcpBlockCount = 300;

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
    const instance = await resolveAvailablePorts(derivedInstance);
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

run().catch((error) => {
  console.error(`[tauri:dev] ${error.message}`);
  process.exitCode = 1;
});
