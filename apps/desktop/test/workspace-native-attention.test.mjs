import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

async function importWorkspaceNativeAttention() {
  const sourcePath = path.join(desktopDir, 'src', 'components', 'workspace', 'workspaceNativeAttention.ts');
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-workspace-native-attention-test-'));
  const outputPath = path.join(tempDir, 'workspaceNativeAttention.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

function event(seq, payload) {
  return {
    runtime_id: 'runtime-1',
    seq,
    occurred_at: `2026-05-05T00:00:${String(seq).padStart(2, '0')}.000Z`,
    payload,
  };
}

function interactivePromptStarted(seq = 1, toolUseId = 'interactive-1') {
  return event(seq, {
    type: 'tool_use_started',
    tool_use_id: toolUseId,
    raw_name: 'AskUserQuestion',
    input_summary: 'Choose an option',
    needs_response: true,
    prompt: {
      prompt_type: 'ask_user_question',
      questions: [],
    },
    category: { category: 'user_input', kind: 'ask_user_question', raw_name: 'AskUserQuestion' },
  });
}

test('plan review card prefers the detailed ExitPlanMode plan over a synthetic blocked-tool prompt', async () => {
  const { extractAttentionState } = await importWorkspaceNativeAttention();

  const attention = extractAttentionState([
    event(1, {
      type: 'tool_use_started',
      tool_use_id: 'synthetic-plan-exit',
      raw_name: 'ExitPlanMode',
      input_summary: 'Claude is ready to run Agent. Confirm before leaving Plan mode and executing changes.',
      needs_response: true,
      prompt: {
        prompt_type: 'plan_exit',
        allowed_prompts: ['继续执行'],
        plan_summary: 'Claude is ready to run Agent. Confirm before leaving Plan mode and executing changes.',
      },
      category: { category: 'user_input', kind: 'plan_exit', raw_name: 'ExitPlanMode' },
    }),
    event(2, {
      type: 'tool_use_started',
      tool_use_id: 'real-plan-exit',
      raw_name: 'ExitPlanMode',
      input_summary: '# Plan: Add copy button',
      needs_response: true,
      prompt: {
        prompt_type: 'plan_exit',
        allowed_prompts: [],
        plan_summary: '# Plan: Add copy button\n\n## Steps\n1. Edit App.tsx',
      },
      category: { category: 'user_input', kind: 'plan_exit', raw_name: 'ExitPlanMode' },
    }),
    event(3, {
      type: 'tool_use_completed',
      tool_use_id: 'real-plan-exit',
      raw_name: 'ExitPlanMode',
      result_summary: 'Plan mode is active. Confirm the plan before leaving Plan mode.',
      success: false,
    }),
  ]);

  assert.equal(attention.prompts.length, 1);
  assert.equal(attention.prompts[0].toolUseId, 'real-plan-exit');
  assert.equal(attention.prompts[0].eventSeq, 2);
  assert.match(attention.prompts[0].prompt.plan_summary, /# Plan: Add copy button/);
});

test('plan exit prompts always expose a primary approval reply', async () => {
  const {
    getPlanExitPrimaryReply,
    isPlanExitApprovalText,
  } = await importWorkspaceNativeAttention();

  assert.equal(
    getPlanExitPrimaryReply({
      prompt_type: 'plan_exit',
      allowed_prompts: [],
      plan_summary: '# Plan: Add copy button',
    }),
    '继续执行',
  );
  assert.equal(
    getPlanExitPrimaryReply({
      prompt_type: 'plan_exit',
      allowed_prompts: ['  通过  '],
      plan_summary: '# Plan: Add copy button',
    }),
    '通过',
  );
  assert.equal(
    getPlanExitPrimaryReply({
      prompt_type: 'ask_user_question',
      questions: [],
    }),
    null,
  );
  assert.equal(isPlanExitApprovalText('approve', []), true);
  assert.equal(isPlanExitApprovalText('通过', []), true);
  assert.equal(isPlanExitApprovalText('ship it', ['Ship it']), true);
  assert.equal(
    isPlanExitApprovalText(
      '<workspace_annotations>approve</workspace_annotations>',
      [],
    ),
    false,
    'model-only annotation XML must never determine the visible approval intent',
  );
});

test('persisted user replies and tool completion cannot dismiss a prompt before its applied receipt', async () => {
  const { extractAttentionState } = await importWorkspaceNativeAttention();

  const beforeReceipt = extractAttentionState([
    event(1, {
      type: 'tool_use_started',
      tool_use_id: 'real-plan-exit',
      raw_name: 'ExitPlanMode',
      input_summary: '# Plan: Add copy button',
      needs_response: true,
      prompt: {
        prompt_type: 'plan_exit',
        allowed_prompts: [],
        plan_summary: '# Plan: Add copy button',
      },
      category: { category: 'user_input', kind: 'plan_exit', raw_name: 'ExitPlanMode' },
    }),
    event(2, {
      type: 'tool_use_completed',
      tool_use_id: 'real-plan-exit',
      raw_name: 'ExitPlanMode',
      result_summary: 'Plan mode is active. Confirm the plan before leaving Plan mode.',
      success: false,
    }),
    event(3, { type: 'user_prompt', text: '继续执行', image_count: 0 }),
  ]);

  assert.equal(beforeReceipt.prompts.length, 1);

  const afterReceipt = extractAttentionState([
    event(1, {
      type: 'tool_use_started',
      tool_use_id: 'real-plan-exit',
      raw_name: 'ExitPlanMode',
      input_summary: '# Plan: Add copy button',
      needs_response: true,
      prompt: {
        prompt_type: 'plan_exit',
        allowed_prompts: [],
        plan_summary: '# Plan: Add copy button',
      },
      category: { category: 'user_input', kind: 'plan_exit', raw_name: 'ExitPlanMode' },
    }),
    event(2, { type: 'user_prompt', text: '继续执行', image_count: 0 }),
    event(3, {
      type: 'tool_use_completed',
      tool_use_id: 'real-plan-exit',
      raw_name: 'ExitPlanMode',
      result_summary: 'Plan accepted.',
      success: true,
    }),
    event(4, {
      type: 'interactive_response_result',
      tool_use_id: 'real-plan-exit',
      prompt_type: 'plan_exit',
      state: 'applied',
    }),
  ]);

  assert.equal(afterReceipt.prompts.length, 0);
});

test('permission requests preserve request and tool-use correlation ids', async () => {
  const { extractAttentionState } = await importWorkspaceNativeAttention();

  const attention = extractAttentionState([
    event(1, {
      type: 'permission_required',
      request_id: 'req-sdk-1',
      tool_use_id: 'toolu-1',
      tool_name: 'Bash',
      input_summary: 'pnpm test',
    }),
  ]);

  assert.deepEqual(attention.permissions, [{
    requestId: 'req-sdk-1',
    toolUseId: 'toolu-1',
    toolName: 'Bash',
    inputSummary: 'pnpm test',
  }]);
});

test('background task permissions remain visible without being cleared by a new human prompt', async () => {
  const { extractAttentionState } = await importWorkspaceNativeAttention();

  const attention = extractAttentionState([
    event(1, {
      type: 'permission_required',
      request_id: 'req-background-1',
      tool_use_id: 'tool-background-1',
      tool_name: 'Bash',
      input_summary: 'pnpm test',
      background_task_id: 'task-background-1',
    }),
    event(2, { type: 'user_prompt', text: 'new foreground prompt', image_count: 0 }),
    event(3, { type: 'session_completed', reason: 'foreground failed' }),
  ]);

  assert.deepEqual(attention.permissions, [{
    requestId: 'req-background-1',
    toolUseId: 'tool-background-1',
    toolName: 'Bash',
    inputSummary: 'pnpm test',
    backgroundTaskId: 'task-background-1',
  }]);
});

test('interactive prompts remain pending until an authoritative helper receipt is observed', async () => {
  const { extractAttentionState } = await importWorkspaceNativeAttention();

  const beforeReceipt = extractAttentionState([interactivePromptStarted()]);
  assert.equal(
    beforeReceipt.prompts.length,
    1,
    'a successful pipe write alone has no event that can permanently hide the card',
  );

  const afterAppliedReceipt = extractAttentionState([
    interactivePromptStarted(),
    event(2, {
      type: 'interactive_response_result',
      tool_use_id: 'interactive-1',
      prompt_type: 'ask_user_question',
      state: 'applied',
      control_request_id: 'control-1',
      query_generation: 4,
    }),
  ]);
  assert.equal(afterAppliedReceipt.prompts.length, 0);
});

test('terminal interactive receipts cannot leave ghost attention cards', async () => {
  const { extractAttentionState } = await importWorkspaceNativeAttention();

  for (const state of ['rejected', 'stale', 'stale_no_resolver', 'resolver_expired']) {
    const attention = extractAttentionState([
      interactivePromptStarted(),
      event(2, {
        type: 'interactive_response_result',
        tool_use_id: 'interactive-1',
        prompt_type: 'ask_user_question',
        state,
      }),
    ]);
    assert.equal(attention.prompts.length, 0, `${state} must invalidate the pending resolver`);
  }
});

test('nonterminal mismatch receipts preserve the live resolver occurrence', async () => {
  const { extractAttentionState } = await importWorkspaceNativeAttention();

  for (const state of ['generation_mismatch', 'prompt_type_mismatch']) {
    const attention = extractAttentionState([
      interactivePromptStarted(7, 'interactive-reused'),
      event(8, {
        type: 'interactive_response_result',
        tool_use_id: 'interactive-reused',
        prompt_type: 'ask_user_question',
        state,
      }),
    ]);
    assert.equal(attention.prompts.length, 1, `${state} must preserve the resolver`);
    assert.equal(attention.prompts[0].eventSeq, 7);
  }
});
