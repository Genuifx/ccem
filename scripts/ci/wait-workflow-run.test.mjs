import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAX_WAIT_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  EXIT_FAILED,
  EXIT_IN_PROGRESS,
  EXIT_SUCCESS,
  EXIT_UNKNOWN,
  HARD_MAX_WAIT_SECONDS,
  parseArgs,
  waitForWorkflowRun,
} from './wait-workflow-run.mjs';

const SHA = '7763abfefe18d38248fe8fe12707b64805a5dc0f';
const OTHER_SHA = 'f7bf794a6fed2612338d86c90939d663dce7af33';

function makeRun(overrides = {}) {
  return {
    id: 44960155635,
    path: '.github/workflows/mode2-signed-readiness.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    html_url: 'https://github.com/Genuifx/ccem/actions/runs/44960155635',
    ...overrides,
  };
}

function makeFakeClock(initialMs = 1_000_000) {
  let current = initialMs;
  const sleeps = [];
  return {
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms);
      current += ms;
    },
    sleeps,
  };
}

test('parseArgs accepts valid options and normalizes workflow filename', () => {
  const parsed = parseArgs([
    '--run-id', '44960155635',
    '--expected-sha', SHA,
    '--expected-workflow', 'mode2-signed-readiness.yml',
    '--expected-event', 'push,workflow_dispatch',
    '--expected-branch', 'main',
  ], {});

  assert.equal(parsed.runId, 44960155635);
  assert.equal(parsed.repository, 'Genuifx/ccem');
  assert.equal(parsed.expectedSha, SHA);
  assert.equal(parsed.expectedWorkflow, '.github/workflows/mode2-signed-readiness.yml');
  assert.deepEqual(parsed.expectedEvents, ['push', 'workflow_dispatch']);
  assert.equal(parsed.expectedBranch, 'main');
  assert.equal(parsed.maxWaitSeconds, DEFAULT_MAX_WAIT_SECONDS);
  assert.equal(parsed.pollIntervalSeconds, DEFAULT_POLL_INTERVAL_SECONDS);
});

test('parseArgs rejects max-wait-seconds above hard cap to prevent 600s auto-backgrounding', () => {
  assert.throws(
    () => parseArgs(['--run-id', '42', '--max-wait-seconds', String(HARD_MAX_WAIT_SECONDS + 1)], {}),
    /exceeds hard cap/,
  );
  assert.throws(
    () => parseArgs(['--run-id', '42', '--expected-sha', 'short'], {}),
    /40-char Git SHA/,
  );
  assert.throws(
    () => parseArgs([], {}),
    /--run-id is required/,
  );
});

test('waitForWorkflowRun returns COMPLETED exit 0 when run finishes with success', async () => {
  const clock = makeFakeClock();
  const responses = [
    makeRun({ status: 'queued', conclusion: null }),
    makeRun({ status: 'in_progress', conclusion: null }),
    makeRun({ status: 'completed', conclusion: 'success' }),
  ];
  let idx = 0;

  const options = parseArgs([
    '--run-id', '44960155635',
    '--expected-sha', SHA,
    '--expected-workflow', 'mode2-signed-readiness.yml',
    '--expected-event', 'push,workflow_dispatch',
    '--max-wait-seconds', '120',
    '--poll-interval-seconds', '15',
  ], {});

  const { exitCode, result } = await waitForWorkflowRun(options, {
    fetchRun: async () => responses[idx++],
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(exitCode, EXIT_SUCCESS);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.conclusion, 'success');
  assert.equal(result.polls, 3);
  assert.deepEqual(clock.sleeps, [15_000, 15_000]);
});

test('waitForWorkflowRun returns COMPLETED exit 1 when run finishes with failure', async () => {
  const clock = makeFakeClock();
  const options = parseArgs(['--run-id', '44960155635'], {});

  const { exitCode, result } = await waitForWorkflowRun(options, {
    fetchRun: async () => makeRun({ status: 'completed', conclusion: 'failure' }),
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(exitCode, EXIT_FAILED);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.conclusion, 'failure');
});

test('waitForWorkflowRun returns IN_PROGRESS exit 2 when bounded wait window elapses', async () => {
  const clock = makeFakeClock();
  const options = parseArgs([
    '--run-id', '44960155635',
    '--expected-sha', SHA,
    '--max-wait-seconds', '45',
    '--poll-interval-seconds', '20',
  ], {});

  const { exitCode, result } = await waitForWorkflowRun(options, {
    fetchRun: async () => makeRun({ status: 'in_progress', conclusion: null }),
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(exitCode, EXIT_IN_PROGRESS);
  assert.equal(result.state, 'IN_PROGRESS');
  assert.equal(result.status, 'in_progress');
  assert.equal(result.elapsedSeconds, 45);
  assert.deepEqual(clock.sleeps, [20_000, 20_000, 5_000]);
});

test('waitForWorkflowRun fails fast on identity mismatches without waiting', async () => {
  const clock = makeFakeClock();
  const baseArgs = ['--run-id', '44960155635', '--max-wait-seconds', '60'];

  await assert.rejects(
    () => waitForWorkflowRun(parseArgs([...baseArgs, '--expected-sha', OTHER_SHA], {}), {
      fetchRun: async () => makeRun(),
      now: clock.now,
      sleep: clock.sleep,
    }),
    /head_sha/,
  );

  await assert.rejects(
    () => waitForWorkflowRun(parseArgs([...baseArgs, '--expected-workflow', 'release-cli.yml'], {}), {
      fetchRun: async () => makeRun(),
      now: clock.now,
      sleep: clock.sleep,
    }),
    /workflow path/,
  );

  await assert.rejects(
    () => waitForWorkflowRun(parseArgs([...baseArgs, '--expected-event', 'push'], {}), {
      fetchRun: async () => makeRun({ event: 'workflow_dispatch' }),
      now: clock.now,
      sleep: clock.sleep,
    }),
    /event workflow_dispatch/,
  );

  assert.equal(clock.sleeps.length, 0);
});

test('waitForWorkflowRun tolerates transient poll failures and returns UNKNOWN exit 3 when exhausted', async () => {
  const clock = makeFakeClock();
  const options = parseArgs([
    '--run-id', '44960155635',
    '--max-wait-seconds', '100',
    '--poll-interval-seconds', '10',
  ], {});

  let calls = 0;
  const recovered = await waitForWorkflowRun(options, {
    fetchRun: async () => {
      calls += 1;
      if (calls <= 2) throw new Error('temporary 502');
      return makeRun({ status: 'completed', conclusion: 'success' });
    },
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(recovered.exitCode, EXIT_SUCCESS);
  assert.equal(recovered.result.polls, 3);

  const exhausted = await waitForWorkflowRun(options, {
    fetchRun: async () => {
      throw new Error('rate limit exceeded');
    },
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(exhausted.exitCode, EXIT_UNKNOWN);
  assert.equal(exhausted.result.state, 'UNKNOWN');
  assert.match(exhausted.result.error, /rate limit exceeded/);
});

test('CLI exits with code 1 on invalid usage', () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wait-workflow-run.mjs');
  const res = spawnSync(process.execPath, [script, '--run-id', '1', '--max-wait-seconds', '900'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, EXIT_FAILED);
  assert.match(res.stderr, /exceeds hard cap/);
});
