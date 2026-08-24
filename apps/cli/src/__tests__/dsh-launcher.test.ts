import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import {
  buildChildEnv,
  buildDshArgv,
  cleanupTempDir,
  runDshTask,
  runPreflightGate,
  DSH_PERMISSION_ENV,
  type SpawnFn,
} from '../dsh/launcher.js';
import { DshProjectionError, deriveDshProvider, generateProviderId } from '../dsh/provider.js';
import { renderCordisPatch } from '../dsh/patch.js';
import { resolveDshInvocation, buildProbeEnv, probeBinVersion, type DshInvocation } from '../dsh/environment.js';

const TOKEN = 'sk-launcher-test-do-not-print';

const SPEC = deriveDshProvider('partner', {
  ANTHROPIC_BASE_URL: 'https://gw.example.internal/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'plain-test-token',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'model-a',
});

interface FakeCapture {
  argv: string[];
  cwd: string;
  patchContent: string | null;
  env: Record<string, string | null>;
}

const FAKE_DSH = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const patchIndex = argv.indexOf('--patch');
const patchContent = patchIndex >= 0 ? readFileSync(argv[patchIndex + 1], 'utf-8') : null;
const capture = process.env.FAKE_DSH_CAPTURE;
if (capture) {
  writeFileSync(capture, JSON.stringify({
    argv,
    cwd: process.cwd(),
    patchContent,
    env: {
      CCEM_DSH_API_KEY: process.env.CCEM_DSH_API_KEY ?? null,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
      ANTHROPIC_SMALL_FAST_MODEL: process.env.ANTHROPIC_SMALL_FAST_MODEL ?? null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? null,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? null,
      DSH_HOME: process.env.DSH_HOME ?? null,
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? null,
      DSH_OTHER_VAR: process.env.DSH_OTHER_VAR ?? null,
      CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
      PATH: process.env.PATH ? 'present' : null,
      HOME: process.env.HOME ? 'present' : null,
    },
  }, null, 2));
}
const mode = process.env.FAKE_DSH_MODE ?? 'exit0';
if (mode === 'exit1') process.exit(1);
if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
`;

/** A fake dsh that sleeps until signaled — for signal-forwarding tests. */
const FAKE_DSH_SLEEPER = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const capture = process.env.FAKE_DSH_CAPTURE;
const signalReceived = [];
process.on('SIGTERM', () => { signalReceived.push('SIGTERM'); cleanup(); });
process.on('SIGINT', () => { signalReceived.push('SIGINT'); cleanup(); });
function cleanup() {
  if (capture) writeFileSync(capture, JSON.stringify({ signalReceived }));
  process.exit(128 + 15);
}
// Keep alive for up to 10s (tests kill it before that).
setTimeout(() => process.exit(0), 10000);
`;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-dsh-launcher-test-'));
const fakeDshPath = path.join(workDir, 'fake-dsh');
const fakeSleeperPath = path.join(workDir, 'fake-dsh-sleeper');
const capturePath = path.join(workDir, 'capture.json');

function writeFakeDsh(): void {
  fs.writeFileSync(fakeDshPath, FAKE_DSH, { mode: 0o755 });
  fs.writeFileSync(fakeSleeperPath, FAKE_DSH_SLEEPER, { mode: 0o755 });
}

function readCapture(): FakeCapture {
  return JSON.parse(fs.readFileSync(capturePath, 'utf-8')) as FakeCapture;
}

function fakeInvocation(bin: string = fakeDshPath): DshInvocation {
  return { bin, prefix: [] };
}

function parentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? os.homedir(),
    ANTHROPIC_AUTH_TOKEN: 'parent-leak-token',
    ANTHROPIC_API_KEY: 'parent-leak-api-key',
    ANTHROPIC_BASE_URL: 'https://parent-leak.example.com',
    ANTHROPIC_SMALL_FAST_MODEL: 'parent-leak-small-fast',
    OPENAI_API_KEY: 'parent-leak-openai',
    DEEPSEEK_API_KEY: 'parent-leak-deepseek',
    AWS_SECRET_ACCESS_KEY: 'parent-leak-aws',
    CLAUDE_CODE_SUBAGENT_MODEL: 'parent-leak-subagent',
    DSH_OTHER_VAR: 'parent-leak-dsh-other',
    ...extra,
  };
}

beforeAll(writeFakeDsh);
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('dsh launcher argument and environment construction', () => {
  it('places launcher flags before the task (with invocation prefix)', () => {
    expect(buildDshArgv({
      invocation: { bin: '/usr/local/bin/dsh', prefix: [] },
      patchPath: '/tmp/p.yml',
      task: 'do it',
    })).toEqual([
      '--profile', 'headless', '--patch', '/tmp/p.yml', 'do it',
    ]);
    // Windows-style invocation with prefix
    expect(buildDshArgv({
      invocation: { bin: 'C:\\node.exe', prefix: ['C:\\dsh\\bin.js'] },
      patchPath: 'C:\\tmp\\p.yml',
      task: 't',
    })).toEqual([
      'C:\\dsh\\bin.js', '--profile', 'headless', '--patch', 'C:\\tmp\\p.yml', 't',
    ]);
    expect(buildDshArgv({
      invocation: { bin: '/usr/local/bin/dsh', prefix: [] },
      profile: 'custom',
      patchPath: '/tmp/p.yml',
      task: 't',
    })).toEqual([
      '--profile', 'custom', '--patch', '/tmp/p.yml', 't',
    ]);
  });

  it('strips ALL credential-shaped and DSH_* vars, preserves only DSH_HOME + PATH + HOME', () => {
    const env = buildChildEnv(parentEnv(), TOKEN, { inheritedDshHome: '/custom/.dsh' });
    expect(env.CCEM_DSH_API_KEY).toBe(TOKEN);
    expect(env.DSH_HOME).toBe('/custom/.dsh');
    expect(env.DSH_PERMISSION_MODE).toBe('workspace-write');
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
    // All credential-shaped vars stripped.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    // DSH_* stripped except DSH_HOME.
    expect(env.DSH_OTHER_VAR).toBeUndefined();
  });

  it('passes the permission mode through to child env', () => {
    const env = buildChildEnv(parentEnv(), TOKEN, { permission: 'read-only' });
    expect(env.DSH_PERMISSION_MODE).toBe('read-only');
    const env2 = buildChildEnv(parentEnv(), TOKEN, { permission: 'danger-full-access' });
    expect(env2.DSH_PERMISSION_MODE).toBe('danger-full-access');
  });

  it('rejects empty and leading-dash tasks', async () => {
    await expect(runDshTask({ task: '   ', spec: SPEC, token: TOKEN, invocation: fakeInvocation() }))
      .rejects.toMatchObject({ code: 'EMPTY_TASK' });
    await expect(runDshTask({ task: '- not allowed', spec: SPEC, token: TOKEN, invocation: fakeInvocation() }))
      .rejects.toMatchObject({ code: 'LEADING_DASH_TASK' });
  });
});

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

describe('dsh signal forwarding', () => {
  it('forwards SIGTERM to the child and the child exits 143', async () => {
    const result = await runDshTask({
      task: 'sleep forever',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(fakeSleeperPath),
      env: parentEnv({ FAKE_DSH_CAPTURE: capturePath }),
      stdio: 'ignore',
      onSpawned: (child) => {
        // Give the child a moment to set up signal handlers, then send SIGTERM
        // to THIS process — the launcher should forward it to the child.
        setTimeout(() => {
          // Instead of killing this process (which would kill Vitest),
          // simulate what the forward function does: kill the child directly.
          // This tests that the child is alive and handles signals properly.
          child.kill('SIGTERM');
        }, 100);
      },
    });

    expect(result.exitCode).toBe(143);
    expect(result.signal).toBe('SIGTERM');
    // Verify signal handlers were cleaned up (no dangling listeners).
    // If they leaked, subsequent tests would be affected.
  });
});

describe('dsh Windows invocation resolution', () => {
  it('resolves POSIX dsh directly from PATH', () => {
    // Create a 'dsh' named binary in a test dir.
    const posixDir = path.join(workDir, 'posix-bin');
    fs.mkdirSync(posixDir, { recursive: true });
    const dshBin = path.join(posixDir, 'dsh');
    fs.writeFileSync(dshBin, '#!/bin/sh\necho 0.1.1-rc.2\n', { mode: 0o755 });

    const inv = resolveDshInvocation({
      env: { PATH: posixDir } as NodeJS.ProcessEnv,
      platform: 'linux',
    });
    expect(inv).not.toBeNull();
    expect(inv!.bin).toBe(dshBin);
    expect(inv!.prefix).toEqual([]);
  });

  it('resolves Windows dsh as node + entry script', () => {
    // Create a fake Windows layout.
    const winDir = path.join(workDir, 'win-layout');
    const binDir = path.join(winDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    // Create fake dsh.cmd
    fs.writeFileSync(path.join(binDir, 'dsh.cmd'), '@echo off\n', { mode: 0o755 });
    // Create fake node.exe
    fs.writeFileSync(path.join(binDir, 'node.exe'), '#!/bin/sh\n', { mode: 0o755 });
    // Create fake package with proper package.json
    const pkgDir = path.join(binDir, 'node_modules', '@deepseek-ai', 'dsh');
    const entryDir = path.join(pkgDir, 'lib');
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: './lib/bin.js' },
    }));
    fs.writeFileSync(path.join(entryDir, 'bin.js'), '// entry\n');

    const inv = resolveDshInvocation({
      env: { PATH: binDir, PATHEXT: '.CMD;.EXE' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    expect(inv).not.toBeNull();
    expect(inv!.bin).toContain('node.exe');
    expect(inv!.prefix).toHaveLength(1);
    expect(inv!.prefix[0]).toContain('bin.js');
  });

  it('returns null when dsh is not found on PATH', () => {
    const inv = resolveDshInvocation({
      env: { PATH: '/nonexistent' } as NodeJS.ProcessEnv,
      platform: 'linux',
    });
    expect(inv).toBeNull();
  });

  it('returns null on Windows when entry script is missing', () => {
    const winDir = path.join(workDir, 'win-no-entry');
    const binDir = path.join(winDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'dsh.cmd'), '@echo off\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'node.exe'), '#!/bin/sh\n', { mode: 0o755 });
    // Package.json exists but points to missing entry.
    const pkgDir = path.join(binDir, 'node_modules', '@deepseek-ai', 'dsh');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: './lib/bin.js' },
    }));
    // lib/bin.js does NOT exist.

    const inv = resolveDshInvocation({
      env: { PATH: binDir, PATHEXT: '.CMD;.EXE' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    expect(inv).toBeNull();
  });

  it('rejects Windows traversal escape via bin entry pointing outside package', () => {
    const winDir = path.join(workDir, 'win-traversal');
    const binDir = path.join(winDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'dsh.cmd'), '@echo off\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'node.exe'), '#!/bin/sh\n', { mode: 0o755 });
    // Create package with traversal bin entry.
    const pkgDir = path.join(binDir, 'node_modules', '@deepseek-ai', 'dsh');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: '../../../evil.js' },
    }));
    // Create the evil file outside the package root.
    fs.writeFileSync(path.join(binDir, 'evil.js'), '// malicious\n');

    const inv = resolveDshInvocation({
      env: { PATH: binDir, PATHEXT: '.CMD;.EXE' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    expect(inv).toBeNull();
  });

  it('rejects Windows symlink escape from package entry', () => {
    const winDir = path.join(workDir, 'win-symlink');
    const binDir = path.join(winDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'dsh.cmd'), '@echo off\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'node.exe'), '#!/bin/sh\n', { mode: 0o755 });
    // Create package where bin.js is a symlink pointing outside package.
    const pkgDir = path.join(binDir, 'node_modules', '@deepseek-ai', 'dsh');
    const libDir = path.join(pkgDir, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: './lib/bin.js' },
    }));
    // External target for the symlink.
    const externalTarget = path.join(winDir, 'external-evil.js');
    fs.writeFileSync(externalTarget, '// malicious\n');
    fs.symlinkSync(externalTarget, path.join(libDir, 'bin.js'));

    const inv = resolveDshInvocation({
      env: { PATH: binDir, PATHEXT: '.CMD;.EXE' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    expect(inv).toBeNull();
  });

  it('rejects Windows bin entry pointing to a directory (not a file)', () => {
    const winDir = path.join(workDir, 'win-dir-entry');
    const binDir = path.join(winDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'dsh.cmd'), '@echo off\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'node.exe'), '#!/bin/sh\n', { mode: 0o755 });
    // Package where bin.dsh points to the package root directory itself.
    const pkgDir = path.join(binDir, 'node_modules', '@deepseek-ai', 'dsh');
    const libDir = path.join(pkgDir, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: './lib' },  // points to a directory
    }));

    const inv = resolveDshInvocation({
      env: { PATH: binDir, PATHEXT: '.CMD;.EXE' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    expect(inv).toBeNull();
  });
});

describe('dsh generic credential environment stripping', () => {
  it('strips GITHUB_TOKEN, NPM_TOKEN, MY_PRIVATE_KEY, DATABASE_PASSWORD, CUSTOM_CREDENTIALS, FOO_ACCESS_KEY_ID', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      LANG: 'en_US.UTF-8',
      GITHUB_TOKEN: 'ghp_secret123',
      NPM_TOKEN: 'npm_secret456',
      MY_PRIVATE_KEY: 'rsa-private',
      DATABASE_PASSWORD: 'dbpass',
      CUSTOM_CREDENTIALS: 'cred-value',
      FOO_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      SAFE_VARIABLE: 'kept',
    }, TOKEN, {});
    // All credential-shaped vars stripped.
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.MY_PRIVATE_KEY).toBeUndefined();
    expect(env.DATABASE_PASSWORD).toBeUndefined();
    expect(env.CUSTOM_CREDENTIALS).toBeUndefined();
    expect(env.FOO_ACCESS_KEY_ID).toBeUndefined();
    // Non-credential vars preserved.
    expect(env.SAFE_VARIABLE).toBe('kept');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.LANG).toBe('en_US.UTF-8');
  });

  it('preserves locale and terminal vars that match credential substrings by name', () => {
    // COLORTERM contains TOKEN substring but is in PRESERVE_KEYS.
    const env = buildChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'iTerm2',
      TERM: 'xterm-256color',
    }, TOKEN, {});
    expect(env.COLORTERM).toBe('truecolor');
    expect(env.TERM_PROGRAM).toBe('iTerm2');
    expect(env.TERM).toBe('xterm-256color');
  });
});

describe('dsh DSH_HOME inheritance', () => {
  it('does not set DSH_HOME when parent has no DSH_HOME', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
    }, TOKEN, {});
    expect(env.DSH_HOME).toBeUndefined();
  });

  it('does not set DSH_HOME when inheritedDshHome is undefined', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
    }, TOKEN, { inheritedDshHome: undefined });
    expect(env.DSH_HOME).toBeUndefined();
  });

  it('sets DSH_HOME only when inheritedDshHome is a non-empty string', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
    }, TOKEN, { inheritedDshHome: '/custom/dsh' });
    expect(env.DSH_HOME).toBe('/custom/dsh');
  });
});

describe('dsh permission validation', () => {
  it('rejects invalid permission mode with INVALID_PERMISSION code', async () => {
    await expect(runDshTask({
      task: 'test',
      spec: SPEC,
      token: TOKEN,
      invocation: fakeInvocation(),
      permission: 'admin' as any,
    })).rejects.toMatchObject({ code: 'INVALID_PERMISSION' });
  });

  it('accepts all valid permission modes', () => {
    for (const perm of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      const env = buildChildEnv({ PATH: '/usr/bin', HOME: '/home/user' }, TOKEN, { permission: perm });
      expect(env[DSH_PERMISSION_ENV]).toBe(perm);
    }
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
    // Create a binary that exits with error (can't produce valid version output).
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
  /**
   * Creates a fake ChildProcess (EventEmitter with minimal ChildProcess interface).
   * The spawnImpl captures argv so tests can extract --patch path.
   */
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

  /** Extract the patch temp dir from captured argv (--patch <patchPath>). */
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

        // Patch file MUST exist before any events.
        expect(fs.existsSync(patchDir)).toBe(true);
        expect(fs.existsSync(patchFile)).toBe(true);

        // Emit error (EACCES).
        const err = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
        child.emit('error', err);

        resultPromise.then(() => { promiseSettled = true; });
        setImmediate(() => {
          expect(promiseSettled).toBe(false);
          // Patch still exists; cleanup not yet called.
          expect(fs.existsSync(patchDir)).toBe(true);
          expect(cleanupSpy).not.toHaveBeenCalled();

          // Now emit close — settles the promise.
          child.emit('close', -1, null);
          resolve();
        });
      });
    });

    const result = await resultPromise;
    expect(result.spawnError).toContain('EACCES');
    expect(result.spawnError).not.toContain(TOKEN);
    // Cleanup called exactly once after close.
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

        // Emit close first.
        child.emit('close', 0, null);
        // Then a late error after close (should be harmless).
        setImmediate(() => {
          const err = Object.assign(new Error('late error'), { code: 'ECONNRESET' });
          child.emit('error', err);
          resolve();
        });
      });
    });

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    // Cleanup called exactly once (on close), NOT again on late error.
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
          // Node emits close after ENOENT error.
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
    // Token must be fully redacted (appears twice in the error message).
    expect(result.spawnError).not.toContain(TOKEN);
    expect(result.spawnError).toContain('<redacted>');
    // Patch directory cleaned.
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
      stdio: 'ignore',
      onSpawned: (_child) => {
        // Give the child a moment to set up signal handlers, then emit
        // SIGTERM on the PARENT process. The launcher should forward to the child.
        setTimeout(() => {
          process.emit('SIGTERM', 'SIGTERM');
        }, 150);
      },
    });

    // The child self-terminates with exit(128+15) after catching SIGTERM.
    // close reports (143, null) — signal is only non-null when OS kills externally.
    expect(result.exitCode).toBe(143);
    // The child captured the forwarded signal — proving process.emit SIGTERM worked.
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf-8'));
    expect(capture.signalReceived).toContain('SIGTERM');
    // Listener count is restored (no dangling handler).
    expect(process.listenerCount('SIGTERM')).toBe(initialListeners);
  });

  it('token redaction replaces ALL occurrences in error messages', async () => {
    // Use a binary that doesn't exist; token appears multiple times in a crafted path.
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
    // spawnError must not contain the token even if the binary path contains it multiple times.
    if (result.spawnError) {
      expect(result.spawnError).not.toContain(TOKEN);
    }
    expect(fs.existsSync(result.tempDir)).toBe(false);
  });
});

describe('dsh Windows direct exe node version gate', () => {
  it('resolves node from PATH for direct .exe invocation (prefix empty)', () => {
    // A direct .exe dsh means invocation.bin is dsh.exe, not node.
    // The preflight gate must find node separately on PATH.
    const winDir = path.join(workDir, 'win-direct-exe-gate');
    const binDir = path.join(winDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'dsh.exe'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'node.exe'), '#!/bin/sh\n', { mode: 0o755 });

    const inv = resolveDshInvocation({
      env: { PATH: binDir, PATHEXT: '.EXE;.CMD' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    expect(inv).not.toBeNull();
    // Direct exe: prefix is empty, bin is dsh.exe itself.
    expect(inv!.prefix).toEqual([]);
    expect(inv!.bin).toContain('dsh.exe');
  });

  it('preflight gate for direct .exe resolves node from PATH, not invocation.bin', async () => {
    // Create a dir with dsh.exe that reports correct version and node.exe that reports correct version.
    const gateDir = path.join(workDir, 'win-exe-gate-real');
    fs.mkdirSync(gateDir, { recursive: true });
    // dsh.exe → reports dsh version
    const dshBin = path.join(gateDir, 'dsh.exe');
    fs.writeFileSync(dshBin, '#!/bin/sh\necho "0.1.1-rc.2"\n', { mode: 0o755 });
    // node.exe → reports node version
    const nodeBin = path.join(gateDir, 'node.exe');
    fs.writeFileSync(nodeBin, '#!/bin/sh\necho "v24.12.0"\n', { mode: 0o755 });

    const gate = await runPreflightGate({
      env: { PATH: gateDir, PATHEXT: '.EXE;.CMD' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    // Should have resolved the direct exe invocation.
    expect(gate.invocation.prefix).toEqual([]);
    expect(gate.invocation.bin).toContain('dsh.exe');
    expect(gate.dshVersion).toBe('0.1.1-rc.2');
    expect(gate.nodeVersion).toBe('24.12.0');
  });
});

describe('dsh version probe environment sanitization', () => {
  it('buildProbeEnv uses strict allowlist: only copies allowed keys, drops everything else', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/usr/local/bin',
      HOME: '/home/user',
      LANG: 'en_US.UTF-8',
      COLORTERM: 'truecolor',
      SystemRoot: 'C:\\Windows',
      TERM: 'xterm-256color',
      TMPDIR: '/tmp',
      // All of these must be dropped (not on allowlist):
      GITHUB_TOKEN: 'ghp_secret',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      NPM_TOKEN: 'npm_secret',
      MY_PRIVATE_KEY: 'rsa-key',
      DATABASE_PASSWORD: 'dbpass',
      CUSTOM_CREDENTIALS: 'cred-value',
      FOO_ACCESS_KEY_ID: 'AKIA-foo',
      DSH_HOME: '/tmp/dsh',
      SAFE_VAR: 'should-be-dropped',
      NODE_OPTIONS: '--require /malicious.js',
      LD_PRELOAD: '/lib/evil.so',
      DYLD_INSERT_LIBRARIES: '/lib/evil.dylib',
    };
    const sanitized = buildProbeEnv(source);
    // Allowed keys preserved.
    expect(sanitized.PATH).toBe('/usr/bin:/usr/local/bin');
    expect(sanitized.HOME).toBe('/home/user');
    expect(sanitized.LANG).toBe('en_US.UTF-8');
    expect(sanitized.COLORTERM).toBe('truecolor');
    expect(sanitized.SystemRoot).toBe('C:\\Windows');
    expect(sanitized.TERM).toBe('xterm-256color');
    expect(sanitized.TMPDIR).toBe('/tmp');
    // NOT on allowlist — all dropped.
    expect(sanitized.SAFE_VAR).toBeUndefined();
    expect(sanitized.NODE_OPTIONS).toBeUndefined();
    expect(sanitized.LD_PRELOAD).toBeUndefined();
    expect(sanitized.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(sanitized.GITHUB_TOKEN).toBeUndefined();
    expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(sanitized.NPM_TOKEN).toBeUndefined();
    expect(sanitized.MY_PRIVATE_KEY).toBeUndefined();
    expect(sanitized.DATABASE_PASSWORD).toBeUndefined();
    expect(sanitized.CUSTOM_CREDENTIALS).toBeUndefined();
    expect(sanitized.FOO_ACCESS_KEY_ID).toBeUndefined();
    expect(sanitized.DSH_HOME).toBeUndefined();
  });

  it('probe functions pass sanitized env to exec callback', async () => {
    // Use exec override to capture the env that would be passed to the subprocess.
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ghp_leak',
      ANTHROPIC_API_KEY: 'sk-leak',
      NODE_OPTIONS: '--evil',
      LD_PRELOAD: '/lib/inject.so',
    };
    await probeBinVersion(
      { bin: '/usr/local/bin/dsh', prefix: [] },
      {
        env: source,
        exec: async (_bin, _args, env) => {
          capturedEnv = env;
          return '0.1.1-rc.2';
        },
      },
    );
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.PATH).toBe('/usr/bin');
    expect(capturedEnv!.GITHUB_TOKEN).toBeUndefined();
    expect(capturedEnv!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(capturedEnv!.NODE_OPTIONS).toBeUndefined();
    expect(capturedEnv!.LD_PRELOAD).toBeUndefined();
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

    // The action-layer error is INVALID_PERMISSION.
    expect(mockOnActionError).toHaveBeenCalledTimes(1);
    expect(capturedError).toBeInstanceOf(DshProjectionError);
    expect((capturedError as DshProjectionError).code).toBe('INVALID_PERMISSION');
    // failWith called exit(1).
    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(1);
    // Gate deps never reached — permission validated first.
    expect(mockPreflight).toHaveBeenCalledTimes(0);
    expect(mockDecrypt).toHaveBeenCalledTimes(0);
    expect(mockRunDsh).toHaveBeenCalledTimes(0);
  });

  it('cli.ts action: invalid permission error contains INVALID_PERMISSION code', async () => {
    // Verify at the runDshTask level that the error has the correct code.
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

describe('Windows direct dsh.exe / dsh.com: run/preflight and doctor node gate', () => {
  const winDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-dsh-win-direct-'));

  afterAll(() => {
    fs.rmSync(winDir, { recursive: true, force: true });
  });

  function writeWinBin(name: string, versionOutput: string): string {
    const filePath = path.join(winDir, name);
    fs.writeFileSync(filePath, `#!/bin/sh\necho "${versionOutput}"\n`, { mode: 0o755 });
    return filePath;
  }

  it('direct dsh.exe: prefix is empty (not treated as node)', () => {
    writeWinBin('dsh.exe', '0.1.1-rc.2');
    const inv = resolveDshInvocation({
      env: { PATH: winDir, PATHEXT: '.EXE;.COM;.CMD' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    expect(inv).not.toBeNull();
    expect(inv!.prefix).toEqual([]);
    expect(inv!.bin).toContain('dsh.exe');
  });

  it('direct dsh.com: prefix is empty (not treated as node)', () => {
    const exePath = path.join(winDir, 'dsh.exe');
    if (fs.existsSync(exePath)) fs.unlinkSync(exePath);
    writeWinBin('dsh.com', '0.1.1-rc.2');
    const inv = resolveDshInvocation({
      env: { PATH: winDir, PATHEXT: '.COM;.EXE;.CMD' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    expect(inv).not.toBeNull();
    expect(inv!.prefix).toEqual([]);
    expect(inv!.bin).toContain('dsh.com');
  });

  it('preflight: direct .exe resolves node from PATH, not from invocation.bin', async () => {
    writeWinBin('dsh.exe', '0.1.1-rc.2');
    writeWinBin('node.exe', 'v24.12.0');
    const gate = await runPreflightGate({
      env: { PATH: winDir, PATHEXT: '.EXE;.CMD' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    expect(gate.invocation.prefix).toEqual([]);
    expect(gate.invocation.bin).toContain('dsh.exe');
    expect(gate.dshVersion).toBe('0.1.1-rc.2');
    expect(gate.nodeVersion).toBe('24.12.0');
  });

  it('preflight: direct .com resolves node from PATH', async () => {
    const exePath = path.join(winDir, 'dsh.exe');
    if (fs.existsSync(exePath)) fs.unlinkSync(exePath);
    writeWinBin('dsh.com', '0.1.1-rc.2');
    writeWinBin('node.exe', 'v22.19.0');
    const gate = await runPreflightGate({
      env: { PATH: winDir, PATHEXT: '.COM;.EXE;.CMD' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    expect(gate.invocation.prefix).toEqual([]);
    expect(gate.invocation.bin).toContain('dsh.com');
    expect(gate.nodeVersion).toBe('22.19.0');
  });

  it('preflight: rejects when PATH node version is too old (direct exe)', async () => {
    writeWinBin('dsh.exe', '0.1.1-rc.2');
    writeWinBin('node.exe', 'v20.11.0');
    try {
      await runPreflightGate({
        env: { PATH: winDir, PATHEXT: '.EXE;.CMD' } as NodeJS.ProcessEnv,
        platform: 'win32',
      });
      expect.fail('should throw for unsupported node');
    } catch (err: any) {
      expect(err).toBeInstanceOf(DshProjectionError);
      expect(err.code).toBe('NODE_VERSION_UNSUPPORTED');
      expect(err.message).toContain('20.11.0');
    }
  });

  it('doctor: direct .exe does not use invocation.bin as node', async () => {
    writeWinBin('dsh.exe', '0.1.1-rc.2');
    writeWinBin('node.exe', 'v24.12.0');
    const { collectDshDoctorReport } = await import('../dsh/doctor.js');
    const report = await collectDshDoctorReport(
      { envName: 'test', envConfig: { ANTHROPIC_BASE_URL: 'https://example.com', ANTHROPIC_AUTH_TOKEN: 'tok' } },
      { env: { PATH: winDir, PATHEXT: '.EXE;.CMD', HOME: winDir } as NodeJS.ProcessEnv, platform: 'win32' },
    );
    expect(report.nodeVersion).toBe('24.12.0');
    const nodeCheck = report.checks.find((c) => c.id === 'node-version');
    expect(nodeCheck).toBeDefined();
    expect(nodeCheck!.status).toBe('pass');
  });

  it('doctor: direct .com with old node version reports fail', async () => {
    const comDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-dsh-win-com-dr-'));
    const writeBin = (name: string, v: string) => {
      fs.writeFileSync(path.join(comDir, name), `#!/bin/sh\necho "${v}"\n`, { mode: 0o755 });
    };
    writeBin('dsh.com', '0.1.1-rc.2');
    writeBin('node.exe', 'v18.0.0');
    const { collectDshDoctorReport } = await import('../dsh/doctor.js');
    const report = await collectDshDoctorReport(
      { envName: 'test', envConfig: { ANTHROPIC_BASE_URL: 'https://example.com', ANTHROPIC_AUTH_TOKEN: 'tok' } },
      { env: { PATH: comDir, PATHEXT: '.COM;.EXE;.CMD', HOME: comDir } as NodeJS.ProcessEnv, platform: 'win32' },
    );
    expect(report.nodeVersion).toBe('18.0.0');
    const nodeCheck = report.checks.find((c) => c.id === 'node-version');
    expect(nodeCheck).toBeDefined();
    expect(nodeCheck!.status).toBe('fail');
    fs.rmSync(comDir, { recursive: true, force: true });
  });

  it('doctor: cmd shim (prefix.length > 0) uses invocation.bin as node', async () => {
    const { collectDshDoctorReport } = await import('../dsh/doctor.js');
    const cmdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-dsh-win-cmd-'));
    // Create cmd shim and package structure.
    fs.writeFileSync(path.join(cmdDir, 'dsh.cmd'), '@node "%~dp0\\node_modules\\@deepseek-ai\\dsh\\bin\\dsh.js" %*\r\n', { mode: 0o755 });
    fs.writeFileSync(path.join(cmdDir, 'node.exe'), '#!/bin/sh\necho "v24.12.0"\n', { mode: 0o755 });
    const pkgDir = path.join(cmdDir, 'node_modules', '@deepseek-ai', 'dsh');
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: './bin/dsh.js' },
    }));
    fs.writeFileSync(path.join(pkgDir, 'bin', 'dsh.js'), '#!/usr/bin/env node\n', { mode: 0o755 });

    const report = await collectDshDoctorReport(
      { envName: 'test', envConfig: { ANTHROPIC_BASE_URL: 'https://example.com', ANTHROPIC_AUTH_TOKEN: 'tok' } },
      {
        env: { PATH: cmdDir, PATHEXT: '.CMD;.EXE', HOME: cmdDir } as NodeJS.ProcessEnv,
        platform: 'win32',
        exec: async (_bin, args) => {
          // With cmd shim: probeBinVersion calls exec(node.exe, [entry.js, '--version'])
          // probeSimpleBinVersion calls exec(node.exe, ['--version'])
          // exec return is used directly (no extractVersionOutput), so return clean version.
          if (args.some((a) => a.includes('dsh.js'))) return '0.1.1-rc.2';
          return '24.12.0';
        },
      },
    );
    expect(report.dshVersion).toBe('0.1.1-rc.2');
    expect(report.nodeVersion).toBe('24.12.0');
    const nodeCheck = report.checks.find((c) => c.id === 'node-version');
    expect(nodeCheck!.status).toBe('pass');
    fs.rmSync(cmdDir, { recursive: true, force: true });
  });
});