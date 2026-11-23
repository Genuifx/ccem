import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPretagWorkflow } from './check-pretag-readiness-runs.mjs';

const repository = 'Genuifx/ccem';
const token = 'fixture-token';
const sourceCommit = 'a'.repeat(40);
const workflow = 'release-cli.yml';
const requiredJob = 'Preflight npm Trusted Publisher';
const run = (overrides = {}) => ({ id: 101, run_attempt: 2, updated_at: '2026-10-19T10:00:00Z', path: `.github/workflows/${workflow}`, head_branch: 'main', head_sha: sourceCommit, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', ...overrides });
const job = (overrides = {}) => ({ run_id: 101, name: requiredJob, status: 'completed', conclusion: 'success', ...overrides });
function fixture(runs, jobs = [job()]) {
  const urls = [];
  return { urls, fetchImpl: async (url) => {
    urls.push(url);
    const isJobs = new URL(url).pathname.endsWith('/jobs');
    return { status: 200, ok: true, json: async () => isJobs ? { total_count: jobs.length, jobs } : { total_count: runs.length, workflow_runs: runs } };
  } };
}
async function inspect(f) {
  return inspectPretagWorkflow({ repository, token, sourceCommit, workflow, fetchImpl: f.fetchImpl });
}

test('reuses readiness only with the current exact attempt and required job', async () => {
  const f = fixture([run()]);
  const result = await inspect(f);
  assert.equal(result.state, 'ready');
  assert.equal(result.run.id, 101);
  assert.match(f.urls[1], /\/runs\/101\/attempts\/2\/jobs/u);
  assert.equal(new URL(f.urls[0]).searchParams.has('status'), false);
});

test('distinguishes missing and pending readiness from a terminal failure', async () => {
  for (const [runs, expected] of [
    [[], 'missing'],
    [[run({ status: 'queued', conclusion: null })], 'pending'],
    [[run({ status: 'completed', conclusion: 'failure' })], 'failed'],
    [[run({ event: 'push', conclusion: 'skipped' })], 'missing'],
    [[run({ event: 'workflow_dispatch', conclusion: 'skipped' })], 'failed'],
  ]) assert.equal((await inspect(fixture(runs))).state, expected);
});

test('successful skipped automatic workflows are missing evidence, never readiness', async () => {
  assert.equal((await inspect(fixture([run({ event: 'push' })], [job({ conclusion: 'skipped' })]))).state, 'missing');
  assert.equal((await inspect(fixture([run()], [job({ conclusion: 'skipped' })]))).state, 'failed');
  assert.equal((await inspect(fixture([run()], []))).state, 'failed');
});

test('does not accept required jobs from another run or another attempt endpoint', async () => {
  const result = await inspect(fixture([run()], [job({ run_id: 999 })]));
  assert.equal(result.state, 'failed');
});

test('reuses a genuinely valid older run behind skipped automatic main runs', async () => {
  const result = await inspect(fixture([run({ id: 102, event: 'push', conclusion: 'skipped' }), run()]));
  assert.equal(result.state, 'ready');
  assert.equal(result.run.id, 101);
});

test('ignores wrong SHA, path, branch and event instead of borrowing their success', async () => {
  for (const override of [{ head_sha: 'b'.repeat(40) }, { path: '.github/workflows/other.yml' }, { head_branch: 'dev' }, { event: 'pull_request' }]) {
    assert.equal((await inspect(fixture([run(override)]))).state, 'missing');
  }
});

test('fails closed on unknown workflow, malformed matching run and incomplete pagination', async () => {
  await assert.rejects(inspectPretagWorkflow({ repository, token, sourceCommit, workflow: 'release-desktop.yml' }), /unsupported readiness workflow/u);
  await assert.rejects(inspect(fixture([run({ run_attempt: undefined })])), /run identity is malformed/u);
  await assert.rejects(inspect({ fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ total_count: 2, workflow_runs: [] }) }) }), /ended before total_count/u);
});

test('a newer pending or failed exact-source run cannot be bypassed with older success', async () => {
  for (const [overrides, expected] of [
    [{ status: 'in_progress', conclusion: null }, 'pending'],
    [{ status: 'completed', conclusion: 'failure' }, 'failed'],
  ]) {
    const result = await inspect(fixture([run({ id: 102, ...overrides }), run()]));
    assert.equal(result.state, expected);
    assert.equal(result.run.id, 102);
  }
});


test('an older run ID with a newer attempt is authoritative over a previous successful run', async () => {
  const olderRerun = run({ id: 100, run_attempt: 4, status: 'in_progress', conclusion: null, updated_at: '2026-10-19T11:00:00Z' });
  const result = await inspect(fixture([run({ id: 102 }), olderRerun], [job({ run_id: 102 })]));
  assert.equal(result.state, 'pending');
  assert.equal(result.run.id, 100);
});

test('unknown attempt timing fails closed and timestamp ties favor blockers over success', async () => {
  await assert.rejects(inspect(fixture([run({ updated_at: undefined })])), /attempt timestamp/u);
  await assert.rejects(inspect(fixture([run({ updated_at: 'not-a-date' })])), /attempt timestamp/u);
  assert.equal((await inspect(fixture([run({ id: 102 }), run({ id: 100, conclusion: 'failure' })], [job({ run_id: 102 })]))).state, 'failed');
});
