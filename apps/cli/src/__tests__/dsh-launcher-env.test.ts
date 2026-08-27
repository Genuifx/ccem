import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildChildEnv,
  buildDshArgv,
  runDshTask,
  DSH_PERMISSION_ENV,
} from '../dsh/launcher.js';
import { DshProjectionError } from '../dsh/provider.js';
import { buildProbeEnv, probeBinVersion } from '../dsh/environment.js';
import {
  TOKEN,
  SPEC,
  writeFakeDsh,
  cleanupWorkDir,
  fakeInvocation,
  parentEnv,
} from './dsh-launcher.setup.js';

beforeAll(writeFakeDsh);
afterAll(cleanupWorkDir);

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
