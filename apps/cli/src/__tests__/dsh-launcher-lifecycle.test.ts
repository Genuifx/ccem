import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import {
  cleanupTempDir,
  runDshTask,
  runPreflightGate,
  type SpawnFn,
} from '../dsh/launcher.js';
import { DshProjectionError } from '../dsh/provider.js';
import { renderCordisPatch } from '../dsh/patch.js';
import {
  TOKEN,
  SPEC,
  workDir,
  capturePath,
  fakeSleeperPath,
  writeFakeDsh,
  cleanupWorkDir,
  readCapture,
  fakeInvocation,
  parentEnv,
} from './dsh-launcher.setup.js';

beforeAll(writeFakeDsh);
afterAll(cleanupWorkDir);

describe('dsh launcher with fake dsh binary', () => {
  it('passes shell metacharacters as one literal argv element without executing them', async () => {
    const pwnMarker = path.join(workDir, 'pwned-1');
    const pwnMarker2 = path.join(workDir, 'pwned-2');
    const task = `echo hi $(touch ${pwnMarker}); rm -rf ${pwnMarker2} \`id\` | & < >`;
    const result = await runDshTask({
      task,
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(),
      env: parentEnv({ FAKE_DSH_CAPTURE: capturePath, FAKE_DSH_MODE: 'exit0' }),
      stdio: 'ignore',
    });

    expect(result.exitCode).toBe(0);
    const capture = readCapture();
    // Task is a single literal argv element, after the launcher flags.
    expect(capture.argv).toHaveLength(5);
    expect(capture.argv[0]).toBe('--profile');
    expect(capture.argv[2]).toBe('--patch');
    expect(capture.argv[4]).toBe(task);
    expect(fs.existsSync(pwnMarker)).toBe(false);
    expect(fs.existsSync(pwnMarker2)).toBe(false);
  });

  it('captures argv, env, and the secret-free patch; DSH_HOME is inherited', async () => {
    const dshRoot = path.join(workDir, 'root-home');
    fs.mkdirSync(dshRoot, { recursive: true });
    const result = await runDshTask({
      task: 'plain task',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(),
      env: parentEnv({ FAKE_DSH_CAPTURE: capturePath, DSH_HOME: dshRoot }),
      stdio: 'ignore',
    });

    expect(result.exitCode).toBe(0);
    const capture = readCapture();
    expect(capture.env.CCEM_DSH_API_KEY).toBe(TOKEN);
    expect(capture.env.DSH_HOME).toBe(dshRoot);
    expect(capture.env.DSH_PERMISSION_MODE).toBe('workspace-write');
    // All credential vars stripped.
    expect(capture.env.ANTHROPIC_AUTH_TOKEN).toBeNull();
    expect(capture.env.ANTHROPIC_API_KEY).toBeNull();
    expect(capture.env.ANTHROPIC_BASE_URL).toBeNull();
    expect(capture.env.ANTHROPIC_SMALL_FAST_MODEL).toBeNull();
    expect(capture.env.OPENAI_API_KEY).toBeNull();
    expect(capture.env.DEEPSEEK_API_KEY).toBeNull();
    expect(capture.env.AWS_SECRET_ACCESS_KEY).toBeNull();
    expect(capture.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeNull();
    expect(capture.env.DSH_OTHER_VAR).toBeNull();
    // PATH and HOME preserved.
    expect(capture.env.PATH).toBe('present');
    expect(capture.env.HOME).toBe('present');
    // The patch the child read is the exact secret-free rendering.
    expect(capture.patchContent).toBe(renderCordisPatch(SPEC));
    expect(capture.patchContent).not.toContain(TOKEN);
  });

  it('patch deterministically disables settings regardless of root settings.yaml', async () => {
    const dshRoot = path.join(workDir, 'conflicting-root');
    fs.mkdirSync(dshRoot, { recursive: true });
    fs.writeFileSync(
      path.join(dshRoot, 'settings.yaml'),
      'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n',
    );
    await runDshTask({
      task: 'plain task',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(),
      env: parentEnv({ FAKE_DSH_CAPTURE: capturePath, DSH_HOME: dshRoot }),
      stdio: 'ignore',
    });

    const capture = readCapture();
    expect(capture.patchContent).toContain('- id: settings\n  disabled: true');
    expect(capture.patchContent).toContain(`provider: ${SPEC.providerId}`);
    expect(capture.patchContent).not.toContain('deepseek-official');
  });

  it('runs the child in the requested cwd', async () => {
    const cwd = path.join(workDir, 'task-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    await runDshTask({
      task: 'plain task',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(),
      env: parentEnv({ FAKE_DSH_CAPTURE: capturePath }),
      cwd,
      stdio: 'ignore',
    });
    // The child reports its own working directory; macOS resolves /var → /private/var.
    expect(fs.realpathSync(readCapture().cwd)).toBe(fs.realpathSync(cwd));
  });

  it('propagates exit code 1', async () => {
    const result = await runDshTask({
      task: 'fail please',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(),
      env: parentEnv({ FAKE_DSH_CAPTURE: capturePath, FAKE_DSH_MODE: 'exit1' }),
      stdio: 'ignore',
    });
    expect(result.exitCode).toBe(1);
    expect(result.signal).toBeNull();
  });

  it('propagates a child signal as 128+signal', async () => {
    const result = await runDshTask({
      task: 'signal please',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(),
      env: parentEnv({ FAKE_DSH_CAPTURE: capturePath, FAKE_DSH_MODE: 'signal' }),
      stdio: 'ignore',
    });
    expect(result.signal).toBe('SIGTERM');
    expect(result.exitCode).toBe(143);
  });

  it('handles ENOENT with a remediation that never leaks the token', async () => {
    const missingBin = path.join(workDir, 'does-not-exist-dsh');
    const result = await runDshTask({
      task: 'plain task',
      spec: SPEC,
      token: TOKEN,
      invocation: { bin: missingBin, prefix: [] },
      env: parentEnv(),
      stdio: 'ignore',
    });
    expect(result.exitCode).toBe(1);
    expect(result.spawnError).toContain('dsh binary not found');
    expect(result.spawnError).not.toContain(TOKEN);
    expect(fs.existsSync(result.tempDir)).toBe(false);
  });

  it('always removes the temporary patch directory on success and failure', async () => {
    for (const mode of ['exit0', 'exit1']) {
      const result = await runDshTask({
        task: 'cleanup check',
        spec: SPEC,
        token: TOKEN,
        invocation: fakeInvocation(),
        env: parentEnv({ FAKE_DSH_CAPTURE: capturePath, FAKE_DSH_MODE: mode }),
        stdio: 'ignore',
      });
      expect(fs.existsSync(result.tempDir)).toBe(false);
    }
  });

  it('projection errors carry stable codes', () => {
    expect(new DshProjectionError('MISSING_TOKEN', 'x').name).toBe('DshProjectionError');
  });
});

describe('dsh child signal handling', () => {
  it('reports 143 when the child handles SIGTERM and exits', async () => {
    const result = await runDshTask({
      task: 'sleep forever',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(fakeSleeperPath),
      env: parentEnv({ FAKE_DSH_CAPTURE: capturePath }),
      stdio: ['ignore', 'pipe', 'ignore'],
      onSpawned: (child) => {
        child.stdout!.once('data', () => {
          child.kill('SIGTERM');
        });
      },
    });

    expect(result.exitCode).toBe(143);
    expect(result.signal).toBeNull();
    expect(JSON.parse(fs.readFileSync(capturePath, 'utf-8')).signalReceived).toEqual(['SIGTERM']);
  });
});

describe('dsh run gate markers', () => {
  it('throws DSH_BINARY_MISSING when dsh not found', async () => {
    await expect(runPreflightGate({
      env: { PATH: '/nonexistent' } as NodeJS.ProcessEnv,
      platform: 'linux',
    })).rejects.toMatchObject({ code: 'DSH_BINARY_MISSING' });
  });

  it('throws DSH_VERSION_UNREADABLE when version probe fails', async () => {
    const gateDir = path.join(workDir, 'gate-unread');
    fs.mkdirSync(gateDir, { recursive: true });
    const dshBin = path.join(gateDir, 'dsh');
    fs.writeFileSync(dshBin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    await expect(runPreflightGate({
      env: { PATH: gateDir } as NodeJS.ProcessEnv,
      platform: 'linux',
    })).rejects.toMatchObject({ code: 'DSH_VERSION_UNREADABLE' });
  });

  it('throws DSH_VERSION_UNSUPPORTED for wrong dsh version', async () => {
    const gateDir = path.join(workDir, 'gate-unsup');
    fs.mkdirSync(gateDir, { recursive: true });
    const dshBin = path.join(gateDir, 'dsh');
    fs.writeFileSync(dshBin, '#!/bin/sh\necho "0.2.0"\n', { mode: 0o755 });
    const nodeBin = path.join(gateDir, 'node');
    fs.writeFileSync(nodeBin, '#!/bin/sh\necho "v24.12.0"\n', { mode: 0o755 });

    await expect(runPreflightGate({
      env: { PATH: gateDir } as NodeJS.ProcessEnv,
      platform: 'linux',
    })).rejects.toMatchObject({ code: 'DSH_VERSION_UNSUPPORTED' });
  });

  it('throws NODE_VERSION_UNREADABLE when node version unreadable', async () => {
    const gateDir = path.join(workDir, 'gate-nodeunread');
    fs.mkdirSync(gateDir, { recursive: true });
    const dshBin = path.join(gateDir, 'dsh');
    fs.writeFileSync(dshBin, '#!/bin/sh\necho "0.1.1-rc.2"\n', { mode: 0o755 });
    const nodeBin = path.join(gateDir, 'node');
    fs.writeFileSync(nodeBin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    await expect(runPreflightGate({
      env: { PATH: gateDir } as NodeJS.ProcessEnv,
      platform: 'linux',
    })).rejects.toMatchObject({ code: 'NODE_VERSION_UNREADABLE' });
  });

  it('throws NODE_VERSION_UNSUPPORTED for old node', async () => {
    const gateDir = path.join(workDir, 'gate-nodeold');
    fs.mkdirSync(gateDir, { recursive: true });
    const dshBin = path.join(gateDir, 'dsh');
    fs.writeFileSync(dshBin, '#!/bin/sh\necho "0.1.1-rc.2"\n', { mode: 0o755 });
    const nodeBin = path.join(gateDir, 'node');
    fs.writeFileSync(nodeBin, '#!/bin/sh\necho "v20.0.0"\n', { mode: 0o755 });

    await expect(runPreflightGate({
      env: { PATH: gateDir } as NodeJS.ProcessEnv,
      platform: 'linux',
    })).rejects.toMatchObject({ code: 'NODE_VERSION_UNSUPPORTED' });
  });
});

describe('dsh launcher spawn lifecycle (deterministic fake ChildProcess)', () => {
  function createFakeChild(): {
    child: ChildProcess;
    spawnImpl: SpawnFn;
    capturedArgv: string[];
  } {
    const emitter = new EventEmitter() as ChildProcess & EventEmitter;
    (emitter as any).exitCode = null;
    (emitter as any).signalCode = null;
    (emitter as any).killed = false;
    (emitter as any).pid = 99999;
    (emitter as any).kill = (_sig?: string) => { (emitter as any).killed = true; return true; };
    const capturedArgv: string[] = [];
    const spawnImpl: SpawnFn = (_bin, args) => {
      capturedArgv.push(...args);
      return emitter as any;
    };
    return { child: emitter as any, spawnImpl, capturedArgv };
  }

  function extractPatchDir(argv: string[]): string {
    const idx = argv.indexOf('--patch');
    return path.dirname(argv[idx + 1]);
  }

  it('error-then-close: patch exists after error but before close, cleanup exactly once', async () => {
    const { child, spawnImpl, capturedArgv } = createFakeChild();
    const cleanupSpy = vi.fn(cleanupTempDir);
    let promiseSettled = false;

    const resultPromise = runDshTask({
      task: 'lifecycle test',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(),
      env: parentEnv(),
      stdio: 'ignore',
      spawnImpl,
      cleanupImpl: cleanupSpy,
    });

    await new Promise<void>((resolve) => {
      setImmediate(() => {
        const patchDir = extractPatchDir(capturedArgv);
        const patchFile = path.join(patchDir, 'cordis.ccem.patch.yml');

        expect(fs.existsSync(patchDir)).toBe(true);
        expect(fs.existsSync(patchFile)).toBe(true);

        const err = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
        child.emit('error', err);

        resultPromise.then(() => { promiseSettled = true; });
        setImmediate(() => {
          expect(promiseSettled).toBe(false);
          expect(fs.existsSync(patchDir)).toBe(true);
          expect(cleanupSpy).not.toHaveBeenCalled();

          child.emit('close', -1, null);
          resolve();
        });
      });
    });

    const result = await resultPromise;
    expect(result.spawnError).toContain('EACCES');
    expect(result.spawnError).not.toContain(TOKEN);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(result.tempDir)).toBe(false);
  });

  it('close-then-late-error: cleanup once, no double finish, listener count restored', async () => {
    const { child, spawnImpl, capturedArgv } = createFakeChild();
    const cleanupSpy = vi.fn(cleanupTempDir);
    const initialListeners = process.listenerCount('SIGTERM');

    const resultPromise = runDshTask({
      task: 'lifecycle late-error',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(),
      env: parentEnv(),
      stdio: 'ignore',
      spawnImpl,
      cleanupImpl: cleanupSpy,
    });

    await new Promise<void>((resolve) => {
      setImmediate(() => {
        const patchDir = extractPatchDir(capturedArgv);
        expect(fs.existsSync(patchDir)).toBe(true);

        child.emit('close', 0, null);
        setImmediate(() => {
          const err = Object.assign(new Error('late error'), { code: 'ECONNRESET' });
          child.emit('error', err);
          resolve();
        });
      });
    });

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(result.tempDir)).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(initialListeners);
  });

  it('ENOENT error followed by close: patch exists until close, cleanup once', async () => {
    const { child, spawnImpl, capturedArgv } = createFakeChild();
    const cleanupSpy = vi.fn(cleanupTempDir);
    let promiseSettled = false;

    const resultPromise = runDshTask({
      task: 'lifecycle enoent',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(),
      env: parentEnv(),
      stdio: 'ignore',
      spawnImpl,
      cleanupImpl: cleanupSpy,
    });

    await new Promise<void>((resolve) => {
      setImmediate(() => {
        const patchDir = extractPatchDir(capturedArgv);

        const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
        child.emit('error', err);

        resultPromise.then(() => { promiseSettled = true; });
        setImmediate(() => {
          expect(promiseSettled).toBe(false);
          expect(fs.existsSync(patchDir)).toBe(true);
          expect(cleanupSpy).not.toHaveBeenCalled();
          child.emit('close', -2, null);
          resolve();
        });
      });
    });

    const result = await resultPromise;
    expect(result.spawnError).toContain('dsh binary not found');
    expect(result.spawnError).not.toContain(TOKEN);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(result.tempDir)).toBe(false);
  });

  it('synchronous spawn throw: redacts token, cleans patch, exits 1', async () => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error(`ENOTSUP: cannot spawn ${TOKEN} in ${TOKEN}`);
    };

    const result = await runDshTask({
      task: 'sync throw test',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(),
      env: parentEnv(),
      stdio: 'ignore',
      spawnImpl: throwingSpawn,
    });

    expect(result.exitCode).toBe(1);
    expect(result.spawnError).toContain('Failed to launch dsh');
    expect(result.spawnError).not.toContain(TOKEN);
    expect(result.spawnError).toContain('<redacted>');
    expect(fs.existsSync(result.tempDir)).toBe(false);
  });
});

describe('dsh signal forwarding via process.emit', () => {
  it('forwards SIGTERM to child via real process.emit and restores listener count', async () => {
    const initialListeners = process.listenerCount('SIGTERM');

    const result = await runDshTask({
      task: 'sleep forever',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(fakeSleeperPath),
      env: parentEnv({ FAKE_DSH_CAPTURE: capturePath }),
      stdio: ['ignore', 'pipe', 'ignore'],
      onSpawned: (child) => {
        child.stdout!.once('data', () => {
          process.emit('SIGTERM', 'SIGTERM');
        });
      },
    });

    expect(result.exitCode).toBe(143);
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf-8'));
    expect(capture.signalReceived).toContain('SIGTERM');
    expect(process.listenerCount('SIGTERM')).toBe(initialListeners);
  });

  it('token redaction replaces ALL occurrences in error messages', async () => {
    const tokenDir = path.join(workDir, `multi-${TOKEN}-${TOKEN}`);
    fs.mkdirSync(tokenDir, { recursive: true });
    const missingBin = path.join(tokenDir, TOKEN);

    const result = await runDshTask({
      task: 'test multi-redact',
      spec: SPEC,
      token: TOKEN,
      invocation: { bin: missingBin, prefix: [] },
      env: parentEnv(),
      stdio: 'ignore',
    });
    if (result.spawnError) {
      expect(result.spawnError).not.toContain(TOKEN);
    }
    expect(fs.existsSync(result.tempDir)).toBe(false);
  });
});

describe('Commander action layer: invalid permission rejects before preflight/decrypt', () => {
  it('runDshTask throws INVALID_PERMISSION before spawn (no preflight/launch)', async () => {
    const fakeSpawn: SpawnFn = () => {
      throw new Error('should not reach spawn');
    };

    try {
      await runDshTask({
        task: 'test invalid permission',
        spec: SPEC,
        token: TOKEN,
        invocation: fakeInvocation(),
        env: parentEnv(),
        stdio: 'ignore',
        spawnImpl: fakeSpawn,
        permission: 'INVALID_MODE_XYZ' as any,
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DshProjectionError);
      expect(err.code).toBe('INVALID_PERMISSION');
      expect(err.message).toContain('INVALID_MODE_XYZ');
    }
  });

  it('cli.ts action: invalid permission → INVALID_PERMISSION code, exit(1), preflight/decrypt/run=0', async () => {
    const { Command } = await import('commander');
    const { registerDshCommands } = await import('../dsh/cli.js');

    const mockPreflight = vi.fn();
    const mockDecrypt = vi.fn();
    const mockRunDsh = vi.fn();
    let capturedError: unknown;
    let exitCode: number | undefined;
    const mockExit = vi.fn((code: number) => {
      exitCode = code;
      throw new Error(`__EXIT_${code}__`);
    }) as unknown as (code: number) => never;
    const mockOnActionError = vi.fn((err: unknown) => { capturedError = err; });

    const program = new Command();
    program.exitOverride();
    const context = {
      getRegistries: () => ({
        testenv: {
          ANTHROPIC_BASE_URL: 'https://example.com',
          ANTHROPIC_AUTH_TOKEN: 'encrypted-token',
        },
      }),
      getCurrentEnvName: () => 'testenv',
    };

    registerDshCommands(program, context, {
      runPreflightGate: mockPreflight,
      decryptToken: mockDecrypt,
      runDshTask: mockRunDsh,
      processExit: mockExit,
      onActionError: mockOnActionError,
    });

    try {
      await program.parseAsync(['node', 'ccem', 'dsh', 'run', '--permission', 'evil-root', 'task text']);
    } catch {
      // Expected: mockExit throws to unwind.
    }

    expect(mockOnActionError).toHaveBeenCalledTimes(1);
    expect(capturedError).toBeInstanceOf(DshProjectionError);
    expect((capturedError as DshProjectionError).code).toBe('INVALID_PERMISSION');
    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(1);
    expect(mockPreflight).toHaveBeenCalledTimes(0);
    expect(mockDecrypt).toHaveBeenCalledTimes(0);
    expect(mockRunDsh).toHaveBeenCalledTimes(0);
  });

  it('cli.ts action: invalid permission error contains INVALID_PERMISSION code', async () => {
    const fakeSpawn: SpawnFn = () => { throw new Error('unreachable'); };
    try {
      await runDshTask({
        task: 'test',
        spec: SPEC,
        token: TOKEN,
        invocation: fakeInvocation(),
        env: parentEnv(),
        stdio: 'ignore',
        spawnImpl: fakeSpawn,
        permission: 'evil-root' as any,
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DshProjectionError);
      expect(err.code).toBe('INVALID_PERMISSION');
    }
  });
});
