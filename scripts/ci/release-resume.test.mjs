import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resumeRelease, openResumeJournal } from './release-resume.mjs';

const repository = 'Genuifx/ccem';
const token = 'fixture-token';
const cli = 'release-cli.yml';
const desktop = 'mode2-signed-readiness.yml';
const sourceCommit = 'a'.repeat(40);
const candidate = { version: '2.98.0', candidateTag: 'v2.98.0', sourceCommit, previousTag: 'v2.97.0', previousCommit: 'b'.repeat(40) };
const required = { [cli]: 'Preflight npm Trusted Publisher', [desktop]: 'Confirm Desktop Release Readiness' };
const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const networkError = () => new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) });
function run(workflow, overrides = {}) {
  return { id: workflow === cli ? 101 : 202, run_attempt: 1, updated_at: '2026-10-19T10:00:00Z', path: `.github/workflows/${workflow}`, head_sha: sourceCommit,
    head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', ...overrides };
}
function fixture(initial = { [cli]: [run(cli)], [desktop]: [run(desktop)] }) {
  let clock = 0;
  let id = 300;
  const state = { runs: initial, requests: [], posts: [], sleeps: [], candidate: { ...candidate }, progress: [], refreshes: 0 };
  const find = (value) => Object.values(state.runs).flat().find((entry) => entry.id === Number(value));
  const fetchImpl = async (url, options) => {
    state.requests.push({ url, options });
    const parsed = new URL(url);
    const dispatch = parsed.pathname.match(/\/workflows\/([^/]+)\/dispatches$/u);
    if (dispatch) {
      assert.equal(options.method, 'POST');
      const workflow = dispatch[1];
      const body = JSON.parse(options.body);
      state.posts.push({ workflow, body });
      if (state.dispatchRejected) return response({}, state.dispatchRejected);
      if (!state.noDispatchEvidence) state.runs[workflow].unshift(run(workflow, { id: ++id, status: 'queued', conclusion: null }));
      if (state.afterDispatch) state.afterDispatch(workflow);
      if (state.uncertainDispatch) throw networkError();
      return response(undefined, 204);
    }
    assert.equal(options.method, 'GET');
    const list = parsed.pathname.match(/\/workflows\/([^/]+)\/runs$/u);
    if (list) {
      let runs = state.runs[list[1]];
      if (parsed.searchParams.get('status') === 'success') runs = runs.filter((entry) => entry.conclusion === 'success');
      return response({ total_count: runs.length, workflow_runs: structuredClone(runs) });
    }
    const jobs = parsed.pathname.match(/\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/u);
    if (jobs) {
      const current = find(jobs[1]);
      assert.equal(current.run_attempt, Number(jobs[2]), 'must read the actual current attempt');
      const workflow = current.path.split('/').at(-1);
      const job = { id: current.id * 10, run_id: current.id, name: required[workflow], status: 'completed', conclusion: current.jobConclusion ?? 'success' };
      return response({ total_count: 1, jobs: [job] });
    }
    const individual = parsed.pathname.match(/\/runs\/(\d+)$/u);
    if (individual) return response(structuredClone(find(individual[1])));
    assert.fail(`Unexpected API path ${parsed.pathname}`);
  };
  state.options = { repository, token, fetchImpl,
    refreshCandidate: async () => { state.refreshes += 1; },
    resolveCandidate: async () => {
      if (state.resolveError) throw state.resolveError;
      return { ...state.candidate };
    },
    now: () => clock, pollIntervalMs: 10, dispatchPollIntervalMs: 5, dispatchPolls: 3, timeoutMs: 100,
    sleepImpl: async (ms) => {
      clock += ms;
      state.sleeps.push(ms);
      if (state.onSleep) state.onSleep();
      else for (const entry of Object.values(state.runs).flat()) if (entry.status !== 'completed') {
        entry.status = 'completed'; entry.conclusion = 'success';
      }
    }, onProgress: (value) => state.progress.push(value),
  };
  return state;
}

test('reuses complete exact readiness and explicitly leaves baseline delivery unverified', async () => {
  const f = fixture();
  const result = await resumeRelease(f.options);
  assert.equal(result.status, 'PRETAG_READINESS_VERIFIED');
  assert.equal(result.baselineDelivery, 'NOT_CHECKED');
  assert.equal(result.releaseEligible, false);
  assert.equal(result.sourceCommit, sourceCommit);
  assert.deepEqual(result.runIds, { [cli]: 101, [desktop]: 202 });
  assert.equal(f.posts.length, 0);
  assert.equal(f.refreshes, 1);
});

test('dispatches only missing readiness with exact pinned inputs and waits for required jobs', async () => {
  const f = fixture({ [cli]: [run(cli)], [desktop]: [] });
  const result = await resumeRelease(f.options);
  assert.equal(result.status, 'PRETAG_READINESS_VERIFIED');
  assert.deepEqual(f.posts, [{ workflow: desktop, body: { ref: 'main', inputs: { expected_sha: sourceCommit, expected_version: '2.98.0' } } }]);
  assert.ok(f.sleeps.length > 0);
  assert.ok(f.requests.some(({ url }) => /\/runs\/301\/attempts\/1\/jobs/u.test(url)));
});

test('dispatches both missing workflows but never a publishing workflow', async () => {
  const f = fixture({ [cli]: [], [desktop]: [] });
  const result = await resumeRelease(f.options);
  assert.equal(result.status, 'PRETAG_READINESS_VERIFIED');
  assert.deepEqual(f.posts.map(({ workflow }) => workflow), [cli, desktop]);
  assert.ok(f.requests.every(({ url, options }) => options.method === 'GET' || /workflows\/(release-cli|mode2-signed-readiness)\.yml\/dispatches$/u.test(url)));
});

test('a pending exact run is waited on rather than duplicated', async () => {
  const f = fixture({ [cli]: [run(cli, { status: 'in_progress', conclusion: null })], [desktop]: [run(desktop)] });
  assert.equal((await resumeRelease(f.options)).status, 'PRETAG_READINESS_VERIFIED');
  assert.equal(f.posts.length, 0);
  assert.ok(f.sleeps.length > 0);
});

test('a skipped automatic workflow is dispatched but never accepted as readiness', async () => {
  const f = fixture({ [cli]: [run(cli, { event: 'push', jobConclusion: 'skipped' })], [desktop]: [run(desktop)] });
  const result = await resumeRelease(f.options);
  assert.equal(result.runIds[cli], 301);
  assert.equal(f.posts.length, 1);
});

test('an uncertain dispatch reconciles a new exact run without retrying POST', async () => {
  const f = fixture({ [cli]: [], [desktop]: [run(desktop)] });
  f.uncertainDispatch = true;
  assert.equal((await resumeRelease(f.options)).status, 'PRETAG_READINESS_VERIFIED');
  assert.equal(f.posts.length, 1);
});

test('an uncertain dispatch without conclusive evidence stops with actionable status', async () => {
  const f = fixture({ [cli]: [], [desktop]: [run(desktop)] });
  f.uncertainDispatch = true;
  f.noDispatchEvidence = true;
  await assert.rejects(resumeRelease(f.options), (error) => {
    assert.equal(error.code, 'UNKNOWN_DISPATCH');
    assert.match(error.message, /release-cli\.yml.*no matching new run.*do not dispatch again/u);
    assert.match(error.message, /github\.com\/Genuifx\/ccem\/actions/u);
    return true;
  });
  assert.equal(f.posts.length, 1);
});

test('a definite authorization failure is not retried or treated as readiness', async () => {
  const f = fixture({ [cli]: [], [desktop]: [run(desktop)] });
  f.dispatchRejected = 403;
  await assert.rejects(resumeRelease(f.options), /dispatch rejected \(403\)/u);
  assert.equal(f.posts.length, 1);
});

test('terminal tests/build failures stop without automatic rerun, even with network wording', async () => {
  const f = fixture({ [cli]: [run(cli, { conclusion: 'failure', display_title: 'test failed: ENOTFOUND' })], [desktop]: [] });
  await assert.rejects(resumeRelease(f.options), (error) => {
    assert.equal(error.code, 'WORKFLOW_FAILED');
    assert.match(error.message, /run 101 attempt 1.*gh run view 101.*--log-failed/u);
    return true;
  });
  assert.equal(f.posts.length, 0);
});

test('failure after dispatch stops instead of dispatching a replacement', async () => {
  const f = fixture({ [cli]: [], [desktop]: [run(desktop)] });
  f.onSleep = () => Object.assign(f.runs[cli][0], { status: 'completed', conclusion: 'failure' });
  await assert.rejects(resumeRelease(f.options), /run 301 attempt 1.*workflow concluded failure/u);
  assert.equal(f.posts.length, 1);
});

test('main drift while waiting stops and does not chase or dispatch a new candidate', async () => {
  const f = fixture({ [cli]: [run(cli, { status: 'in_progress', conclusion: null })], [desktop]: [run(desktop)] });
  f.onSleep = () => { f.candidate.sourceCommit = 'c'.repeat(40); };
  await assert.rejects(resumeRelease(f.options), /candidate changed.*start a new invocation/u);
  assert.equal(f.posts.length, 0);
});

test('candidate tag races before the second dispatch stop immediately', async () => {
  const f = fixture({ [cli]: [], [desktop]: [] });
  f.afterDispatch = () => { f.resolveError = new Error('v2.98.0 already exists on origin'); };
  await assert.rejects(resumeRelease(f.options), /already exists on origin/u);
  assert.equal(f.posts.length, 1);
});

test('pending workflow timeout reports the active run and does not claim success', async () => {
  const f = fixture({ [cli]: [run(cli, { status: 'in_progress', conclusion: null })], [desktop]: [run(desktop)] });
  f.onSleep = () => {};
  await assert.rejects(resumeRelease(f.options), (error) => {
    assert.equal(error.code, 'READINESS_PENDING');
    assert.match(error.message, /101.*still pending/u);
    return true;
  });
  assert.equal(f.posts.length, 0);
});

test('help describes the non-publishing boundary without touching git or authentication', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./release-resume.mjs', import.meta.url)), '--help'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /non-publishing/u);
  assert.match(result.stdout, /baseline delivery/u);
});

function journalFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ccem-resume-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, journal: openResumeJournal({ directory, repository }) };
}

test('unknown dispatch is durably reconciled across invocations without another POST', async (t) => {
  const saved = journalFixture(t);
  const f = fixture({ [cli]: [], [desktop]: [run(desktop)] });
  f.uncertainDispatch = true;
  f.noDispatchEvidence = true;
  await assert.rejects(resumeRelease({ ...f.options, journal: saved.journal }), /no matching new run/u);
  saved.journal.close();
  const reopened = openResumeJournal({ directory: saved.directory, repository });
  await assert.rejects(resumeRelease({ ...f.options, journal: reopened }), /no matching new run/u);
  assert.equal(f.posts.length, 1);
  f.runs[cli] = [run(cli, { id: 301 })];
  assert.equal((await resumeRelease({ ...f.options, journal: reopened })).status, 'PRETAG_READINESS_VERIFIED');
  assert.equal(f.posts.length, 1);
  assert.deepEqual(reopened.pending(), []);
  reopened.close();
});

test('the durable journal refuses concurrent invocations and survives clean lock release', (t) => {
  const saved = journalFixture(t);
  assert.throws(() => openResumeJournal({ directory: saved.directory, repository }), /already locked/u);
  saved.journal.close();
  const reopened = openResumeJournal({ directory: saved.directory, repository });
  reopened.close();
});

test('a rejected dispatch clears intent so correcting access can try again', async (t) => {
  const saved = journalFixture(t);
  const f = fixture({ [cli]: [], [desktop]: [run(desktop)] });
  f.dispatchRejected = 403;
  await assert.rejects(resumeRelease({ ...f.options, journal: saved.journal }), /dispatch rejected/u);
  f.dispatchRejected = null;
  assert.equal((await resumeRelease({ ...f.options, journal: saved.journal })).status, 'PRETAG_READINESS_VERIFIED');
  assert.equal(f.posts.length, 2);
  saved.journal.close();
});

test('an unresolved dispatch cannot be cleared by unrelated automatic success', async (t) => {
  const saved = journalFixture(t);
  const f = fixture({ [cli]: [], [desktop]: [run(desktop)] });
  f.uncertainDispatch = true;
  f.noDispatchEvidence = true;
  await assert.rejects(resumeRelease({ ...f.options, journal: saved.journal }), /no matching new run/u);
  f.runs[cli] = [run(cli, { id: 301, event: 'push' })];
  await assert.rejects(resumeRelease({ ...f.options, journal: saved.journal }), /no matching new run/u);
  assert.equal(f.posts.length, 1);
  saved.journal.close();
});


test('unresolved dispatch on an old SHA blocks a new candidate until reconciled', async (t) => {
  const saved = journalFixture(t);
  const f = fixture({ [cli]: [], [desktop]: [run(desktop)] });
  f.uncertainDispatch = true;
  f.noDispatchEvidence = true;
  await assert.rejects(resumeRelease({ ...f.options, journal: saved.journal }), /no matching new run/u);
  f.candidate.sourceCommit = 'c'.repeat(40);
  await assert.rejects(resumeRelease({ ...f.options, journal: saved.journal }), /unresolved dispatch.*previous source/u);
  assert.equal(f.posts.length, 1);
  saved.journal.close();
});

test('a reconciled failed dispatch clears intent before reporting its real failure', async (t) => {
  const saved = journalFixture(t);
  const f = fixture({ [cli]: [], [desktop]: [run(desktop)] });
  f.uncertainDispatch = true;
  f.noDispatchEvidence = true;
  await assert.rejects(resumeRelease({ ...f.options, journal: saved.journal }), /no matching new run/u);
  f.runs[cli] = [run(cli, { id: 301, conclusion: 'failure' })];
  await assert.rejects(resumeRelease({ ...f.options, journal: saved.journal }), /workflow concluded failure/u);
  assert.deepEqual(saved.journal.pending(), []);
  assert.equal(f.posts.length, 1);
  saved.journal.close();
});

test('CLI rejects a repository mismatch or credential-bearing origin before network/authentication', (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccem-resume-origin-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/Genuifx/ccem.git');
  const script = fileURLToPath(new URL('./release-resume.mjs', import.meta.url));
  const env = { ...process.env, GITHUB_REPOSITORY: 'Other/fork', GH_TOKEN: token };
  const mismatch = spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /REPOSITORY_MISMATCH/u);
  git('remote', 'set-url', 'origin', `https://${token}@github.com/Genuifx/ccem.git`);
  const unsafe = spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' });
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /INVALID_ORIGIN/u);
  assert.doesNotMatch(unsafe.stderr, new RegExp(token, 'u'));
});
