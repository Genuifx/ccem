import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importCodexContextUsageModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-codex-context-test-'));
  const outfile = path.join(tempDir, 'codexContextUsage.mjs');
  await build({
    entryPoints: [path.join(packageDir, 'src', 'codexContextUsage.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

test('reads Codex context usage from last_token_usage instead of cumulative totals', async () => {
  const {
    findCodexSessionFile,
    readLatestCodexContextUsageFromSessionFile,
    resolveCodexSessionsRoot,
  } = await importCodexContextUsageModule();

  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-codex-home-'));
  const sessionsRoot = resolveCodexSessionsRoot({ CCEM_AGENT_HOME: codexHome, CODEX_HOME: '/official/codex', CCEM_CODEX_ISOLATED: '1' });
  assert.equal(sessionsRoot, path.join(codexHome, 'codex', 'sessions'));
  assert.equal(resolveCodexSessionsRoot({ HOME: codexHome, CODEX_HOME: '~/shared-codex', CCEM_CODEX_ISOLATED: '0' }),
    path.join(codexHome, 'shared-codex', 'sessions'));
  const sessionId = '019dbb39-4e70-7351-a75d-3847d4288e31';
  const sessionDir = path.join(sessionsRoot, '2026', '05', '11');
  const sessionPath = path.join(sessionDir, `rollout-2026-05-11T01-02-03-${sessionId}.jsonl`);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionPath, [
    '{"type":"turn_context","payload":{"model":"gpt-5.5-codex"}}',
    '{"timestamp":"2026-05-11T01:02:04.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":34022401,"cached_input_tokens":32696832,"output_tokens":135990,"total_tokens":34158391},"last_token_usage":{"input_tokens":166399,"cached_input_tokens":149376,"output_tokens":601,"total_tokens":167000},"model_context_window":258400}}}',
  ].join('\n'));

  assert.equal(findCodexSessionFile(sessionId, sessionsRoot), sessionPath);

  const snapshot = readLatestCodexContextUsageFromSessionFile(sessionPath);
  assert.equal(snapshot.usedTokens, 167000);
  assert.equal(snapshot.maxTokens, 258400);
  assert.equal(snapshot.model, 'gpt-5.5-codex');
  assert.equal(Math.round(snapshot.percentage), 65);
  assert.deepEqual(snapshot.categories, [
    { name: 'input', tokens: 166399 },
    { name: 'output', tokens: 601 },
  ]);
});

test('does not turn cumulative Codex totals into context occupancy', async () => {
  const { buildCodexContextUsageFromTokenCount } = await importCodexContextUsageModule();

  const snapshot = buildCodexContextUsageFromTokenCount({
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: 34022401,
        output_tokens: 135990,
        total_tokens: 34158391,
      },
      model_context_window: 258400,
    },
  });

  assert.equal(snapshot, null);
});

