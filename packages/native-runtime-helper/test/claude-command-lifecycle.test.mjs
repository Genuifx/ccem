import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  buildHelperWithWireMock,
  spawnTrackedHelper,
  send,
  waitForOutput,
  sleep,
  isLifecycle,
  lifecycleCount,
  readyCount,
  startHelper,
} from './claude-command-lifecycle-harness.mjs';

test('FullLifecycle caches pre-init frames and Result is observation until completed', async (t) => {
  const session = await startHelper(t, {
    scenario: 'preinit_full',
    terminalDelayMs: 250,
  }, {
    initial_prompt: 'initial correlated prompt',
    initial_command_id: 'cmd-one',
  });

  await waitForOutput(session, (output) => isLifecycle(
    output,
    'turn_result_observed',
    'cmd-one',
  ), 'Result observation');

  const metaIndex = session.outputs.findIndex((output) => output.type === 'session_meta'
    && output.query_generation === 1
    && Array.isArray(output.capabilities)
    && output.capabilities.includes('msg_lifecycle_v1'));
  const queuedIndex = session.outputs.findIndex((output) => isLifecycle(
    output,
    'sdk_command_state',
    'cmd-one',
    'queued',
  ));
  assert.ok(metaIndex >= 0 && queuedIndex > metaIndex, 'negotiated meta must precede cached frame flush');

  const readyAtResult = readyCount(session);
  send(session, { type: 'prompt', text: 'overlap', command_id: 'cmd-two' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_rejected',
    'cmd-two',
  ), 'overlap rejection');
  await sleep(80);
  assert.equal(lifecycleCount(session, 'sdk_command_state', 'cmd-one'), 2);
  assert.equal(readyCount(session), readyAtResult);

  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'cmd-one',
    'completed',
  ), 'matching completed terminal');
  send(session, { type: 'prompt', text: 'after terminal', command_id: 'cmd-two' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_admitted',
    'cmd-two',
  ), 'admission after completed');
});

test('LegacySerial is explicit and releases only after Result plus idle', async (t) => {
  const session = await startHelper(t, {
    scenario: 'legacy',
    terminalDelayMs: 250,
  }, {
    provider_session_id: 'resume-session',
  });

  await waitForOutput(session, (output) => output.type === 'session_meta'
    && output.query_generation === 1
    && Object.hasOwn(output, 'capabilities')
    && Array.isArray(output.capabilities)
    && output.capabilities.length === 0, 'explicit LegacySerial meta');
  const negotiating = session.outputs.find((output) => output.type === 'session_meta'
    && output.query_generation === 1
    && !Object.hasOwn(output, 'capabilities'));
  assert.ok(negotiating, 'negotiating meta must omit capabilities');

  send(session, { type: 'prompt', text: 'legacy turn', command_id: 'legacy-one' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'turn_result_observed',
    'legacy-one',
  ), 'legacy Result observation');
  const readyAtResult = readyCount(session);
  assert.equal(lifecycleCount(session, 'legacy_turn_terminal', 'legacy-one'), 0);
  await sleep(80);
  assert.equal(readyCount(session), readyAtResult);

  await waitForOutput(session, (output) => isLifecycle(
    output,
    'legacy_turn_terminal',
    'legacy-one',
  ), 'legacy Result plus idle terminal');
});

test('capability negotiation requires an explicit list and rejects contradictory pre-init frames', async (t) => {
  await t.test('absent capabilities stay negotiating', async (t) => {
    const session = await startHelper(t, { scenario: 'missing_capabilities' });
    send(session, { type: 'prompt', text: 'no capability list', command_id: 'negotiating-one' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'turn_result_observed',
      'negotiating-one',
    ), 'Result while capability negotiation remains open');
    await sleep(100);
    const metas = session.outputs.filter((output) => output.type === 'session_meta'
      && output.query_generation === 1);
    assert.ok(metas.length > 0);
    assert.equal(metas.some((output) => Object.hasOwn(output, 'capabilities')), false);
    assert.equal(lifecycleCount(session, 'legacy_turn_terminal', 'negotiating-one'), 0);
    send(session, { type: 'prompt', text: 'still blocked', command_id: 'negotiating-two' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'command_rejected',
      'negotiating-two',
    ), 'negotiating foreground remains owned');
  });

  await t.test('explicit legacy conflicts with pre-init lifecycle evidence', async (t) => {
    const session = await startHelper(t, { scenario: 'preinit_legacy' }, {
      initial_prompt: 'contradictory wire',
      initial_command_id: 'preinit-legacy-one',
    });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'lifecycle_protocol_error',
      'preinit-legacy-one',
    ), 'pre-init lifecycle and legacy capability conflict');
    assert.equal(lifecycleCount(session, 'legacy_turn_terminal', 'preinit-legacy-one'), 0);
  });
});

test('FullLifecycle accepts every matching raw terminal and ignores mismatches', async (t) => {
  for (const state of ['cancelled', 'discarded', 'refused']) {
    await t.test(state, async (t) => {
      const session = await startHelper(t, { scenario: 'terminal_only', terminalState: state });
      send(session, { type: 'prompt', text: state, command_id: `terminal-${state}` });
      await waitForOutput(session, (output) => isLifecycle(
        output,
        'sdk_command_state',
        `terminal-${state}`,
        state,
      ), `${state} terminal`);
      send(session, { type: 'prompt', text: 'next', command_id: `after-${state}` });
      await waitForOutput(session, (output) => isLifecycle(
        output,
        'command_admitted',
        `after-${state}`,
      ), `admission after ${state}`);
    });
  }

  await t.test('mismatched terminal', async (t) => {
    const session = await startHelper(t, {
      scenario: 'mismatched_terminal',
      terminalDelayMs: 220,
    });
    send(session, { type: 'prompt', text: 'match me', command_id: 'matching-terminal' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'sdk_command_state',
      'another-command',
      'completed',
    ), 'mismatched terminal observation');
    const readyBeforeMatch = readyCount(session);
    send(session, { type: 'prompt', text: 'too early', command_id: 'before-match' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'command_rejected',
      'before-match',
    ), 'mismatched terminal cannot release foreground');
    await sleep(80);
    assert.equal(readyCount(session), readyBeforeMatch);
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'sdk_command_state',
      'matching-terminal',
      'completed',
    ), 'matching terminal after mismatch');
  });
});

test('malformed or missing FullLifecycle terminals poison the active command', async (t) => {
  await t.test('malformed matching state', async (t) => {
    const session = await startHelper(t, { scenario: 'malformed_state' });
    send(session, { type: 'prompt', text: 'bad state', command_id: 'malformed-one' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'lifecycle_protocol_error',
      'malformed-one',
    ), 'malformed matching state protocol error');
  });

  await t.test('idle without Result or terminal', async (t) => {
    const session = await startHelper(t, { scenario: 'idle_without_terminal' }, {}, {
      CCEM_NATIVE_LIFECYCLE_TERMINAL_TIMEOUT_MS: '100',
    });
    send(session, { type: 'prompt', text: 'idle without terminal', command_id: 'idle-missing-one' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'lifecycle_protocol_error',
      'idle-missing-one',
    ), 'idle missing terminal protocol error');
  });
});

test('a terminal-before-Result keeps late usage detached from the next command', async (t) => {
  const session = await startHelper(t, {
    scenario: 'terminal_before_result',
    terminalDelayMs: 220,
  });
  send(session, { type: 'prompt', text: 'first', command_id: 'late-result-one' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'late-result-one',
    'completed',
  ), 'first terminal before Result');
  send(session, { type: 'prompt', text: 'second', command_id: 'late-result-two' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_admitted',
    'late-result-two',
  ), 'second admission before late Result');
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'turn_result_observed',
    'late-result-one',
  ), 'late first Result observation');
  assert.equal(lifecycleCount(session, 'turn_result_observed', 'late-result-two'), 0);
  assert.ok(session.outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'token_usage'
    && output.payload.scope === 'turn_total'));
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'late-result-two',
    'completed',
  ), 'second terminal remains independently correlated');
});

test('conversation_reset before or after terminal never releases or double-completes', async (t) => {
  await t.test('reset before terminal', async (t) => {
    const session = await startHelper(t, {
      scenario: 'reset_before',
      terminalDelayMs: 200,
    });
    send(session, { type: 'prompt', text: '/clear', command_id: 'clear-one' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'conversation_reset',
      'clear-one',
    ), 'conversation reset observation');
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'turn_result_observed',
      'clear-one',
    ), 'clear Result observation');
    send(session, { type: 'prompt', text: 'too early', command_id: 'after-clear' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'command_rejected',
      'after-clear',
    ), 'reset must not release foreground');
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'sdk_command_state',
      'clear-one',
      'completed',
    ), 'clear terminal');
  });

  await t.test('reset after terminal', async (t) => {
    const session = await startHelper(t, { scenario: 'reset_after' });
    send(session, { type: 'prompt', text: '/clear', command_id: 'clear-after' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'sdk_command_state',
      'clear-after',
      'completed',
    ), 'terminal before reset');
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'conversation_reset',
      undefined,
    ), 'late reset observation');
    assert.equal(lifecycleCount(session, 'sdk_command_state', 'clear-after'), 3);
    send(session, { type: 'prompt', text: 'next', command_id: 'after-late-reset' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'command_admitted',
      'after-late-reset',
    ), 'late reset leaves next admission open');
  });
});

test('matching unknown lifecycle state poisons the query', async (t) => {
  const session = await startHelper(t, { scenario: 'unknown' });
  send(session, { type: 'prompt', text: 'unknown state', command_id: 'unknown-one' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'lifecycle_protocol_error',
    'unknown-one',
  ), 'unknown state protocol error');
  const readyAtError = readyCount(session);
  await sleep(100);
  assert.equal(lifecycleCount(session, 'sdk_command_state', 'unknown-one'), 1);
  assert.equal(readyCount(session), readyAtError);
  send(session, { type: 'prompt', text: 'must remain blocked', command_id: 'unknown-two' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_rejected',
    'unknown-two',
  ), 'poisoned foreground rejection');
});

test('advertised lifecycle without terminal poisons after a bounded deadline', async (t) => {
  const session = await startHelper(t, { scenario: 'missing_terminal' }, {}, {
    CCEM_NATIVE_LIFECYCLE_TERMINAL_TIMEOUT_MS: '100',
  });
  send(session, { type: 'prompt', text: 'missing terminal', command_id: 'missing-one' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'turn_result_observed',
    'missing-one',
  ), 'Result before missing terminal');
  const readyAtResult = readyCount(session);
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'lifecycle_protocol_error',
    'missing-one',
  ), 'missing terminal protocol error');
  assert.equal(lifecycleCount(session, 'legacy_turn_terminal', 'missing-one'), 0);
  assert.equal(readyCount(session), readyAtResult);
});

test('coordinator-stamped prompt query failure is delivery_uncertain and never replayed', async (t) => {
  const session = await startHelper(t, { scenario: 'query_failure' });
  send(session, { type: 'prompt', text: 'ambiguous delivery', command_id: 'uncertain-one' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'delivery_uncertain',
    'uncertain-one',
  ), 'delivery uncertain');
  await sleep(200);
  assert.equal(lifecycleCount(session, 'command_admitted', 'uncertain-one'), 1);
  assert.equal(lifecycleCount(session, 'sdk_command_state', 'uncertain-one'), 0);
  send(session, { type: 'prompt', text: 'must not overlap uncertainty', command_id: 'uncertain-two' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_rejected',
    'uncertain-two',
  ), 'uncertain foreground rejection');
});

test('LegacySerial interrupt emits an explicit terminal before accepting the next prompt', async (t) => {
  const session = await startHelper(t, { scenario: 'legacy', resultDelayMs: 250 });
  send(session, { type: 'prompt', text: 'interrupt legacy', command_id: 'legacy-interrupt-one' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_admitted',
    'legacy-interrupt-one',
  ), 'legacy interrupt target admitted');
  send(session, { type: 'interrupt_turn' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'legacy_turn_terminal',
    'legacy-interrupt-one',
  ), 'legacy interrupt terminal');
  send(session, { type: 'prompt', text: 'after legacy interrupt', command_id: 'legacy-interrupt-two' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_admitted',
    'legacy-interrupt-two',
  ), 'admission after legacy interrupt');
});

test('FullLifecycle interrupt waits for the matching cancelled terminal', async (t) => {
  const session = await startHelper(t, {
    scenario: 'full_interrupt',
    terminalDelayMs: 250,
  });
  send(session, { type: 'prompt', text: 'interrupt me', command_id: 'interrupt-one' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'interrupt-one',
    'started',
  ), 'interrupt target started');
  const readyBeforeInterrupt = readyCount(session);
  send(session, { type: 'interrupt_turn' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'interrupt_requested',
  ), 'interrupt request');
  send(session, { type: 'prompt', text: 'too early', command_id: 'interrupt-two' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_rejected',
    'interrupt-two',
  ), 'prompt rejected before interrupt terminal');
  await sleep(80);
  assert.equal(readyCount(session), readyBeforeInterrupt);
  assert.equal(lifecycleCount(session, 'turn_interrupted', 'interrupt-one'), 0);
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'interrupt-one',
    'cancelled',
  ), 'matching cancelled terminal');
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'turn_interrupted',
    'interrupt-one',
  ), 'interrupted projection after raw terminal');
  send(session, { type: 'prompt', text: 'after interrupt', command_id: 'interrupt-three' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_admitted',
    'interrupt-three',
  ), 'admission after interrupt terminal');
});

test('concurrent stamped admissions cannot overwrite foreground ownership', async (t) => {
  await t.test('two prompt commands in one tick', async (t) => {
    const session = await startHelper(t, { scenario: 'full', resultDelayMs: 250 });
    send(session, { type: 'prompt', text: 'first race', command_id: 'race-one' });
    send(session, { type: 'prompt', text: 'second race', command_id: 'race-two' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'command_rejected',
      'race-two',
    ) || isLifecycle(output, 'command_rejected', 'race-one'), 'one racing command rejected');
    const admitted = session.outputs.filter((output) => isLifecycle(output, 'command_admitted')
      && ['race-one', 'race-two'].includes(output.payload.command_id));
    assert.equal(admitted.length, 1);
  });

  await t.test('initial prompt owns foreground before initialized ready is observable', async (t) => {
    const session = await startHelper(t, { scenario: 'full', resultDelayMs: 250 }, {
      initial_prompt: 'initial owner',
      initial_command_id: 'initial-owner',
    });
    send(session, { type: 'prompt', text: 'immediate follower', command_id: 'initial-follower' });
    await waitForOutput(session, (output) => isLifecycle(
      output,
      'command_rejected',
      'initial-follower',
    ), 'immediate follower rejected');
    assert.equal(lifecycleCount(session, 'command_admitted', 'initial-owner'), 1);
    assert.equal(lifecycleCount(session, 'command_admitted', 'initial-follower'), 0);
  });
});

test('initial prompt setup failure rejects the registered command explicitly', async (t) => {
  const built = await buildHelperWithWireMock({ scenario: 'full' });
  const session = spawnTrackedHelper(t, built);
  send(session, {
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    provider_session_id: 'parent-session',
    fork_session: true,
    initial_prompt: 'fork then run',
    initial_command_id: 'initial-fork-command',
  });

  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_rejected',
    'initial-fork-command',
  ), 'initial command rejection');
  assert.equal(lifecycleCount(session, 'command_admitted', 'initial-fork-command'), 0);
});

test('prompt arriving during no-initial-prompt setup waits for initialization settled', async (t) => {
  const built = await buildHelperWithWireMock({ scenario: 'full' });
  t.after(async () => {
    await fs.rm(built.tempDir, { recursive: true, force: true });
  });
  const session = spawnTrackedHelper(t, built);
  send(session, {
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
  });
  send(session, { type: 'prompt', text: 'early follower', command_id: 'early-follower' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'initialization_settled',
  ), 'initialization settled');
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_admitted',
    'early-follower',
  ), 'early follower admitted');
  const settledIndex = session.outputs.findIndex((output) => isLifecycle(
    output,
    'initialization_settled',
  ));
  const admittedIndex = session.outputs.findIndex((output) => isLifecycle(
    output,
    'command_admitted',
    'early-follower',
  ));
  assert.ok(settledIndex >= 0 && settledIndex < admittedIndex);
});

test('interrupt reconciles a command that never entered the helper foreground', async (t) => {
  const session = await startHelper(t, { scenario: 'full' });
  send(session, {
    type: 'interrupt_turn',
    expected_command_id: 'missing-admission',
  });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_abandoned',
    'missing-admission',
  ), 'abandoned command receipt');
  assert.equal(lifecycleCount(session, 'command_admitted', 'missing-admission'), 0);
});

test('interrupt atomically cancels a normal command pending helper admission', async (t) => {
  const session = await startHelper(t, { scenario: 'full' });
  send(session, { type: 'prompt', text: 'cancel before admission', command_id: 'pending-normal' });
  send(session, {
    type: 'interrupt_turn',
    expected_command_id: 'pending-normal',
  });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_abandoned',
    'pending-normal',
  ), 'pending normal command abandoned');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(lifecycleCount(session, 'command_admitted', 'pending-normal'), 0);
});

test('interrupt atomically cancels an initial command during async fork setup', async (t) => {
  const built = await buildHelperWithWireMock({ scenario: 'slow_fork' });
  t.after(async () => {
    await fs.rm(built.tempDir, { recursive: true, force: true });
  });
  const session = spawnTrackedHelper(t, built);
  send(session, {
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    provider_session_id: 'parent-session',
    fork_session: true,
    initial_prompt: 'cancel forked initial',
    initial_command_id: 'pending-initial',
  });
  send(session, {
    type: 'interrupt_turn',
    expected_command_id: 'pending-initial',
  });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_abandoned',
    'pending-initial',
  ), 'pending initial command abandoned');
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(lifecycleCount(session, 'command_admitted', 'pending-initial'), 0);
});

test('cancelling a slow pre-admission command does not strand its queued follower', async (t) => {
  const built = await buildHelperWithWireMock({ scenario: 'slow_fork' });
  t.after(async () => {
    await fs.rm(built.tempDir, { recursive: true, force: true });
  });
  const session = spawnTrackedHelper(t, built);
  send(session, {
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    provider_session_id: 'parent-session',
    fork_session: true,
    initial_prompt: 'cancel slow owner',
    initial_command_id: 'slow-owner',
  });
  send(session, {
    type: 'interrupt_turn',
    expected_command_id: 'slow-owner',
  });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_abandoned',
    'slow-owner',
  ), 'slow owner abandoned');
  send(session, { type: 'prompt', text: 'queued follower', command_id: 'queued-follower' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    lifecycleCount(session, 'command_admitted', 'queued-follower'),
    0,
    'follower must wait for fork identity to settle',
  );
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_admitted',
    'queued-follower',
  ), 'queued follower admitted after cancellation');
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'queued-follower',
    'completed',
  ), 'queued follower completed');
  assert.equal(lifecycleCount(session, 'command_admitted', 'slow-owner'), 0);
});

test('failed slow initialization rejects its follower before publishing fatal status', async (t) => {
  const built = await buildHelperWithWireMock({ scenario: 'slow_fork_failure' });
  t.after(async () => {
    await fs.rm(built.tempDir, { recursive: true, force: true });
  });
  const session = spawnTrackedHelper(t, built);
  send(session, {
    type: 'init',
    provider: 'claude',
    env_name: 'default',
    perm_mode: 'dev',
    working_dir: os.tmpdir(),
    provider_session_id: 'parent-session',
    fork_session: true,
    initial_prompt: 'cancel failing owner',
    initial_command_id: 'failing-owner',
  });
  send(session, { type: 'interrupt_turn', expected_command_id: 'failing-owner' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_abandoned',
    'failing-owner',
  ), 'failing owner abandoned');
  send(session, { type: 'prompt', text: 'failure follower', command_id: 'failure-follower' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_rejected',
    'failure-follower',
  ), 'failure follower rejected');
  await waitForOutput(session, (output) => output.type === 'status'
    && output.status === 'error', 'initialization fatal status');
  const followerRejectionIndex = session.outputs.findIndex((output) => isLifecycle(
    output,
    'command_rejected',
    'failure-follower',
  ));
  const fatalStatusIndex = session.outputs.findIndex((output) => output.type === 'status'
    && output.status === 'error');
  assert.ok(followerRejectionIndex >= 0 && followerRejectionIndex < fatalStatusIndex);
  assert.equal(lifecycleCount(session, 'command_admitted', 'failure-follower'), 0);
});

test('permission-only settings failure emits the exact failed ACK', async (t) => {
  const session = await startHelper(t, {
    scenario: 'full',
    resultDelayMs: 180,
    permissionModeDelays: { plan: -1 },
  });
  send(session, { type: 'prompt', text: 'live owner', command_id: 'live-settings-owner' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'live-settings-owner',
    'started',
  ), 'live owner started');
  send(session, {
    type: 'update_settings',
    request_id: 'permission-failure',
    perm_mode: 'plan',
  });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'runtime_settings_changed'
    && output.payload.request_id === 'permission-failure'
    && output.payload.state === 'failed', 'permission failure ACK');
  assert.equal(session.outputs.some((output) => output.type === 'status'
    && output.status === 'error'), false);
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'live-settings-owner',
    'completed',
  ), 'live owner survives failed settings');
});

test('interrupt never abandons a different live helper foreground', async (t) => {
  const session = await startHelper(t, { scenario: 'full', resultDelayMs: 250 });
  send(session, { type: 'prompt', text: 'active', command_id: 'actual-active' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'command_admitted',
    'actual-active',
  ), 'active admission');
  send(session, {
    type: 'interrupt_turn',
    expected_command_id: 'stale-target',
  });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'interrupt_target_mismatch',
    'stale-target',
  ), 'mismatched interrupt target');
  assert.equal(lifecycleCount(session, 'command_abandoned', 'stale-target'), 0);
});

test('interactive resolver redelivery is generation-bound', async (t) => {
  const session = await startHelper(t, { scenario: 'interactive_redelivery' });
  send(session, { type: 'prompt', text: 'first question', command_id: 'interactive-one' });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'tool_use_started'
    && output.payload.tool_use_id === 'shared-interactive-tool', 'first interactive resolver');
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'interactive-one',
    'completed',
  ), 'first query terminal');
  send(session, { type: 'prompt', text: 'redelivered question', command_id: 'interactive-two' });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'interactive_response_result'
    && output.payload.tool_use_id === 'shared-interactive-tool'
    && output.payload.query_generation === 1
    && output.payload.state === 'resolver_expired', 'first-generation resolver expired');
  await waitForOutput(session, () => session.outputs.filter((output) => output.type === 'event'
    && output.payload?.type === 'tool_use_started'
    && output.payload.tool_use_id === 'shared-interactive-tool').length >= 2, 'second-generation resolver');
  await waitForOutput(session, (output) => output.type === 'session_meta'
    && output.query_generation === 2
    && output.capabilities?.includes('msg_lifecycle_v1'), 'second query negotiation');
  send(session, {
    type: 'interactive_prompt_response',
    control_request_id: 'interactive-control-stale',
    expected_query_generation: 1,
    tool_use_id: 'shared-interactive-tool',
    prompt_type: 'ask_user_question',
    answers: { decision: 'No' },
  });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'interactive_response_result'
    && output.payload.control_request_id === 'interactive-control-stale'
    && output.payload.query_generation === 2
    && output.payload.state === 'generation_mismatch', 'stale expected generation rejected');
  send(session, {
    type: 'interactive_prompt_response',
    control_request_id: 'interactive-control-two',
    expected_query_generation: 2,
    tool_use_id: 'shared-interactive-tool',
    prompt_type: 'ask_user_question',
    answers: { decision: 'Yes' },
  });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'interactive_response_result'
    && output.payload.control_request_id === 'interactive-control-two'
    && output.payload.query_generation === 2
    && output.payload.state === 'applied', 'second-generation interactive ACK');
});

test('interrupt expires the live foreground interactive resolver', async (t) => {
  const session = await startHelper(t, { scenario: 'interactive_wait' });
  send(session, { type: 'prompt', text: 'interrupt question', command_id: 'interactive-interrupt' });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'tool_use_started'
    && output.payload.tool_use_id === 'shared-interactive-tool', 'interactive resolver before interrupt');
  send(session, {
    type: 'interrupt_turn',
    expected_command_id: 'interactive-interrupt',
  });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'interactive_response_result'
    && output.payload.tool_use_id === 'shared-interactive-tool'
    && output.payload.query_generation === 1
    && output.payload.state === 'resolver_expired', 'interactive resolver expired on interrupt');
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'tool_use_completed'
    && output.payload.tool_use_id === 'shared-interactive-tool'
    && output.payload.success === false, 'interrupted interactive tool completed as denied');
  const expiredIndex = session.outputs.findIndex((output) => output.type === 'event'
    && output.payload?.type === 'interactive_response_result'
    && output.payload.tool_use_id === 'shared-interactive-tool'
    && output.payload.state === 'resolver_expired');
  const completedIndex = session.outputs.findIndex((output) => output.type === 'event'
    && output.payload?.type === 'tool_use_completed'
    && output.payload.tool_use_id === 'shared-interactive-tool');
  assert.ok(expiredIndex >= 0 && expiredIndex < completedIndex);
});

test('interactive response prompt type mismatch does not consume the Plan resolver', async (t) => {
  const session = await startHelper(t, { scenario: 'interactive_plan' });
  send(session, { type: 'prompt', text: 'review plan', command_id: 'interactive-plan' });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'tool_use_started'
    && output.payload.tool_use_id === 'shared-interactive-tool'
    && output.payload.prompt?.prompt_type === 'plan_exit', 'Plan interactive resolver');
  send(session, {
    type: 'interactive_prompt_response',
    control_request_id: 'interactive-plan-wrong-type',
    expected_query_generation: 1,
    tool_use_id: 'shared-interactive-tool',
    prompt_type: 'ask_user_question',
    answers: { decision: 'Yes' },
  });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'interactive_response_result'
    && output.payload.control_request_id === 'interactive-plan-wrong-type'
    && output.payload.query_generation === 1
    && output.payload.state === 'prompt_type_mismatch', 'wrong prompt type rejected');
  send(session, {
    type: 'interactive_prompt_response',
    control_request_id: 'interactive-plan-correct-type',
    expected_query_generation: 1,
    tool_use_id: 'shared-interactive-tool',
    prompt_type: 'plan_exit',
    answers: { decision: 'approve' },
  });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'interactive_response_result'
    && output.payload.control_request_id === 'interactive-plan-correct-type'
    && output.payload.query_generation === 1
    && output.payload.state === 'applied', 'correct Plan response applied after mismatch');
});

test('deferred settings apply only after the FullLifecycle terminal', async (t) => {
  const session = await startHelper(t, {
    scenario: 'full',
    resultDelayMs: 180,
    terminalDelayMs: 80,
    idleDelayMs: 300,
  });
  send(session, { type: 'prompt', text: 'settings turn', command_id: 'settings-one' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'settings-one',
    'started',
  ), 'settings turn started');
  send(session, {
    type: 'update_settings',
    request_id: 'settings-request',
    env_name: 'next-env',
  });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'runtime_settings_changed'
    && output.payload.request_id === 'settings-request'
    && output.payload.state === 'deferred', 'deferred settings ACK');
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'turn_result_observed',
    'settings-one',
  ), 'settings turn Result');
  assert.equal(session.outputs.some((output) => output.type === 'event'
    && output.payload?.type === 'runtime_settings_changed'
    && output.payload.request_id === 'settings-request'
    && output.payload.state === 'applied'), false);
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'settings-one',
    'completed',
  ), 'settings turn terminal');
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'runtime_settings_changed'
    && output.payload.request_id === 'settings-request'
    && output.payload.state === 'applied', 'applied settings ACK after terminal', 150);
});

test('missing permission resolver emits a terminal expiry receipt', async (t) => {
  const session = await startHelper(t, { scenario: 'full' });
  send(session, {
    type: 'permission_response',
    request_id: 'permission-from-retired-helper',
    approved: true,
  });

  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'permission_responded'
    && output.payload.request_id === 'permission-from-retired-helper'
    && output.payload.approved === false
    && output.payload.responder === 'resolver_expired', 'permission resolver expiry receipt');
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'permission_response_stale',
    undefined,
    'permission-from-retired-helper',
  ), 'stale permission diagnostic');
});

test('permission-only settings ACK does not emit ready during a live turn', async (t) => {
  const session = await startHelper(t, {
    scenario: 'full',
    resultDelayMs: 220,
  });
  send(session, { type: 'prompt', text: 'plan turn', command_id: 'plan-one' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'plan-one',
    'started',
  ), 'plan turn started');
  const readyBefore = readyCount(session);
  send(session, {
    type: 'update_settings',
    request_id: 'plan-mode-request',
    perm_mode: 'plan',
  });
  await waitForOutput(session, (output) => output.type === 'event'
    && output.payload?.type === 'runtime_settings_changed'
    && output.payload.request_id === 'plan-mode-request'
    && output.payload.state === 'applied', 'permission settings applied ACK');
  assert.equal(readyCount(session), readyBefore);
});

test('same-generation permission settings are applied and acknowledged in wire order', async (t) => {
  const session = await startHelper(t, {
    scenario: 'full',
    resultDelayMs: 250,
    permissionModeDelays: { plan: 80, dev: 0 },
  });
  send(session, { type: 'prompt', text: 'settings ordering', command_id: 'settings-order-turn' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'settings-order-turn',
    'started',
  ), 'settings ordering turn started');
  send(session, {
    type: 'update_settings',
    request_id: 'settings-order-a',
    perm_mode: 'plan',
  });
  send(session, {
    type: 'update_settings',
    request_id: 'settings-order-b',
    perm_mode: 'dev',
  });
  await waitForOutput(session, () => session.outputs.filter((output) => output.type === 'event'
    && output.payload?.type === 'runtime_settings_changed'
    && ['settings-order-a', 'settings-order-b'].includes(output.payload.request_id)
    && output.payload.state === 'applied').length === 2, 'both ordered settings ACKs');

  const appliedOrder = session.outputs
    .filter((output) => output.type === 'event'
      && output.payload?.type === 'runtime_settings_changed'
      && ['settings-order-a', 'settings-order-b'].includes(output.payload.request_id)
      && output.payload.state === 'applied')
    .map((output) => output.payload.request_id);
  assert.deepEqual(appliedOrder, ['settings-order-a', 'settings-order-b']);
});

test('hung usage probes do not block the next FullLifecycle terminal', async (t) => {
  const session = await startHelper(t, { scenario: 'full', usageHangs: true });
  send(session, { type: 'prompt', text: 'first usage turn', command_id: 'usage-one' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'usage-one',
    'completed',
  ), 'first raw terminal');
  send(session, { type: 'prompt', text: 'second usage turn', command_id: 'usage-two' });
  await waitForOutput(session, (output) => isLifecycle(
    output,
    'sdk_command_state',
    'usage-two',
    'completed',
  ), 'second raw terminal despite hung usage');
});
