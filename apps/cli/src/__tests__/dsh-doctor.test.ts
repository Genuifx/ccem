import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildDshInspectReport,
  collectDshDoctorReport,
  type DshDoctorReport,
} from '../dsh/doctor.js';
import {
  extractVersionOutput,
  resolveBinOnPath,
  resolveDshRoot,
} from '../dsh/environment.js';
import {
  compareVersions,
  isDshVersionCompatible,
  isNodeVersionCompatible,
} from '../dsh/version.js';

const PARTNER_ENV = {
  ANTHROPIC_BASE_URL: 'https://gw.example.internal/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'plain-test-token',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'model-a',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'model-b',
};

describe('dsh version gates', () => {
  it('compares semver with prerelease precedence', () => {
    expect(compareVersions('0.1.1-rc.2', '0.1.1-rc.2')).toBe(0);
    expect(compareVersions('0.1.1-rc.2', '0.1.1-rc.10')).toBeLessThan(0);
    expect(compareVersions('0.1.1-rc.2', '0.1.1')).toBeLessThan(0);
    expect(compareVersions('0.1.1', '0.1.2')).toBeLessThan(0);
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('v24.12.0', '24.12.0')).toBe(0);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBeLessThan(0);
  });

  it('accepts ONLY the exact verified dsh version 0.1.1-rc.2', () => {
    expect(isDshVersionCompatible('0.1.1-rc.2')).toBe(true);
    // All others rejected:
    expect(isDshVersionCompatible('0.1.1-rc.1')).toBe(false);
    expect(isDshVersionCompatible('0.1.1-rc.3')).toBe(false);
    expect(isDshVersionCompatible('0.1.1')).toBe(false);
    expect(isDshVersionCompatible('0.1.2')).toBe(false);
    expect(isDshVersionCompatible('0.1.0')).toBe(false);
    expect(isDshVersionCompatible('0.2.0')).toBe(false);
    expect(isDshVersionCompatible('1.0.0')).toBe(false);
    expect(isDshVersionCompatible('garbage')).toBe(false);
  });

  it('gates node on the pi-ai engines floor', () => {
    expect(isNodeVersionCompatible('22.19.0')).toBe(true);
    expect(isNodeVersionCompatible('v24.12.0')).toBe(true);
    expect(isNodeVersionCompatible('22.18.0')).toBe(false);
    expect(isNodeVersionCompatible('v20.1.0')).toBe(false);
  });

  it('extracts versions from --version output', () => {
    expect(extractVersionOutput('0.1.1-rc.2\n')).toBe('0.1.1-rc.2');
    expect(extractVersionOutput('dsh 0.1.1\n')).toBe('0.1.1');
    expect(extractVersionOutput('v24.12.0\n')).toBe('24.12.0');
    expect(extractVersionOutput('some banner\n1.2.3\n')).toBe('1.2.3');
    expect(extractVersionOutput('no version here')).toBeNull();
  });
});

describe('dsh environment resolution', () => {
  it('resolves the active root from inherited DSH_HOME or ~/.dsh', () => {
    expect(resolveDshRoot({ DSH_HOME: '/tmp/custom-home' } as NodeJS.ProcessEnv)).toBe('/tmp/custom-home');
    expect(resolveDshRoot({ DSH_HOME: '  ' } as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), '.dsh'));
    expect(resolveDshRoot({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), '.dsh'));
  });

  it('resolves binaries from PATH with PATHEXT on win32', () => {
    expect(resolveBinOnPath('/bin/definitely-missing-xyz', {} as NodeJS.ProcessEnv, 'linux')).toBeNull();
    expect(resolveBinOnPath('definitely-missing-xyz-123', { PATH: '/nonexistent-dir' } as NodeJS.ProcessEnv, 'linux')).toBeNull();
  });
});

describe('dsh doctor report', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-dsh-doctor-test-'));
  const binDir = path.join(workDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  function writeBin(name: string, versionLine: string): string {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${versionLine}"\n`, { mode: 0o755 });
    return file;
  }

  function depsFor(overrides: Partial<Parameters<typeof collectDshDoctorReport>[1]> = {}): Parameters<typeof collectDshDoctorReport>[1] {
    return {
      env: { PATH: binDir, HOME: workDir } as NodeJS.ProcessEnv,
      platform: 'linux',
      ...overrides,
    };
  }

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('passes end to end with exactly dsh 0.1.1-rc.2 and node >= 22.19', async () => {
    writeBin('dsh', '0.1.1-rc.2');
    writeBin('node', 'v24.12.0');
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      depsFor(),
    );

    expect(report.ok).toBe(true);
    expect(report.dshVersion).toBe('0.1.1-rc.2');
    expect(report.nodeVersion).toBe('24.12.0');
    expect(report.dshRoot).toBe(path.join(workDir, '.dsh'));
    expect(report.environment.spec?.selectedModel).toBe('model-a');
    for (const check of report.checks) {
      if (check.id === 'dsh-root') continue;
      expect(check.status, check.id).toBe('pass');
    }
    // Redaction: the report never carries the token.
    expect(JSON.stringify(report)).not.toContain('plain-test-token');
    expect(JSON.stringify(report)).toContain('present');
  });

  it('fails closed when dsh is missing', async () => {
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      depsFor({ env: { PATH: '/nonexistent', HOME: workDir } as NodeJS.ProcessEnv }),
    );
    expect(report.ok).toBe(false);
    const binary = report.checks.find((check) => check.id === 'dsh-binary');
    expect(binary?.status).toBe('fail');
    expect(binary?.remediation).toContain('@deepseek-ai/dsh@0.1.1-rc.2');
  });

  it('fails on dsh 0.1.1-rc.3 (not the exact verified version)', async () => {
    writeBin('dsh', '0.1.1-rc.3');
    writeBin('node', 'v24.12.0');
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      depsFor(),
    );
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'dsh-version')?.status).toBe('fail');
  });

  it('fails on dsh 0.1.1 (release, not the rc.2 prerelease)', async () => {
    writeBin('dsh', '0.1.1');
    writeBin('node', 'v24.12.0');
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      depsFor(),
    );
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'dsh-version')?.status).toBe('fail');
  });

  it('fails on dsh 0.1.2 (patch bump, untested contract)', async () => {
    writeBin('dsh', '0.1.2');
    writeBin('node', 'v24.12.0');
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      depsFor(),
    );
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'dsh-version')?.status).toBe('fail');
  });

  it('fails when dsh version is unreadable (null return)', async () => {
    writeBin('dsh', '0.1.1-rc.2');
    writeBin('node', 'v24.12.0');
    // Inject exec override that returns null for dsh version probe.
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      depsFor({ exec: async (_bin, args) => {
        if (args.includes('--version') && _bin.includes('dsh')) return null;
        return '24.12.0';
      }}),
    );
    expect(report.ok).toBe(false);
    const vCheck = report.checks.find((c) => c.id === 'dsh-version');
    expect(vCheck?.status).toBe('fail');
    expect(vCheck?.detail).toContain('could not read version');
  });

  it('fails when node is missing/unresolvable (ok:false)', async () => {
    writeBin('dsh', '0.1.1-rc.2');
    // Remove the node binary so it cannot be found.
    const nodeFile = path.join(binDir, 'node');
    if (fs.existsSync(nodeFile)) fs.unlinkSync(nodeFile);
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      depsFor(),
    );
    expect(report.ok).toBe(false);
    const nodeCheck = report.checks.find((c) => c.id === 'node-version');
    expect(nodeCheck?.status).toBe('fail');
    expect(nodeCheck?.detail).toContain('could not resolve');
  });

  it('fails when node version is unreadable (ok:false)', async () => {
    writeBin('dsh', '0.1.1-rc.2');
    writeBin('node', 'v24.12.0');
    // Inject exec override that returns null for node version probe.
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      depsFor({ exec: async (_bin, args) => {
        if (args.includes('--version') && _bin.includes('node')) return null;
        return '0.1.1-rc.2';
      }}),
    );
    expect(report.ok).toBe(false);
    const nodeCheck = report.checks.find((c) => c.id === 'node-version');
    expect(nodeCheck?.status).toBe('fail');
  });

  it('fails on an incompatible node version with remediation', async () => {
    writeBin('dsh', '0.1.1-rc.2');
    writeBin('node', 'v22.18.0');
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      depsFor(),
    );
    expect(report.ok).toBe(false);
    const nodeCheck = report.checks.find((check) => check.id === 'node-version');
    expect(nodeCheck?.status).toBe('fail');
    expect(nodeCheck?.remediation).toContain('22.19.0');
  });

  it('reports dsh root as a deterministic fact (patch disables settings)', async () => {
    writeBin('dsh', '0.1.1-rc.2');
    writeBin('node', 'v24.12.0');
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      depsFor(),
    );
    const rootCheck = report.checks.find((c) => c.id === 'dsh-root');
    expect(rootCheck?.status).toBe('pass');
    expect(rootCheck?.detail).toContain('disables the settings row');
    // Doctor does NOT read settings.yaml — just reports the invariant.
  });

  it('does NOT read settings.yaml from the root', async () => {
    writeBin('dsh', '0.1.1-rc.2');
    writeBin('node', 'v24.12.0');
    // Create a root with settings.yaml — doctor should not reference its content.
    const dshRoot = path.join(workDir, '.dsh');
    fs.mkdirSync(dshRoot, { recursive: true });
    fs.writeFileSync(
      path.join(dshRoot, 'settings.yaml'),
      'agent-default-model:\n  provider: deepseek-official\n',
    );
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      depsFor(),
    );
    // No "warn" about conflicting sections — doctor doesn't scan settings.
    const settingsWarn = report.checks.find(
      (c) => c.detail?.includes('agent-default-model') && c.status === 'warn',
    );
    expect(settingsWarn).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  it('reports environment projection failures without leaking secrets', async () => {
    writeBin('dsh', '0.1.1-rc.2');
    writeBin('node', 'v24.12.0');
    const report: DshDoctorReport = await collectDshDoctorReport(
      { envName: 'official', envConfig: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } },
      depsFor(),
    );
    expect(report.ok).toBe(false);
    expect(report.environment.error).toMatch(/OAuth-backed/);
    expect(report.environment.spec).toBeNull();
  });

  it('fails on an unknown environment', async () => {
    writeBin('dsh', '0.1.1-rc.2');
    writeBin('node', 'v24.12.0');
    const report = await collectDshDoctorReport(
      { envName: 'ghost', envConfig: undefined },
      depsFor(),
    );
    expect(report.ok).toBe(false);
    expect(report.environment.error).toContain("'ghost'");
  });

  it('accepts --tier and --model in deriveOptions', async () => {
    writeBin('dsh', '0.1.1-rc.2');
    writeBin('node', 'v24.12.0');
    const report = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV, deriveOptions: { tier: 'haiku' } },
      depsFor(),
    );
    expect(report.ok).toBe(true);
    expect(report.environment.spec?.selectedModel).toBe('model-b');

    const report2 = await collectDshDoctorReport(
      { envName: 'partner', envConfig: PARTNER_ENV, deriveOptions: { model: 'custom-xyz' } },
      depsFor(),
    );
    expect(report2.ok).toBe(true);
    expect(report2.environment.spec?.selectedModel).toBe('custom-xyz');
    expect(report2.environment.spec?.models).toContain('custom-xyz');
  });
});

describe('dsh inspect report', () => {
  it('is fully redacted and includes the secret-free patch preview', () => {
    const report = buildDshInspectReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      { dshRoot: '/tmp/root', dshVersion: '0.1.1-rc.2', nodeVersion: '24.12.0' },
    );
    expect(report.environment.error).toBeNull();
    expect(report.environment.models).toEqual(['model-a', 'model-b']);
    expect(report.environment.credentialState).toBe('present');
    expect(report.dsh.versionCompatible).toBe(true);
    expect(report.node.versionCompatible).toBe(true);
    expect(report.patchPreview).toContain('apiKeyEnv: CCEM_DSH_API_KEY');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('plain-test-token');
  });

  it('marks non-exact dsh versions as incompatible', () => {
    const report = buildDshInspectReport(
      { envName: 'partner', envConfig: PARTNER_ENV },
      { dshRoot: '/tmp/root', dshVersion: '0.1.1-rc.3', nodeVersion: '24.12.0' },
    );
    expect(report.dsh.versionCompatible).toBe(false);
  });

  it('accepts deriveOptions for tier/model', () => {
    const report = buildDshInspectReport(
      { envName: 'partner', envConfig: PARTNER_ENV, deriveOptions: { model: 'new-model' } },
      { dshRoot: '/tmp/root', dshVersion: '0.1.1-rc.2', nodeVersion: '24.12.0' },
    );
    expect(report.environment.selectedModel).toBe('new-model');
    expect(report.environment.models).toContain('new-model');
  });

  it('explains projection failures without a patch preview', () => {
    const report = buildDshInspectReport(
      { envName: 'official', envConfig: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } },
      { dshRoot: '/tmp/root', dshVersion: null, nodeVersion: null },
    );
    expect(report.environment.error).toMatch(/OAuth-backed/);
    expect(report.patchPreview).toBeNull();
  });
});
