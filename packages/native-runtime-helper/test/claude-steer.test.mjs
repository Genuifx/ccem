import test from 'node:test';
import assert from 'node:assert/strict';
import {send,waitForOutput,sleep,isLifecycle,lifecycleCount,readyCount} from './claude-command-lifecycle-harness.mjs';
import {startSteerHelper,startRoot,steer,releaseGate,isProbe} from './claude-steer-harness.mjs';

const events = (session, type) => session.outputs.filter((output) => output.type === 'event' && output.payload?.type === type).map((output) => output.payload);
const waitLifecycle = (session, stage, id, detail) => waitForOutput(session,
  (output) => isLifecycle(output,stage,id,detail), `${stage} ${id} ${detail ?? ''}`);

test('steer crosses a live tool boundary without interrupting or replacing the root operation', async (t) => {
  const session = await startSteerHelper(t);
  await startRoot(session);
  const readyBeforeSteer = readyCount(session);
  steer(session);
  await waitLifecycle(session,'steer_admitted','steer-one');
  const input = await waitForOutput(session,(output) => isProbe(output,'sdk_input','steer-one'),'concurrent steer SDK input');
  assert.equal(input.priority,'next');
  assert.equal(session.outputs.some((output) => isProbe(output,'interrupt')),false);
  assert.equal(lifecycleCount(session,'command_admitted','steer-one'),0);

  send(session,{type:'prompt',text:'must remain busy',command_id:'ordinary-overlap'});
  await waitLifecycle(session,'command_rejected','ordinary-overlap');
  await releaseGate(session,'root-one','boundary');
  await waitLifecycle(session,'steer_command_state','steer-one','completed');
  assert.equal(lifecycleCount(session,'turn_completed','root-one'),0,'child completion must not finish its parent');
  assert.equal(readyCount(session),readyBeforeSteer);
  send(session,{type:'prompt',text:'child completed but parent owns turn',command_id:'after-child'});
  await waitLifecycle(session,'command_rejected','after-child');

  await releaseGate(session,'root-one','result','terminal');
  await waitLifecycle(session,'turn_completed','root-one');
  assert.equal(lifecycleCount(session,'turn_completed','root-one'),1);
  assert.equal(lifecycleCount(session,'turn_completed','steer-one'),0);
  assert.equal(lifecycleCount(session,'turn_result_observed','root-one'),1);
  assert.equal(lifecycleCount(session,'turn_result_observed','steer-one'),0);
  const completed = events(session,'input_operation').filter((event) => event.stage === 'completed');
  assert.equal(completed.length,1);
  assert.equal(completed[0].command_id,'root-one');
  assert.deepEqual(completed[0].client_message_ids,['client-root-one','client-steer-one']);
  const started = events(session,'input_operation').filter((event) => event.stage === 'started');
  assert.equal(started.length,1,'steer must preserve the one transcript operation');
  assert.equal(started[0].operation_id,completed[0].operation_id);
  assert.equal(events(session,'assistant_chunk').filter((event) => event.text.includes('STEER_ACK_4729')).length,1);
  assert.equal(events(session,'tool_use_completed').filter((event) => event.tool_use_id === 'boundary-root-one').length,1);
  assert.equal(session.outputs.some((output) => isProbe(output,'unexpected_overlap')),false);

  await startRoot(session,'root-two');
  await releaseGate(session,'root-two','boundary','result','terminal');
  await waitLifecycle(session,'turn_completed','root-two');
  assert.equal(lifecycleCount(session,'turn_result_observed','root-two'),1);
});

test('steer rejects stale fences, slash commands and empty text before SDK delivery', async (t) => {
  const session = await startSteerHelper(t);
  steer(session,{command_id:'no-active'});
  await waitLifecycle(session,'steer_rejected','no-active');
  await startRoot(session);
  for (const [command_id,overrides] of [
    ['stale-parent',{expected_command_id:'old-root'}],
    ['stale-generation',{expected_query_generation:0}],
    ['slash',{text:'/compact'}],
    ['empty',{text:'   '}],
    ['root-one',{}],
  ]) {
    steer(session,{command_id,...overrides});
    await waitLifecycle(session,'steer_rejected',command_id);
    assert.equal(lifecycleCount(session,'steer_admitted',command_id),0);
  }
  assert.deepEqual(session.outputs.filter((output) => isProbe(output,'sdk_input')).map((output) => output.command_id),['root-one']);
  assert.equal(lifecycleCount(session,'turn_completed','root-one'),0);
  await releaseGate(session,'root-one','boundary','result','terminal');
  await waitLifecycle(session,'turn_completed','root-one');
});

test('LegacySerial explicitly rejects injection and keeps its foreground turn running', async (t) => {
  const session = await startSteerHelper(t,{capabilities:[]});
  await startRoot(session);
  steer(session);
  await waitLifecycle(session,'steer_rejected','steer-one');
  assert.equal(session.outputs.some((output) => isProbe(output,'sdk_input','steer-one')),false);
  assert.equal(session.outputs.some((output) => isProbe(output,'interrupt')),false);
  await releaseGate(session,'root-one','boundary','result','terminal');
  await waitLifecycle(session,'legacy_turn_terminal','root-one');
});

test('duplicate steer transport identity is acknowledged without reinjection, including after terminal', async (t) => {
  const session = await startSteerHelper(t);
  await startRoot(session);
  steer(session);
  await waitLifecycle(session,'steer_admitted','steer-one');
  steer(session);
  await waitForOutput(session,() => lifecycleCount(session,'steer_admitted','steer-one') === 2,'second duplicate ACK');
  await releaseGate(session,'root-one','boundary','result','terminal');
  await waitLifecycle(session,'turn_completed','root-one');
  steer(session);
  await waitForOutput(session,() => lifecycleCount(session,'steer_admitted','steer-one') === 3,'completed duplicate ACK');
  assert.equal(session.outputs.filter((output) => isProbe(output,'sdk_input','steer-one')).length,1);
  assert.equal(session.outputs.filter((output) => isProbe(output,'child_executed','steer-one')).length,1);
  assert.equal(events(session,'input_operation').filter((event) => event.stage === 'completed').length,1);
});

test('root terminal waits for an attached child, and its late result cannot complete the next root', async (t) => {
  const session = await startSteerHelper(t,{mode:'terminal_before_child_result'},
    {CCEM_NATIVE_LIFECYCLE_TERMINAL_TIMEOUT_MS:'80'});
  await startRoot(session);
  steer(session);
  await waitLifecycle(session,'steer_admitted','steer-one');
  await waitLifecycle(session,'steer_command_state','steer-one','queued');
  const readyBeforeTerminal = readyCount(session);
  await releaseGate(session,'root-one','boundary');
  await waitForOutput(session,(output) => isProbe(output,'parent_terminal_sent','root-one'),'SDK parent terminal');
  await sleep(150);
  assert.equal(lifecycleCount(session,'sdk_command_state','root-one') ,2,'raw root terminal must be buffered');
  assert.equal(lifecycleCount(session,'turn_completed','root-one'),0);
  assert.equal(lifecycleCount(session,'lifecycle_protocol_error','root-one'),0,'accepted child execution is not missing-terminal failure');
  assert.equal(readyCount(session),readyBeforeTerminal);
  send(session,{type:'prompt',text:'parent SDK terminal must not release root lease',command_id:'during-child'});
  await waitLifecycle(session,'command_rejected','during-child');

  await releaseGate(session,'root-one','child');
  await waitLifecycle(session,'turn_completed','root-one');
  await startRoot(session,'root-two');
  await releaseGate(session,'root-one','late_result');
  await waitLifecycle(session,'turn_result_observed','root-one');
  assert.equal(lifecycleCount(session,'turn_result_observed','root-two'),0);
  assert.equal(lifecycleCount(session,'turn_completed','root-two'),0);
  assert.equal(lifecycleCount(session,'turn_completed','root-one'),1);
  assert.equal(lifecycleCount(session,'turn_result_observed','steer-one'),0);
  await releaseGate(session,'root-two','boundary','result','terminal');
  await waitLifecycle(session,'turn_completed','root-two');
});

test('Stop cancels queued steers before they can survive the interrupted root', async (t) => {
  const session = await startSteerHelper(t);
  await startRoot(session);
  steer(session);
  await waitLifecycle(session,'steer_command_state','steer-one','queued');
  send(session,{type:'interrupt_turn',expected_command_id:'root-one'});
  await waitLifecycle(session,'turn_interrupted','root-one');
  await sleep(30);
  const interrupt = session.outputs.find((output) => isProbe(output,'interrupt'));
  assert.equal(interrupt?.cancel_queued,true,'Stop must use the cancel-queued SDK control contract');
  assert.equal(session.outputs.some((output) => isProbe(output,'child_executed','steer-one')),false);
  assert.equal(session.outputs.filter((output) => isLifecycle(output,'steer_command_state','steer-one','cancelled')).length,1);
  assert.equal(events(session,'assistant_chunk').some((event) => event.text.includes('SURVIVED_STOP')),false);
  assert.equal(lifecycleCount(session,'steer_failed','steer-one'),0,'user-requested Stop does not add a refused-steer error');
  assert.equal(lifecycleCount(session,'turn_completed','steer-one'),0);
  await startRoot(session,'after-stop');
  await releaseGate(session,'after-stop','boundary','result','terminal');
  await waitLifecycle(session,'turn_completed','after-stop');
});

test('an SDK continuation after the root result stays busy and completes with the steered response', async (t) => {
  const session = await startSteerHelper(t,{mode:'root_result_before_child'},
    {CCEM_NATIVE_LIFECYCLE_TERMINAL_TIMEOUT_MS:'70'});
  await startRoot(session);
  steer(session);
  await waitLifecycle(session,'steer_command_state','steer-one','queued');
  await releaseGate(session,'root-one','boundary');
  await waitLifecycle(session,'turn_result_observed','root-one');
  await waitForOutput(session,(output) => isProbe(output,'parent_terminal_sent','root-one'),'root result then terminal');
  await sleep(130);
  assert.equal(lifecycleCount(session,'lifecycle_protocol_error','root-one'),0,'held root terminal must cancel the result timeout');
  assert.equal(lifecycleCount(session,'turn_completed','root-one'),0);
  steer(session,{command_id:'too-late'});
  await waitLifecycle(session,'steer_rejected','too-late');
  assert.equal(session.outputs.some((output) => isProbe(output,'sdk_input','too-late')),false);
  await releaseGate(session,'root-one','child');
  const completed = await waitLifecycle(session,'turn_completed','root-one');
  assert.match(completed.payload.detail,/CHILD_ACK STEER_ACK_4729/);
  assert.equal(lifecycleCount(session,'turn_completed','root-one'),1);
  assert.equal(lifecycleCount(session,'turn_result_observed','steer-one'),0);
  assert.equal(events(session,'input_operation').filter((event) => event.stage === 'completed').length,1);
});

test('Stop during a pending continuation interrupts the overall root despite its earlier completed SDK terminal', async (t) => {
  const session = await startSteerHelper(t,{mode:'root_result_before_child'});
  await startRoot(session);
  steer(session);
  await waitLifecycle(session,'steer_command_state','steer-one','queued');
  await releaseGate(session,'root-one','boundary');
  await waitForOutput(session,(output) => isProbe(output,'parent_terminal_sent','root-one'),'held root terminal before Stop');
  assert.equal(lifecycleCount(session,'turn_completed','root-one'),0);

  send(session,{type:'interrupt_turn',expected_command_id:'root-one'});
  await waitForOutput(session,(output) => isLifecycle(output,'turn_interrupted','root-one')
    || isLifecycle(output,'turn_completed','root-one'),'overall root terminal after Stop');
  await sleep(30);
  assert.equal(lifecycleCount(session,'turn_interrupted','root-one'),1,'cancelled continuation makes the overall operation interrupted');
  assert.equal(lifecycleCount(session,'turn_completed','root-one'),0,'the earlier SDK success cannot hide unexecuted accepted input');
  assert.equal(session.outputs.filter((output) => isLifecycle(output,'sdk_command_state','root-one','completed')).length,1,'keep the original SDK terminal fence');
  assert.equal(session.outputs.filter((output) => isLifecycle(output,'sdk_command_state','root-one','cancelled')).length,0,'do not invent a second root SDK terminal');
  assert.equal(session.outputs.filter((output) => isLifecycle(output,'steer_command_state','steer-one','cancelled')).length,1);
  assert.equal(lifecycleCount(session,'steer_failed','steer-one'),0,'user-requested Stop is already visible as interruption');
  assert.equal(events(session,'input_operation').filter((event) => event.command_id === 'root-one' && event.stage === 'failed').length,1);
  assert.equal(events(session,'input_operation').filter((event) => event.command_id === 'root-one' && event.stage === 'completed').length,0);
  assert.equal(session.outputs.some((output) => isProbe(output,'child_executed','steer-one')),false);
  assert.equal(events(session,'turn_metrics').length,0,'an interrupted combined operation must not publish successful-turn metrics');

  await startRoot(session,'after-continuation-stop');
  await releaseGate(session,'after-continuation-stop','boundary','result','terminal');
  await waitLifecycle(session,'turn_completed','after-continuation-stop');
});

test('root and child SDK results sum usage once under the root operation despite duplicate frames', async (t) => {
  const session = await startSteerHelper(t,{mode:'root_result_before_child',duplicateResults:true});
  await startRoot(session);
  steer(session);
  await waitLifecycle(session,'steer_command_state','steer-one','queued');
  await releaseGate(session,'root-one','boundary');
  await waitLifecycle(session,'turn_result_observed','root-one');
  await releaseGate(session,'root-one','child');
  await waitLifecycle(session,'turn_completed','root-one');
  await sleep(20);
  const operation = events(session,'input_operation').find((event) => event.command_id === 'root-one' && event.stage === 'started');
  const metrics = events(session,'turn_metrics').filter((event) => event.operation_id === operation.operation_id);
  assert.equal(metrics.length,1);
  assert.equal(metrics[0].output_tokens,9,'root 2 + continuation 7, with neither duplicate charged twice');
  const resultUsage = events(session,'token_usage').filter((event) => event.scope === 'turn_total');
  assert.equal(resultUsage.length,2);
  assert.ok(resultUsage.every((event) => event.operation_id === operation.operation_id));
  assert.equal(resultUsage.reduce((sum,event) => sum + event.output_tokens,0),9);
  assert.equal(lifecycleCount(session,'turn_result_observed','root-one'),2,'one observation per distinct SDK result');
  assert.equal(lifecycleCount(session,'turn_result_observed','steer-one'),0);
});

test('failed SDK steer terminals are visible and never trigger replay or interrupt', async (t) => {
  for (const terminal of ['refused','discarded','cancelled']) {
    await t.test(terminal,async (t) => {
      const session = await startSteerHelper(t,{mode:'refused_child',childTerminal:terminal});
      await startRoot(session);
      steer(session);
      await waitLifecycle(session,'steer_command_state','steer-one','queued');
      await releaseGate(session,'root-one','boundary','result','terminal');
      await waitLifecycle(session,'turn_completed','root-one');
      assert.equal(session.outputs.filter((output) => isLifecycle(output,'steer_command_state','steer-one',terminal)).length,1);
      const failure = session.outputs.find((output) => isLifecycle(output,'steer_failed','steer-one'));
      assert.ok(failure,'SDK rejection must produce a user-visible failure observation');
      assert.match(failure.payload.detail,/steer-one/);
      assert.ok(failure.payload.detail.includes(terminal));
      assert.equal(session.outputs.filter((output) => isProbe(output,'sdk_input','steer-one')).length,1);
      assert.equal(session.outputs.some((output) => isProbe(output,'child_executed','steer-one')),false);
      assert.equal(session.outputs.some((output) => isProbe(output,'interrupt')),false);
      assert.equal(lifecycleCount(session,'steer_rejected','steer-one'),0,'failure is after admission, not an unsent fallback');
      assert.equal(lifecycleCount(session,'turn_result_observed','root-one'),1);
    });
  }
});

test('steer is unsupported without a safe queued-input cancellation contract', async (t) => {
  for (const [name,options] of [
    ['missing CLI capability',{capabilities:['msg_lifecycle_v1','interrupt_receipt_v1']}],
    ['missing SDK control adapter',{controlRequest:false}],
  ]) {
    await t.test(name,async (t) => {
      const session = await startSteerHelper(t,options);
      await startRoot(session);
      steer(session);
      await waitLifecycle(session,'steer_rejected','steer-one');
      assert.equal(session.outputs.some((output) => isProbe(output,'sdk_input','steer-one')),false);
      assert.equal(session.outputs.some((output) => isProbe(output,'interrupt')),false);
      assert.equal(session.outputs.some((output) => output.type === 'session_meta'
        && output.capabilities?.includes('ccem_steer_v1')),false);
      await releaseGate(session,'root-one','boundary','result','terminal');
      await waitLifecycle(session,'turn_completed','root-one');
    });
  }
});

test('deferred settings block steer without restarting or interrupting the active command', async (t) => {
  const session = await startSteerHelper(t);
  await startRoot(session);
  send(session,{type:'update_settings',request_id:'settings-pending',env_name:'next-env'});
  await waitForOutput(session,(output) => output.type === 'event'
    && output.payload?.type === 'runtime_settings_changed'
    && output.payload.request_id === 'settings-pending'
    && output.payload.state === 'deferred','deferred settings receipt');
  steer(session);
  await waitLifecycle(session,'steer_rejected','steer-one');
  assert.equal(session.outputs.some((output) => isProbe(output,'sdk_input','steer-one')),false);
  assert.equal(session.outputs.some((output) => isProbe(output,'interrupt')),false);
  await releaseGate(session,'root-one','boundary','result','terminal');
  await waitLifecycle(session,'turn_completed','root-one');
  await waitForOutput(session,(output) => output.type === 'event'
    && output.payload?.type === 'runtime_settings_changed'
    && output.payload.request_id === 'settings-pending'
    && output.payload.state === 'applied','settings applied after root terminal');
});
