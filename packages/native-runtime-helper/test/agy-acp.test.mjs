import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAgyExecutableFixture } from './agy-executable-fixture.mjs';

const helper = fileURLToPath(new URL('../dist/native-runtime-helper.mjs', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchAgyHelper(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-agy-acp-'));
  const logFile = path.join(dir, 'fixture.jsonl');
  const agyPath = await createAgyExecutableFixture(dir);

  const env = {
    ...process.env,
    HOME: options.home ?? dir,
    AGY_FIXTURE_LOG: logFile,
    AGY_FIXTURE_SCENARIO: options.scenario ?? 'default',
    ...(options.version ? { AGY_FIXTURE_VERSION: options.version } : {}),
    ...(options.parentEnv ?? {}),
  };
  if (!options.parentEnv) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
  }

  const child = spawn(process.execPath, [helper], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  t.after(async () => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end();
    }
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(2000),
      ]);
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  const outputs = [];
  let buffer = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const idx = buffer.indexOf('\n');
      if (idx < 0) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) {
        outputs.push(JSON.parse(line));
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const send = (command) => {
    child.stdin.write(`${JSON.stringify(command)}\n`);
  };

  const wait = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = outputs.find(predicate);
      if (found) return found;
      await sleep(10);
    }
    throw new Error(`Timed out waiting for helper output:\n${JSON.stringify({ outputs, stderr }, null, 2)}`);
  };

  const readFixtureLog = async () => {
    try {
      const raw = await fs.readFile(logFile, 'utf8');
      return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };

  const baseInit = {
    type: 'init',
    provider: 'agy',
    env_name: 'Antigravity',
    working_dir: dir,
    perm_mode: 'dev',
    effort: 'medium',
    agy_path: agyPath,
  };

  return { child, dir, agyPath, send, wait, outputs, readFixtureLog, baseInit };
}

test('agy acp initialize + session/new + streaming updates (thought, plan, tool, text, usage, images)', async (t) => {
  const h = await launchAgyHelper(t, { scenario: 'stdout_noise', version: '1.5.4' });

  h.send({
    ...h.baseInit,
    model: 'gemini-3-pro',
    initial_prompt: 'Inspect this [Image #1]',
    initial_images: [{ mediaType: 'image/png', base64Data: 'iVBORw0KGgo=', placeholder: '[Image #1]' }],
  });

  await h.wait((o) => o.type === 'status' && o.status === 'ready' && o.detail === 'Ready for the next prompt.');

  const sessionMeta = h.outputs.find((o) => o.type === 'session_meta');
  assert.equal(sessionMeta?.provider_session_id, 'agy-sess-1');

  const events = h.outputs.filter((o) => o.type === 'event').map((o) => o.payload);

  // Version < 1.5.5 emits non-fatal warning + non-JSON stdout line is tolerated safely
  assert.ok(events.some((e) => e.type === 'stderr_line' && /below recommended 1\.5\.5/.test(e.line)));
  assert.ok(events.some((e) => e.type === 'stderr_line' && /Loaded cached credentials/.test(e.line)));

  // Thought -> system_message
  assert.ok(events.some((e) => e.type === 'system_message' && e.message.includes('Analyzing the repository')));

  // Plan -> todo_snapshot attached to tool_use_started
  const planEvent = events.find((e) => e.type === 'tool_use_started' && e.todo_snapshot);
  assert.ok(planEvent, 'expected plan todo_snapshot event');
  assert.equal(planEvent.todo_snapshot.provider, 'agy');
  assert.equal(planEvent.todo_snapshot.source, 'plan');
  assert.equal(planEvent.todo_snapshot.items.length, 2);
  assert.equal(planEvent.todo_snapshot.items[0].text, 'Inspect files');
  assert.equal(planEvent.todo_snapshot.items[1].status, 'in_progress');

  // Tool call start + completion
  const toolStart = events.find((e) => e.type === 'tool_use_started' && e.tool_use_id === 'call-1');
  assert.equal(toolStart?.category?.category, 'file_op');
  const toolDone = events.find((e) => e.type === 'tool_use_completed' && e.tool_use_id === 'call-1');
  assert.equal(toolDone?.success, true);
  assert.match(toolDone?.result_summary ?? '', /# CCEM/);

  // Assistant text chunk
  const assistantText = events
    .filter((e) => e.type === 'assistant_chunk')
    .map((e) => e.text)
    .join('');
  assert.match(assistantText, /Hello from Antigravity turn 1/);

  // Token usage
  const usage = events.find((e) => e.type === 'token_usage');
  assert.equal(usage?.provider, 'agy');
  assert.equal(usage?.input_tokens, 120);
  assert.equal(usage?.output_tokens, 45);
  assert.equal(usage?.cache_read_tokens, 30);

  // Verify ACP wire calls (initialize, session/new, config options, prompt with image block)
  const log = await h.readFixtureLog();
  const promptRpc = log.find((entry) => entry.event === 'recv' && entry.msg.method === 'session/prompt');
  assert.ok(promptRpc);
  assert.deepEqual(promptRpc.msg.params.prompt, [
    { type: 'text', text: 'Inspect this' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  ]);
  assert.ok(log.some((entry) => entry.event === 'recv'
    && entry.msg.method === 'session/set_config_option'
    && entry.msg.params.configId === 'mode'
    && entry.msg.params.value === 'accept-edits'));
  assert.ok(log.some((entry) => entry.event === 'recv'
    && entry.msg.method === 'session/set_config_option'
    && entry.msg.params.configId === 'model'
    && entry.msg.params.value === 'gemini-3-pro'));
  assert.ok(log.some((entry) => entry.event === 'recv'
    && entry.msg.method === 'session/set_config_option'
    && entry.msg.params.configId === 'thought_level'
    && entry.msg.params.value === 'medium'));
});

test('agy acp session/request_permission approves with allow_once and denies with reject_once', async (t) => {
  const h = await launchAgyHelper(t, { scenario: 'permission_flow' });

  h.send({ ...h.baseInit, initial_prompt: 'First tool run' });
  const perm1 = await h.wait((o) => o.type === 'event' && o.payload.type === 'permission_required');
  assert.equal(perm1.payload.tool_name, 'run_command');
  assert.match(perm1.payload.input_summary, /rm -rf build/);

  h.send({ type: 'permission_response', request_id: perm1.payload.request_id, approved: true });
  await h.wait((o) => o.type === 'event' && o.payload.type === 'assistant_chunk' && o.payload.text.includes('opt-allow-once'));
  await h.wait((o) => o.type === 'status' && o.status === 'ready' && o.detail === 'Ready for the next prompt.');

  // Second prompt: deny permission -> maps to reject_once
  h.send({ type: 'prompt', text: 'Second tool run' });
  const perm2 = await h.wait(
    (o) => o.type === 'event'
      && o.payload.type === 'permission_required'
      && o.payload.request_id !== perm1.payload.request_id,
  );
  h.send({ type: 'permission_response', request_id: perm2.payload.request_id, approved: false });
  await h.wait((o) => o.type === 'event' && o.payload.type === 'assistant_chunk' && o.payload.text.includes('opt-reject-once'));
});

test('agy acp interrupt_turn sends session/cancel, cancels pending permission, and keeps session alive for next prompt', async (t) => {
  const h = await launchAgyHelper(t, { scenario: 'interrupt_then_continue' });

  h.send({ ...h.baseInit, initial_prompt: 'Long running turn' });
  await h.wait((o) => o.type === 'event' && o.payload.type === 'permission_required');

  h.send({ type: 'interrupt_turn' });
  await h.wait((o) => o.type === 'status' && o.status === 'ready' && o.detail === 'Turn interrupted. Ready for the next prompt.');

  // Follow-up prompt must succeed on the SAME agy acp child process
  h.send({ type: 'prompt', text: 'Follow-up after interrupt' });
  await h.wait((o) => o.type === 'event' && o.payload.type === 'assistant_chunk' && o.payload.text.includes('Hello from Antigravity turn 2'));

  const log = await h.readFixtureLog();
  const spawns = log.filter((entry) => entry.event === 'spawn');
  assert.equal(spawns.length, 1, 'interrupt_turn must keep the same agy acp process alive');
  assert.ok(log.some((entry) => entry.event === 'recv' && entry.msg.method === 'session/cancel'));
  const permResult = log.find((entry) => entry.event === 'permission_result');
  assert.deepEqual(permResult?.response?.result?.outcome, { outcome: 'cancelled' });
});

test('agy acp session/resume and fallback to session/load when provider_session_id is provided', async (t) => {
  // 1. Direct session/resume
  const h1 = await launchAgyHelper(t, { scenario: 'default' });
  h1.send({
    ...h1.baseInit,
    provider_session_id: 'existing-agy-session',
    initial_prompt: 'Continue work',
  });
  await h1.wait((o) => o.type === 'status' && o.status === 'ready' && o.detail === 'Ready for the next prompt.');
  const log1 = await h1.readFixtureLog();
  assert.ok(log1.some((e) => e.event === 'recv' && e.msg.method === 'session/resume' && e.msg.params.sessionId === 'existing-agy-session'));
  assert.ok(!log1.some((e) => e.event === 'recv' && e.msg.method === 'session/load'));

  // 2. Fallback to session/load when session/resume returns -32601
  const h2 = await launchAgyHelper(t, { scenario: 'resume_fallback_to_load' });
  h2.send({
    ...h2.baseInit,
    provider_session_id: 'legacy-agy-session',
    initial_prompt: 'Continue legacy work',
  });
  await h2.wait((o) => o.type === 'status' && o.status === 'ready' && o.detail === 'Ready for the next prompt.');
  const log2 = await h2.readFixtureLog();
  assert.ok(log2.some((e) => e.event === 'recv' && e.msg.method === 'session/resume'));
  assert.ok(log2.some((e) => e.event === 'recv' && e.msg.method === 'session/load' && e.msg.params.sessionId === 'legacy-agy-session'));
});

test('agy acp -32000 Authentication required emits AGY_AUTH_REQUIRED sentinel error', async (t) => {
  const h = await launchAgyHelper(t, { scenario: 'auth_required' });
  h.send({ ...h.baseInit, initial_prompt: 'Hello' });

  const errStatus = await h.wait((o) => o.type === 'status' && o.status === 'error');
  assert.ok(
    errStatus.detail.startsWith('AGY_AUTH_REQUIRED: Antigravity is not signed in. Sign in with Google to continue.'),
    `unexpected error detail: ${errStatus.detail}`,
  );
  const stderrEvent = h.outputs.find(
    (o) => o.type === 'event'
      && o.payload.type === 'stderr_line'
      && o.payload.line.startsWith('AGY_AUTH_REQUIRED: Antigravity is not signed in. Sign in with Google to continue.'),
  );
  assert.ok(stderrEvent);
});

test('agy acp update_settings updates perm_mode and effort live and tolerates unsupported config options', async (t) => {
  const h = await launchAgyHelper(t, { scenario: 'unsupported_config' });
  h.send({ ...h.baseInit, initial_prompt: 'Initial prompt' });
  await h.wait((o) => o.type === 'status' && o.status === 'ready' && o.detail === 'Ready for the next prompt.');

  h.send({
    type: 'update_settings',
    request_id: 'req-live-1',
    perm_mode: 'plan',
    effort: 'high',
  });
  const ack = await h.wait((o) => o.type === 'settings_update_result' && o.request_id === 'req-live-1');
  assert.equal(ack.outcome, 'applied');

  const log = await h.readFixtureLog();
  assert.ok(log.some((e) => e.event === 'recv'
    && e.msg.method === 'session/set_config_option'
    && e.msg.params.configId === 'mode'
    && e.msg.params.value === 'plan'));
  assert.ok(log.some((e) => e.event === 'recv'
    && e.msg.method === 'session/set_config_option'
    && e.msg.params.configId === 'thought_level'
    && e.msg.params.value === 'high'));

  // Even though thought_level was rejected by fixture, next turn still succeeds cleanly
  h.send({ type: 'prompt', text: 'After settings update' });
  await h.wait((o) => o.type === 'event' && o.payload.type === 'assistant_chunk' && o.payload.text.includes('Hello from Antigravity turn 2'));
});

test('agy acp stop closes session cleanly and preserves HOME while stripping ANTHROPIC_* and Claude/Codex isolation env vars from parent process.env and env_vars', async (t) => {
  const customHome = path.join(os.tmpdir(), `ccem-agy-home-${Date.now()}`);
  await fs.mkdir(customHome, { recursive: true });
  t.after(() => fs.rm(customHome, { recursive: true, force: true }));

  const h = await launchAgyHelper(t, {
    home: customHome,
    parentEnv: {
      ANTHROPIC_API_KEY: 'sk-ant-from-parent-env',
      ANTHROPIC_BASE_URL: 'https://parent-anthropic.example',
      CLAUDE_CONFIG_DIR: '/tmp/ccem-claude-config',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/ccem-claude-secure',
      CLAUDE_CODE_PLUGIN_CACHE_DIR: '/tmp/ccem-claude-plugins',
      CODEX_HOME: '/tmp/ccem-codex-home',
      CODEX_SQLITE_HOME: '/tmp/ccem-codex-sqlite',
      CCEM_CODEX_ISOLATED: '1',
    },
  });
  h.send({
    ...h.baseInit,
    perm_mode: 'yolo',
    env_vars: {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      HOME: '/tmp/should-not-override-home',
      ANTHROPIC_API_KEY: 'sk-ant-should-never-leak',
      ANTHROPIC_BASE_URL: 'https://should-never-leak.example',
      CLAUDE_CONFIG_DIR: '/tmp/extra-claude-config',
      CODEX_HOME: '/tmp/extra-codex-home',
    },
    initial_prompt: 'Check env',
  });
  await h.wait((o) => o.type === 'status' && o.status === 'ready' && o.detail === 'Ready for the next prompt.');

  h.send({ type: 'stop' });
  await h.wait((o) => o.type === 'status' && o.status === 'closed_idle');
  await new Promise((resolve) => h.child.once('exit', resolve));

  const log = await h.readFixtureLog();
  const spawnEntry = log.find((e) => e.event === 'spawn');
  assert.deepEqual(spawnEntry?.argv, ['acp', '--dangerously-skip-permissions']);
  assert.equal(spawnEntry?.env?.HOME, customHome, 'HOME must be preserved natively');
  assert.equal(spawnEntry?.env?.HTTPS_PROXY, 'http://127.0.0.1:7890', 'proxy env vars must pass through');
  assert.equal(spawnEntry?.env?.ANTHROPIC_API_KEY, null, 'ANTHROPIC_API_KEY must never leak from parent or env_vars');
  assert.equal(spawnEntry?.env?.ANTHROPIC_BASE_URL, null, 'ANTHROPIC_BASE_URL must never leak from parent or env_vars');
  assert.equal(spawnEntry?.env?.CLAUDE_CONFIG_DIR, null, 'CLAUDE_CONFIG_DIR must not leak into agy acp');
  assert.equal(spawnEntry?.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, null, 'CLAUDE_SECURESTORAGE_CONFIG_DIR must not leak into agy acp');
  assert.equal(spawnEntry?.env?.CLAUDE_CODE_PLUGIN_CACHE_DIR, null, 'CLAUDE_CODE_PLUGIN_CACHE_DIR must not leak into agy acp');
  assert.equal(spawnEntry?.env?.CODEX_HOME, null, 'CODEX_HOME must not leak into agy acp');
  assert.equal(spawnEntry?.env?.CODEX_SQLITE_HOME, null, 'CODEX_SQLITE_HOME must not leak into agy acp');
  assert.equal(spawnEntry?.env?.CCEM_CODEX_ISOLATED, null, 'CCEM_CODEX_ISOLATED must not leak into agy acp');
  assert.ok(log.some((e) => e.event === 'recv' && e.msg.method === 'session/close'));
  assert.ok(log.some((e) => e.event === 'eof_exit'), 'agy acp child must exit cleanly on stdin EOF');
});

test('agy acp multi-step turn emits context_usage from usage_update, single turn_total from prompt result, ttft_ms, and segmented generation_ms', async (t) => {
  const h = await launchAgyHelper(t, { scenario: 'multi_step_metrics' });

  h.send({
    ...h.baseInit,
    model: 'gemini-3-pro',
    initial_prompt: 'Run multi-step check',
  });

  await h.wait((o) => o.type === 'status' && o.status === 'ready' && o.detail === 'Ready for the next prompt.');

  const events = h.outputs.filter((o) => o.type === 'event').map((o) => o.payload);

  // usage_update { used, size } maps to context_usage (never inflated into token_usage)
  const contextEvents = events.filter((e) => e.type === 'context_usage');
  assert.deepEqual(
    contextEvents.map((e) => ({
      provider: e.provider,
      used: e.used_tokens,
      max: e.max_tokens,
      model: e.model,
    })),
    [
      { provider: 'agy', used: 0, max: 1000000, model: 'gemini-3-pro' },
      { provider: 'agy', used: 9337, max: 1000000, model: 'gemini-3-pro' },
      { provider: 'agy', used: 24500, max: 1000000, model: 'gemini-3-pro' },
    ],
  );

  // Only ONE turn_total token_usage from session/prompt result.usage
  const tokenUsageEvents = events.filter((e) => e.type === 'token_usage');
  assert.equal(tokenUsageEvents.length, 1, 'intermediate usage_update context snapshots must never emit token_usage');
  assert.equal(tokenUsageEvents[0].provider, 'agy');
  assert.equal(tokenUsageEvents[0].scope, 'turn_total');
  assert.equal(tokenUsageEvents[0].input_tokens, 12000);
  assert.equal(tokenUsageEvents[0].output_tokens, 450);
  assert.equal(tokenUsageEvents[0].cache_read_tokens, 8000);
  assert.equal(tokenUsageEvents[0].cache_creation_tokens, 0);

  // Live progress carries ttft_ms
  const progressEvents = events.filter((e) => e.type === 'turn_progress');
  assert.ok(progressEvents.length >= 1, 'expected live turn_progress');
  assert.ok(progressEvents.every((e) => typeof e.ttft_ms === 'number' && e.ttft_ms >= 80), 'ttft_ms on turn_progress');

  // Final turn_metrics carries accurate ttft_ms and segmented generation_ms (excludes tool run & inter-step TTFT)
  const turnMetrics = events.filter((e) => e.type === 'turn_metrics');
  assert.equal(turnMetrics.length, 1);
  assert.equal(turnMetrics[0].provider, 'agy');
  assert.equal(turnMetrics[0].output_tokens, 450);
  assert.ok(turnMetrics[0].ttft_ms >= 80 && turnMetrics[0].ttft_ms < 300, `expected ttft_ms around 110ms, got ${turnMetrics[0].ttft_ms}`);
  assert.ok(turnMetrics[0].generation_ms >= 80 && turnMetrics[0].generation_ms < 260, `expected segmented generation_ms ~120ms, got ${turnMetrics[0].generation_ms}`);
  assert.ok(
    turnMetrics[0].elapsed_ms >= turnMetrics[0].generation_ms + 380,
    `elapsed_ms (${turnMetrics[0].elapsed_ms}) should significantly exceed generation_ms (${turnMetrics[0].generation_ms}) because TTFT + tool execution are excluded`,
  );
});

test('agy acp dynamic model and effort switching clamps initial effort, hot-swaps models without respawn, and rejects invalid standalone updates', async (t) => {
  const h = await launchAgyHelper(t, { scenario: 'dynamic_models' });

  // Initial launch requests effort="max" on gemini-4-neon (which only supports low..xhigh);
  // helper should clamp to xhigh and emit authoritative runtime_config_options_updated.
  h.send({
    ...h.baseInit,
    model: 'gemini-4-neon',
    effort: 'max',
    initial_prompt: 'Start with neon',
  });
  await h.wait((o) => o.type === 'status' && o.status === 'ready' && o.detail === 'Ready for the next prompt.');

  const initialConfigEvents = h.outputs
    .filter((o) => o.type === 'event' && o.payload.type === 'runtime_config_options_updated')
    .map((o) => o.payload);
  assert.ok(initialConfigEvents.length >= 1, 'expected runtime_config_options_updated on session start');
  const firstSnapshot = initialConfigEvents.at(-1);
  assert.equal(firstSnapshot.current_model, 'gemini-4-neon');
  assert.equal(firstSnapshot.current_effort, 'xhigh');
  assert.equal(firstSnapshot.supports_effort, true);
  assert.deepEqual(
    firstSnapshot.efforts.map((c) => c.value),
    ['low', 'medium', 'high', 'xhigh'],
  );

  // Hot-swap model to claude-opus-5-5 (only supports low/medium/high) on the SAME ACP child process.
  const beforeOpusCount = h.outputs.length;
  h.send({
    type: 'update_settings',
    request_id: 'req-model-opus',
    model: 'claude-opus-5-5',
  });
  const opusAck = await h.wait((o) => o.type === 'settings_update_result' && o.request_id === 'req-model-opus');
  assert.equal(opusAck.outcome, 'applied');

  const opusSnapshot = h.outputs
    .slice(beforeOpusCount)
    .filter((o) => o.type === 'event' && o.payload.type === 'runtime_config_options_updated')
    .map((o) => o.payload)
    .at(-1);
  assert.ok(opusSnapshot, 'expected runtime_config_options_updated after model switch');
  assert.equal(opusSnapshot.current_model, 'claude-opus-5-5');
  assert.equal(opusSnapshot.current_effort, 'high');
  assert.equal(opusSnapshot.supports_effort, true);
  assert.deepEqual(
    opusSnapshot.efforts.map((c) => c.value),
    ['low', 'medium', 'high'],
  );

  // Reject unsupported standalone effort ("xhigh" on claude-opus-5-5) and re-emit authoritative state.
  const beforeInvalidEffort = h.outputs.length;
  h.send({
    type: 'update_settings',
    request_id: 'req-effort-invalid',
    effort: 'xhigh',
  });
  const invalidEffortAck = await h.wait(
    (o) => o.type === 'settings_update_result' && o.request_id === 'req-effort-invalid',
  );
  assert.equal(invalidEffortAck.outcome, 'failed');
  assert.match(invalidEffortAck.detail ?? '', /not offered/);
  const snappedSnapshot = h.outputs
    .slice(beforeInvalidEffort)
    .filter((o) => o.type === 'event' && o.payload.type === 'runtime_config_options_updated')
    .map((o) => o.payload)
    .at(-1);
  assert.equal(snappedSnapshot?.current_effort, 'high');

  // Switch to a model without thought_level support -> supports_effort becomes false.
  const beforeOrchCount = h.outputs.length;
  h.send({
    type: 'update_settings',
    request_id: 'req-model-orch',
    model: 'gemini-pro-orchestrator-neon',
  });
  const orchAck = await h.wait((o) => o.type === 'settings_update_result' && o.request_id === 'req-model-orch');
  assert.equal(orchAck.outcome, 'applied');
  const orchSnapshot = h.outputs
    .slice(beforeOrchCount)
    .filter((o) => o.type === 'event' && o.payload.type === 'runtime_config_options_updated')
    .map((o) => o.payload)
    .at(-1);
  assert.equal(orchSnapshot?.current_model, 'gemini-pro-orchestrator-neon');
  assert.equal(orchSnapshot?.supports_effort, false);
  assert.equal(orchSnapshot?.current_effort, null);
  assert.deepEqual(orchSnapshot?.efforts, []);

  // Reject unknown model cleanly.
  h.send({
    type: 'update_settings',
    request_id: 'req-model-unknown',
    model: 'nonexistent-model',
  });
  const unknownAck = await h.wait(
    (o) => o.type === 'settings_update_result' && o.request_id === 'req-model-unknown',
  );
  assert.equal(unknownAck.outcome, 'failed');

  // Confirm all live model/effort switches happened on the SAME agy acp child process (no respawn).
  const log = await h.readFixtureLog();
  const spawns = log.filter((entry) => entry.event === 'spawn');
  assert.equal(spawns.length, 1, 'live agy model/effort switching must not respawn agy acp');
});
