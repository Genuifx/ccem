import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Control where the default control descriptor lives. The mock lets the
// auto-clean tests point getCcemConfigDir() at a per-test temp dir without
// disturbing tests that use CCEM_CONTROL_FILE directly.
let mockedCcemConfigDir: string | null = null;
vi.mock('@ccem/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ccem/core')>();
  return {
    ...actual,
    getCcemConfigDir: () => mockedCcemConfigDir ?? actual.getCcemConfigDir(),
  };
});

const {
  buildDesktopRouterUpdateParams,
  extractHost,
  getOrUpdateDesktopRoutes,
  getDesktopEnvironmentReferences,
  deleteDesktopEnvironment,
  renameDesktopEnvironment,
  isLoopbackHost,
  isPidAlive,
  parseDesktopRoutes,
  parseLimitOption,
  parseSinceOption,
  requestDesktopControl,
  resolveDesktopControlDescriptor,
  StaleDesktopControlDescriptorError,
} = await import('../desktopControl.js');

const STALE_PID = 999_999_999;

function killStub(deadPids: number[]) {
  return vi.spyOn(process, 'kill').mockImplementation(((
    pid: number,
    signal?: number | string,
  ) => {
    if (signal === 0 && deadPids.includes(pid)) {
      const error = new Error(`kill ESRCH ${pid}`);
      (error as NodeJS.ErrnoException).code = 'ESRCH';
      throw error;
    }
    return true;
  }) as typeof process.kill);
}

function writeDescriptor(
  filePath: string,
  overrides: Partial<{ endpoint: string; token: string; pid: number | null }> = {},
) {
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      endpoint: 'http://127.0.0.1:34567/rpc',
      token: 'secret',
      pid: process.pid,
      ...overrides,
    }),
  );
}

describe('desktop control client', () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-desktop-control-test-'));
    process.env = { ...originalEnv };
    process.env.CCEM_CONTROL_FILE = path.join(tempDir, 'control.json');
    mockedCcemConfigDir = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = originalEnv;
    mockedCcemConfigDir = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeCurrentDescriptor(
    overrides: Partial<{ endpoint: string; token: string; pid: number | null }> = {},
  ): void {
    writeDescriptor(process.env.CCEM_CONTROL_FILE!, overrides);
  }

  // ----------------------------------------------------------------------
  // resolveDesktopControlDescriptor boundary checks
  // ----------------------------------------------------------------------

  it('resolves the descriptor from CCEM_CONTROL_FILE', () => {
    writeCurrentDescriptor();

    expect(resolveDesktopControlDescriptor()).toEqual({
      endpoint: 'http://127.0.0.1:34567/rpc',
      token: 'secret',
      pid: process.pid,
    });
  });

  it('rejects a non-loopback endpoint (example.com)', () => {
    writeCurrentDescriptor({ endpoint: 'http://example.com:1234/rpc' });

    expect(() => resolveDesktopControlDescriptor()).toThrow(/not bound to loopback/);
  });

  it('rejects a 192.168 endpoint as non-loopback', () => {
    writeCurrentDescriptor({ endpoint: 'http://192.168.1.5:1234/rpc' });

    expect(() => resolveDesktopControlDescriptor()).toThrow(/not bound to loopback/);
  });

  it('rejects a stale descriptor when pid is dead', () => {
    writeCurrentDescriptor({ pid: STALE_PID });
    const killSpy = killStub([STALE_PID]);

    expect(() => resolveDesktopControlDescriptor()).toThrow(StaleDesktopControlDescriptorError);
    expect(fs.existsSync(process.env.CCEM_CONTROL_FILE!)).toBe(true);
    killSpy.mockRestore();
  });

  it('accepts localhost endpoints', () => {
    writeCurrentDescriptor({ endpoint: 'http://localhost:34567/rpc' });

    const descriptor = resolveDesktopControlDescriptor();
    expect(descriptor.endpoint).toBe('http://localhost:34567/rpc');
  });

  it('accepts ::1 endpoints', () => {
    writeCurrentDescriptor({ endpoint: 'http://[::1]:34567/rpc' });

    const descriptor = resolveDesktopControlDescriptor();
    expect(descriptor.endpoint).toBe('http://[::1]:34567/rpc');
  });

  // ----------------------------------------------------------------------
  // requestDesktopControl
  // ----------------------------------------------------------------------

  it('queries native environment references through the dedicated RPC', async () => {
    const requester = vi.fn(async () => ({
      references: ['runtime:recoverable-1:defaultEnv'],
    }));

    await expect(getDesktopEnvironmentReferences('legacy', requester))
      .resolves.toEqual(['runtime:recoverable-1:defaultEnv']);
    expect(requester).toHaveBeenCalledWith('ccem.environment.references', { name: 'legacy' });
  });

  it('rejects malformed native environment reference responses', async () => {
    await expect(getDesktopEnvironmentReferences(
      'legacy',
      vi.fn(async () => ({ references: [1] })),
    )).rejects.toThrow(/invalid.*reference/i);
  });

  it('uses the Desktop atomic rename and delete environment RPCs', async () => {
    const requester = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        operation: 'rename',
        oldName: 'legacy',
        newName: 'partner',
        updatedSessions: 2,
        current: 'partner',
      })
      .mockResolvedValueOnce({
        ok: true,
        operation: 'delete',
        name: 'partner',
        current: 'official',
      });

    await expect(renameDesktopEnvironment('legacy', 'partner', requester)).resolves.toMatchObject({
      operation: 'rename',
      updatedSessions: 2,
    });
    await expect(deleteDesktopEnvironment('partner', requester)).resolves.toMatchObject({
      operation: 'delete',
      current: 'official',
    });
    expect(requester).toHaveBeenNthCalledWith(1, 'ccem.environment.rename', {
      oldName: 'legacy',
      newName: 'partner',
    });
    expect(requester).toHaveBeenNthCalledWith(2, 'ccem.environment.delete', {
      name: 'partner',
    });
  });

  it('rejects malformed Desktop environment mutation results', async () => {
    await expect(renameDesktopEnvironment(
      'legacy',
      'partner',
      vi.fn(async () => ({ ok: true, operation: 'delete' })),
    )).rejects.toThrow(/invalid.*mutation/i);
  });

  it('sends JSON-RPC requests with the descriptor bearer token', async () => {
    writeCurrentDescriptor();

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 'ccem-test',
      result: { ok: true },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestDesktopControl('ccem.health', { verbose: true })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:34567/rpc', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      }),
    }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.method).toBe('ccem.health');
    expect(body.params).toEqual({ verbose: true });
  });

  it('times out when the server is slow and produces a readable error', async () => {
    writeCurrentDescriptor();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new DOMException('The operation was aborted', 'AbortError');
          reject(error);
        });
      });
    }));

    await expect(
      requestDesktopControl('ccem.health', undefined, undefined, { timeoutMs: 50 }),
    ).rejects.toThrow(/timed out after 50ms/);
  });

  it('supports the legacy fetchTimeoutMs option shape', async () => {
    writeCurrentDescriptor();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }));

    await expect(
      requestDesktopControl('ccem.health', undefined, { fetchTimeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it('respects an externally provided AbortSignal', async () => {
    writeCurrentDescriptor();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new DOMException('The operation was aborted', 'AbortError');
          reject(error);
        });
      });
    }));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(
      requestDesktopControl('ccem.health', undefined, undefined, {
        signal: controller.signal,
        timeoutMs: 30000,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('detects a stale descriptor by pid and refuses to call fetch', async () => {
    writeCurrentDescriptor({ pid: STALE_PID });

    const killSpy = killStub([STALE_PID]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestDesktopControl('ccem.health')).rejects.toMatchObject({
      name: 'StaleDesktopControlDescriptorError',
      reason: 'dead-pid',
      pid: STALE_PID,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(process.env.CCEM_CONTROL_FILE!)).toBe(true);
    await expect(requestDesktopControl('ccem.health')).rejects.toBeInstanceOf(StaleDesktopControlDescriptorError);
    killSpy.mockRestore();
  });

  it('auto-removes stale descriptors at the default ccem path', async () => {
    mockedCcemConfigDir = tempDir;
    delete process.env.CCEM_CONTROL_FILE;
    const defaultPath = path.join(tempDir, 'control.json');
    writeDescriptor(defaultPath, { pid: STALE_PID });

    const killSpy = killStub([STALE_PID]);
    vi.stubGlobal('fetch', vi.fn());

    const caught = await requestDesktopControl('ccem.health').catch((error) => error);
    expect(caught).toBeInstanceOf(StaleDesktopControlDescriptorError);
    expect((caught as InstanceType<typeof StaleDesktopControlDescriptorError>).cleanedUp).toBe(true);
    expect(fs.existsSync(defaultPath)).toBe(false);
    expect(String((caught as Error).message)).not.toContain('secret');
    killSpy.mockRestore();
  });

  it('treats descriptors without a pid as live and does not probe process state', async () => {
    writeCurrentDescriptor({ pid: null });

    const killSpy = vi.spyOn(process, 'kill');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 'ccem-test',
      result: { ok: true },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestDesktopControl('ccem.health')).resolves.toEqual({ ok: true });
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });

  it('reports ECONNREFUSED as a stale endpoint descriptor without deleting custom paths', async () => {
    writeCurrentDescriptor();

    const fetchMock = vi.fn(async () => {
      const error = new TypeError('fetch failed');
      (error as NodeJS.ErrnoException).cause = { code: 'ECONNREFUSED' };
      throw error;
    });
    vi.stubGlobal('fetch', fetchMock);

    const caught = await requestDesktopControl('ccem.health').catch((error) => error);
    expect(caught).toBeInstanceOf(StaleDesktopControlDescriptorError);
    expect((caught as InstanceType<typeof StaleDesktopControlDescriptorError>).reason).toBe('endpoint-unreachable');
    expect((caught as InstanceType<typeof StaleDesktopControlDescriptorError>).cleanedUp).toBe(false);
    expect(String((caught as Error).message)).not.toContain('secret');
    expect(fs.existsSync(process.env.CCEM_CONTROL_FILE!)).toBe(true);
  });

  it('keeps the default descriptor when the owning pid is alive but endpoint is unreachable', async () => {
    mockedCcemConfigDir = tempDir;
    delete process.env.CCEM_CONTROL_FILE;
    const defaultPath = path.join(tempDir, 'control.json');
    writeDescriptor(defaultPath, { pid: process.pid });

    const fetchMock = vi.fn(async () => {
      const error = new TypeError('fetch failed');
      (error as NodeJS.ErrnoException).cause = { code: 'ECONNREFUSED' };
      throw error;
    });
    vi.stubGlobal('fetch', fetchMock);

    const caught = await requestDesktopControl('ccem.health').catch((error) => error);
    expect(caught).toBeInstanceOf(StaleDesktopControlDescriptorError);
    expect((caught as InstanceType<typeof StaleDesktopControlDescriptorError>).reason).toBe('endpoint-unreachable');
    expect((caught as InstanceType<typeof StaleDesktopControlDescriptorError>).cleanedUp).toBe(false);
    expect(fs.existsSync(defaultPath)).toBe(true);
  });

  it('aborts the request after the configured timeout and marks the descriptor stale', async () => {
    writeDescriptor(process.env.CCEM_CONTROL_FILE!, { pid: process.pid });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const caught = await requestDesktopControl(
      'ccem.health',
      undefined,
      { fetchTimeoutMs: 20 },
    ).catch((error) => error);
    expect(caught).toBeInstanceOf(StaleDesktopControlDescriptorError);
    expect((caught as InstanceType<typeof StaleDesktopControlDescriptorError>).reason).toBe('request-timeout');
    expect((caught as Error).message).toContain('20ms');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      signal: expect.any(AbortSignal),
    });
    expect(String((caught as Error).message)).not.toContain('secret');
  });

  it('keeps default descriptors when a live pid times out', async () => {
    mockedCcemConfigDir = tempDir;
    delete process.env.CCEM_CONTROL_FILE;
    const defaultPath = path.join(tempDir, 'control.json');
    writeDescriptor(defaultPath);
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }));

    const caught = await requestDesktopControl('ccem.health', undefined, { fetchTimeoutMs: 20 })
      .catch((error) => error);
    expect(caught).toBeInstanceOf(StaleDesktopControlDescriptorError);
    expect((caught as InstanceType<typeof StaleDesktopControlDescriptorError>).reason).toBe('request-timeout');
    expect((caught as InstanceType<typeof StaleDesktopControlDescriptorError>).cleanedUp).toBe(false);
    expect(String((caught as Error).message)).toContain('20ms');
    expect(String((caught as Error).message)).not.toContain('secret');
    expect(fs.existsSync(defaultPath)).toBe(true);
  });

  it('does not treat arbitrary network errors as stale descriptors', async () => {
    writeCurrentDescriptor();

    const original = new TypeError('something else went wrong');
    vi.stubGlobal('fetch', vi.fn(async () => { throw original; }));

    await expect(requestDesktopControl('ccem.health')).rejects.toBe(original);
    expect(fs.existsSync(process.env.CCEM_CONTROL_FILE!)).toBe(true);
  });

  // ----------------------------------------------------------------------
  // parseSinceOption / parseLimitOption
  // ----------------------------------------------------------------------

  describe('parseSinceOption', () => {
    it('accepts non-negative integers', () => {
      expect(parseSinceOption(undefined)).toBeNull();
      expect(parseSinceOption('0')).toBe(0);
      expect(parseSinceOption('42')).toBe(42);
    });

    it('rejects negative values', () => {
      expect(() => parseSinceOption('-1')).toThrow(/Invalid --since/);
    });

    it('rejects non-integer values', () => {
      expect(() => parseSinceOption('1.5')).toThrow(/Invalid --since/);
      expect(() => parseSinceOption('abc')).toThrow(/Invalid --since/);
      expect(() => parseSinceOption('NaN')).toThrow(/Invalid --since/);
    });
  });

  describe('parseLimitOption', () => {
    it('accepts positive integers', () => {
      expect(parseLimitOption(undefined)).toBeNull();
      expect(parseLimitOption('1')).toBe(1);
      expect(parseLimitOption('100')).toBe(100);
    });

    it('rejects zero', () => {
      expect(() => parseLimitOption('0')).toThrow(/Invalid --limit/);
    });

    it('rejects negative values', () => {
      expect(() => parseLimitOption('-5')).toThrow(/Invalid --limit/);
    });

    it('rejects non-integer values', () => {
      expect(() => parseLimitOption('abc')).toThrow(/Invalid --limit/);
      expect(() => parseLimitOption('1.5')).toThrow(/Invalid --limit/);
    });
  });

  describe('desktop router options', () => {
    it('merges JSON routes with repeated --route values, with flags taking precedence', () => {
      expect(parseDesktopRoutes(
        ['background=deepseek', 'subagent:Explore=glm'],
        JSON.stringify({
          background: 'official',
          'subagent:Plan': 'official',
        }),
      )).toEqual({
        background: 'deepseek',
        'subagent:Plan': 'official',
        'subagent:Explore': 'glm',
      });
    });

    it('distinguishes omitted routes from an explicitly empty JSON map', () => {
      expect(parseDesktopRoutes([], undefined)).toBeUndefined();
      expect(parseDesktopRoutes([], '{}')).toEqual({});
    });

    it('returns stable validation errors for invalid route inputs', () => {
      expect(() => parseDesktopRoutes(['missing-separator'], undefined))
        .toThrow("Invalid --route value 'missing-separator'. Expected key=env.");
      expect(() => parseDesktopRoutes([], '[]'))
        .toThrow('Invalid --routes-json. Expected a JSON object of key-to-environment bindings.');
      expect(() => parseDesktopRoutes([], '{broken'))
        .toThrow('Invalid --routes-json. Expected a JSON object of key-to-environment bindings.');
      expect(parseDesktopRoutes(['background=Team GLM (legacy):v2'], undefined))
        .toEqual({ background: 'Team GLM (legacy):v2' });
      expect(() => parseDesktopRoutes(['subagent:my custom reviewer=glm'], undefined))
        .toThrow(/Invalid route key/);
      expect(() => parseDesktopRoutes([`subagent:${'x'.repeat(129)}=glm`], undefined))
        .toThrow(/Invalid route key/);
    });

    it('builds a CAS update while preserving bindings and allowed environments', () => {
      const current = {
        launchTransport: 'routed',
        defaultEnv: 'official',
        bindings: {
          background: 'deepseek',
          'subagent:Plan': 'official',
        },
        allowedEnvs: ['official', 'deepseek'],
        sourceProfileId: null,
        profileRevision: null,
        dynamicRouting: true,
        revision: 7,
        warnings: [],
      };

      expect(buildDesktopRouterUpdateParams('runtime-1', current, 'subagent:Explore=glm')).toEqual({
        runtimeId: 'runtime-1',
        expectedRevision: 7,
        patch: {
          bindings: {
            background: 'deepseek',
            'subagent:Plan': 'official',
            'subagent:Explore': 'glm',
          },
          allowedEnvs: ['official', 'deepseek', 'glm'],
        },
      });
      expect(current.bindings).not.toHaveProperty('subagent:Explore');
      expect(current.allowedEnvs).toEqual(['official', 'deepseek']);
    });

    it('does not duplicate an existing allowed target and rejects malformed state', () => {
      const current = {
        revision: 2,
        bindings: { background: 'glm' },
        allowedEnvs: ['official', 'glm'],
      };
      expect(buildDesktopRouterUpdateParams('runtime-2', current, 'background=glm'))
        .toMatchObject({ patch: { allowedEnvs: ['official', 'glm'] } });
      expect(() => buildDesktopRouterUpdateParams('runtime-2', { revision: -1 }, 'background=glm'))
        .toThrow('Invalid router state returned by CCEM Desktop.');
    });

    it('uses getRouter then updateRouter with the returned revision', async () => {
      const requester = vi.fn()
        .mockResolvedValueOnce({
          revision: 4,
          bindings: { background: 'official' },
          allowedEnvs: ['official'],
        })
        .mockResolvedValueOnce({ revision: 5, bindings: { background: 'glm' } });

      await expect(getOrUpdateDesktopRoutes(
        'runtime-3',
        'background=glm',
        requester,
      )).resolves.toEqual({ revision: 5, bindings: { background: 'glm' } });
      expect(requester).toHaveBeenNthCalledWith(1, 'ccem.workspace.getRouter', {
        runtimeId: 'runtime-3',
      });
      expect(requester).toHaveBeenNthCalledWith(2, 'ccem.workspace.updateRouter', {
        runtimeId: 'runtime-3',
        expectedRevision: 4,
        patch: {
          bindings: { background: 'glm' },
          allowedEnvs: ['official', 'glm'],
        },
      });
    });

    it('only calls getRouter when --set is omitted', async () => {
      const state = { revision: 1, bindings: {}, allowedEnvs: ['official'] };
      const requester = vi.fn().mockResolvedValue(state);

      await expect(getOrUpdateDesktopRoutes('runtime-4', undefined, requester)).resolves.toBe(state);
      expect(requester).toHaveBeenCalledOnce();
      expect(requester).toHaveBeenCalledWith('ccem.workspace.getRouter', {
        runtimeId: 'runtime-4',
      });
    });
  });

  // ----------------------------------------------------------------------
  // isLoopbackHost / extractHost / isPidAlive unit tests
  // ----------------------------------------------------------------------

  describe('isLoopbackHost', () => {
    it('accepts loopback hosts', () => {
      expect(isLoopbackHost('127.0.0.1')).toBe(true);
      expect(isLoopbackHost('localhost')).toBe(true);
      expect(isLoopbackHost('::1')).toBe(true);
      expect(isLoopbackHost('[::1]')).toBe(true);
      expect(isLoopbackHost('127.255.255.255')).toBe(true);
    });

    it('rejects non-loopback hosts', () => {
      expect(isLoopbackHost('example.com')).toBe(false);
      expect(isLoopbackHost('192.168.1.1')).toBe(false);
      expect(isLoopbackHost('10.0.0.1')).toBe(false);
      expect(isLoopbackHost('0.0.0.0')).toBe(false);
    });
  });

  describe('extractHost', () => {
    it('extracts host from IPv4 endpoint', () => {
      expect(extractHost('http://127.0.0.1:34567/rpc')).toBe('127.0.0.1');
    });

    it('extracts host from localhost endpoint', () => {
      expect(extractHost('http://localhost:34567/rpc')).toBe('localhost');
    });

    it('extracts host from IPv6 endpoint', () => {
      expect(extractHost('http://[::1]:34567/rpc')).toBe('::1');
    });

    it('extracts host without scheme', () => {
      expect(extractHost('example.com:1234')).toBe('example.com');
    });
  });

  describe('isPidAlive', () => {
    it('returns true for the current process', () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it('returns false for a process reported as missing', () => {
      const killSpy = killStub([STALE_PID]);
      expect(isPidAlive(STALE_PID)).toBe(false);
      killSpy.mockRestore();
    });

    it('returns false for invalid pids', () => {
      expect(isPidAlive(-1)).toBe(false);
      expect(isPidAlive(NaN)).toBe(false);
      expect(isPidAlive(0)).toBe(false);
    });
  });
});
