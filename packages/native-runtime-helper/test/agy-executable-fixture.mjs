import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Creates an executable fake `agy` CLI binary that speaks ACP JSON-RPC 2.0 over stdio.
 * Behavior is controlled via environment variables (`AGY_FIXTURE_LOG`, `AGY_FIXTURE_SCENARIO`,
 * `AGY_FIXTURE_VERSION`, etc.) so deterministic tests can exercise the compiled
 * `dist/native-runtime-helper.mjs` bundle end-to-end.
 */
export async function createAgyExecutableFixture(directory) {
  const scriptPath = path.join(directory, 'fake-agy.mjs');
  const source = `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';

const logFile = process.env.AGY_FIXTURE_LOG;
const scenario = process.env.AGY_FIXTURE_SCENARIO || 'default';
const agentVersion = process.env.AGY_FIXTURE_VERSION || '1.5.13';

function record(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...entry }) + '\\n');
}

record({
  event: 'spawn',
  argv: process.argv.slice(2),
  env: {
    HOME: process.env.HOME ?? null,
    HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? null,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? null,
    CODEX_HOME: process.env.CODEX_HOME ?? null,
    CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME ?? null,
    CCEM_CODEX_ISOLATED: process.env.CCEM_CODEX_ISOLATED ?? null,
  },
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

let nextServerReqId = 9000;
const pendingServerRequests = new Map();
let activePromptId = null;
let activeSessionId = null;
let promptCount = 0;

function sendServerRequest(method, params) {
  const id = nextServerReqId++;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  record({ event: 'recv', msg });

  // Response to server->client request (e.g. session/request_permission)
  if (msg.id !== undefined && !msg.method && ('result' in msg || 'error' in msg)) {
    const resolve = pendingServerRequests.get(msg.id);
    if (resolve) {
      pendingServerRequests.delete(msg.id);
      resolve(msg);
    }
    return;
  }

  if (msg.method === 'initialize') {
    if (scenario === 'stdout_noise') {
      process.stdout.write('Loaded cached credentials.\\n');
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server', version: agentVersion },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
        },
        authMethods: [
          { id: 'oauth-personal', name: 'Log in with Google' },
          ...(msg.params?.clientCapabilities?.auth?.terminal
            ? [{ id: 'terminal-login', type: 'terminal', args: ['--login'] }]
            : []),
        ],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    if (scenario === 'auth_required') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'Authentication required' },
      });
      return;
    }
    activeSessionId = 'agy-sess-1';
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: activeSessionId,
        configOptions: [
          {
            configId: 'mode',
            category: 'mode',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'accept-edits', name: 'Accept Edits' },
              { value: 'plan', name: 'Plan' },
              { value: 'auto', name: 'Auto' },
            ],
          },
          {
            configId: 'model',
            category: 'model',
            currentValue: 'gemini-3-pro',
            options: [{ value: 'gemini-3-pro', name: 'Gemini 3 Pro' }],
          },
          {
            configId: 'thought_level',
            category: 'thought_level',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
    });
    return;
  }

  if (msg.method === 'session/resume') {
    if (scenario === 'resume_fallback_to_load') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found: session/resume' },
      });
      return;
    }
    activeSessionId = msg.params.sessionId;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId: activeSessionId, configOptions: [] },
    });
    return;
  }

  if (msg.method === 'session/load') {
    activeSessionId = msg.params.sessionId;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId: activeSessionId, configOptions: [] },
    });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    if (scenario === 'unsupported_config' && msg.params.configId === 'thought_level') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: 'Unsupported config option: thought_level' },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        configOptions: [
          { configId: msg.params.configId, currentValue: msg.params.value },
        ],
      },
    });
    return;
  }

  if (msg.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/cancel') {
    if (activePromptId !== null) {
      const promptId = activePromptId;
      activePromptId = null;
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
    }
    return;
  }

  if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/prompt') {
    promptCount += 1;
    activePromptId = msg.id;

    if (scenario === 'permission_flow' || scenario === 'interrupt_permission') {
      const permResp = await sendServerRequest('session/request_permission', {
        sessionId: activeSessionId,
        toolCall: {
          toolCallId: 'tool-perm-' + promptCount,
          title: 'run_command',
          kind: 'execute',
          rawInput: { command: 'rm -rf build' },
        },
        options: [
          { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'opt-allow-always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'opt-reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      record({ event: 'permission_result', response: permResp });
      if (activePromptId !== msg.id) {
        return;
      }
      const outcome = permResp.result?.outcome;
      if (outcome?.outcome === 'cancelled') {
        activePromptId = null;
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'cancelled' } });
        return;
      }
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Permission outcome: ' + outcome?.optionId },
          },
        },
      });
      activePromptId = null;
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }

    if (scenario === 'interrupt_then_continue' && promptCount === 1) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Working...' },
          },
        },
      });
      // Request permission and wait until cancelled via session/cancel
      const permResp = await sendServerRequest('session/request_permission', {
        sessionId: activeSessionId,
        toolCall: {
          toolCallId: 'tool-interrupt-1',
          title: 'run_command',
          kind: 'execute',
          rawInput: { command: 'sleep 60' },
        },
        options: [
          { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'opt-reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      record({ event: 'permission_result', response: permResp });
      return;
    }

    if (scenario === 'multi_step_metrics') {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      // Initial zero context snapshot right after prompt starts (mirrors real agy acp)
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: { sessionUpdate: 'usage_update', used: 0, size: 1000000 },
        },
      });
      // Step 1 TTFT
      await wait(110);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Planning step 1' },
          },
        },
      });
      await wait(45);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: { sessionUpdate: 'usage_update', used: 9337, size: 1000000 },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-metrics-1',
            title: 'run_command',
            kind: 'execute',
            rawInput: { command: 'sleep 0.2' },
          },
        },
      });
      // Tool execution delay (must be excluded from generation_ms)
      await wait(240);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-metrics-1',
            status: 'completed',
            content: [{ type: 'text', text: 'ok' }],
          },
        },
      });
      // Step 2 TTFT (must also be excluded from generation_ms)
      await wait(120);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Final answer part 1. ' },
          },
        },
      });
      await wait(60);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Final answer part 2.' },
          },
        },
      });
      await wait(15);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: activeSessionId,
          update: { sessionUpdate: 'usage_update', used: 24500, size: 1000000 },
        },
      });
      activePromptId = null;
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 12000,
            outputTokens: 450,
            cachedReadTokens: 8000,
            cachedWriteTokens: 0,
            totalTokens: 20450,
          },
        },
      });
      return;
    }

    // Default rich streaming turn
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Analyzing the repository...' },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [
            { id: 'step-1', content: 'Inspect files', status: 'completed' },
            { id: 'step-2', content: 'Implement fix', status: 'in_progress' },
          ],
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'read_file',
          kind: 'read',
          rawInput: { path: 'README.md' },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'in_progress',
          title: 'Reading README.md',
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          content: [{ type: 'text', text: '# CCEM' }],
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello from Antigravity turn ' + promptCount },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: activeSessionId,
        update: {
          sessionUpdate: 'usage_update',
          inputTokens: 120,
          outputTokens: 45,
          cachedReadTokens: 30,
          cost: { amount: 0.0025 },
        },
      },
    });
    activePromptId = null;
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }

  send({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: 'Unknown method: ' + msg.method },
  });
});

rl.on('close', () => {
  record({ event: 'eof_exit' });
  process.exit(0);
});
`;

  await fs.writeFile(scriptPath, source, { mode: 0o755 });
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}
