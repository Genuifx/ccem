import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildPlanContentHelper, spawnTrackedHelper, send, waitForOutput, PLAN } from './claude-plan-content-harness.mjs';

async function start(t) {
  const built = await buildPlanContentHelper();
  const session = spawnTrackedHelper(t, built);
  send(session, { type: 'init', provider: 'claude', env_name: 'default', perm_mode: 'dev', working_dir: built.tempDir });
  await waitForOutput(session, o => o.type === 'status' && o.status === 'ready', 'ready');
  return { ...session, tempDir: built.tempDir };
}
async function review(session, spec = {}, turn = 1) {
  send(session, { type: 'prompt', text: JSON.stringify(spec), command_id: `plan-command-${turn}` });
  const event = await waitForOutput(session, o => o.type === 'event'
    && o.payload?.type === 'tool_use_started' && o.payload.tool_use_id === `exit-plan-${turn}`, 'plan review');
  assert.equal(event.payload.needs_response, true);
  return event.payload.prompt;
}
async function respond(session, turn = 1, decision = 'approve') {
  send(session, { type: 'interactive_prompt_response', tool_use_id: `exit-plan-${turn}`, prompt_type: 'plan_exit', answers: { decision } });
  await waitForOutput(session, o => o.payload?.type === 'interactive_response_result'
    && o.payload.tool_use_id === `exit-plan-${turn}` && o.payload.state === 'applied', 'response applied');
  await waitForOutput(session, o => o.payload?.type === 'lifecycle'
    && o.payload.command_id === `plan-command-${turn}` && o.payload.stage === 'turn_completed', 'turn completed');
}

for (const streamFirst of [false, true]) {
  test(`empty ExitPlanMode displays the complete successful Write (streamFirst=${streamFirst})`, async t => {
    const session = await start(t);
    const prompt = await review(session, { streamFirst });
    assert.equal(prompt.plan_summary, PLAN);
    assert.ok(PLAN.length > 4000, 'exercise content beyond ordinary tool-summary limits');
    assert.equal(session.outputs.some(o => o.payload?.text === 'PLAN_FIXTURE_APPROVED'), false);
    await respond(session);
    assert.ok(session.outputs.some(o => o.payload?.text === 'PLAN_FIXTURE_APPROVED'));
    assert.equal(session.outputs.filter(o => o.payload?.type === 'tool_use_started' && o.payload.raw_name === 'ExitPlanMode').length, 1);
  });
}

test('explicit plan wins and empty inline text falls back', async t => {
  const session = await start(t);
  assert.equal((await review(session, { inline: '# Explicit plan' })).plan_summary, '# Explicit plan');
  await respond(session);
  assert.equal((await review(session, { inline: '  ' }, 2)).plan_summary, PLAN);
  await respond(session, 2, 'revise');
  assert.ok(session.outputs.some(o => o.payload?.text === 'PLAN_FIXTURE_REVISE'));
});

test('late successful writes keep the same pending card on the latest draft', async t => {
  const session = await start(t);
  await review(session, { lateResult: true, writes: [
    { path: '.plans/review.md', content: '# Intermediate draft' },
    { path: '.plans/review.md', content: PLAN },
  ] });
  const enriched = await waitForOutput(session, o => o.payload?.prompt?.plan_summary === PLAN, 'late plan content');
  assert.equal(enriched.payload.tool_use_id, 'exit-plan-1');
  const prompts = session.outputs.filter(o => o.payload?.prompt?.prompt_type === 'plan_exit');
  assert.deepEqual(prompts.map(o => o.payload.prompt.plan_summary), [undefined, '# Intermediate draft', PLAN]);
  assert.equal(session.outputs.some(o => o.payload?.text === 'PLAN_FIXTURE_APPROVED'), false);
  await respond(session);
  assert.equal(session.outputs.filter(o => o.payload?.type === 'interactive_response_result').length, 1);
});

test('failed writes, unrelated files and background plans cannot supply foreground review', async t => {
  const session = await start(t);
  const prompt = await review(session, { writes: [
    { path: '.plans/failed.md', content: 'FAILED', failed: true },
    { path: 'README.md', content: 'UNRELATED' },
    { path: '.plans/background.md', content: 'BACKGROUND', background: true },
    { path: '.plans/code.ts', content: 'NOT MARKDOWN' },
  ] });
  assert.equal(prompt.plan_summary, undefined);
  await respond(session);
});

test('only the latest successful plan is used and no previous-turn plan leaks', async t => {
  const session = await start(t);
  const prompt = await review(session, { writes: [
    { path: '.plans/one.md', content: '# Earlier' },
    { path: '.plans/two.md', content: PLAN },
    { path: '.plans/failed.md', content: 'FAILED', failed: true },
  ] });
  assert.equal(prompt.plan_summary, PLAN);
  await respond(session);
  assert.equal((await review(session, { writes: [] }, 2)).plan_summary, undefined);
  await respond(session, 2);
});

test('successful Edit uses the complete revised file and supports worktree plan paths', async t => {
  const session = await start(t);
  const file = '.claude/worktrees/plan-test/.plans/review.md';
  const prompt = await review(session, { writes: [
    { path: file, content: PLAN },
    { path: file, edit: true, old: '步骤 1', content: '已修订步骤 1' },
  ] });
  assert.equal(prompt.plan_summary, PLAN.replace('步骤 1', '已修订步骤 1'));
  await respond(session);
});

test('Claude internal plans and linked worktree plans work outside the original cwd', async t => {
  const built = await buildPlanContentHelper();
  const agentBase = path.join(built.tempDir, 'agents');
  const session = spawnTrackedHelper(t, built, { CCEM_AGENT_HOME: agentBase });
  send(session, { type: 'init', provider: 'claude', env_name: 'default', perm_mode: 'dev', working_dir: path.join(built.tempDir, 'project') });
  await waitForOutput(session, o => o.type === 'status' && o.status === 'ready', 'ready');
  assert.equal((await review(session, { writes: [{ path: path.join(agentBase, 'claude/plans/review.md'), content: PLAN }] })).plan_summary, PLAN);
  await respond(session);
  assert.equal((await review(session, { writes: [{ path: path.join(built.tempDir, 'linked-worktree/.plans/review.md'), content: PLAN }] }, 2)).plan_summary, PLAN);
  await respond(session, 2);
});
