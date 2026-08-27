import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');

async function importClaudeRouteHookModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-claude-route-hook-test-'));
  const outfile = path.join(tempDir, 'claudeRouteHook.mjs');

  await build({
    entryPoints: [path.join(packageDir, 'src', 'claudeRouteHook.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

const router = {
  routeTagNonce: 'nonce_123',
  dynamicRouting: true,
  menu: 'Allowed route targets: glm, official.',
};

function agentInput(overrides = {}) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: {
      description: 'Explore the repository',
      subagent_type: 'Explore',
      prompt: 'Inspect the project.',
      ...overrides,
    },
    tool_use_id: 'tool-agent',
  };
}

test('signs a valid Agent identity without exposing binding logic', async () => {
  const { buildClaudeRoutePreToolUseHook } = await importClaudeRouteHookModule();
  const hook = buildClaudeRoutePreToolUseHook(router);

  const result = await hook(agentInput());

  assert.equal(result.continue, true);
  assert.equal(
    result.hookSpecificOutput?.updatedInput?.prompt,
    '<CCEM-ROUTE nonce="nonce_123">subagent:Explore</CCEM-ROUTE>\nInspect the project.',
  );
  assert.equal(result.hookSpecificOutput?.updatedInput?.description, 'Explore the repository');
});

test('converts only an exact first-character raw env override into a signed marker', async () => {
  const { buildClaudeRoutePreToolUseHook } = await importClaudeRouteHookModule();
  const hook = buildClaudeRoutePreToolUseHook(router);

  const result = await hook(agentInput({
    prompt: '<CCEM-ROUTE>ccem:glm</CCEM-ROUTE>\nInspect the project.',
  }));

  assert.equal(
    result.hookSpecificOutput?.updatedInput?.prompt,
    '<CCEM-ROUTE nonce="nonce_123">ccem:glm</CCEM-ROUTE>\nInspect the project.',
  );
});

test('rejects colon and overlong explicit environment aliases', async () => {
  const { buildClaudeRoutePreToolUseHook } = await importClaudeRouteHookModule();
  const hook = buildClaudeRoutePreToolUseHook(router);
  const invalidAliases = ['glm:v2', 'x'.repeat(65)];

  for (const alias of invalidAliases) {
    const rawPrompt = `<CCEM-ROUTE>ccem:${alias}</CCEM-ROUTE>\nInspect the project.`;
    const result = await hook(agentInput({ prompt: rawPrompt }));
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', alias);
    assert.match(
      result.hookSpecificOutput?.permissionDecisionReason ?? '',
      /ROUTER_ENV_ALIAS_INVALID/,
      alias,
    );
  }
});

test('consumes at most one line break after an exact raw override', async () => {
  const { buildClaudeRoutePreToolUseHook } = await importClaudeRouteHookModule();
  const hook = buildClaudeRoutePreToolUseHook(router);

  const crlf = await hook(agentInput({
    prompt: '<CCEM-ROUTE>ccem:glm</CCEM-ROUTE>\r\nInspect the project.',
  }));
  const twoBreaks = await hook(agentInput({
    prompt: '<CCEM-ROUTE>ccem:glm</CCEM-ROUTE>\n\nInspect the project.',
  }));

  assert.equal(
    crlf.hookSpecificOutput?.updatedInput?.prompt,
    '<CCEM-ROUTE nonce="nonce_123">ccem:glm</CCEM-ROUTE>\nInspect the project.',
  );
  assert.equal(
    twoBreaks.hookSpecificOutput?.updatedInput?.prompt,
    '<CCEM-ROUTE nonce="nonce_123">ccem:glm</CCEM-ROUTE>\n\nInspect the project.',
  );
});

test('keeps raw tags in ordinary text but denies malformed first-character overrides', async () => {
  const { buildClaudeRoutePreToolUseHook } = await importClaudeRouteHookModule();
  const hook = buildClaudeRoutePreToolUseHook(router);
  const embedded = 'Before <CCEM-ROUTE>ccem:glm</CCEM-ROUTE> after';
  const malformed = '<CCEM-ROUTE>ccem:glm/evil</CCEM-ROUTE>suffix';
  const missingClose = '<CCEM-ROUTE>ccem:glm Inspect the project.';

  const embeddedResult = await hook(agentInput({ prompt: embedded }));
  const malformedResult = await hook(agentInput({ prompt: malformed }));
  const missingCloseResult = await hook(agentInput({ prompt: missingClose }));

  assert.equal(
    embeddedResult.hookSpecificOutput?.updatedInput?.prompt,
    `<CCEM-ROUTE nonce="nonce_123">subagent:Explore</CCEM-ROUTE>\n${embedded}`,
  );
  assert.equal(malformedResult.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(
    malformedResult.hookSpecificOutput?.permissionDecisionReason ?? '',
    /ROUTER_ENV_ALIAS_INVALID/,
  );
  assert.equal(missingCloseResult.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(
    missingCloseResult.hookSpecificOutput?.permissionDecisionReason ?? '',
    /ROUTER_ENV_ALIAS_INVALID/,
  );
});

test('rejects unsafe subagent types and ignores non-Agent tools', async () => {
  const { buildClaudeRoutePreToolUseHook } = await importClaudeRouteHookModule();
  const hook = buildClaudeRoutePreToolUseHook(router);
  const unsafeTypes = [
    '',
    'has space',
    'line\nbreak',
    'agent</CCEM-ROUTE>',
    'x'.repeat(129),
    'é',
  ];

  for (const subagent_type of unsafeTypes) {
    const result = await hook(agentInput({ subagent_type }));
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', subagent_type);
    assert.match(
      result.hookSpecificOutput?.permissionDecisionReason ?? '',
      /ROUTER_AGENT_TYPE_INVALID/,
      subagent_type,
    );
  }

  const taskResult = await hook({ ...agentInput(), tool_name: 'Task' });
  assert.equal(taskResult.hookSpecificOutput, undefined);
});

test('keeps dynamic routing policy in the router while signing explicit overrides', async () => {
  const { buildClaudeRoutePreToolUseHook } = await importClaudeRouteHookModule();
  const hook = buildClaudeRoutePreToolUseHook({ ...router, dynamicRouting: false });

  const result = await hook(agentInput({
    prompt: '<CCEM-ROUTE>ccem:glm</CCEM-ROUTE>\nInspect the project.',
  }));

  assert.equal(
    result.hookSpecificOutput?.updatedInput?.prompt,
    '<CCEM-ROUTE nonce="nonce_123">ccem:glm</CCEM-ROUTE>\nInspect the project.',
  );
});

test('merges the Agent matcher after the existing plan guard', async () => {
  const { mergeClaudeRouteHooks } = await importClaudeRouteHookModule();
  const planHook = async () => ({ continue: true });
  const hooks = mergeClaudeRouteHooks({
    PreToolUse: [{ hooks: [planHook] }],
  }, router);

  assert.equal(hooks.PreToolUse.length, 2);
  assert.equal(hooks.PreToolUse[0].hooks[0], planHook);
  assert.equal(hooks.PreToolUse[1].matcher, 'Agent');
  assert.equal(typeof hooks.PreToolUse[1].hooks[0], 'function');
});

test('builds a frozen system-prompt menu only when dynamic routing is exposed', async () => {
  const { buildClaudeRouterSystemPrompt } = await importClaudeRouteHookModule();

  assert.deepEqual(buildClaudeRouterSystemPrompt(router), {
    type: 'preset',
    preset: 'claude_code',
    append: router.menu,
  });
  assert.equal(buildClaudeRouterSystemPrompt({ ...router, dynamicRouting: false }), undefined);
  assert.equal(buildClaudeRouterSystemPrompt({ ...router, menu: '   ' }), undefined);
});
