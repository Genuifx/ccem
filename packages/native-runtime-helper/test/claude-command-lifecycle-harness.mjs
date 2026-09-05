import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function buildHelperWithWireMock(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-command-lifecycle-'));
  const outfile = path.join(tempDir, 'native-runtime-helper.mjs');
  const scenario = options.scenario ?? 'full';
  const resultDelayMs = options.resultDelayMs ?? 0;
  const terminalDelayMs = options.terminalDelayMs ?? 0;
  const idleDelayMs = options.idleDelayMs ?? 0;
  const usageHangs = options.usageHangs ?? false;
  const terminalState = options.terminalState ?? 'completed';
  const permissionModeDelays = options.permissionModeDelays ?? {};

  await build({
    entryPoints: [options.entryPoint ?? path.join(packageDir, 'src', 'index.ts')],
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
        pluginBuild.onResolve({ filter: /^@anthropic-ai\/sdk$/ }, () => ({
          path: 'anthropic-sdk',
          namespace: 'mock-sdk',
        }));
        pluginBuild.onResolve({ filter: /^@openai\/codex-sdk$/ }, () => ({
          path: 'codex-sdk',
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
            const scenario = ${JSON.stringify(scenario)};
            const resultDelayMs = ${JSON.stringify(resultDelayMs)};
            const terminalDelayMs = ${JSON.stringify(terminalDelayMs)};
            const idleDelayMs = ${JSON.stringify(idleDelayMs)};
            const usageHangs = ${JSON.stringify(usageHangs)};
            const terminalState = ${JSON.stringify(terminalState)};
            const permissionModeDelays = ${JSON.stringify(permissionModeDelays)};
            const permissionCapabilityProbe = ${JSON.stringify(options.permissionCapabilityProbe ?? false)};
            const probe = (value) => { if (permissionCapabilityProbe) process.stdout.write(JSON.stringify({type:'permission_probe',...value})+'\\n'); };
            let queryCount = 0;
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const fullCapabilities = ['msg_lifecycle_v1', 'interrupt_receipt_v1'];
            function initFrame(session_id, capabilities) {
              return { type: 'system', subtype: 'init', capabilities, session_id };
            }
            function resultFrame(userMessage, turn, session_id) {
              return {
                type: 'result',
                subtype: 'success',
                result: 'done ' + turn,
                user_message_uuid: userMessage.uuid,
                usage: {
                  input_tokens: 1,
                  output_tokens: 2,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
                total_cost_usd: 0,
                session_id,
              };
            }
            export async function forkSession() {
              if (scenario === 'slow_fork') {
                await sleep(120);
                return { sessionId: 'forked-session' };
              }
              if (scenario === 'slow_fork_failure') {
                await sleep(120);
                throw new Error('mock slow fork failed');
              }
              throw new Error('forkSession should not be called in this test');
            }
            export function query({ prompt, options }) {
              const thisQuery = ++queryCount;
              probe({stage:'query',query:thisQuery,mode:options.permissionMode,allowBypass:options.allowDangerouslySkipPermissions});
              let closed = false;
              let localTurn = 0;
              let signalInterrupt;
              const interruptSignal = new Promise((resolve) => { signalInterrupt = resolve; });
              return {
                close() {
                  probe({stage:'close',query:thisQuery});
                  closed = true;
                },
                async interrupt() { signalInterrupt(); },
                async setModel() {},
                async setPermissionMode(mode) {
                  probe({stage:'set_mode',query:thisQuery,mode});
                  if (permissionCapabilityProbe && mode === 'bypassPermissions' && !options.allowDangerouslySkipPermissions) {
                    throw new Error('Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions');
                  }
                  const delay = permissionModeDelays[mode] ?? 0;
                  if (delay < 0) throw new Error('mock permission mode failure: ' + mode);
                  if (delay > 0) await sleep(delay);
                },
                async getContextUsage() {
                  if (usageHangs) return new Promise(() => {});
                  return {
                    totalTokens: 100,
                    maxTokens: 200000,
                    rawMaxTokens: null,
                    percentage: 0.05,
                    autoCompactThreshold: null,
                    isAutoCompactEnabled: false,
                    model: 'mock-model',
                    categories: [],
                  };
                },
                async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
                  if (usageHangs) return new Promise(() => {});
                  return {
                    session: {
                      model_usage: {
                        'mock-model': {
                          inputTokens: 1,
                          outputTokens: 2,
                          cacheReadInputTokens: 0,
                          cacheCreationInputTokens: 0,
                          costUSD: null,
                        },
                      },
                    },
                  };
                },
                async *[Symbol.asyncIterator]() {
                  const iterator = prompt[Symbol.asyncIterator]();
                  const session_id = 'mock-session';
                  const preInit = scenario === 'preinit_full' || scenario === 'preinit_legacy';
                  const legacy = scenario === 'legacy' || scenario === 'preinit_legacy';
                  if (!preInit) {
                    if (scenario === 'missing_capabilities') {
                      yield { type: 'system', subtype: 'init', session_id };
                    } else {
                      yield initFrame(session_id, legacy ? [] : fullCapabilities);
                    }
                  }

                  while (!closed) {
                    const next = await iterator.next();
                    if (closed || next.done) break;
                    const userMessage = next.value;
                    localTurn += 1;
                    if (scenario === 'end_before_admission' && thisQuery === 1) {
                      probe({stage:'unaccepted_prompt',query:thisQuery,commandId:userMessage.uuid});
                      break;
                    }
                    if (thisQuery === 2 && localTurn === 1 && ${JSON.stringify(options.replacementAdmissionDelayMs ?? 0)} > 0) {
                      await sleep(${JSON.stringify(options.replacementAdmissionDelayMs ?? 0)});
                    }

                    if (scenario === 'query_failure' && thisQuery === 1) {
                      throw new Error('mock query failed after consuming the prompt');
                    }

                    if (preInit && localTurn === 1) {
                      yield { type: 'command_lifecycle', command_uuid: userMessage.uuid, state: 'queued', session_id };
                      yield { type: 'command_lifecycle', command_uuid: userMessage.uuid, state: 'started', session_id };
                      yield initFrame(session_id, legacy ? [] : fullCapabilities);
                    } else if (!legacy) {
                      yield { type: 'command_lifecycle', command_uuid: userMessage.uuid, state: 'queued', session_id };
                      if (scenario === 'malformed_state') {
                        yield { type: 'command_lifecycle', command_uuid: userMessage.uuid, state: 42, session_id };
                      } else if (scenario === 'unknown') {
                        yield { type: 'command_lifecycle', command_uuid: userMessage.uuid, state: 'mystery_state', session_id };
                      } else {
                        yield { type: 'command_lifecycle', command_uuid: userMessage.uuid, state: 'started', session_id };
                      }
                    }

                    if (scenario === 'reset_before') {
                      yield {
                        type: 'conversation_reset',
                        new_conversation_id: 'conversation-' + localTurn,
                        uuid: 'reset-' + localTurn,
                        session_id,
                      };
                      yield initFrame(session_id, fullCapabilities);
                    }

                    yield { ...userMessage, session_id };
                    yield { type: 'system', subtype: 'session_state_changed', state: 'running', session_id };

                    if (scenario === 'browser_evaluate') {
                      const result = await options.canUseTool('mcp__ccem-browser__evaluate', {script:'1 + 1'}, {toolUseID:'evaluate-'+localTurn});
                      probe({stage:'evaluate',query:thisQuery,turn:localTurn,behavior:result.behavior});
                    }
                    if (scenario === 'permission_wait') {
                      await options.canUseTool('Bash', {command:'echo protected'}, {toolUseID:'permission-tool'});
                    }
                    if (scenario === 'permission_background') {
                      yield {type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'live-bg',description:'live tool'}]};
                    }
                    if (scenario === 'full_interrupt') {
                      await interruptSignal;
                      if (terminalDelayMs > 0) await sleep(terminalDelayMs);
                      yield {
                        type: 'command_lifecycle',
                        command_uuid: userMessage.uuid,
                        state: 'cancelled',
                        session_id,
                      };
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      continue;
                    }

                    if (scenario === 'idle_without_terminal') {
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      await new Promise(() => {});
                    }

                    if (
                      scenario === 'interactive_redelivery'
                      || scenario === 'interactive_wait'
                      || scenario === 'interactive_plan'
                    ) {
                      const isPlan = scenario === 'interactive_plan';
                      const input = isPlan
                        ? { plan: 'Verify the prompt-type fence.' }
                        : {
                            questions: [{
                              question: 'Continue?',
                              header: 'Choice',
                              multiSelect: false,
                              options: [{ label: 'Yes', description: 'Continue.' }],
                            }],
                          };
                      const response = options.canUseTool(isPlan ? 'ExitPlanMode' : 'AskUserQuestion', input, {
                        toolUseID: 'shared-interactive-tool',
                      });
                      if (scenario === 'interactive_redelivery' && thisQuery === 1) {
                        void response;
                        yield {
                          type: 'command_lifecycle',
                          command_uuid: userMessage.uuid,
                          state: 'completed',
                          session_id,
                        };
                        return;
                      }
                      await response;
                      yield resultFrame(userMessage, localTurn, session_id);
                      yield {
                        type: 'command_lifecycle',
                        command_uuid: userMessage.uuid,
                        state: 'completed',
                        session_id,
                      };
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      continue;
                    }

                    if (scenario === 'terminal_only') {
                      yield {
                        type: 'command_lifecycle',
                        command_uuid: userMessage.uuid,
                        state: terminalState,
                        session_id,
                      };
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      continue;
                    }

                    if (scenario === 'mismatched_terminal') {
                      yield {
                        type: 'command_lifecycle',
                        command_uuid: 'another-command',
                        state: 'completed',
                        session_id,
                      };
                      if (terminalDelayMs > 0) await sleep(terminalDelayMs);
                      yield {
                        type: 'command_lifecycle',
                        command_uuid: userMessage.uuid,
                        state: 'completed',
                        session_id,
                      };
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      continue;
                    }

                    if (scenario === 'terminal_before_result') {
                      yield {
                        type: 'command_lifecycle',
                        command_uuid: userMessage.uuid,
                        state: 'completed',
                        session_id,
                      };
                      if (terminalDelayMs > 0) await sleep(terminalDelayMs);
                      yield resultFrame(userMessage, localTurn, session_id);
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      continue;
                    }

                    if (resultDelayMs > 0) await sleep(resultDelayMs);
                    yield resultFrame(userMessage, localTurn, session_id);

                    if (scenario === 'missing_terminal') {
                      await new Promise(() => {});
                    }
                    if (terminalDelayMs > 0) await sleep(terminalDelayMs);

                    if (legacy) {
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      continue;
                    }

                    yield {
                      type: 'command_lifecycle',
                      command_uuid: userMessage.uuid,
                      state: terminalState,
                      session_id,
                    };
                    if (idleDelayMs > 0) await sleep(idleDelayMs);
                    if (scenario === 'reset_after') {
                      yield {
                        type: 'conversation_reset',
                        new_conversation_id: 'conversation-after-' + localTurn,
                        uuid: 'reset-after-' + localTurn,
                        session_id,
                      };
                    }
                    yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                  }
                  if (thisQuery === 1 && ${JSON.stringify(options.closedLoopDelayMs ?? 0)} > 0) {
                    await sleep(${JSON.stringify(options.closedLoopDelayMs ?? 0)});
                    probe({stage:'loop_end',query:thisQuery});
                    if (${JSON.stringify(options.closedLoopError ?? null)}) {
                      const error = new Error('mock retired query failure');
                      error.name = ${JSON.stringify(options.closedLoopError ?? 'Error')};
                      throw error;
                    }
                  }
                },
              };
            }
          `,
        }));
        pluginBuild.onLoad({ filter: /^anthropic-sdk$/, namespace: 'mock-sdk' }, () => ({
          loader: 'js',
          contents: 'const Anthropic = {}; export default Anthropic; export { Anthropic };',
        }));
        pluginBuild.onLoad({ filter: /^codex-sdk$/, namespace: 'mock-sdk' }, () => ({
          loader: 'js',
          contents: 'const Codex = {}; export default Codex; export { Codex };',
        }));
      },
    }],
  });
  return { outfile, tempDir };
}

function spawnTrackedHelper(t, built, env = {}) {
  const helper = spawn(process.execPath, [built.outfile], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '60000',
      CCEM_NATIVE_USAGE_DEADLINE_MS: '300',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    helper.kill('SIGTERM');
    await fs.rm(built.tempDir, { recursive: true, force: true });
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';
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

  return { helper, outputs, stderrRef };
}

function send(session, command) {
  session.helper.stdin.write(`${JSON.stringify(command)}\n`);
}

function waitForOutput(session, predicate, description, timeoutMs = 2_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const match = session.outputs.find(predicate);
      if (match) {
        resolve(match);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error([
          `Timed out waiting for ${description}.`,
          `stdout=${JSON.stringify(session.outputs)}`,
          `stderr=${session.stderrRef.value}`,
        ].join('\n')));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLifecycle(output, stage, commandId, detail) {
  return output.type === 'event'
    && output.payload?.type === 'lifecycle'
    && output.payload.stage === stage
    && (commandId === undefined || output.payload.command_id === commandId)
    && (detail === undefined || output.payload.detail === detail);
}

function lifecycleCount(session, stage, commandId) {
  return session.outputs.filter((output) => isLifecycle(output, stage, commandId)).length;
}

function readyCount(session) {
  return session.outputs.filter((output) => output.type === 'status' && output.status === 'ready').length;
}

async function startHelper(t, options = {}, initOverrides = {}, env = {}) {
  const built = await buildHelperWithWireMock(options);
  const session = spawnTrackedHelper(t, built, env);
  send(session, {
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    ...initOverrides,
  });
  await waitForOutput(
    session,
    (output) => output.type === 'status' && output.status === 'ready',
    'initial ready',
  );
  return session;
}

export {
  buildHelperWithWireMock,
  spawnTrackedHelper,
  send,
  waitForOutput,
  sleep,
  isLifecycle,
  lifecycleCount,
  readyCount,
  startHelper,
};
