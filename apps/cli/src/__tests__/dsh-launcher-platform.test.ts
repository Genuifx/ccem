import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runPreflightGate } from '../dsh/launcher.js';
import { DshProjectionError } from '../dsh/provider.js';
import { resolveDshInvocation } from '../dsh/environment.js';
import {
  workDir,
  writeFakeDsh,
  cleanupWorkDir,
} from './dsh-launcher.setup.js';

beforeAll(writeFakeDsh);
afterAll(cleanupWorkDir);

function fakeVersionProbe(versions: Record<string, string | null>) {
  return vi.fn(async (bin: string, args: string[]): Promise<string | null> => {
    expect(args).toEqual(['--version']);
    return versions[path.basename(bin).toLowerCase()] ?? null;
  });
}

describe('dsh Windows invocation resolution', () => {
  it('resolves POSIX dsh directly from PATH', () => {
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
    const winDir = path.join(workDir, 'win-layout');
    const binDir = path.join(winDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'dsh.cmd'), '@echo off\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'node.exe'), '#!/bin/sh\n', { mode: 0o755 });
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
    const pkgDir = path.join(binDir, 'node_modules', '@deepseek-ai', 'dsh');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: './lib/bin.js' },
    }));

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
    const pkgDir = path.join(binDir, 'node_modules', '@deepseek-ai', 'dsh');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: '../../../evil.js' },
    }));
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
    const pkgDir = path.join(binDir, 'node_modules', '@deepseek-ai', 'dsh');
    const libDir = path.join(pkgDir, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: './lib/bin.js' },
    }));
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
    const pkgDir = path.join(binDir, 'node_modules', '@deepseek-ai', 'dsh');
    const libDir = path.join(pkgDir, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      bin: { dsh: './lib' },
    }));

    const inv = resolveDshInvocation({
      env: { PATH: binDir, PATHEXT: '.CMD;.EXE' } as NodeJS.ProcessEnv,
      platform: 'win32',
    });
    expect(inv).toBeNull();
  });
});

describe('dsh Windows direct exe node version gate', () => {
  it('resolves node from PATH for direct .exe invocation (prefix empty)', () => {
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
    expect(inv!.prefix).toEqual([]);
    expect(inv!.bin).toContain('dsh.exe');
  });

  it('preflight gate for direct .exe resolves node from PATH, not invocation.bin', async () => {
    const gateDir = path.join(workDir, 'win-exe-gate-real');
    fs.mkdirSync(gateDir, { recursive: true });
    const dshBin = path.join(gateDir, 'dsh.exe');
    fs.writeFileSync(dshBin, 'version-probe fixture\n', { mode: 0o755 });
    const nodeBin = path.join(gateDir, 'node.exe');
    fs.writeFileSync(nodeBin, 'version-probe fixture\n', { mode: 0o755 });
    const exec = fakeVersionProbe({
      'dsh.exe': '0.1.1-rc.2',
      'node.exe': '24.12.0',
    });

    const gate = await runPreflightGate({
      env: { PATH: gateDir, PATHEXT: '.EXE;.CMD' } as NodeJS.ProcessEnv,
      platform: 'win32',
      exec,
    });
    expect(gate.invocation.prefix).toEqual([]);
    expect(gate.invocation.bin).toContain('dsh.exe');
    expect(gate.dshVersion).toBe('0.1.1-rc.2');
    expect(gate.nodeVersion).toBe('24.12.0');
    expect(exec.mock.calls.map(([bin]) => path.basename(bin).toLowerCase())).toEqual([
      'dsh.exe',
      'node.exe',
    ]);
  });
});

describe('Windows direct dsh.exe / dsh.com: run/preflight and doctor node gate', () => {
  const winDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-dsh-win-direct-'));

  afterAll(() => {
    fs.rmSync(winDir, { recursive: true, force: true });
  });

  function writeWinBin(name: string, versionOutput: string): string {
    const filePath = path.join(winDir, name);
    fs.writeFileSync(filePath, `version-probe fixture: ${versionOutput}\n`, { mode: 0o755 });
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
    const exec = fakeVersionProbe({
      'dsh.exe': '0.1.1-rc.2',
      'node.exe': '24.12.0',
    });
    const gate = await runPreflightGate({
      env: { PATH: winDir, PATHEXT: '.EXE;.CMD' } as NodeJS.ProcessEnv,
      platform: 'win32',
      exec,
    });
    expect(gate.invocation.prefix).toEqual([]);
    expect(gate.invocation.bin).toContain('dsh.exe');
    expect(gate.dshVersion).toBe('0.1.1-rc.2');
    expect(gate.nodeVersion).toBe('24.12.0');
    expect(exec.mock.calls.map(([bin]) => path.basename(bin).toLowerCase())).toEqual([
      'dsh.exe',
      'node.exe',
    ]);
  });

  it('preflight: direct .com resolves node from PATH', async () => {
    const exePath = path.join(winDir, 'dsh.exe');
    if (fs.existsSync(exePath)) fs.unlinkSync(exePath);
    writeWinBin('dsh.com', '0.1.1-rc.2');
    writeWinBin('node.exe', 'v22.19.0');
    const exec = fakeVersionProbe({
      'dsh.com': '0.1.1-rc.2',
      'node.exe': '22.19.0',
    });
    const gate = await runPreflightGate({
      env: { PATH: winDir, PATHEXT: '.COM;.EXE;.CMD' } as NodeJS.ProcessEnv,
      platform: 'win32',
      exec,
    });
    expect(gate.invocation.prefix).toEqual([]);
    expect(gate.invocation.bin).toContain('dsh.com');
    expect(gate.nodeVersion).toBe('22.19.0');
    expect(exec.mock.calls.map(([bin]) => path.basename(bin).toLowerCase())).toEqual([
      'dsh.com',
      'node.exe',
    ]);
  });

  it('preflight: rejects when PATH node version is too old (direct exe)', async () => {
    writeWinBin('dsh.exe', '0.1.1-rc.2');
    writeWinBin('node.exe', 'v20.11.0');
    const exec = fakeVersionProbe({
      'dsh.exe': '0.1.1-rc.2',
      'node.exe': '20.11.0',
    });
    try {
      await runPreflightGate({
        env: { PATH: winDir, PATHEXT: '.EXE;.CMD' } as NodeJS.ProcessEnv,
        platform: 'win32',
        exec,
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
    const exec = fakeVersionProbe({
      'dsh.exe': '0.1.1-rc.2',
      'node.exe': '24.12.0',
    });
    const { collectDshDoctorReport } = await import('../dsh/doctor.js');
    const report = await collectDshDoctorReport(
      { envName: 'test', envConfig: { ANTHROPIC_BASE_URL: 'https://example.com', ANTHROPIC_AUTH_TOKEN: 'tok' } },
      {
        env: { PATH: winDir, PATHEXT: '.EXE;.CMD', HOME: winDir } as NodeJS.ProcessEnv,
        platform: 'win32',
        exec,
      },
    );
    expect(report.nodeVersion).toBe('24.12.0');
    const nodeCheck = report.checks.find((c) => c.id === 'node-version');
    expect(nodeCheck).toBeDefined();
    expect(nodeCheck!.status).toBe('pass');
  });

  it('doctor: direct .com with old node version reports fail', async () => {
    const comDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-dsh-win-com-dr-'));
    const writeBin = (name: string, v: string) => {
      fs.writeFileSync(path.join(comDir, name), `version-probe fixture: ${v}\n`, { mode: 0o755 });
    };
    writeBin('dsh.com', '0.1.1-rc.2');
    writeBin('node.exe', 'v18.0.0');
    const exec = fakeVersionProbe({
      'dsh.com': '0.1.1-rc.2',
      'node.exe': '18.0.0',
    });
    const { collectDshDoctorReport } = await import('../dsh/doctor.js');
    const report = await collectDshDoctorReport(
      { envName: 'test', envConfig: { ANTHROPIC_BASE_URL: 'https://example.com', ANTHROPIC_AUTH_TOKEN: 'tok' } },
      {
        env: { PATH: comDir, PATHEXT: '.COM;.EXE;.CMD', HOME: comDir } as NodeJS.ProcessEnv,
        platform: 'win32',
        exec,
      },
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
