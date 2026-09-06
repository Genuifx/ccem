import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const desktopControlMocks = vi.hoisted(() => ({
  request: vi.fn(),
  resolveDescriptor: vi.fn(),
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
    resolveDesktopControlDescriptor: desktopControlMocks.resolveDescriptor,
  };
});

describe('desktop create command route boundary', () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.resetModules();
    desktopControlMocks.request.mockReset();
    desktopControlMocks.request.mockResolvedValue({ runtimeId: 'runtime-codex-1' });
    desktopControlMocks.resolveDescriptor.mockReset();
    desktopControlMocks.resolveDescriptor.mockReturnValue({ endpoint: 'http://127.0.0.1:1234/rpc', token: 'fixture' });
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
    const exited = new Error('CLI exited');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      process.exitCode = code ?? 0;
      throw exited;
    });
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
      stdout.push(values.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
      stderr.push(values.map(String).join(' '));
    });
    process.argv = [process.execPath, 'index.ts', 'desktop', 'create', ...args];

    try {
      await import('../index.js');
    } catch (error) {
      if (error !== exited) throw error;
    }

    return { stdout, stderr };
  }

  it('checks model capability and creates using the exact same discovered Desktop', async () => {
    const descriptor = { endpoint: 'http://127.0.0.1:1234/rpc', token: 'fixture' };
    desktopControlMocks.resolveDescriptor.mockReturnValueOnce(descriptor)
      .mockReturnValue({ endpoint: 'http://127.0.0.1:9999/rpc', token: 'other' });
    desktopControlMocks.request.mockResolvedValueOnce({
      capabilities: { taskModelSelection: { version: 1, providers: ['codex'] } },
    }).mockResolvedValueOnce({ runtimeId: 'model-session', model: 'gpt-6-astra' });
    const output = await runDesktopCreate([
      '--provider', 'codex', '--cwd', '/tmp/project', '--prompt', 'start',
      '--model', 'gpt-6-astra', '--effort', 'medium', '--perm', 'yolo', '--json',
    ]);
    expect(desktopControlMocks.resolveDescriptor).toHaveBeenCalledOnce();
    expect(desktopControlMocks.request).toHaveBeenNthCalledWith(1, 'ccem.health', undefined, descriptor);
    expect(desktopControlMocks.request).toHaveBeenNthCalledWith(2, 'ccem.workspace.createSession',
      expect.objectContaining({ model: 'gpt-6-astra', effort: 'medium', permissionMode: 'yolo' }), descriptor);
    expect(output.stdout.map((line) => JSON.parse(line))).toEqual([{ runtimeId: 'model-session', model: 'gpt-6-astra' }]);
    expect(output.stderr).toEqual([]);
  });

  for (const health of [null, { ok: true },
    { capabilities: { taskModelSelection: { version: 2, providers: ['codex'] } } },
    { capabilities: { taskModelSelection: { version: 1, providers: ['claude'] } } },
  ]) {
    it(`refuses model dispatch to unsupported Desktop: ${JSON.stringify(health)}`, async () => {
      desktopControlMocks.request.mockResolvedValueOnce(health);
      const output = await runDesktopCreate([
        '--provider', 'codex', '--cwd', '/tmp/project', '--prompt', 'start', '--model', 'gpt-6-astra',
      ]);
      expect(desktopControlMocks.request).toHaveBeenCalledOnce();
      expect(output.stderr.join('\n')).toContain('MODEL_SELECTION_UNSUPPORTED');
      expect(process.exitCode).toBe(1);
    });
  }

  it('does not create after a failed health request', async () => {
    desktopControlMocks.request.mockRejectedValueOnce(new Error('health unavailable'));
    const output = await runDesktopCreate([
      '--provider', 'codex', '--cwd', '/tmp/project', '--prompt', 'start', '--model', 'gpt-6-astra',
    ]);
    expect(desktopControlMocks.request).toHaveBeenCalledOnce();
    expect(output.stderr.join('\n')).toContain('health unavailable');
    expect(process.exitCode).toBe(1);
  });

  for (const [provider, model, code] of [
    ['claude', 'gpt-6-astra', 'MODEL_PROVIDER_UNSUPPORTED'],
    ['codex', '', 'MODEL_INVALID'], ['codex', '   ', 'MODEL_INVALID'],
    ['codex', 'gpt 6', 'MODEL_INVALID'], ['codex', 'gpt\n', 'MODEL_INVALID'],
  ]) {
    it(`rejects invalid model before discovery: ${provider} ${JSON.stringify(model)}`, async () => {
      const output = await runDesktopCreate([
        '--provider', provider, '--cwd', '/tmp/project', '--prompt', 'start', '--model', model,
      ]);
      expect(desktopControlMocks.request).not.toHaveBeenCalled();
      expect(desktopControlMocks.resolveDescriptor).not.toHaveBeenCalled();
      expect(output.stderr.join('\n')).toContain(code);
      expect(process.exitCode).toBe(1);
    });
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
    expect(desktopControlMocks.request.mock.calls[0][1]).not.toHaveProperty('model');
    expect(desktopControlMocks.resolveDescriptor).not.toHaveBeenCalled();
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
