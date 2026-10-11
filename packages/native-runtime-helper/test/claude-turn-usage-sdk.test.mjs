import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';

// Real pinned SDK/CLI, deterministic local Messages API. Protect the usage
// contract on SDK upgrades without credentials, billable calls, or saved sessions.
test('installed Claude SDK result output usage is per turn with streaming input', async (t) => {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* discard prompts and headers */ }
    if (!req.url.startsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const outputTokens = ++requests === 1 ? 11 : 17;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    emit('message_start', { message: { id: `msg_${requests}`, type: 'message', role: 'assistant',
      model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } });
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `reply ${requests}` } });
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } });
    emit('message_stop', {});
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  let release;
  const ids = [randomUUID(), randomUUID()];
  async function* prompts() {
    for (const uuid of ids) {
      yield { type: 'user', uuid, session_id: '', parent_tool_use_id: null,
        message: { role: 'user', content: 'Reply briefly.' } };
      await new Promise((resolve) => { release = resolve; });
    }
  }
  const sdk = query({ prompt: prompts(), options: {
    model: 'claude-sonnet-4-6', tools: [], mcpServers: {}, settingSources: [],
    persistSession: false, includePartialMessages: true,
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ANTHROPIC_API_KEY: 'local-usage-fixture', ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  } });
  const deadline = setTimeout(() => sdk.close(), 30_000);
  t.after(() => { clearTimeout(deadline); sdk.close(); release?.(); });
  const results = [];
  const assistantCounts = [];
  for await (const message of sdk) {
    if (message.type === 'assistant') assistantCounts.push(message.message.usage.output_tokens);
    if (message.type !== 'result') continue;
    assert.equal(message.subtype, 'success');
    results.push(message);
    if (results.length === 2) break;
    release?.();
  }
  assert.equal(requests, 2);
  assert.deepEqual(results.map((result) => result.user_message_uuid), ids);
  assert.deepEqual(results.map((result) => result.usage.output_tokens), [11, 17]);
  assert.deepEqual(results.map((result) => result.usage.input_tokens), [100, 100]);
  assert.deepEqual(assistantCounts, [0, 0], 'partial-mode assistant usage is not final output usage');
});
