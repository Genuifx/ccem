import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyPretagReadinessRuns } from './check-pretag-readiness-runs.mjs';

const repository = 'Genuifx/ccem';
const token = 'github_token_fixture';
const sourceCommit = 'a'.repeat(40);
const requiredJobs = {
  'release-cli.yml': 'Preflight npm Trusted Publisher',
  'mode2-signed-readiness.yml': 'Confirm Desktop Release Readiness',
};

function run(workflow, overrides = {}) {
  return {
    id: workflow === 'release-cli.yml' ? 101 : 202,
    path: `.github/workflows/${workflow}`,
    head_sha: sourceCommit,
    head_branch: 'main',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 3,
    ...overrides,
  };
}

function job(workflow, overrides = {}) {
  return {
    id: workflow === 'release-cli.yml' ? 1001 : 2002,
    run_id: workflow === 'release-cli.yml' ? 101 : 202,
    name: requiredJobs[workflow],
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

function fixtureFetch(overrides = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const parsed = new URL(url);
    const workflowMatch = parsed.pathname.match(/\/actions\/workflows\/([^/]+)\/runs$/u);
    if (workflowMatch) {
      const workflow = decodeURIComponent(workflowMatch[1]);
      const workflowOverrides = overrides[workflow];
      if (workflowOverrides?.status) {
        return response(workflowOverrides.status, workflowOverrides.body ?? {});
      }
      return response(200, {
        workflow_runs: [run(workflow, workflowOverrides?.run)],
      });
    }
    const jobsMatch = parsed.pathname.match(
      /\/actions\/runs\/(101|202)\/attempts\/(\d+)\/jobs$/u,
    );
    assert.ok(jobsMatch, `unexpected URL ${url}`);
    const workflow = jobsMatch[1] === '101' ? 'release-cli.yml' : 'mode2-signed-readiness.yml';
    const workflowOverrides = overrides[workflow];
    if (workflowOverrides?.jobsStatus) {
      return response(workflowOverrides.jobsStatus, workflowOverrides.jobsBody ?? {});
    }
    return response(200, workflowOverrides?.jobsBody ?? {
      total_count: 1,
      jobs: [job(workflow, workflowOverrides?.job)],
    });
  };
  return { fetchImpl, requests };
}

test('accepts exact-SHA main dispatch readiness after a non-release-message commit', async () => {
  const fixture = fixtureFetch();
  const result = await verifyPretagReadinessRuns({
    repository,
    token,
    sourceCommit,
    fetchImpl: fixture.fetchImpl,
  });
  assert.deepEqual(result, {
    repository,
    sourceCommit,
    runIds: {
      'release-cli.yml': 101,
      'mode2-signed-readiness.yml': 202,
    },
  });
  assert.equal(fixture.requests.length, 4);
  for (const request of fixture.requests) {
    const url = new URL(request.url);
    assert.equal(url.searchParams.get('per_page'), '100');
    assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
    if (url.pathname.includes('/actions/workflows/')) {
      assert.equal(url.searchParams.get('branch'), 'main');
      assert.equal(url.searchParams.has('event'), false);
      assert.equal(url.searchParams.get('status'), 'success');
      assert.equal(url.searchParams.get('head_sha'), sourceCommit);
    } else {
      assert.match(url.pathname, /\/attempts\/3\/jobs$/u);
      assert.equal(url.searchParams.get('page'), '1');
    }
  }
});

test('fails closed for stale, untrusted-event, failed, or foreign workflow runs', async (t) => {
  const cases = [
    ['stale SHA', { head_sha: 'b'.repeat(40) }],
    ['pull request', { event: 'pull_request' }],
    ['workflow run', { event: 'workflow_run' }],
    ['scheduled run', { event: 'schedule' }],
    ['failed run', { conclusion: 'failure' }],
    ['skipped run', { conclusion: 'skipped' }],
    ['wrong branch', { head_branch: 'release' }],
    ['incomplete run', { status: 'in_progress', conclusion: null }],
    ['missing run attempt', { run_attempt: undefined }],
    ['foreign workflow path', { path: '.github/workflows/other.yml' }],
  ];
  for (const [name, runOverrides] of cases) {
    await t.test(name, async () => {
      const fixture = fixtureFetch({
        'mode2-signed-readiness.yml': { run: runOverrides },
      });
      await assert.rejects(
        verifyPretagReadinessRuns({
          repository,
          token,
          sourceCommit,
          fetchImpl: fixture.fetchImpl,
        }),
        /has no successful main push or workflow_dispatch run for exact source/u,
      );
    });
  }
});

test('run success cannot hide a skipped, missing, failed, or foreign required job', async (t) => {
  const cases = [
    ['skipped required job', { conclusion: 'skipped' }],
    ['failed required job', { conclusion: 'failure' }],
    ['incomplete required job', { status: 'in_progress', conclusion: null }],
    ['foreign job', { name: 'Unrelated successful job' }],
  ];
  for (const [name, jobOverrides] of cases) {
    await t.test(name, async () => {
      const fixture = fixtureFetch({
        'mode2-signed-readiness.yml': { job: jobOverrides },
      });
      await assert.rejects(
        verifyPretagReadinessRuns({
          repository,
          token,
          sourceCommit,
          fetchImpl: fixture.fetchImpl,
        }),
        /did not complete required job Confirm Desktop Release Readiness/u,
      );
    });
  }

  await t.test('missing required job', async () => {
    const fixture = fixtureFetch({
      'mode2-signed-readiness.yml': { jobsBody: { total_count: 0, jobs: [] } },
    });
    await assert.rejects(
      verifyPretagReadinessRuns({ repository, token, sourceCommit, fetchImpl: fixture.fetchImpl }),
      /did not complete required job Confirm Desktop Release Readiness/u,
    );
  });
});

test('fails closed on malformed input, denied API access, and invalid response bodies', async (t) => {
  const neverFetch = async () => { throw new Error('must not fetch'); };
  await assert.rejects(
    verifyPretagReadinessRuns({ repository: 'invalid', token, sourceCommit, fetchImpl: neverFetch }),
    /exact owner\/name pair/u,
  );
  await assert.rejects(
    verifyPretagReadinessRuns({ repository, token: 'bad token', sourceCommit, fetchImpl: neverFetch }),
    /invalid format/u,
  );
  await assert.rejects(
    verifyPretagReadinessRuns({ repository, token, sourceCommit: 'abc', fetchImpl: neverFetch }),
    /full lowercase Git SHA/u,
  );

  await t.test('denied', async () => {
    const fixture = fixtureFetch({ 'release-cli.yml': { status: 403 } });
    await assert.rejects(
      verifyPretagReadinessRuns({ repository, token, sourceCommit, fetchImpl: fixture.fetchImpl }),
      /read failed \(403\)/u,
    );
  });
  await t.test('malformed', async () => {
    const fixture = fixtureFetch({
      'release-cli.yml': { status: 200, body: { workflow_runs: null } },
    });
    await assert.rejects(
      verifyPretagReadinessRuns({ repository, token, sourceCommit, fetchImpl: fixture.fetchImpl }),
      /runs response is malformed/u,
    );
  });
  await t.test('malformed jobs', async () => {
    const fixture = fixtureFetch({
      'release-cli.yml': { jobsBody: { total_count: 1, jobs: null } },
    });
    await assert.rejects(
      verifyPretagReadinessRuns({ repository, token, sourceCommit, fetchImpl: fixture.fetchImpl }),
      /jobs response is malformed/u,
    );
  });
  await t.test('network errors cannot leak tokens', async () => {
    await assert.rejects(
      verifyPretagReadinessRuns({
        repository,
        token,
        sourceCommit,
        fetchImpl: async () => { throw new Error(`Bearer ${token}`); },
      }),
      (error) => {
        assert.match(error.message, /request failed/u);
        assert.doesNotMatch(error.message, new RegExp(token, 'u'));
        return true;
      },
    );
  });
});

test('continues to accept release-commit push readiness and mixed triggers', async () => {
  for (const events of [['push', 'push'], ['push', 'workflow_dispatch'], ['workflow_dispatch', 'push']]) {
    const fixture = fixtureFetch(Object.fromEntries(
      Object.keys(requiredJobs).map((workflow, index) => [workflow, { run: { event: events[index] } }]),
    ));
    const result = await verifyPretagReadinessRuns({
      repository, token, sourceCommit, fetchImpl: fixture.fetchImpl,
    });
    assert.deepEqual(result.runIds, { 'release-cli.yml': 101, 'mode2-signed-readiness.yml': 202 });
  }
});
