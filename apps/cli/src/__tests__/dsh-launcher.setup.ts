/**
 * Shared test infrastructure for dsh launcher test suite.
 * Provides fake dsh binaries, capture helpers, and common constants.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deriveDshProvider } from '../dsh/provider.js';
import type { DshInvocation } from '../dsh/environment.js';

export const TOKEN = 'sk-launcher-test-do-not-print';

export const SPEC = deriveDshProvider('partner', {
  ANTHROPIC_BASE_URL: 'https://gw.example.internal/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'plain-test-token',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'model-a',
});

export interface FakeCapture {
  argv: string[];
  cwd: string;
  patchContent: string | null;
  env: Record<string, string | null>;
}

export const FAKE_DSH = `#!/usr/bin/env node
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

export const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccem-dsh-launcher-test-'));
export const fakeDshPath = path.join(workDir, 'fake-dsh.mjs');
export const capturePath = path.join(workDir, 'capture.json');

export function writeFakeDsh(): void {
  fs.writeFileSync(fakeDshPath, FAKE_DSH, { mode: 0o755 });
}

export function readCapture(): FakeCapture {
  return JSON.parse(fs.readFileSync(capturePath, 'utf-8')) as FakeCapture;
}

export function fakeInvocation(bin: string = fakeDshPath): DshInvocation {
  // Route the JavaScript fixture through a real cross-platform executable;
  // Windows cannot execute a POSIX shebang fixture directly.
  return { bin: process.execPath, prefix: [bin] };
}

export function parentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
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

export function cleanupWorkDir(): void {
  fs.rmSync(workDir, { recursive: true, force: true });
}
