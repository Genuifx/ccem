import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importPermissionPreviewModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-permission-preview-test-'));
  const outfile = path.join(tempDir, 'permissionPreview.mjs');
  await build({
    entryPoints: [path.join(packageDir, 'src', 'permissionPreview.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

test('exposes bidi, zero-width, and quote lookalikes without normalizing ordinary text', async () => {
  const { formatPermissionPreview } = await importPermissionPreviewModule();
  const hostile = `printf \u201csafe\u201d\u202E ; rm\u200B -rf /tmp/demo\uFEFF`;

  assert.equal(
    formatPermissionPreview(hostile),
    'printf \\u{201C}safe\\u{201D}\\u{202E} ; rm\\u{200B} -rf /tmp/demo\\u{FEFF}',
  );
  assert.equal(
    formatPermissionPreview('  echo "中文内容"  &&  cat /tmp/CCEM test  '),
    'echo "中文内容" && cat /tmp/CCEM test',
  );
  assert.equal(formatPermissionPreview('e\u0301'), 'e\u0301');
  assert.equal(
    formatPermissionPreview('req\n\r\t\u0085\u2028\u2029id'),
    'req\\u{000A}\\u{000D}\\u{0009}\\u{0085}\\u{2028}\\u{2029}id',
  );
});

test('keeps escape markers and surrogate pairs intact at the truncation boundary', async () => {
  const { formatPermissionPreview } = await importPermissionPreviewModule();

  assert.equal(formatPermissionPreview(`ab\u202Ecd`, 11), 'ab\\u{202E}…');
  assert.equal(formatPermissionPreview('abc😀def', 6), 'abc😀…');
  assert.equal(formatPermissionPreview('\uFEFFvisible'), '\\u{FEFF}visible');
  assert.equal(
    formatPermissionPreview(formatPermissionPreview('x\u202Ey')),
    formatPermissionPreview('x\u202Ey'),
  );
});

test('exposes additional invisible formats and bounds work for hostile long input', async () => {
  const { formatPermissionPreview } = await importPermissionPreviewModule();
  const defaultIgnorableRangeBoundaries = [
    0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f,
    0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x206f, 0x3164, 0xfe00, 0xfe0f,
    0xfeff, 0xffa0, 0xfff0, 0xfff8, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a,
    0xe0000, 0xe0fff,
  ];
  const hostile = defaultIgnorableRangeBoundaries
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join('');

  for (const codePoint of defaultIgnorableRangeBoundaries) {
    assert.match(formatPermissionPreview(String.fromCodePoint(codePoint)), /^\\u\{[0-9A-F]+\}$/u);
  }

  let consumed = 0;
  const guardedHostileInput = {
    *[Symbol.iterator]() {
      while (consumed < 1_000_000) {
        consumed += 1;
        if (consumed > 25) throw new Error('formatter scanned beyond the visible preview boundary');
        yield String.fromCodePoint(0x202e);
      }
    },
  };
  assert.equal(
    formatPermissionPreview(guardedHostileInput),
    `${'\\u{202E}'.repeat(19)}…`,
  );
  assert.equal(consumed, 21);
  assert.ok(hostile.length > 0);
});

async function buildHelperWithPermissionMock() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-permission-preview-test-'));
  const outfile = path.join(tempDir, 'native-runtime-helper.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
    plugins: [{
      name: 'mock-native-runtime-sdks',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
          path: 'claude-agent-sdk',
          namespace: 'mock-sdk',
        }));
        pluginBuild.onLoad({ filter: /^claude-agent-sdk$/, namespace: 'mock-sdk' }, () => ({
          loader: 'js',
          contents: `
            export function tool(name, description, inputSchema, handler) {
              return { name, description, inputSchema, handler };
            }

            export function createSdkMcpServer(config) {
              return {
                type: 'sdk',
                name: config.name,
                instance: {
                  _registeredTools: Object.fromEntries((config.tools || []).map((definition) => [definition.name, definition])),
                },
              };
            }

            function deepFreeze(value) {
              if (value && typeof value === 'object') {
                Object.freeze(value);
                Object.values(value).forEach(deepFreeze);
              }
              return value;
            }

            export function query({ prompt, options }) {
              return {
                close() {},
                async getContextUsage() {
                  return {
                    totalTokens: 1,
                    maxTokens: 10,
                    rawMaxTokens: 10,
                    percentage: 10,
                    autoCompactThreshold: null,
                    isAutoCompactEnabled: false,
                    model: 'mock',
                    categories: [],
                  };
                },
                async *[Symbol.asyncIterator]() {
                  const iterator = prompt[Symbol.asyncIterator]();
                  const next = await iterator.next();
                  if (next.done) return;

                  const rawInput = deepFreeze({
                    command: 'printf ' + String.fromCodePoint(0x201c) + 'safe' + String.fromCodePoint(0x201d)
                      + String.fromCodePoint(0x202e) + ' ; rm' + String.fromCodePoint(0x200b)
                      + ' -rf /tmp/demo' + String.fromCodePoint(0x000a, 0x001b, 0x0000),
                    nested: { value: 'unchanged' },
                  });
                  const before = JSON.stringify(rawInput);
                  const requestId = String.fromCodePoint(0xfeff) + ' req'
                    + String.fromCodePoint(0x000a, 0x001b, 0x0000, 0x202e)
                    + 'id ' + String.fromCodePoint(0xfeff);
                  const result = await options.canUseTool('Bash', rawInput, {
                    toolUseID: 'toolu-preview-1',
                    requestId,
                    displayName: 'Bash',
                  });
                  const after = JSON.stringify(rawInput);
                  const identity = result.behavior === 'allow'
                    ? result.updatedInput === rawInput
                    : !('updatedInput' in result);
                  console.error('PERMISSION_PROOF ' + JSON.stringify({
                    behavior: result.behavior,
                    identity,
                    unchanged: before === after,
                    before,
                    after,
                  }));
                  yield { type: 'result', subtype: 'success', result: 'done', session_id: 'mock-session' };
                },
              };
            }
          `,
        }));
        pluginBuild.onResolve({ filter: /^@openai\/codex-sdk$/ }, () => ({
          path: 'codex-sdk',
          namespace: 'mock-sdk',
        }));
        pluginBuild.onLoad({ filter: /^codex-sdk$/, namespace: 'mock-sdk' }, () => ({
          loader: 'js',
          contents: 'export class Codex {}',
        }));
      },
    }],
  });

  return outfile;
}

function collectHelperOutput(helper) {
  const outputs = [];
  let stdoutBuffer = '';
  const stderrRef = { value: '' };

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) outputs.push(JSON.parse(line));
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  return { outputs, stderrRef };
}

function waitFor(predicate, description, diagnostic) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const result = predicate();
      if (result) return resolve(result);
      if (Date.now() - startedAt > 2_000) {
        reject(new Error(`Timed out waiting for ${description}.\n${diagnostic()}`));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

async function runPermissionScenario(approved, t) {
  const helperPath = await buildHelperWithPermissionMock();
  const helper = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => helper.kill('SIGTERM'));
  const { outputs, stderrRef } = collectHelperOutput(helper);

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'run the command',
  })}\n`);

  const permission = await waitFor(
    () => outputs.find((output) => output.type === 'event'
      && output.payload?.type === 'permission_required'),
    'permission request',
    () => `stdout=${JSON.stringify(outputs)}\nstderr=${stderrRef.value}`,
  );
  helper.stdin.write(`${JSON.stringify({
    type: 'permission_response',
    request_id: permission.payload.request_id,
    approved,
  })}\n`);

  const proofLine = await waitFor(
    () => stderrRef.value.split('\n').find((line) => line.startsWith('PERMISSION_PROOF ')),
    'permission proof marker',
    () => `stdout=${JSON.stringify(outputs)}\nstderr=${stderrRef.value}`,
  );
  return {
    outputs,
    permission,
    proof: JSON.parse(proofLine.slice('PERMISSION_PROOF '.length)),
  };
}

for (const approved of [true, false]) {
  test(`permission ${approved ? 'approval' : 'denial'} keeps raw tool input unchanged`, async (t) => {
    const { outputs, permission, proof } = await runPermissionScenario(approved, t);
    const started = outputs.find((output) => output.type === 'event'
      && output.payload?.type === 'tool_use_started');

    assert.equal(permission.payload.request_id, `\uFEFF req\n\u001B\u0000\u202Eid \uFEFF`);
    assert.equal(permission.payload.tool_use_id, 'toolu-preview-1');
    assert.equal(permission.payload.input_summary, started.payload.input_summary);
    assert.match(permission.payload.input_summary, /\\u\{201C\}safe\\u\{201D\}\\u\{202E\}/u);
    assert.match(permission.payload.input_summary, /rm\\u\{200B\} -rf/u);
    assert.match(permission.payload.input_summary, /\\u\{000A\}\\u\{001B\}\\u\{0000\}/u);
    assert.doesNotMatch(
      permission.payload.input_summary,
      /[\u0000\u001B\u200B\u202E\u201C\u201D]/u,
    );
    assert.equal(proof.behavior, approved ? 'allow' : 'deny');
    assert.equal(proof.identity, true);
    assert.equal(proof.unchanged, true);
    assert.equal(proof.before, proof.after);
  });
}
