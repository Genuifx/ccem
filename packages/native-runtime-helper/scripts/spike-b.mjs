#!/usr/bin/env node
/**
 * Spike B harness — CCEM Router 设计 §5.3(docs/plans/2026-08-09-subagent-env-router-design.md)
 *
 * 目的:抓包证实四个放行门槛。
 *   B1  PreToolUse updatedInput 改写的 prompt 是否原样成为 subagent 独立 user text block
 *       并出现在其 API 请求体(含强制工具调用后的下一轮仍在)
 *   B2  当前版本 Task 工具的 tool_name / subagent_type 字段名(Task vs Agent)
 *   B3  ANTHROPIC_SMALL_FAST_MODEL 任意字符串是否进入请求 model 字段
 *   B4  不设 ANTHROPIC_AUTH_TOKEN 时 Authorization 头形态(harness 只记录有无;
 *       OAuth 透传需 official 账号人工验证)
 *
 * 方法:本地 HTTP 捕获服务器冒充 Anthropic 上游,返回编排好的 SSE:
 *   第 1 个 /v1/messages 请求 → 返回 Task 工具调用(tool_use)
 *   subagent 自己的请求      → 返回简单文本
 *   含 tool_result 的请求    → 返回结束文本
 *
 * 运行:node scripts/spike-b.mjs  (在 packages/native-runtime-helper 目录下)
 * 环境变量:
 *   SPIKE_TOOL_NAME=Task|Agent   指定工具名(默认先 Task,失败后自动用 Agent 重试)
 *   SPIKE_REPORT=<path>          报告输出路径(默认 ./spike-b-report.json)
 *   SPIKE_AUTH_MODE=dummy|none   dummy 设测试 token;none 清空 token env 观测 OAuth 头
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

const TAG = '<CCEM-ROUTE>subagent:Explore</CCEM-ROUTE>';
const TASK_INPUT = { description: 'spike probe', prompt: 'Reply with the single word: pong', subagent_type: 'Explore' };

// ---------- 编排 SSE 响应 ----------

function sseText(id, text) {
  return [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'spike-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

function sseToolUse(id, toolName, input = TASK_INPUT, toolUseId = 'toolu_spike_1') {
  return [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'spike-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

// ---------- 捕获服务器 ----------

function startCaptureServer(toolName) {
  const captures = [];
  let mainToolIssued = false;
  let subagentProbeIssued = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      const userMessageTexts = extractUserTexts(body);
      captures.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization ? 'present' : 'absent',
        xApiKey: req.headers['x-api-key'] ? 'present' : 'absent',
        model: body?.model ?? null,
        firstUserMessageText: userMessageTexts[0] ?? null,
        userMessageTexts,
        hasToolResult: JSON.stringify(body?.messages ?? []).includes('"tool_result"'),
      });
      if (!req.url?.includes('/v1/messages')) {
        res.writeHead(404).end();
        return;
      }
      const capture = captures[captures.length - 1];
      const isBackgroundRequest = capture.model === 'ccem-route:background';
      const hasRouteTag = capture.userMessageTexts.some((text) => text.startsWith(TAG));
      const payload = isBackgroundRequest
        ? sseText('msg_spike_background', 'spike title')
        : hasRouteTag && capture.hasToolResult
          ? sseText('msg_spike_sub_final', 'pong')
          : hasRouteTag && !subagentProbeIssued
            ? (subagentProbeIssued = true, sseToolUse(
                'msg_spike_sub_tool',
                'Bash',
                { command: 'printf spike-multiturn', description: 'Run the spike multi-turn probe' },
                'toolu_spike_sub_1',
              ))
            : !mainToolIssued
              ? (mainToolIssued = true, sseToolUse('msg_spike_1', toolName))
              : sseText('msg_spike_final', 'done');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, captures, port: server.address().port }));
  });
}

function extractUserTexts(body) {
  return (body?.messages ?? [])
    .filter((message) => message.role === 'user')
    .flatMap((message) => {
      if (typeof message.content === 'string') return [message.content.slice(0, 4000)];
      return (message.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text.slice(0, 4000));
    });
}

// ---------- 单次运行 ----------

async function runOnce(toolName) {
  const { server, captures, port } = await startCaptureServer(toolName);
  const hookEvents = [];
  const base = `http://127.0.0.1:${port}`;

  const routeHook = async (input) => {
    hookEvents.push({
      tool_name: input.tool_name,
      tool_input_keys: input.tool_input ? Object.keys(input.tool_input) : [],
      subagent_type: input.tool_input?.subagent_type ?? null,
    });
    const ti = input.tool_input ?? {};
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...ti, prompt: `${TAG}\n${ti.prompt ?? ''}` },
      },
    };
  };

  const timeout = setTimeout(() => {
    console.error('TIMEOUT: session exceeded 120s');
    server.close();
    process.exit(2);
  }, 120_000);

  const authMode = process.env.SPIKE_AUTH_MODE === 'none' ? 'none' : 'dummy';
  const queryEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_MODEL: 'spike-model',
    ANTHROPIC_SMALL_FAST_MODEL: 'ccem-route:background',
  };
  if (authMode === 'dummy') {
    queryEnv.ANTHROPIC_AUTH_TOKEN = 'spike-dummy';
  } else {
    delete queryEnv.ANTHROPIC_AUTH_TOKEN;
    delete queryEnv.ANTHROPIC_API_KEY;
    delete queryEnv.CLAUDE_CODE_OAUTH_TOKEN;
  }

  let sessionError = null;
  try {
    const q = query({
      prompt: 'This is an automated spike. Follow instructions from the harness.',
      options: {
        cwd: process.cwd(),
        permissionMode: 'bypassPermissions',
        settingSources: [],
        env: queryEnv,
        hooks: {
          PreToolUse: [
            // 既有 plan guard 的占位样例:验证多 matcher 合并后两者都存活
            { hooks: [async () => ({ continue: true })] },
            { matcher: toolName, hooks: [routeHook] },
          ],
        },
      },
    });
    for await (const _msg of q) { /* drain */ }
  } catch (err) {
    sessionError = String(err?.message ?? err);
  } finally {
    clearTimeout(timeout);
    server.close();
  }
  return { authMode, captures, hookEvents, sessionError };
}

// ---------- 断言与报告 ----------

function evaluate(toolName, { authMode, captures, hookEvents, sessionError }) {
  const tagCarrier = captures.find(
    (c) => c.userMessageTexts?.some((text) => text.startsWith(TAG)),
  );
  const multiTurnRetention = captures.filter(
    (c) => c.userMessageTexts?.some((text) => text.startsWith(TAG)),
  ).length;
  return {
    B1_tag_reaches_subagent_request: tagCarrier ? 'PASS' : 'FAIL',
    B1_multi_turn_tag_count: multiTurnRetention,
    B1_multi_turn_tag_retained: multiTurnRetention >= 2 ? 'PASS' : 'FAIL',
    B2_tool_name_candidate: toolName,
    B2_tool_name_observed: hookEvents[0]?.tool_name ?? null,
    B2_hook_events: hookEvents,
    B2_subagent_type_field_seen: hookEvents.some((e) => e.subagent_type === 'Explore') ? 'PASS' : 'FAIL',
    B3_background_alias_in_request: captures.some((c) => c.model === 'ccem-route:background')
      ? 'PASS'
      : 'INCONCLUSIVE (短编排会话可能未触发 side-query,需人工验证)',
    B4_auth_mode: authMode,
    B4_authorization_header: captures.map((c) => c.authorization).includes('present') ? 'present' : 'absent',
    session_error: sessionError,
    captures,
  };
}

async function main() {
  const preferred = process.env.SPIKE_TOOL_NAME;
  const candidates = preferred ? [preferred] : ['Task', 'Agent'];
  let report = null;
  for (const name of candidates) {
    console.log(`\n=== Spike B run with tool name: ${name} ===`);
    const result = await runOnce(name);
    report = { toolName: name, ...evaluate(name, result) };
    const toolSeen = result.hookEvents.length > 0;
    if (toolSeen || preferred) break;
    console.log(`(未观察到 ${name} 工具调用,尝试下一个候选名)`);
  }
  const out = process.env.SPIKE_REPORT ?? './spike-b-report.json';
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\n=== Spike B summary ===');
  for (const [k, v] of Object.entries(report)) {
    if (k !== 'captures' && k !== 'B2_hook_events') console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  console.log(`\n报告已写入 ${out}。把结论回填到设计文档「实施记录」。`);
}

await main();
