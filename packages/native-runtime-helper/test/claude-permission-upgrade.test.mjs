import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { startHelper, buildHelperWithWireMock, spawnTrackedHelper, send, waitForOutput, isLifecycle } from './claude-command-lifecycle-harness.mjs';
const setting = (id, mode = 'yolo') => ({ type: 'update_settings', request_id: id, perm_mode: mode, permission_scope: 'display' });
const probe = (s, stage) => s.outputs.filter(o => o.type === 'permission_probe' && o.stage === stage);
const ack = (s, id, outcome) => waitForOutput(s, o => o.type === 'settings_update_result' && o.request_id === id && o.outcome === outcome, `${id} ${outcome}`);
async function turn(s, id) { send(s, { type: 'prompt', text: id, command_id: id }); await waitForOutput(s, o => isLifecycle(o, 'sdk_command_state', id, 'completed'), 'completed ' + id); }
for (const closedLoopError of [null, 'AbortError', 'Error']) {
    for (const waitingFor of ['interrupt terminal', 'SDK admission']) {
        test(`retired query ${closedLoopError ?? 'return'} cannot affect replacement awaiting ${waitingFor}`, async (t) => {
            const interrupt = waitingFor === 'interrupt terminal';
            const s = await startHelper(t, {
                scenario: interrupt ? 'full_interrupt' : 'full',
                permissionCapabilityProbe: true,
                closedLoopDelayMs: 250,
                closedLoopError,
                terminalDelayMs: interrupt ? 700 : 0,
                replacementAdmissionDelayMs: interrupt ? 0 : 700,
            }, { perm_mode: 'safe' });
            send(s, setting('retire-safe'));
            await ack(s, 'retire-safe', 'applied');
            send(s, { type: 'prompt', text: 'replacement work', command_id: 'replacement' });
            await waitForOutput(s, o => isLifecycle(o, 'command_admitted', 'replacement'), 'replacement admitted');
            if (interrupt) {
                await waitForOutput(s, o => isLifecycle(o, 'sdk_command_state', 'replacement', 'started'), 'replacement started');
                send(s, { type: 'interrupt_turn' });
                await waitForOutput(s, o => isLifecycle(o, 'interrupt_requested'), 'replacement interrupt');
            }
            await waitForOutput(s, o => o.type === 'permission_probe' && o.stage === 'loop_end', 'retired loop exit');
            const terminalState = interrupt ? 'cancelled' : 'completed';
            const failure = o => isLifecycle(o, 'lifecycle_protocol_error')
                || isLifecycle(o, 'delivery_uncertain') || o.payload?.type === 'session_completed';
            await waitForOutput(s, o => failure(o)
                || isLifecycle(o, 'sdk_command_state', 'replacement', terminalState), 'replacement terminal without stale-loop failure');
            assert.deepEqual(s.outputs.filter(failure), [], 'retired loop must not fail or consume the replacement foreground');
            const oldExit = s.outputs.findIndex(o => o.type === 'permission_probe' && o.stage === 'loop_end');
            const terminal = s.outputs.findIndex(o => isLifecycle(o, 'sdk_command_state', 'replacement', terminalState));
            assert.ok(terminal > oldExit, 'exercise old-loop exit while replacement is still pending');
            send(s, { type: 'prompt', text: 'still usable', command_id: 'after-retired-exit' });
            await waitForOutput(s, o => isLifecycle(o, 'sdk_command_state', 'after-retired-exit', 'started'), 'same replacement accepts next command');
            assert.equal(probe(s, 'query').length, 2);
        });
    }
}
test('owning loop still replays an unacknowledged legacy prompt after normal exit', async (t) => {
    const s = await startHelper(t, { scenario: 'end_before_admission', permissionCapabilityProbe: true });
    send(s, { type: 'prompt', text: 'legacy replay control' });
    const original = await waitForOutput(s, o => o.type === 'permission_probe' && o.stage === 'unaccepted_prompt', 'unaccepted legacy prompt');
    await waitForOutput(s, o => isLifecycle(o, 'sdk_command_state', original.commandId, 'completed'), 'replayed legacy prompt completes');
    assert.equal(probe(s, 'query').length, 2);
    assert.equal(s.outputs.filter(o => isLifecycle(o, 'command_admitted', original.commandId)).length, 2);
    assert.equal(s.outputs.some(o => isLifecycle(o, 'delivery_uncertain') || isLifecycle(o, 'lifecycle_protocol_error')), false);
});
test('owning loop keeps coordinator delivery uncertain instead of replaying after normal exit', async (t) => {
    const s = await startHelper(t, { scenario: 'end_before_admission', permissionCapabilityProbe: true });
    send(s, { type: 'prompt', text: 'coordinator control', command_id: 'do-not-replay' });
    await waitForOutput(s, o => isLifecycle(o, 'delivery_uncertain', 'do-not-replay'), 'owner reports uncertainty');
    assert.equal(probe(s, 'query').length, 1);
    assert.equal(s.outputs.filter(o => isLifecycle(o, 'command_admitted', 'do-not-replay')).length, 1);
});
test('explicit idle Safe upgrade retires incapable query before exact ACK and next prompt uses bypass', async (t) => {
    const s = await startHelper(t, { permissionCapabilityProbe: true, closedLoopDelayMs: 150 }, { perm_mode: 'safe' });
    assert.equal(probe(s, 'query')[0].allowBypass, false);
    send(s, setting('upgrade'));
    await ack(s, 'upgrade', 'applied');
    assert.equal(probe(s, 'set_mode').length, 0, 'do not ask an incapable live query to bypass');
    const close = s.outputs.findIndex(o => o.type === 'permission_probe' && o.stage === 'close');
    const applied = s.outputs.findIndex(o => o.payload?.type === 'runtime_settings_changed' && o.payload.request_id === 'upgrade' && o.payload.state === 'applied');
    assert.ok(close >= 0 && close < applied);
    assert.equal(s.outputs[applied].payload.query_generation, 1);
    assert.equal(s.outputs[applied].payload.perm_mode, 'yolo');
    assert.equal(probe(s, 'query').length, 1, 'ACK confirms next-query configuration before a new generation');
    await turn(s, 'after-upgrade');
    assert.equal(probe(s, 'query').length, 2);
    assert.equal(probe(s, 'query')[1].allowBypass, true);
    assert.equal(probe(s, 'query')[1].mode, 'bypassPermissions');
    await waitForOutput(s, o => o.type === 'permission_probe' && o.stage === 'loop_end', 'old loop finally');
    await turn(s, 'after-old-finally');
    assert.equal(probe(s, 'query').length, 2, 'old finally must not clear new query');
    assert.equal(s.outputs.filter(o => o.type === 'settings_update_result' && o.request_id === 'upgrade').length, 1);
});
test('cold query after idle close upgrades configuration without creating a Safe bypass-capable query', async (t) => {
    const s = await startHelper(t, { permissionCapabilityProbe: true }, { perm_mode: 'safe' }, { CCEM_NATIVE_CLAUDE_IDLE_TTL_MS: '20' });
    await turn(s, 'before-close');
    await waitForOutput(s, o => o.type === 'permission_probe' && o.stage === 'close', 'idle close');
    send(s, setting('cold'));
    await ack(s, 'cold', 'applied');
    await turn(s, 'cold-next');
    assert.equal(probe(s, 'query')[0].allowBypass, false);
    assert.equal(probe(s, 'query').at(-1).allowBypass, true);
});
test('bypass-capable query switches online through Safe without losing original capability', async (t) => {
    const s = await startHelper(t, { permissionCapabilityProbe: true }, { perm_mode: 'yolo' });
    send(s, setting('safe', 'safe'));
    await ack(s, 'safe', 'applied');
    send(s, setting('again'));
    await ack(s, 'again', 'applied');
    assert.equal(probe(s, 'query').length, 1);
    assert.equal(probe(s, 'close').length, 0);
    assert.deepEqual(probe(s, 'set_mode').map(o => o.mode), ['default', 'bypassPermissions']);
});
for (const initialMode of ['safe', 'dev']) {
for (const scenario of ['full_interrupt', 'permission_background', 'interactive_plan', 'interactive_wait', 'permission_wait']) {
    test(`${initialMode} incapable upgrade rejects unchanged without destroying ${scenario}`, async (t) => {
        const s = await startHelper(t, { scenario, permissionCapabilityProbe: true }, { perm_mode: initialMode });
        send(s, { type: 'prompt', text: 'protected work', command_id: 'protected' });
        if (scenario === 'permission_background')
            await waitForOutput(s, o => isLifecycle(o, 'sdk_command_state', 'protected', 'completed'), 'background foreground complete');
        else if (scenario.startsWith('interactive'))
            await waitForOutput(s, o => o.payload?.type === 'tool_use_started' && o.payload.needs_response === true, 'resolver');
        else if (scenario === 'permission_wait')
            await waitForOutput(s, o => o.payload?.type === 'permission_required', 'permission resolver');
        else
            await waitForOutput(s, o => isLifecycle(o, 'sdk_command_state', 'protected', 'started'), 'foreground started');
        const before = s.outputs.length;
        send(s, setting('blocked'));
        await ack(s, 'blocked', 'rejected_unchanged');
        const failed = s.outputs.slice(before).find(o => o.payload?.type === 'runtime_settings_changed' && o.payload.request_id === 'blocked');
        assert.equal(failed.payload.state, 'failed');
        assert.equal(failed.payload.perm_mode, initialMode);
        assert.equal(failed.payload.query_generation, 1);
        const receipts = s.outputs.filter(o => o.type === 'settings_update_result' && o.request_id === 'blocked');
        assert.equal(receipts.length, 1);
        assert.ok(s.outputs.indexOf(failed) < s.outputs.indexOf(receipts[0]), 'old-authority lifecycle precedes typed rejection');
        assert.equal(probe(s, 'close').length, 0);
        assert.equal(probe(s, 'set_mode').length, 0);
        assert.equal(s.outputs.slice(before).some(o => o.payload?.state === 'resolver_expired'), false);
        if (scenario === 'permission_wait') {
            const request = s.outputs.find(o => o.payload?.type === 'permission_required').payload;
            send(s, { type: 'permission_response', request_id: request.request_id, approved: true });
            await waitForOutput(s, o => isLifecycle(o, 'sdk_command_state', 'protected', 'completed'), 'preserved permission completes');
        }
        if (scenario.startsWith('interactive')) {
            send(s, { type: 'interactive_prompt_response', control_request_id: 'resume-resolver', expected_query_generation: 1, tool_use_id: 'shared-interactive-tool', prompt_type: scenario === 'interactive_plan' ? 'plan_exit' : 'ask_user_question', approved: false, answers: { decision: 'Yes' } });
            await waitForOutput(s, o => o.payload?.type === 'interactive_response_result' && o.payload.control_request_id === 'resume-resolver' && o.payload.state === 'applied', 'preserved interactive response');
        }
    });
}
}
test('incapable upgrade preserves an already deferred settings transaction', async (t) => {
    const s = await startHelper(t, { permissionCapabilityProbe: true, resultDelayMs: 250 }, { perm_mode: 'safe' });
    send(s, { type: 'prompt', text: 'working', command_id: 'busy' });
    await waitForOutput(s, o => isLifecycle(o, 'sdk_command_state', 'busy', 'started'), 'busy');
    send(s, { type: 'update_settings', request_id: 'original-settings', env_name: 'next-env' });
    await ack(s, 'original-settings', 'deferred');
    send(s, setting('do-not-overwrite'));
    await ack(s, 'do-not-overwrite', 'rejected_unchanged');
    await waitForOutput(s, o => o.payload?.type === 'runtime_settings_changed' && o.payload.request_id === 'original-settings' && o.payload.state === 'applied', 'original deferred settings applied');
    assert.equal(probe(s, 'set_mode').length, 0);
});
test('initialization preflight rejects before creating or mutating a query', async (t) => {
    const built = await buildHelperWithWireMock({ scenario: 'slow_fork', permissionCapabilityProbe: true });
    const s = spawnTrackedHelper(t, built);
    send(s, { type: 'init', provider: 'claude', env_name: 'default', perm_mode: 'safe', working_dir: os.tmpdir(), provider_session_id: 'parent-session', fork_session: true });
    send(s, setting('during-init'));
    await ack(s, 'during-init', 'rejected_unchanged');
    assert.equal(probe(s, 'set_mode').length, 0);
    await waitForOutput(s, o => isLifecycle(o, 'initialization_settled'), 'initialization settles');
    assert.equal(probe(s, 'query')[0].allowBypass, false);
});
test('unknown capable-query setter failure keeps generic failed outcome', async (t) => {
    const s = await startHelper(t, { permissionCapabilityProbe: true, permissionModeDelays: { bypassPermissions: -1 } }, { perm_mode: 'yolo' });
    send(s, setting('safe', 'safe'));
    await ack(s, 'safe', 'applied');
    send(s, setting('unknown-failure'));
    await ack(s, 'unknown-failure', 'failed');
    assert.equal(probe(s, 'close').length, 0);
});
test('capable live Plan query changes permissions online and retains its resolver', async (t) => {
    const s = await startHelper(t, { scenario: 'interactive_plan', permissionCapabilityProbe: true }, { perm_mode: 'yolo' });
    send(s, setting('safe', 'safe'));
    await ack(s, 'safe', 'applied');
    send(s, { type: 'prompt', text: 'plan', command_id: 'plan-live' });
    await waitForOutput(s, o => o.payload?.type === 'tool_use_started' && o.payload.needs_response === true, 'Plan resolver');
    const before = s.outputs.length;
    send(s, setting('live-upgrade'));
    await ack(s, 'live-upgrade', 'applied');
    assert.equal(probe(s, 'close').length, 0);
    assert.equal(s.outputs.slice(before).some(o => o.type === 'status' && o.status === 'ready'), false);
    send(s, { type: 'interactive_prompt_response', control_request_id: 'live-plan-answer', expected_query_generation: 1, tool_use_id: 'shared-interactive-tool', prompt_type: 'plan_exit', answers: { decision: 'No' } });
    await waitForOutput(s, o => o.payload?.type === 'interactive_response_result' && o.payload.control_request_id === 'live-plan-answer' && o.payload.state === 'applied', 'live Plan resolver retained');
    assert.deepEqual(probe(s, 'set_mode').map(o => o.mode), ['default', 'bypassPermissions']);
});
test('browser evaluate uses current Safe/Plan permissions instead of query launch capability', async (t) => {
    const s = await startHelper(t, { scenario: 'browser_evaluate', permissionCapabilityProbe: true }, { perm_mode: 'yolo' });
    await turn(s, 'yolo-evaluate');
    assert.equal(s.outputs.some(o => o.payload?.type === 'permission_required'), false);
    for (const [id, mode, scope] of [['safe-evaluate', 'safe', 'display'], ['plan-evaluate', 'plan', 'runtime']]) {
        send(s, { ...setting(id + '-settings', mode), permission_scope: scope });
        await ack(s, id + '-settings', 'applied');
        const before = s.outputs.length;
        send(s, { type: 'prompt', text: id, command_id: id });
        const request = await waitForOutput(s, o => s.outputs.indexOf(o) >= before && o.payload?.type === 'permission_required', id + ' requires permission');
        send(s, { type: 'permission_response', request_id: request.payload.request_id, approved: true });
        await waitForOutput(s, o => isLifecycle(o, 'sdk_command_state', id, 'completed'), id + ' completes');
    }
    send(s, setting('restore-yolo'));
    await ack(s, 'restore-yolo', 'applied');
    const before = s.outputs.length;
    await turn(s, 'restored-evaluate');
    assert.equal(s.outputs.slice(before).some(o => o.payload?.type === 'permission_required'), false);
    assert.equal(probe(s, 'query').length, 1);
    assert.equal(probe(s, 'close').length, 0);
    assert.equal(probe(s, 'evaluate').length, 4);
});

test('completed warm Safe query restarts lazily and preserves the next command', async t => {
    const s = await startHelper(t, { permissionCapabilityProbe: true }, { perm_mode: 'safe' });
    await turn(s, 'warm-before');
    send(s, setting('warm-upgrade'));
    await ack(s, 'warm-upgrade', 'applied');
    assert.equal(probe(s, 'close').length, 1);
    await turn(s, 'warm-after');
    assert.equal(probe(s, 'query').length, 2);
    assert.equal(probe(s, 'query')[1].allowBypass, true);
});

test('lazy display YOLO capability survives runtime Plan until the same Plan approval resolves', async t => {
    const s = await startHelper(t, { scenario: 'interactive_plan', permissionCapabilityProbe: true }, { perm_mode: 'safe' });
    send(s, setting('display-yolo'));
    await ack(s, 'display-yolo', 'applied');
    send(s, { ...setting('runtime-plan', 'plan'), permission_scope: 'runtime' });
    await ack(s, 'runtime-plan', 'applied');
    assert.equal(probe(s, 'query').length, 1, 'both ACKs configure the next query lazily');
    send(s, { type: 'prompt', text: 'make a plan', command_id: 'lazy-plan' });
    await waitForOutput(s, o => o.payload?.type === 'tool_use_started' && o.payload.needs_response === true, 'new Plan resolver');
    assert.equal(probe(s, 'query')[1].mode, 'plan');
    assert.equal(probe(s, 'query')[1].allowBypass, true, 'explicit display YOLO authorizes future query capability');
    send(s, { ...setting('approve-runtime-yolo'), permission_scope: 'runtime' });
    await ack(s, 'approve-runtime-yolo', 'applied');
    send(s, { type: 'interactive_prompt_response', control_request_id: 'approve-same-plan', expected_query_generation: 2, tool_use_id: 'shared-interactive-tool', prompt_type: 'plan_exit', answers: { decision: 'approve' } });
    await waitForOutput(s, o => o.payload?.type === 'interactive_response_result' && o.payload.control_request_id === 'approve-same-plan' && o.payload.state === 'applied', 'same Plan resolver accepts approval');
    await waitForOutput(s, o => o.payload?.type === 'tool_use_completed' && o.payload.tool_use_id === 'shared-interactive-tool' && o.payload.success === true, 'Plan approval allows original tool');
    assert.equal(probe(s, 'query').length, 2);
    assert.equal(probe(s, 'close').length, 1);
});

for (const [mode, scope, allowBypass] of [['safe', 'display', false], ['plan', 'runtime', true]]) {
    test(`lazy display YOLO followed by ${scope} ${mode} keeps current browser permission separate from capability`, async t => {
        const s = await startHelper(t, { scenario: 'browser_evaluate', permissionCapabilityProbe: true }, { perm_mode: 'safe' });
        send(s, setting('select-yolo'));
        await ack(s, 'select-yolo', 'applied');
        send(s, { ...setting('select-next', mode), permission_scope: scope });
        await ack(s, 'select-next', 'applied');
        send(s, { type: 'prompt', text: 'evaluate', command_id: 'next-evaluate' });
        const request = await waitForOutput(s, o => o.payload?.type === 'permission_required', 'current mode requires evaluate permission');
        assert.equal(probe(s, 'query')[1].mode, mode === 'safe' ? 'default' : 'plan');
        assert.equal(probe(s, 'query')[1].allowBypass, allowBypass);
        send(s, { type: 'permission_response', request_id: request.payload.request_id, approved: true });
        await waitForOutput(s, o => isLifecycle(o, 'sdk_command_state', 'next-evaluate', 'completed'), 'evaluate completes after explicit approval');
    });
}
