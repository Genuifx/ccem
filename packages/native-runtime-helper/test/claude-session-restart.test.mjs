import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function buildHelperWithMockClaudeSdk(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-claude-restart-test-'));
  const outfile = path.join(tempDir, 'native-runtime-helper.mjs');
  const firstResultSubtype = options.firstResultSubtype ?? 'success';
  const delayMsBeforeResult = options.delayMsBeforeResult ?? 0;
  const settleDelayMsAfterResult = options.settleDelayMsAfterResult ?? 0;
  const yieldIdleBeforeResult = options.yieldIdleBeforeResult ?? false;
  const interruptible = options.interruptible ?? false;
  const interruptHangs = options.interruptHangs ?? false;
  const interruptRejects = options.interruptRejects ?? false;
  const interruptDelayMs = options.interruptDelayMs ?? 0;
  const logClose = options.logClose ?? false;
  const logCloseWithTurn = options.logCloseWithTurn ?? false;
  const logInterrupt = options.logInterrupt ?? false;
  const expectedQueryModel = options.expectedQueryModel ?? null;
  const reportModelState = options.reportModelState ?? false;
  const keepAliveAfterResult = options.keepAliveAfterResult ?? false;
  const yieldIdleAfterResult = options.yieldIdleAfterResult ?? keepAliveAfterResult;
  const endFirstTurnWithoutResult = options.endFirstTurnWithoutResult ?? false;
  const assertHumanPromptOrigin = options.assertHumanPromptOrigin ?? false;
  const permissionOwnershipScenario = options.permissionOwnershipScenario ?? false;
  const yieldLateResultAfterClose = options.yieldLateResultAfterClose ?? false;
  const peerStartsAfterIdleMs = options.peerStartsAfterIdleMs ?? 0;
  const launchBackgroundTaskBeforeInterrupt = options.launchBackgroundTaskBeforeInterrupt ?? false;

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

            const firstResultSubtype = ${JSON.stringify(firstResultSubtype)};
            const delayMsBeforeResult = ${JSON.stringify(delayMsBeforeResult)};
            const settleDelayMsAfterResult = ${JSON.stringify(settleDelayMsAfterResult)};
            const yieldIdleBeforeResult = ${JSON.stringify(yieldIdleBeforeResult)};
            const interruptible = ${JSON.stringify(interruptible)};
            const interruptHangs = ${JSON.stringify(interruptHangs)};
            const interruptRejects = ${JSON.stringify(interruptRejects)};
            const interruptDelayMs = ${JSON.stringify(interruptDelayMs)};
            const logClose = ${JSON.stringify(logClose)};
            const logCloseWithTurn = ${JSON.stringify(logCloseWithTurn)};
            const logInterrupt = ${JSON.stringify(logInterrupt)};
            const expectedQueryModel = ${JSON.stringify(expectedQueryModel)};
            const reportModelState = ${JSON.stringify(reportModelState)};
            const keepAliveAfterResult = ${JSON.stringify(keepAliveAfterResult)};
            const yieldIdleAfterResult = ${JSON.stringify(yieldIdleAfterResult)};
            const endFirstTurnWithoutResult = ${JSON.stringify(endFirstTurnWithoutResult)};
            const assertHumanPromptOrigin = ${JSON.stringify(assertHumanPromptOrigin)};
            const permissionOwnershipScenario = ${JSON.stringify(permissionOwnershipScenario)};
            const yieldLateResultAfterClose = ${JSON.stringify(yieldLateResultAfterClose)};
            const peerStartsAfterIdleMs = ${JSON.stringify(peerStartsAfterIdleMs)};
            const launchBackgroundTaskBeforeInterrupt = ${JSON.stringify(launchBackgroundTaskBeforeInterrupt)};
            let queryCount = 0;
            let setModelCalled = false;
            export async function forkSession() {
              throw new Error('forkSession should not be called in this test');
            }

            export function query({ prompt, options }) {
              if (expectedQueryModel !== null && options.model !== expectedQueryModel) {
                throw new Error('expected query model ' + expectedQueryModel + ', got ' + options.model);
              }
              const turn = ++queryCount;
              let closed = false;
              let interruptResolver = null;
              let interruptRequested = false;
              const waitForInterrupt = () => interruptRequested
                ? Promise.resolve()
                : new Promise((resolve) => {
                    interruptResolver = resolve;
                  });
              return {
                close() {
                  closed = true;
                  if (logClose) {
                    process.stderr.write('__MOCK_CLAUDE_CLOSE__\\n');
                  }
                  if (logCloseWithTurn) {
                    process.stderr.write('__MOCK_CLAUDE_CLOSE_TURN_' + turn + '__\\n');
                  }
                  interruptResolver?.();
                },
                async interrupt() {
                  if (logInterrupt) {
                    process.stderr.write('__MOCK_CLAUDE_INTERRUPT__\\n');
                  }
                  if (interruptHangs) {
                    return new Promise(() => {});
                  }
                  if (interruptRejects) {
                    throw new Error('mock interrupt rejected');
                  }
                  if (interruptDelayMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, interruptDelayMs));
                  }
                  interruptRequested = true;
                  interruptResolver?.();
                },
                async setModel() {
                  setModelCalled = true;
                },
                async *[Symbol.asyncIterator]() {
                  const iterator = prompt[Symbol.asyncIterator]();
                  const session_id = 'mock-session';
                  let localTurn = 0;
                  while (!closed) {
                    const next = await iterator.next();
                    if (closed || next.done) return;
                    if (assertHumanPromptOrigin && next.value?.origin?.kind !== 'human') {
                      throw new Error('expected SDK prompt origin.kind to be human');
                    }
                    yield {
                      ...next.value,
                      session_id,
                    };
                    localTurn += 1;
                    const responseNumber = (interruptible && !interruptHangs) || keepAliveAfterResult ? localTurn : turn;
                    const text = reportModelState
                      ? 'model=' + (options.model ?? '<none>') + ';setModel=' + setModelCalled
                      : 'mock response ' + responseNumber;
                    yield { type: 'system', subtype: 'session_state_changed', state: 'running', session_id };
                    if (launchBackgroundTaskBeforeInterrupt && localTurn === 1) {
                      yield {
                        type: 'assistant',
                        session_id,
                        message: {
                          content: [{
                            type: 'tool_use',
                            id: 'tool-background-during-interrupt',
                            name: 'Bash',
                            input: { command: 'sleep 30', run_in_background: true },
                          }],
                        },
                      };
                      yield {
                        type: 'system',
                        subtype: 'task_started',
                        task_id: 'task-background-during-interrupt',
                        tool_use_id: 'tool-background-during-interrupt',
                        task_type: 'bash',
                        description: 'Background task surviving foreground interrupt failure',
                        session_id,
                      };
                      yield {
                        type: 'system',
                        subtype: 'background_tasks_changed',
                        tasks: [{
                          task_id: 'task-background-during-interrupt',
                          tool_use_id: 'tool-background-during-interrupt',
                          task_type: 'bash',
                          description: 'Background task surviving foreground interrupt failure',
                        }],
                        session_id,
                      };
                    }
                    if (permissionOwnershipScenario && localTurn === 1) {
                      yield {
                        type: 'assistant',
                        session_id,
                        message: {
                          content: [
                            {
                              type: 'tool_use',
                              id: 'tool-background-agent',
                              name: 'Agent',
                              input: {
                                description: 'Background permission owner',
                                run_in_background: true,
                              },
                            },
                            {
                              type: 'tool_use',
                              id: 'tool-background-agent-two',
                              name: 'Agent',
                              input: {
                                description: 'Second background permission owner',
                                run_in_background: true,
                              },
                            },
                            {
                              type: 'tool_use',
                              id: 'tool-background-workflow',
                              name: 'Workflow',
                              input: {
                                description: 'Background workflow permission owner',
                                run_in_background: true,
                              },
                            },
                            {
                              type: 'tool_use',
                              id: 'ask-background-agent',
                              name: 'AskUserQuestion',
                              input: { questions: [{ question: 'Background?', header: 'BG', options: [] }] },
                            },
                            {
                              type: 'tool_use',
                              id: 'ask-foreground-agent',
                              name: 'AskUserQuestion',
                              input: { questions: [{ question: 'Foreground?', header: 'FG', options: [] }] },
                            },
                          ],
                        },
                      };
                      yield {
                        type: 'system',
                        subtype: 'task_started',
                        task_id: 'background-agent',
                        tool_use_id: 'tool-background-agent',
                        task_type: 'agent',
                        description: 'Background permission owner',
                        session_id,
                      };
                      yield {
                        type: 'system',
                        subtype: 'task_started',
                        task_id: 'background-workflow',
                        tool_use_id: 'tool-background-workflow',
                        task_type: 'local_workflow',
                        description: 'Background workflow permission owner',
                        session_id,
                      };
                      yield {
                        type: 'system',
                        subtype: 'task_started',
                        task_id: 'background-agent-two',
                        tool_use_id: 'tool-background-agent-two',
                        task_type: 'agent',
                        description: 'Second background permission owner',
                        session_id,
                      };
                      yield {
                        type: 'system',
                        subtype: 'background_tasks_changed',
                        tasks: [
                          {
                            task_id: 'background-agent',
                            task_type: 'agent',
                            description: 'Background permission owner',
                          },
                          {
                            task_id: 'background-agent-two',
                            task_type: 'agent',
                            description: 'Second background permission owner',
                          },
                          {
                            task_id: 'background-workflow',
                            task_type: 'local_workflow',
                            description: 'Background workflow permission owner',
                          },
                        ],
                        session_id,
                      };
                      yield {
                        type: 'assistant',
                        parent_tool_use_id: 'tool-background-workflow',
                        session_id,
                        message: {
                          content: [{
                            type: 'tool_use',
                            id: 'permission-background-workflow',
                            name: 'Bash',
                            input: { command: 'echo workflow child' },
                          }],
                        },
                      };
                      const backgroundPermission = options.canUseTool(
                        'Bash',
                        { command: 'echo background' },
                        {
                          toolUseID: 'permission-background-agent',
                          requestId: 'request-background-agent',
                          agentID: 'background-agent',
                        },
                      );
                      const foregroundPermission = options.canUseTool(
                        'Bash',
                        { command: 'echo foreground' },
                        {
                          toolUseID: 'permission-foreground-agent',
                          requestId: 'request-foreground-agent',
                          agentID: 'foreground-agent',
                        },
                      );
                      const secondBackgroundPermission = options.canUseTool(
                        'Bash',
                        { command: 'echo background two' },
                        {
                          toolUseID: 'permission-background-agent-two',
                          requestId: 'request-background-agent-two',
                          agentID: 'background-agent-two',
                        },
                      );
                      const workflowBackgroundPermission = options.canUseTool(
                        'Bash',
                        { command: 'echo workflow child' },
                        {
                          toolUseID: 'permission-background-workflow',
                          requestId: 'request-background-workflow',
                          agentID: 'workflow-agent-7',
                        },
                      );
                      const backgroundQuestion = options.canUseTool(
                        'AskUserQuestion',
                        { questions: [{ question: 'Background?', header: 'BG', options: [] }] },
                        { toolUseID: 'ask-background-agent', agentID: 'background-agent' },
                      );
                      const foregroundQuestion = options.canUseTool(
                        'AskUserQuestion',
                        { questions: [{ question: 'Foreground?', header: 'FG', options: [] }] },
                        { toolUseID: 'ask-foreground-agent', agentID: 'foreground-agent' },
                      );
                      await Promise.all([foregroundPermission, foregroundQuestion]);
                      await waitForInterrupt();
                      void backgroundPermission;
                      void secondBackgroundPermission;
                      void workflowBackgroundPermission;
                      void backgroundQuestion;
                      if (closed) return;
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      yield {
                        type: 'result',
                        subtype: 'error_during_execution',
                        errors: ['interrupted'],
                        user_message_uuid: next.value.uuid,
                        session_id,
                      };
                      continue;
                    }
                    yield {
                      type: 'assistant',
                      session_id,
                      message: { content: [{ type: 'text', text }] },
                    };
                    if (permissionOwnershipScenario && localTurn === 2) {
                      yield {
                        type: 'system',
                        subtype: 'task_notification',
                        task_id: 'background-agent',
                        tool_use_id: 'tool-background-agent',
                        status: 'stopped',
                        output_file: '/tmp/background-agent.output',
                        summary: 'First background task stopped',
                        session_id,
                      };
                      yield {
                        type: 'system',
                        subtype: 'task_notification',
                        task_id: 'background-workflow',
                        tool_use_id: 'tool-background-workflow',
                        status: 'stopped',
                        output_file: '/tmp/background-workflow.output',
                        summary: 'Background workflow stopped',
                        session_id,
                      };
                      yield {
                        type: 'system',
                        subtype: 'background_tasks_changed',
                        tasks: [{
                          task_id: 'background-agent-two',
                          task_type: 'agent',
                          description: 'Second background permission owner',
                        }],
                        session_id,
                      };
                    }
                    if (delayMsBeforeResult > 0) {
                      await new Promise((resolve) => setTimeout(resolve, delayMsBeforeResult));
                    }
                    if (interruptible && localTurn === 1) {
                      await waitForInterrupt();
                      if (closed) {
                        if (yieldLateResultAfterClose) {
                          await new Promise((resolve) => setTimeout(resolve, 100));
                          yield {
                            type: 'result',
                            subtype: 'error_during_execution',
                            errors: ['late result from closed query'],
                            origin: { kind: 'human' },
                            session_id,
                          };
                        }
                        return;
                      }
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      yield { type: 'result', subtype: 'error_during_execution', errors: ['interrupted'], session_id };
                      continue;
                    }
                    if (yieldIdleBeforeResult) {
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                    }
                    if (endFirstTurnWithoutResult && turn === 1 && localTurn === 1) {
                      return;
                    }
                    if (!interruptible && turn === 1 && firstResultSubtype !== 'success') {
                      yield { type: 'result', subtype: firstResultSubtype, errors: ['hit turn limit'], session_id };
                    } else {
                      yield { type: 'result', subtype: 'success', result: 'done ' + responseNumber, session_id };
                    }
                    if (settleDelayMsAfterResult > 0) {
                      await new Promise((resolve) => setTimeout(resolve, settleDelayMsAfterResult));
                    }
                    if (yieldIdleAfterResult && !yieldIdleBeforeResult && !interruptible) {
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                    }
                    if (peerStartsAfterIdleMs > 0 && localTurn === 1) {
                      await new Promise((resolve) => setTimeout(resolve, peerStartsAfterIdleMs));
                      yield {
                        type: 'user',
                        origin: { kind: 'peer', from: 'peer-session' },
                        session_id,
                        message: { content: [{ type: 'text', text: 'peer turn after prepare' }] },
                      };
                      yield {
                        type: 'system',
                        subtype: 'session_state_changed',
                        state: 'running',
                        session_id,
                      };
                    }
                    if (!interruptible && !keepAliveAfterResult) return;
                  }
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

async function buildHelperWithBackgroundRaceMock(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-helper-background-race-test-'));
  const outfile = path.join(tempDir, 'native-runtime-helper.mjs');
  const foregroundNotificationOnly = options.foregroundNotificationOnly ?? false;
  const peerIngressOnly = options.peerIngressOnly ?? false;
  const notificationStreamWaitsForQueuedHumanPrompt = options.notificationStreamWaitsForQueuedHumanPrompt ?? false;
  const foregroundPlanAfterTaskNotification = options.foregroundPlanAfterTaskNotification ?? false;

  await build({
    entryPoints: [path.join(packageDir, 'src', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
    plugins: [{
      name: 'mock-background-race-sdk',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
          path: 'claude-agent-sdk',
          namespace: 'mock-sdk',
        }));
        pluginBuild.onLoad({ filter: /^claude-agent-sdk$/, namespace: 'mock-sdk' }, () => ({
          loader: 'js',
          contents: `
            const foregroundNotificationOnly = ${JSON.stringify(foregroundNotificationOnly)};
            const peerIngressOnly = ${JSON.stringify(peerIngressOnly)};
            const notificationStreamWaitsForQueuedHumanPrompt = ${JSON.stringify(notificationStreamWaitsForQueuedHumanPrompt)};
            const foregroundPlanAfterTaskNotification = ${JSON.stringify(foregroundPlanAfterTaskNotification)};
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
            export async function forkSession() {
              throw new Error('forkSession should not be called in this test');
            }

            export function query({ prompt, options: queryOptions }) {
              let closed = false;
              return {
                close() { closed = true; },
                async interrupt() {},
                async stopTask() {},
                async *[Symbol.asyncIterator]() {
                  const iterator = prompt[Symbol.asyncIterator]();
                  const session_id = 'background-race-session';
                  let turn = 0;
                  while (!closed) {
                    const next = await iterator.next();
                    if (closed || next.done) return;
                    turn += 1;
                    const promptUuid = next.value.uuid;
                    yield { ...next.value, session_id };
                    yield { type: 'system', subtype: 'session_state_changed', state: 'running', session_id };

                    if (foregroundPlanAfterTaskNotification && turn === 1) {
                      const input = {
                        questions: [{
                          question: 'Which runtime strategy?',
                          header: 'Runtime',
                          multiSelect: false,
                          options: [{
                            label: 'Managed',
                            description: 'Let CCEM manage the runtime.',
                          }],
                        }],
                      };
                      yield {
                        type: 'user',
                        origin: { kind: 'task-notification' },
                        uuid: 'queued-task-notification-during-plan',
                        shouldQuery: true,
                        session_id,
                        message: {
                          content: '<task-notification>\\n<task-id>research-agent</task-id>\\n<status>completed</status>\\n</task-notification>',
                        },
                      };

                      const firstPrompt = queryOptions.canUseTool(
                        'AskUserQuestion',
                        input,
                        { toolUseID: 'ask-after-task-notification' },
                      );
                      const redeliveredPrompt = queryOptions.canUseTool(
                        'AskUserQuestion',
                        input,
                        { toolUseID: 'ask-after-task-notification' },
                      );

                      yield {
                        type: 'assistant',
                        parent_tool_use_id: null,
                        session_id,
                        message: {
                          content: [{
                            type: 'text',
                            text: 'Foreground plan survives the task notification',
                          }, {
                            type: 'tool_use',
                            id: 'ask-after-task-notification',
                            name: 'AskUserQuestion',
                            input,
                          }],
                        },
                      };

                      const [firstResult, redeliveredResult] = await Promise.all([
                        firstPrompt,
                        redeliveredPrompt,
                      ]);
                      process.stderr.write(
                        'INTERACTIVE_RESULTS '
                        + firstResult.behavior
                        + ' '
                        + redeliveredResult.behavior
                        + '\\n',
                      );
                      yield {
                        type: 'user',
                        session_id,
                        message: {
                          content: [{
                            type: 'tool_result',
                            tool_use_id: 'ask-after-task-notification',
                            content: 'User answered the runtime question.',
                          }],
                        },
                      };
                      yield {
                        type: 'assistant',
                        parent_tool_use_id: null,
                        session_id,
                        message: {
                          content: [{
                            type: 'text',
                            text: 'Foreground plan continues after the answer',
                          }],
                        },
                      };
                      const planInput = {
                        plan: 'Use the managed runtime strategy.',
                        allowedPrompts: ['Implement the approved plan.'],
                      };
                      const planExit = queryOptions.canUseTool(
                        'ExitPlanMode',
                        planInput,
                        { toolUseID: 'exit-after-task-notification' },
                      );
                      const planExitResult = await planExit;
                      process.stderr.write(
                        'PLAN_EXIT_RESULT ' + planExitResult.behavior + '\\n',
                      );
                      yield {
                        type: 'assistant',
                        parent_tool_use_id: null,
                        session_id,
                        message: {
                          content: [{
                            type: 'text',
                            text: 'Foreground plan is ready for review',
                          }, {
                            type: 'tool_use',
                            id: 'exit-after-task-notification',
                            name: 'ExitPlanMode',
                            input: planInput,
                          }],
                        },
                      };
                      yield {
                        type: 'user',
                        session_id,
                        message: {
                          content: [{
                            type: 'tool_result',
                            tool_use_id: 'exit-after-task-notification',
                            content: 'User approved the plan.',
                          }],
                        },
                      };
                      yield {
                        type: 'result',
                        subtype: 'success',
                        result: 'plan question answered',
                        origin: { kind: 'human' },
                        user_message_uuid: promptUuid,
                        session_id,
                      };
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      continue;
                    }

                    if (foregroundPlanAfterTaskNotification) {
                      yield {
                        type: 'assistant',
                        parent_tool_use_id: null,
                        session_id,
                        message: {
                          content: [{
                            type: 'text',
                            text: 'Next foreground turn remains visible',
                          }],
                        },
                      };
                      yield {
                        type: 'result',
                        subtype: 'success',
                        result: 'next foreground turn completed',
                        session_id,
                      };
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      continue;
                    }

                    if (peerIngressOnly) {
                      yield {
                        type: 'user',
                        origin: { kind: 'peer', from: 'peer-session' },
                        session_id,
                        message: { content: [{ type: 'text', text: 'peer request' }] },
                      };
                      yield {
                        type: 'user',
                        origin: { kind: 'human' },
                        uuid: 'stale-human-echo',
                        session_id,
                        message: { content: [{ type: 'text', text: 'stale human prompt' }] },
                      };
                      yield {
                        type: 'assistant',
                        parent_tool_use_id: null,
                        session_id,
                        message: {
                          id: 'peer-assistant-message',
                          usage: { input_tokens: 91, output_tokens: 17 },
                          content: [{ type: 'text', text: 'Peer assistant must stay hidden' }],
                        },
                      };
                      yield {
                        type: 'stream_event',
                        parent_tool_use_id: null,
                        session_id,
                        event: {
                          type: 'content_block_delta',
                          delta: { type: 'text_delta', text: 'Peer stream must stay hidden' },
                        },
                      };
                      yield {
                        type: 'result',
                        subtype: 'success',
                        result: 'peer result',
                        origin: { kind: 'peer', from: 'peer-session' },
                        session_id,
                      };
                      yield {
                        type: 'assistant',
                        parent_tool_use_id: null,
                        session_id,
                        message: { content: [{ type: 'text', text: 'Human assistant remains visible' }] },
                      };
                      yield {
                        type: 'stream_event',
                        parent_tool_use_id: null,
                        session_id,
                        event: {
                          type: 'content_block_delta',
                          delta: { type: 'text_delta', text: 'Human stream remains visible' },
                        },
                      };
                      yield {
                        type: 'result',
                        subtype: 'success',
                        result: '',
                        origin: { kind: 'human' },
                        user_message_uuid: promptUuid,
                        session_id,
                      };
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      continue;
                    }

                    if (foregroundNotificationOnly) {
                      yield {
                        type: 'assistant',
                        session_id,
                        message: {
                          content: [{
                            type: 'tool_use',
                            id: 'tool-fg-1',
                            name: 'Bash',
                            input: { command: 'echo foreground', run_in_background: false },
                          }],
                        },
                      };
                      yield {
                        type: 'system',
                        subtype: 'task_started',
                        task_id: 'task-fg-1',
                        tool_use_id: 'tool-fg-1',
                        task_type: 'bash',
                        description: 'Foreground Bash',
                        session_id,
                      };
                      yield {
                        type: 'system',
                        subtype: 'task_notification',
                        task_id: 'task-fg-1',
                        tool_use_id: 'tool-fg-1',
                        status: 'completed',
                        output_file: '/tmp/task-fg-1.output',
                        summary: 'Foreground Bash finished',
                        session_id,
                      };
                      yield {
                        type: 'user',
                        session_id,
                        message: {
                          content: [{
                            type: 'tool_result',
                            tool_use_id: 'tool-fg-1',
                            content: 'foreground result',
                          }],
                        },
                      };
                      yield {
                        type: 'result',
                        subtype: 'success',
                        result: 'foreground done',
                        origin: { kind: 'human' },
                        user_message_uuid: promptUuid,
                        session_id,
                      };
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      continue;
                    }

                    if (turn === 1) {
                      yield {
                        type: 'assistant',
                        session_id,
                        message: {
                          content: [{
                            type: 'tool_use',
                            id: 'tool-bg-1',
                            name: 'Bash',
                            input: { command: 'sleep 30', run_in_background: true },
                          }, {
                            type: 'tool_use',
                            id: 'tool-bg-2',
                            name: 'Bash',
                            input: { command: 'sleep 45', run_in_background: true },
                          }],
                        },
                      };
                      yield {
                        type: 'system',
                        subtype: 'task_started',
                        task_id: 'task-bg-1',
                        task_type: 'bash',
                        description: 'Long background Bash',
                        session_id,
                      };
                      yield {
                        type: 'system',
                        subtype: 'task_started',
                        task_id: 'task-bg-2',
                        task_type: 'bash',
                        description: 'Second background Bash',
                        session_id,
                      };
                      yield {
                        type: 'user',
                        session_id,
                        message: {
                          content: [{
                            type: 'tool_result',
                            tool_use_id: 'tool-bg-1',
                            content: 'Background task launched',
                          }],
                        },
                        tool_use_result: { backgroundTaskId: 'task-bg-1' },
                      };
                      yield {
                        type: 'user',
                        session_id,
                        message: {
                          content: [{
                            type: 'tool_result',
                            tool_use_id: 'tool-bg-2',
                            content: 'Second background task launched',
                          }],
                        },
                        tool_use_result: { backgroundTaskId: 'task-bg-2' },
                      };
                      yield {
                        type: 'system',
                        subtype: 'background_tasks_changed',
                        tasks: [{
                          task_id: 'task-bg-1',
                          task_type: 'bash',
                          description: 'Long background Bash',
                        }, {
                          task_id: 'task-bg-2',
                          task_type: 'bash',
                          description: 'Second background Bash',
                        }],
                        session_id,
                      };
                      yield {
                        type: 'result',
                        subtype: 'success',
                        result: 'Parent turn finished',
                        origin: { kind: 'human' },
                        user_message_uuid: promptUuid,
                        session_id,
                      };
                      yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      if (notificationStreamWaitsForQueuedHumanPrompt) {
                        yield {
                          type: 'system',
                          subtype: 'task_notification',
                          task_id: 'task-bg-1',
                          status: 'completed',
                          output_file: '/tmp/task-bg-1.output',
                          summary: 'Background Bash finished before the queued human echo',
                          session_id,
                        };
                        yield {
                          type: 'user',
                          uuid: 'task-notification-before-human-echo',
                          shouldQuery: false,
                          session_id,
                          message: {
                            content: '<task-notification>\\n<task-id>task-bg-1</task-id>\\n<status>completed</status>\\n</task-notification>',
                          },
                        };
                        const queuedHuman = await iterator.next();
                        if (closed || queuedHuman.done) return;
                        const queuedHumanUuid = queuedHuman.value.uuid;
                        yield {
                          type: 'stream_event',
                          parent_tool_use_id: null,
                          session_id,
                          event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'Queued notification stream must stay hidden' },
                          },
                        };
                        yield {
                          type: 'assistant',
                          parent_tool_use_id: null,
                          session_id,
                          message: {
                            id: 'queued-notification-assistant',
                            usage: { input_tokens: 77, output_tokens: 13 },
                            content: [{ type: 'text', text: 'Queued notification assistant must stay hidden' }],
                          },
                        };
                        yield {
                          type: 'result',
                          subtype: 'success',
                          result: 'notification finished',
                          origin: { kind: 'task-notification' },
                          session_id,
                        };
                        yield { ...queuedHuman.value, session_id };
                        yield { type: 'system', subtype: 'session_state_changed', state: 'running', session_id };
                        yield {
                          type: 'stream_event',
                          parent_tool_use_id: null,
                          session_id,
                          event: {
                            type: 'content_block_delta',
                            delta: { type: 'text_delta', text: 'Queued human stream remains visible' },
                          },
                        };
                        yield {
                          type: 'result',
                          subtype: 'success',
                          result: 'queued human finished',
                          origin: { kind: 'human' },
                          user_message_uuid: queuedHumanUuid,
                          session_id,
                        };
                        yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                      }
                      continue;
                    }

                    yield {
                      type: 'assistant',
                      session_id,
                      message: { content: [{ type: 'text', text: 'Working on the second prompt' }] },
                    };
                    yield {
                      type: 'user',
                      origin: { kind: 'task-notification' },
                      uuid: 'task-notification-1',
                      session_id,
                      message: {
                        content: [{
                          type: 'tool_result',
                          tool_use_id: 'tool-bg-1',
                          content: 'Early notification tool result',
                        }],
                      },
                    };
                    yield {
                      type: 'system',
                      subtype: 'task_notification',
                      task_id: 'task-bg-1',
                      status: 'completed',
                      output_file: '/tmp/task-bg-1.output',
                      summary: 'Background Bash finished',
                      usage: { total_tokens: 0, tool_uses: 1, duration_ms: 1000 },
                      session_id,
                    };
                    yield {
                      type: 'user',
                      origin: { kind: 'task-notification' },
                      uuid: 'task-notification-2',
                      shouldQuery: false,
                      session_id,
                      message: {
                        content: [{
                          type: 'tool_result',
                          tool_use_id: 'tool-bg-2',
                          content: 'Second notification tool result',
                        }],
                      },
                    };
                    yield {
                      type: 'system',
                      subtype: 'task_notification',
                      task_id: 'task-bg-2',
                      status: 'completed',
                      output_file: '/tmp/task-bg-2.output',
                      summary: 'Second background Bash finished',
                      usage: { total_tokens: 0, tool_uses: 1, duration_ms: 1200 },
                      session_id,
                    };
                    yield {
                      type: 'assistant',
                      parent_tool_use_id: 'tool-bg-1',
                      session_id,
                      message: { content: [
                        { type: 'text', text: 'Must stay in the task panel' },
                        {
                          type: 'tool_use',
                          id: 'tool-bg-child',
                          name: 'Read',
                          input: { file_path: '/tmp/background' },
                        },
                      ] },
                    };
                    yield {
                      type: 'tool_progress',
                      tool_use_id: 'tool-bg-progress-child',
                      tool_name: 'Bash',
                      parent_tool_use_id: 'tool-bg-1',
                      session_id,
                    };
                    yield {
                      type: 'tool_use_summary',
                      summary: 'Background child tools finished',
                      preceding_tool_use_ids: ['tool-bg-child', 'tool-bg-progress-child'],
                      session_id,
                    };
                    yield {
                      type: 'stream_event',
                      session_id,
                      event: {
                        type: 'content_block_delta',
                        delta: { type: 'text_delta', text: 'Human stream survives' },
                      },
                    };
                    yield {
                      type: 'user',
                      origin: { kind: 'task-notification' },
                      uuid: 'queued-task-notification-attachment',
                      shouldQuery: false,
                      session_id,
                      message: {
                        content: '<task-notification>\\n<task-id>task-bg-2</task-id>\\n<status>completed</status>\\n</task-notification>',
                      },
                    };
                    yield {
                      type: 'stream_event',
                      session_id,
                      event: {
                        type: 'content_block_delta',
                        delta: { type: 'text_delta', text: 'Human stream after attachment survives' },
                      },
                    };
                    yield {
                      type: 'result',
                      subtype: 'success',
                      uuid: 'duplicate-task-notification-result',
                      result: 'task notification boundary',
                      session_id,
                    };
                    yield {
                      type: 'result',
                      subtype: 'success',
                      uuid: 'duplicate-task-notification-result',
                      result: 'task notification boundary',
                      session_id,
                    };
                    yield {
                      type: 'result',
                      subtype: 'success',
                      result: 'stale human result',
                      origin: { kind: 'human' },
                      user_message_uuid: 'stale-human-prompt',
                      session_id,
                    };
                    await new Promise((resolve) => setTimeout(resolve, 140));
                    yield {
                      type: 'result',
                      subtype: 'success',
                      result: '',
                      user_message_uuid: promptUuid,
                      session_id,
                    };
                    yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
                  }
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

function waitForOutput(outputs, predicate, stderrRef, description) {
  const timeoutMs = 1_500;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const match = outputs.find(predicate);
      if (match) {
        resolve(match);
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error([
          `Timed out waiting for ${description}.`,
          `stdout=${JSON.stringify(outputs)}`,
          `stderr=${stderrRef.value}`,
        ].join('\n')));
        return;
      }

      setTimeout(check, 20);
    };

    check();
  });
}

function waitForStderr(stderrRef, pattern, description) {
  const timeoutMs = 1_500;
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      if (pattern.test(stderrRef.value)) {
        resolve();
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error([
          `Timed out waiting for ${description}.`,
          `stderr=${stderrRef.value}`,
        ].join('\n')));
        return;
      }

      setTimeout(check, 20);
    };

    check();
  });
}

function waitForProcessExit(child, description) {
  const timeoutMs = 1_500;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}.`));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnTrackedHelper(t, helperPath) {
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '60000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

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

test('task notification cannot hide or duplicate an active foreground plan question', async (t) => {
  const helperPath = await buildHelperWithBackgroundRaceMock({
    foregroundPlanAfterTaskNotification: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '60000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'plan',
    working_dir: os.tmpdir(),
    initial_prompt: 'research in parallel, then ask for my runtime choice',
  })}\n`);

  const promptEvent = await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'tool_use_started'
      && output.payload.tool_use_id === 'ask-after-task-notification'
      && output.payload.needs_response === true,
    stderrRef,
    'foreground plan question after a task notification',
  );
  assert.equal(promptEvent.payload.prompt?.prompt_type, 'ask_user_question');
  assert.equal(
    promptEvent.payload.prompt?.questions?.[0]?.question,
    'Which runtime strategy?',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'interactive_prompt_response',
    tool_use_id: 'ask-after-task-notification',
    prompt_type: 'ask_user_question',
    answers: { 'Which runtime strategy?': 'Managed' },
  })}\n`);

  const planExitEvent = await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'tool_use_started'
      && output.payload.tool_use_id === 'exit-after-task-notification'
      && output.payload.needs_response === true,
    stderrRef,
    'foreground plan review after the question answer',
  );
  assert.equal(planExitEvent.payload.prompt?.prompt_type, 'plan_exit');
  assert.equal(
    planExitEvent.payload.prompt?.plan_summary,
    'Use the managed runtime strategy.',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'interactive_prompt_response',
    tool_use_id: 'exit-after-task-notification',
    prompt_type: 'plan_exit',
    answers: { decision: 'approve' },
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed'
      && output.payload.detail === 'plan question answered',
    stderrRef,
    'foreground plan turn completion',
  );
  await waitForOutput(
    outputs,
    () => stderrRef.value.includes('INTERACTIVE_RESULTS allow allow')
      && stderrRef.value.includes('PLAN_EXIT_RESULT allow'),
    stderrRef,
    'question redelivery and plan exit callbacks to resolve',
  );

  const promptEvents = outputs.filter((output) => output.type === 'event'
    && output.payload?.type === 'tool_use_started'
    && output.payload.tool_use_id === 'ask-after-task-notification');
  assert.equal(promptEvents.length, 1, 'callback redelivery and assistant stream must upsert one card');

  const firstPlanTextIndex = outputs.findIndex((output) => output.type === 'event'
    && output.payload?.type === 'assistant_chunk'
    && output.payload.text === 'Foreground plan survives the task notification');
  const promptIndex = outputs.indexOf(promptEvent);
  assert.ok(firstPlanTextIndex >= 0, 'foreground plan text must remain visible');
  assert.ok(promptIndex < firstPlanTextIndex, 'interactive callback must create the card before stream rendering');
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'assistant_chunk'
    && output.payload.text === 'Foreground plan continues after the answer'), true);
  const planReviewTextIndex = outputs.findIndex((output) => output.type === 'event'
    && output.payload?.type === 'assistant_chunk'
    && output.payload.text === 'Foreground plan is ready for review');
  assert.ok(planReviewTextIndex >= 0, 'foreground plan review text must remain visible');
  assert.ok(
    outputs.indexOf(planExitEvent) < planReviewTextIndex,
    'ExitPlanMode callback must create the review card before stream rendering',
  );
  assert.equal(outputs.filter((output) => output.type === 'event'
    && output.payload?.type === 'tool_use_started'
    && output.payload.tool_use_id === 'exit-after-task-notification').length, 1);

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'continue with a legacy result frame',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed'
      && output.payload.detail === 'next foreground turn completed',
    stderrRef,
    'next foreground turn after notification bookkeeping is cleared',
  );
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'assistant_chunk'
    && output.payload.text === 'Next foreground turn remains visible'), true);
});

test('background task result cannot complete a queued human turn', async (t) => {
  const helperPath = await buildHelperWithBackgroundRaceMock();
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '60000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'start a background task',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'parent turn ready while background task remains active',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'tool_use_completed'
      && output.payload.tool_use_id === 'tool-bg-1'),
    false,
    'background launch receipt must leave the original tool card running',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'background_tasks_changed'
      && output.payload.tasks.some((task) => task.task_id === 'task-bg-1')),
    true,
    `background task snapshot missing: ${JSON.stringify(outputs)}`,
  );
  const readyCountBeforeSecond = outputs.filter(
    (output) => output.type === 'status' && output.status === 'ready',
  ).length;

  helper.stdin.write(`${JSON.stringify({ type: 'prompt', text: 'slow human prompt' })}\n`);
  const terminalUpdate = await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'background_task_updated'
      && output.payload.task.task_id === 'task-bg-1'
      && output.payload.task.status === 'completed',
    stderrRef,
    'background task notification',
  );
  await delay(40);

  assert.equal(
    outputs.filter((output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed').length,
    1,
    'task-notification result must not complete the second human turn',
  );
  assert.equal(
    outputs.filter((output) => output.type === 'status' && output.status === 'ready').length,
    readyCountBeforeSecond,
    'task-notification result must not make the second human turn ready',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'Must stay in the task panel'),
    false,
    'task-notification assistant content must not enter the top-level transcript',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'tool_use_completed'
      && ['tool-bg-child', 'tool-bg-progress-child'].includes(output.payload.tool_use_id)),
    false,
    'background child tool summaries must not create top-level orphan completions',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'Human stream survives'),
    true,
    'a human stream frame interleaved after task notification must remain visible',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'Human stream after attachment survives'),
    true,
    'a shouldQuery=false task attachment must not take ownership from the active human stream',
  );
  const terminalIndex = outputs.indexOf(terminalUpdate);
  const toolCompletionIndex = outputs.findIndex((output) => output.type === 'event'
    && output.payload?.type === 'tool_use_completed'
    && output.payload.tool_use_id === 'tool-bg-1');
  assert.ok(toolCompletionIndex > terminalIndex, 'notification must complete the original tool card');

  const humanCompletion = await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed'
      && output.payload.detail === '',
    stderrRef,
    'real human turn completion',
  );
  assert.equal(humanCompletion.payload.detail, '');
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.detail === 'Claude turn completed.'),
    false,
  );
  await waitForOutput(
    outputs,
    () => outputs.filter((output) => output.type === 'status' && output.status === 'ready').length
      === readyCountBeforeSecond + 1,
    stderrRef,
    'ready status after the real human result',
  );
});

test('queued human input cannot reclassify an in-flight task-notification stream', async (t) => {
  const helperPath = await buildHelperWithBackgroundRaceMock({
    notificationStreamWaitsForQueuedHumanPrompt: true,
  });
  const helper = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'start a background task',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'parent turn ready before queued notification stream',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'prompt', text: 'queued human prompt' })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed'
      && output.payload.detail === 'queued human finished',
    stderrRef,
    'queued human completion after notification result',
  );

  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'assistant_chunk'
    && output.payload.text.includes('Queued notification')), false);
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'token_usage'
    && output.payload.input_tokens === 77), false);
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'checkpoint_created'
    && output.payload.prompt_summary.includes('<task-notification>')), false);
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'assistant_chunk'
    && output.payload.text === 'Queued human stream remains visible'), true);
  assert.equal(outputs.filter((output) => output.type === 'event'
    && output.payload?.type === 'lifecycle'
    && output.payload.stage === 'turn_completed').length, 2);
});

test('peer turn frames stay isolated without hiding the active human stream', async (t) => {
  const helperPath = await buildHelperWithBackgroundRaceMock({ peerIngressOnly: true });
  const helper = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'human prompt',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed',
    stderrRef,
    'human completion after peer turn',
  );

  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'assistant_chunk'
    && output.payload.text.includes('Peer')), false);
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'assistant_chunk'
    && output.payload.text === 'Human assistant remains visible'), true);
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'assistant_chunk'
    && output.payload.text === 'Human stream remains visible'), true);
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'token_usage'
    && output.payload.input_tokens === 91), false, 'peer usage must not count toward the foreground turn');
  assert.equal(outputs.filter((output) => output.type === 'event'
    && output.payload?.type === 'checkpoint_created').length, 1,
  'a stale human echo must not create another foreground checkpoint');
  assert.equal(outputs.filter((output) => output.type === 'event'
    && output.payload?.type === 'lifecycle'
    && output.payload.stage === 'turn_completed').length, 1);
});

test('foreground Bash task notifications never enter the background task lifecycle', async (t) => {
  const helperPath = await buildHelperWithBackgroundRaceMock({ foregroundNotificationOnly: true });
  const helper = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'run foreground Bash',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'tool_use_completed'
      && output.payload.tool_use_id === 'tool-fg-1',
    stderrRef,
    'foreground tool completion',
  );
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed',
    stderrRef,
    'foreground turn completion',
  );
  await delay(30);

  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'background_task_updated'
    && output.payload.task.task_id === 'task-fg-1'), false);
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'background_tasks_changed'
    && output.payload.tasks.some((task) => task.task_id === 'task-fg-1')), false);
  assert.equal(outputs.filter((output) => output.type === 'event'
    && output.payload?.type === 'tool_use_completed'
    && output.payload.tool_use_id === 'tool-fg-1').length, 1);
});

test('restarts Claude query and marks each desktop prompt as human-originated', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    assertHumanPromptOrigin: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 1',
    stderrRef,
    'first Claude response',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after the first Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response',
  );

  const chunks = outputs
    .filter((output) => output.type === 'event' && output.payload?.type === 'assistant_chunk')
    .map((output) => output.payload.text);

  assert.deepEqual(chunks, ['mock response 1', 'mock response 2']);
});

test('keeps an idle Claude query open for the next prompt instead of closing background work', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    logClose: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after the first persistent Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response on the same persistent query',
  );

  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_CLOSE__/);
});

test('stop closes an idle retained Claude query without interrupting a completed turn', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    logClose: true,
    logInterrupt: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after completed retained Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`);

  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'idle retained Claude query closed on stop',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'idle_stop',
    stderrRef,
    'idle_stop lifecycle event',
  );
  await waitForProcessExit(helper, 'idle helper process exit after stop');

  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_INTERRUPT__/);
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_interrupted'),
    false,
  );
});

test('two-phase app teardown freezes prompts, can cancel, and then exits cleanly', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    logClose: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready before teardown preparation',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prepare_stop',
    request_id: 'prepare-cancel',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'teardown_prepared'
      && output.request_id === 'prepare-cancel'
      && output.ready === true,
    stderrRef,
    'first teardown preparation',
  );
  helper.stdin.write(`${JSON.stringify({
    type: 'cancel_prepare_stop',
    request_id: 'prepare-cancel',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Native runtime close was cancelled.',
    stderrRef,
    'teardown cancellation',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'prompt', text: 'second' })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'prompt accepted after cancelled teardown',
  );
  await waitForOutput(
    outputs,
    () => outputs.filter((output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed').length >= 2,
    stderrRef,
    'second turn completion',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prepare_stop',
    request_id: 'prepare-commit',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'teardown_prepared'
      && output.request_id === 'prepare-commit'
      && output.ready === true,
    stderrRef,
    'second teardown preparation',
  );
  helper.stdin.write(`${JSON.stringify({ type: 'stop', force_background_tasks: false })}\n`);
  await waitForStderr(stderrRef, /__MOCK_CLAUDE_CLOSE__/, 'prepared query close');
  await waitForProcessExit(helper, 'prepared helper process exit');
});

test('app teardown reports the post-Result SDK settling window instead of pretending it is idle', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    settleDelayMsAfterResult: 250,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'finish before the SDK becomes idle',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed',
    stderrRef,
    'foreground completion before SDK idle',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prepare_stop',
    request_id: 'prepare-while-sdk-settling',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'teardown_prepared'
      && output.request_id === 'prepare-while-sdk-settling'
      && output.ready === false
      && output.detail === 'Claude SDK is not idle.',
    stderrRef,
    'safe close rejection while SDK is still settling',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'cancel_prepare_stop',
    request_id: 'prepare-while-sdk-settling',
  })}\n`);
});

test('terminal handoff preparation freezes the idle Query before final revalidation', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    peerStartsAfterIdleMs: 120,
    logClose: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'finish before handoff',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'idle foreground before handoff prepare',
  );

  const prepare = {
    type: 'prepare_stop',
    request_id: 'handoff-recheck',
    require_idle: true,
  };
  helper.stdin.write(`${JSON.stringify(prepare)}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'teardown_prepared'
      && output.request_id === 'handoff-recheck'
      && output.ready === true,
    stderrRef,
    'initial idle handoff preparation',
  );
  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'idle Query frozen during handoff preparation',
  );
  const turnStartedCountAfterFreeze = outputs.filter((output) => output.type === 'event'
    && output.payload?.type === 'lifecycle'
    && output.payload.stage === 'turn_started').length;

  await delay(180);
  helper.stdin.write(`${JSON.stringify(prepare)}\n`);
  await waitForOutput(
    outputs,
    () => outputs.filter((output) => output.type === 'teardown_prepared'
      && output.request_id === 'handoff-recheck'
      && output.ready === true).length === 2,
    stderrRef,
    'final handoff idle recheck after the old Query was frozen',
  );
  assert.equal(outputs.filter((output) => output.type === 'event'
    && output.payload?.type === 'lifecycle'
    && output.payload.stage === 'turn_started').length, turnStartedCountAfterFreeze);
});

test('forced terminal handoff defers background interruption until final preparation', async (t) => {
  const helperPath = await buildHelperWithBackgroundRaceMock();
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'launch background tasks before handoff',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'parent turn ready with background tasks',
  );

  const prepare = {
    type: 'prepare_stop',
    request_id: 'forced-handoff',
    require_idle: true,
    force_background_tasks: true,
  };
  helper.stdin.write(`${JSON.stringify(prepare)}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'teardown_prepared'
      && output.request_id === 'forced-handoff'
      && output.ready === true,
    stderrRef,
    'forced handoff initial preparation',
  );
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'background_task_updated'
    && output.payload.task?.status === 'interrupted'), false);

  helper.stdin.write(`${JSON.stringify({ ...prepare, finalize: true })}\n`);
  await waitForOutput(
    outputs,
    () => outputs.filter((output) => output.type === 'teardown_prepared'
      && output.request_id === 'forced-handoff'
      && output.ready === true).length === 2,
    stderrRef,
    'forced handoff final preparation',
  );
  assert.deepEqual(
    outputs
      .filter((output) => output.type === 'event'
        && output.payload?.type === 'background_task_updated'
        && output.payload.task?.status === 'interrupted')
      .map((output) => output.payload.task.task_id)
      .sort(),
    ['task-bg-1', 'task-bg-2'],
  );
});

test('teardown preparation gates an active foreground turn without interrupting it before commit', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    delayMsBeforeResult: 350,
    keepAliveAfterResult: true,
    logInterrupt: true,
  });
  const helper = spawn(process.execPath, [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'active foreground turn',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 1',
    stderrRef,
    'active foreground output',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prepare_stop',
    request_id: 'prepare-handoff-active',
    require_idle: true,
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'teardown_prepared'
      && output.request_id === 'prepare-handoff-active'
      && output.ready === false,
    stderrRef,
    'terminal handoff rejects active foreground turn',
  );
  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_INTERRUPT__/);
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'lifecycle'
    && output.payload.stage === 'turn_interrupted'), false);

  helper.stdin.write(`${JSON.stringify({
    type: 'cancel_prepare_stop',
    request_id: 'prepare-handoff-active',
  })}\n`);
  helper.stdin.write(`${JSON.stringify({
    type: 'prepare_stop',
    request_id: 'prepare-active',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'teardown_prepared'
      && output.request_id === 'prepare-active'
      && output.ready === true,
    stderrRef,
    'app termination may gate an active foreground turn without interrupting it',
  );
  helper.stdin.write(`${JSON.stringify({
    type: 'cancel_prepare_stop',
    request_id: 'prepare-active',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed',
    stderrRef,
    'foreground turn completes after cancelled preparation',
  );
  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_INTERRUPT__/);
});

test('idle teardown closes the captured Claude query and exits instead of accepting a reconnect', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    logCloseWithTurn: true,
    logInterrupt: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after retained Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'closed_idle'
      && output.detail === 'Claude runtime stopped after completed turn.',
    stderrRef,
    'closed_idle status after idle stop',
  );

  await waitForProcessExit(helper, 'helper exit after idle teardown');
  const chunks = outputs
    .filter((output) => output.type === 'event' && output.payload?.type === 'assistant_chunk')
    .map((output) => output.payload.text);
  assert.deepEqual(chunks, ['mock response 1']);
  assert.match(stderrRef.value, /__MOCK_CLAUDE_CLOSE_TURN_1__/);
  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_INTERRUPT__/);
});

test('closes an idle Claude query after the retention timeout', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    logClose: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '40',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status before idle retention timeout',
  );

  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'idle Claude query close after retention timeout',
  );
});

test('restarts an idle retained Claude query before sending with updated environment settings', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    logClose: true,
    reportModelState: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '60000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    env_vars: { ANTHROPIC_MODEL: 'old-model' },
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=old-model;setModel=false',
    stderrRef,
    'first Claude response with original environment model',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'update_settings',
    request_id: 'settings-idle',
    env_name: 'updated',
    env_vars: { ANTHROPIC_MODEL: 'new-model' },
  })}\n`);
  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'runtime_settings_changed'
      && output.payload.state === 'applied'
      && output.payload.request_id === 'settings-idle'
      && output.payload.env_name === 'updated',
    stderrRef,
    'applied settings acknowledgement',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Settings applied.',
    stderrRef,
    'applied settings status',
  );

  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'idle retained query close after environment update',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=new-model;setModel=false',
    stderrRef,
    'second Claude response with updated environment model',
  );
});

test('defers retained-query settings until the SDK reports real idle after Result', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    settleDelayMsAfterResult: 180,
    yieldIdleAfterResult: true,
    logClose: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '60000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed',
    stderrRef,
    'foreground Result boundary',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'update_settings',
    request_id: 'settings-after-result-before-idle',
    env_name: 'next-environment',
    env_vars: { ANTHROPIC_MODEL: 'next-model' },
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'runtime_settings_changed'
      && output.payload.state === 'deferred'
      && output.payload.request_id === 'settings-after-result-before-idle',
    stderrRef,
    'deferred settings acknowledgement before SDK idle',
  );
  await delay(60);
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'runtime_settings_changed'
      && output.payload.state === 'applied'
      && output.payload.request_id === 'settings-after-result-before-idle'),
    false,
    'Result alone must not fabricate SDK idle or apply retained-query settings',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'runtime_settings_changed'
      && output.payload.state === 'applied'
      && output.payload.request_id === 'settings-after-result-before-idle',
    stderrRef,
    'settings applied after real SDK idle',
  );
  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'retained query close after real SDK idle',
  );
});

test('force-restarts a completed retained Claude query without waiting for SDK idle', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    keepAliveAfterResult: true,
    yieldIdleAfterResult: false,
    logClose: true,
    reportModelState: true,
  });
  const { helper, outputs, stderrRef } = spawnTrackedHelper(t, helperPath);

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    env_vars: { ANTHROPIC_MODEL: 'old-model' },
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed',
    stderrRef,
    'completed foreground Result without SDK idle',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'update_settings',
    request_id: 'force-settings-after-result',
    env_name: 'updated',
    env_vars: { ANTHROPIC_MODEL: 'new-model' },
    force_restart: true,
  })}\n`);
  helper.stdin.write(`${JSON.stringify({ type: 'prompt', text: 'second' })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'runtime_settings_changed'
      && output.payload.state === 'applied'
      && output.payload.request_id === 'force-settings-after-result'
      && output.payload.env_name === 'updated',
    stderrRef,
    'forced settings acknowledgement without SDK idle',
  );
  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'forced retained query close without SDK idle',
  );
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=new-model;setModel=false',
    stderrRef,
    'next Claude response with the forced environment',
  );
});

test('forced settings preserve the active foreground turn then interrupt background tasks', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    delayMsBeforeResult: 180,
    keepAliveAfterResult: true,
    yieldIdleAfterResult: false,
    launchBackgroundTaskBeforeInterrupt: true,
    logClose: true,
    reportModelState: true,
  });
  const { helper, outputs, stderrRef } = spawnTrackedHelper(t, helperPath);

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    env_vars: { ANTHROPIC_MODEL: 'old-model' },
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'background_tasks_changed'
      && output.payload.tasks.some((task) => task.task_id === 'task-background-during-interrupt'),
    stderrRef,
    'active background task before forced environment switch',
  );
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=old-model;setModel=false',
    stderrRef,
    'foreground response before its Result boundary',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'update_settings',
    request_id: 'force-settings-after-active-turn',
    env_name: 'updated',
    env_vars: { ANTHROPIC_MODEL: 'new-model' },
    force_restart: true,
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'runtime_settings_changed'
      && output.payload.state === 'deferred'
      && output.payload.request_id === 'force-settings-after-active-turn',
    stderrRef,
    'forced settings deferred until the foreground Result',
  );
  await delay(40);
  assert.doesNotMatch(
    stderrRef.value,
    /__MOCK_CLAUDE_CLOSE__/,
    'forced environment switch must preserve the active foreground turn',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'background_task_updated'
      && output.payload.task.task_id === 'task-background-during-interrupt'
      && output.payload.task.status === 'interrupted'),
    false,
    'background work must remain attached until the foreground Result',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed',
    stderrRef,
    'preserved foreground Result boundary',
  );
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'runtime_settings_changed'
      && output.payload.state === 'applied'
      && output.payload.request_id === 'force-settings-after-active-turn'
      && output.payload.env_name === 'updated',
    stderrRef,
    'forced settings applied at the foreground Result boundary',
  );
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'background_task_updated'
      && output.payload.task.task_id === 'task-background-during-interrupt'
      && output.payload.task.status === 'interrupted',
    stderrRef,
    'background task interrupted by forced environment switch',
  );
  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'retained query close after preserved foreground Result',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'prompt', text: 'second' })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=new-model;setModel=false',
    stderrRef,
    'next Claude response after background-task teardown',
  );
});

test('applies environment settings after the active Claude turn before accepting the next prompt', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    delayMsBeforeResult: 120,
    keepAliveAfterResult: true,
    logClose: true,
    reportModelState: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '60000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    env_vars: { ANTHROPIC_MODEL: 'old-model' },
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=old-model;setModel=false',
    stderrRef,
    'first Claude response while the turn remains active',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'update_settings',
    request_id: 'settings-active',
    env_name: 'updated',
    env_vars: { ANTHROPIC_MODEL: 'new-model' },
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'runtime_settings_changed'
      && output.payload.state === 'deferred'
      && output.payload.request_id === 'settings-active'
      && output.payload.pending_env_name === 'updated',
    stderrRef,
    'deferred settings acknowledgement',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'processing'
      && output.detail === 'Settings will apply to the next Claude runtime.',
    stderrRef,
    'queued active-turn settings status',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'runtime_settings_changed'
      && output.payload.state === 'applied'
      && output.payload.request_id === 'settings-active'
      && output.payload.env_name === 'updated',
    stderrRef,
    'settings applied acknowledgement after active turn',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Settings applied.',
    stderrRef,
    'settings applied after active turn completion',
  );

  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'active-turn query close after applying environment settings',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=new-model;setModel=false',
    stderrRef,
    'next Claude response with active-turn environment update',
  );
});

test('restarts Claude query when a prompt arrives after idle but before the old query settles', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    yieldIdleBeforeResult: true,
    settleDelayMsAfterResult: 80,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after the first Claude turn',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response after idle-before-result race',
  );
});

test('passes Claude runtime model at query startup without setModel control request', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    expectedQueryModel: 'opus',
    reportModelState: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    env_vars: {
      ANTHROPIC_MODEL: ' opus ',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-test',
    },
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'model=opus;setModel=false',
    stderrRef,
    'Claude query model without setModel',
  );
});

test('marks Claude helper ready after a non-success result so the workspace can continue', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    firstResultSubtype: 'error_max_turns',
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'session_completed'
      && output.payload.reason === 'hit turn limit',
    stderrRef,
    'non-success Claude completion event',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after non-success Claude result',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response',
  );
});

test('preserves partial output, reports one incomplete response, and recovers the next Claude prompt', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    endFirstTurnWithoutResult: true,
    yieldIdleBeforeResult: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
  });

  const outputs = [];
  const stderrRef = { value: '' };
  let stdoutBuffer = '';
  const incompleteReason = 'Claude response ended before a final result. Partial output was preserved; send the next prompt to retry.';

  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 1',
    stderrRef,
    'partial Claude response before the missing result',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'session_completed'
      && output.payload.reason === incompleteReason,
    stderrRef,
    'recoverable incomplete-response error',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Claude response incomplete. Ready to retry.',
    stderrRef,
    'ready status after the incomplete response',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response after reconnect',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status after the recovered response',
  );

  assert.equal(
    outputs.filter((output) => output.type === 'event'
      && output.payload?.type === 'session_completed'
      && output.payload.reason === incompleteReason).length,
    1,
  );
  assert.deepEqual(
    outputs
      .filter((output) => output.type === 'event' && output.payload?.type === 'assistant_chunk')
      .map((output) => output.payload.text),
    ['mock response 1', 'mock response 2'],
  );
});

test('interrupts an active Claude turn without closing the query process', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    interruptible: true,
    interruptDelayMs: 60,
    logClose: true,
    logInterrupt: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 1',
    stderrRef,
    'first Claude response before interrupt',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'interrupt_turn' })}\n`);
  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_interrupted',
    stderrRef,
    'turn_interrupted lifecycle event',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Turn interrupted. Ready for the next prompt.',
    stderrRef,
    'ready status after interrupt',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response after interrupt',
  );

  assert.match(stderrRef.value, /__MOCK_CLAUDE_INTERRUPT__/);
  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_CLOSE__/);
  assert.equal(
    outputs.some((output) => output.type === 'event' && output.payload?.type === 'session_completed'),
    false,
  );
});

test('foreground interrupt rejection keeps the Claude query and background tasks attached', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    interruptible: true,
    interruptRejects: true,
    launchBackgroundTaskBeforeInterrupt: true,
    logClose: true,
    logInterrupt: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'keep background task alive when interrupt rejects',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'background_task_updated'
      && output.payload.task?.task_id === 'task-background-during-interrupt'
      && output.payload.task?.status === 'running',
    stderrRef,
    'running background task before foreground interrupt',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'interrupt_turn' })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'interrupt_failed',
    stderrRef,
    'scoped foreground interrupt failure',
  );
  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'processing'
      && output.detail.includes('background tasks remain attached'),
    stderrRef,
    'processing status after foreground interrupt rejection',
  );
  await delay(60);

  assert.equal(helper.exitCode, null);
  assert.match(stderrRef.value, /__MOCK_CLAUDE_INTERRUPT__/);
  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_CLOSE__/);
  assert.equal(outputs.some((output) => output.type === 'status' && output.status === 'error'), false);
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'background_task_updated'
    && output.payload.task?.task_id === 'task-background-during-interrupt'
    && ['completed', 'failed', 'stopped', 'interrupted'].includes(output.payload.task?.status)), false);
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'tool_use_completed'
    && output.payload.tool_use_id === 'tool-background-during-interrupt'), false);
});

test('foreground interrupt clears foreground Agent prompts and preserves background Agent prompts', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    interruptible: true,
    permissionOwnershipScenario: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => helper.kill('SIGTERM'));

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
  helper.stderr.on('data', (chunk) => { stderrRef.value += chunk; });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'start permission ownership scenario',
  })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'permission_required'
      && output.payload.request_id === 'request-background-agent',
    stderrRef,
    'background Agent permission',
  );
  const backgroundPermissionEvent = outputs.find((output) => output.type === 'event'
    && output.payload?.type === 'permission_required'
    && output.payload.request_id === 'request-background-agent');
  assert.equal(backgroundPermissionEvent.payload.background_task_id, 'background-agent');
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'permission_required'
      && output.payload.request_id === 'request-background-agent-two',
    stderrRef,
    'second background Agent permission',
  );
  const workflowPermissionEvent = await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'permission_required'
      && output.payload.request_id === 'request-background-workflow',
    stderrRef,
    'background workflow child permission',
  );
  assert.equal(
    workflowPermissionEvent.payload.background_task_id,
    'background-workflow',
    'workflow child agent must inherit its top-level background task owner',
  );
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'permission_required'
      && output.payload.request_id === 'request-foreground-agent',
    stderrRef,
    'foreground Agent permission',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'interrupt_turn' })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_interrupted',
    stderrRef,
    'foreground interrupt completion',
  );
  await delay(30);

  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'permission_responded'
      && output.payload.request_id === 'request-foreground-agent'
      && output.payload.approved === false),
    true,
    'synchronous foreground Agent permission must be denied on interrupt',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'tool_use_completed'
      && output.payload.tool_use_id === 'ask-foreground-agent'
      && output.payload.success === false),
    true,
    'foreground AskUserQuestion must be completed as denied',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'permission_responded'
      && output.payload.request_id === 'request-background-agent'),
    false,
    'background Agent permission must remain pending',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'permission_responded'
      && output.payload.request_id === 'request-background-workflow'),
    false,
    'background workflow child permission must remain pending on foreground interrupt',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'tool_use_completed'
      && output.payload.tool_use_id === 'ask-background-agent'),
    false,
    'background Agent AskUserQuestion must not create a top-level tool card',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'prompt', text: 'continue while background waits' })}\n`);
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'new foreground response while background permission remains pending',
  );
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'permission_responded'
      && output.payload.request_id === 'request-background-agent'
      && output.payload.approved === false,
    stderrRef,
    'stopped background task permission cleanup',
  );
  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'permission_responded'
      && output.payload.request_id === 'request-background-workflow'
      && output.payload.approved === false,
    stderrRef,
    'stopped background workflow permission cleanup',
  );
  assert.equal(outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'permission_responded'
    && output.payload.request_id === 'request-background-agent-two'), false,
  'stopping one background task must not resolve another task permission');
});

test('times out a stuck Claude interrupt and restarts the next prompt on a fresh query', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    interruptible: true,
    interruptHangs: true,
    logClose: true,
    logCloseWithTurn: true,
    logInterrupt: true,
    yieldLateResultAfterClose: true,
  });
  const helper = spawn(process.execPath, [helperPath], {
    env: {
      ...process.env,
      CCEM_NATIVE_CLAUDE_INTERRUPT_TIMEOUT_MS: '40',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 1',
    stderrRef,
    'first Claude response before stuck interrupt',
  );

  helper.stdin.write(`${JSON.stringify({ type: 'interrupt_turn' })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'interrupt_requested',
    stderrRef,
    'interrupt_requested lifecycle event',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'interrupt_timeout',
    stderrRef,
    'interrupt_timeout lifecycle event',
  );

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'interrupted'
      && output.detail === 'Claude interrupt timed out; runtime will reconnect on the next prompt.',
    stderrRef,
    'interrupted status after interrupt timeout',
  );

  await waitForStderr(
    stderrRef,
    /__MOCK_CLAUDE_CLOSE__/,
    'stuck Claude query closed after interrupt timeout',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response after interrupt timeout',
  );
  await delay(160);

  assert.match(stderrRef.value, /__MOCK_CLAUDE_INTERRUPT__/);
  assert.match(stderrRef.value, /__MOCK_CLAUDE_CLOSE_TURN_1__/);
  assert.doesNotMatch(stderrRef.value, /__MOCK_CLAUDE_CLOSE_TURN_2__/);
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_interrupted'),
    false,
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'session_completed'
      && output.payload.reason === 'late result from closed query'),
    false,
    'a Result from the replaced query generation must not complete the new foreground turn',
  );
  assert.equal(
    outputs.some((output) => output.type === 'event'
      && output.payload?.type === 'lifecycle'
      && output.payload.stage === 'turn_completed'),
    false,
    'the second foreground turn must remain active after the stale Result',
  );
});

test('does not drop prompts sent while a completed one-shot Claude query is settling', async (t) => {
  const helperPath = await buildHelperWithMockClaudeSdk({
    settleDelayMsAfterResult: 120,
  });
  const helper = spawn(process.execPath, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => {
    helper.kill('SIGTERM');
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
      if (line) {
        outputs.push(JSON.parse(line));
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  helper.stderr.setEncoding('utf8');
  helper.stderr.on('data', (chunk) => {
    stderrRef.value += chunk;
  });

  helper.stdin.write(`${JSON.stringify({
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    initial_prompt: 'first',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'status'
      && output.status === 'ready'
      && output.detail === 'Ready for the next prompt.',
    stderrRef,
    'ready status before one-shot query settles',
  );

  helper.stdin.write(`${JSON.stringify({
    type: 'prompt',
    text: 'second',
  })}\n`);

  await waitForOutput(
    outputs,
    (output) => output.type === 'event'
      && output.payload?.type === 'assistant_chunk'
      && output.payload.text === 'mock response 2',
    stderrRef,
    'second Claude response after settling restart',
  );
});
