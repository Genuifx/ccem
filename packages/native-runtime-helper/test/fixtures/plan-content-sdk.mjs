import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PLAN = '# 完整计划验证\n\n'
  + Array.from({ length: 60 }, (_, i) => `## 步骤 ${i + 1}\n\n完整正文第 ${i + 1} 段：验证计划写入、确认卡片和后续执行。\n\n- 保留 Markdown 列表与代码：\`step_${i + 1}\`。`).join('\n\n')
  + '\n\n**计划正文结束：END_OF_COMPLETE_PLAN**\n';

export function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}
export function createSdkMcpServer(config) {
  return { type: 'sdk', name: config.name, instance: {} };
}
export function forkSession() { throw new Error('Unexpected fork in plan fixture'); }

// Only the provider is simulated. The production helper consumes these SDK
// frames, waits for the real control response, and emits its normal events.
export function query({ prompt, options }) {
  let closed = false;
  return {
    close() { closed = true; },
    async setPermissionMode() {},
    async getContextUsage() { return null; },
    async *[Symbol.asyncIterator]() {
      const session_id = randomUUID();
      let turn = 0;
      yield { type: 'system', subtype: 'init', session_id, capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1'] };
      for await (const userMessage of prompt) {
        if (closed) return;
        turn++;
        let spec = {};
        try { spec = JSON.parse(userMessage.message.content); } catch { /* Desktop smoke uses a plain prompt. */ }
        for (const state of ['queued', 'started']) {
          yield { type: 'command_lifecycle', command_uuid: userMessage.uuid, state, session_id };
        }
        yield { ...userMessage, session_id };
        yield { type: 'system', subtype: 'session_state_changed', state: 'running', session_id };
        const assistant = (content, background = false) => ({
          type: 'assistant', session_id, parent_tool_use_id: background ? 'background-plan-agent' : null,
          message: { role: 'assistant', content },
        });
        const writes = spec.writes ?? [{ path: '.plans/review.md', content: PLAN }];
        const delayedResults = [];
        for (const [index, write] of writes.entries()) {
          const id = `write-${turn}-${index}`;
          const file_path = path.resolve(options.cwd, write.path);
          const name = write.edit ? 'Edit' : 'Write';
          const input = write.edit
            ? { file_path, old_string: write.old, new_string: write.content }
            : { file_path, content: write.content };
          yield assistant([{ type: 'tool_use', id, name, input }], write.background);
          if (!write.failed) {
            fs.mkdirSync(path.dirname(file_path), { recursive: true });
            const content = write.edit
              ? fs.readFileSync(file_path, 'utf8').replace(write.old, write.content)
              : write.content;
            fs.writeFileSync(file_path, content);
          }
          const result = {
            type: 'user', session_id, parent_tool_use_id: write.background ? 'background-plan-agent' : null,
            message: { role: 'user', content: [{
              type: 'tool_result', tool_use_id: id, is_error: write.failed === true,
              content: write.failed ? 'Write failed' : 'File saved successfully',
            }] },
          };
          if (spec.lateResult) delayedResults.push(result);
          else yield result;
        }
        const toolUseID = `exit-plan-${turn}`;
        const input = spec.inline === undefined ? {} : { plan: spec.inline };
        const toolFrame = assistant([{ type: 'tool_use', id: toolUseID, name: 'ExitPlanMode', input }]);
        if (spec.streamFirst) yield toolFrame;
        const pending = options.canUseTool('ExitPlanMode', input, { toolUseID });
        for (const result of delayedResults) yield result;
        if (!spec.streamFirst) yield toolFrame;
        const response = await pending;
        if (response.behavior === 'allow' && JSON.stringify(response.updatedInput) !== JSON.stringify(input)) {
          throw new Error('Display fallback must not alter SDK tool input');
        }
        yield assistant([{ type: 'text', text: response.behavior === 'allow' ? 'PLAN_FIXTURE_APPROVED' : 'PLAN_FIXTURE_REVISE' }]);
        yield { type: 'result', subtype: 'success', result: 'Plan fixture finished', user_message_uuid: userMessage.uuid, session_id };
        yield { type: 'command_lifecycle', command_uuid: userMessage.uuid, state: 'completed', session_id };
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id };
      }
    },
  };
}
