import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const desktopControlMocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('@ccem/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ccem/core')>();
  return {
    ...actual,
    ensureCcemDir: () => '/tmp/.ccem-test',
    getCcemConfigDir: () => '/tmp/.ccem-test',
  };
});

vi.mock('conf', () => ({
  default: class MockConf {
    store: Record<string, unknown>;

    constructor(options: { defaults?: Record<string, unknown> } = {}) {
      this.store = structuredClone(options.defaults ?? {});
    }

    get(key: string): unknown {
      return this.store[key];
    }

    set(key: string, value: unknown): void {
      this.store[key] = value;
    }
  },
}));

vi.mock('../desktopControl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../desktopControl.js')>();
  return {
    ...actual,
    requestDesktopControl: desktopControlMocks.request,
  };
});

describe('desktop create command route boundary', () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    desktopControlMocks.request.mockReset();
    desktopControlMocks.request.mockResolvedValue({ runtimeId: 'runtime-codex-1' });
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  async function runDesktopCreate(args: string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      stdout.push(values.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
      stderr.push(values.map(String).join(' '));
    });
    process.argv = [process.execPath, 'index.ts', 'desktop', 'create', ...args];

    await import('../index.js');

    return { stdout, stderr };
  }

  it('ignores repeated --route values for Codex and warns on stderr', async () => {
    const output = await runDesktopCreate([
      '--provider', 'codex',
      '--cwd', '/tmp/project',
      '--prompt', 'start',
      '--route', 'background=glm',
      '--route', 'subagent:Explore=deepseek',
    ]);

    expect(desktopControlMocks.request).toHaveBeenCalledOnce();
    expect(desktopControlMocks.request).toHaveBeenCalledWith(
      'ccem.workspace.createSession',
      expect.any(Object),
    );
    expect(desktopControlMocks.request.mock.calls[0][1]).not.toHaveProperty('routes');
    expect(output.stderr.join('\n')).toMatch(/warning.*codex.*route.*ignored/i);
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps JSON stdout pure while ignoring --routes-json for Codex', async () => {
    const output = await runDesktopCreate([
      '--provider', 'codex',
      '--cwd', '/tmp/project',
      '--prompt', 'start',
      '--routes-json', '{broken',
      '--json',
    ]);

    expect(desktopControlMocks.request).toHaveBeenCalledOnce();
    expect(desktopControlMocks.request).toHaveBeenCalledWith(
      'ccem.workspace.createSession',
      expect.any(Object),
    );
    expect(desktopControlMocks.request.mock.calls[0][1]).not.toHaveProperty('routes');
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0])).toEqual({ runtimeId: 'runtime-codex-1' });
    expect(output.stderr.join('\n')).toMatch(/warning.*codex.*route.*ignored/i);
    expect(process.exitCode).toBeUndefined();
  });
});
