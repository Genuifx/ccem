#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPOSITORY = 'Genuifx/ccem';
export const DEFAULT_MAX_WAIT_SECONDS = 420;
export const HARD_MAX_WAIT_SECONDS = 540;
export const DEFAULT_POLL_INTERVAL_SECONDS = 20;
export const MIN_POLL_INTERVAL_SECONDS = 5;
export const MAX_POLL_INTERVAL_SECONDS = 120;
export const MAX_CONSECUTIVE_POLL_ERRORS = 3;

export const EXIT_SUCCESS = 0;
export const EXIT_FAILED = 1;
export const EXIT_IN_PROGRESS = 2;
export const EXIT_UNKNOWN = 3;

const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const WORKFLOW_FILE_PATTERN = /^(?:\.github\/workflows\/)?[A-Za-z0-9_.-]+\.ya?ml$/u;

class UsageError extends Error {
  constructor(message) {
    super(`[wait-workflow-run] ${message}`);
    this.name = 'UsageError';
  }
}

class IdentityMismatchError extends Error {
  constructor(message) {
    super(`[wait-workflow-run] ${message}`);
    this.name = 'IdentityMismatchError';
  }
}

function parsePositiveInt(raw, label) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/u.test(raw)) {
    throw new UsageError(`${label} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new UsageError(`${label} must be a safe positive integer`);
  }
  return value;
}

export function normalizeExpectedWorkflow(value) {
  if (typeof value !== 'string' || !WORKFLOW_FILE_PATTERN.test(value)) {
    throw new UsageError('expected-workflow must be a workflow filename or .github/workflows/<file>.yml');
  }
  return value.startsWith('.github/workflows/') ? value : `.github/workflows/${value}`;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    runId: null,
    repository: env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
    expectedSha: null,
    expectedWorkflow: null,
    expectedEvents: null,
    expectedBranch: null,
    maxWaitSeconds: DEFAULT_MAX_WAIT_SECONDS,
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const nextValue = () => {
      if (i + 1 >= argv.length) {
        throw new UsageError(`missing value for ${arg}`);
      }
      i += 1;
      return argv[i];
    };

    switch (arg) {
      case '--run-id':
        options.runId = parsePositiveInt(nextValue(), '--run-id');
        break;
      case '--repo':
        options.repository = nextValue();
        break;
      case '--expected-sha':
        options.expectedSha = nextValue();
        break;
      case '--expected-workflow':
        options.expectedWorkflow = normalizeExpectedWorkflow(nextValue());
        break;
      case '--expected-event':
        options.expectedEvents = nextValue()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        break;
      case '--expected-branch':
        options.expectedBranch = nextValue();
        break;
      case '--max-wait-seconds':
        options.maxWaitSeconds = parsePositiveInt(nextValue(), '--max-wait-seconds');
        break;
      case '--poll-interval-seconds':
        options.pollIntervalSeconds = parsePositiveInt(nextValue(), '--poll-interval-seconds');
        break;
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  if (options.runId === null) {
    throw new UsageError('--run-id is required');
  }
  if (!REPO_PATTERN.test(options.repository)) {
    throw new UsageError('--repo must be an exact owner/name pair');
  }
  if (options.expectedSha !== null && !SHA_PATTERN.test(options.expectedSha)) {
    throw new UsageError('--expected-sha must be a full lowercase 40-char Git SHA');
  }
  if (options.expectedEvents !== null && options.expectedEvents.length === 0) {
    throw new UsageError('--expected-event must contain at least one event name');
  }
  if (options.expectedBranch !== null && options.expectedBranch.trim().length === 0) {
    throw new UsageError('--expected-branch must not be empty');
  }
  if (options.maxWaitSeconds > HARD_MAX_WAIT_SECONDS) {
    throw new UsageError(
      `--max-wait-seconds (${options.maxWaitSeconds}) exceeds hard cap ${HARD_MAX_WAIT_SECONDS}s (keeps waits safely under 600s tool timeout)`,
    );
  }
  if (
    options.pollIntervalSeconds < MIN_POLL_INTERVAL_SECONDS
    || options.pollIntervalSeconds > MAX_POLL_INTERVAL_SECONDS
  ) {
    throw new UsageError(
      `--poll-interval-seconds must be between ${MIN_POLL_INTERVAL_SECONDS} and ${MAX_POLL_INTERVAL_SECONDS}`,
    );
  }

  return options;
}

export function fetchRunWithGh({ repository, runId }) {
  const result = spawnSync(
    'gh',
    ['api', `/repos/${repository}/actions/runs/${runId}`],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (result.error) {
    throw new Error(`gh api failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 300);
    throw new Error(`gh api exited with ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('gh api returned invalid JSON');
  }
}

function validateRunShape(run) {
  if (
    !run
    || typeof run !== 'object'
    || !Number.isSafeInteger(run.id)
    || typeof run.status !== 'string'
  ) {
    throw new Error('workflow run response is malformed');
  }
}

function verifyRunIdentity(run, options) {
  if (run.id !== options.runId) {
    throw new IdentityMismatchError(`expected run id ${options.runId}, got ${run.id}`);
  }
  if (options.expectedSha && run.head_sha !== options.expectedSha) {
    throw new IdentityMismatchError(
      `run ${run.id} head_sha ${run.head_sha} does not match expected ${options.expectedSha}`,
    );
  }
  if (options.expectedWorkflow && run.path !== options.expectedWorkflow) {
    throw new IdentityMismatchError(
      `run ${run.id} workflow path ${run.path} does not match expected ${options.expectedWorkflow}`,
    );
  }
  if (options.expectedEvents && !options.expectedEvents.includes(run.event)) {
    throw new IdentityMismatchError(
      `run ${run.id} event ${run.event} is not in [${options.expectedEvents.join(', ')}]`,
    );
  }
  if (options.expectedBranch && run.head_branch !== options.expectedBranch) {
    throw new IdentityMismatchError(
      `run ${run.id} head_branch ${run.head_branch} does not match expected ${options.expectedBranch}`,
    );
  }
}

function buildResult(state, options, run, polls, elapsedSeconds, error = null) {
  const payload = {
    state,
    runId: options.runId,
    repository: options.repository,
    workflowPath: run?.path ?? options.expectedWorkflow ?? null,
    event: run?.event ?? null,
    headBranch: run?.head_branch ?? null,
    headSha: run?.head_sha ?? null,
    status: run?.status ?? null,
    conclusion: run?.conclusion ?? null,
    runAttempt: run?.run_attempt ?? null,
    htmlUrl: run?.html_url ?? null,
    elapsedSeconds,
    polls,
  };
  if (error) payload.error = error;
  return payload;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForWorkflowRun(options, deps = {}) {
  const fetchRun = deps.fetchRun ?? fetchRunWithGh;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const maxErrors = deps.maxConsecutiveErrors ?? MAX_CONSECUTIVE_POLL_ERRORS;

  const startMs = now();
  const deadlineMs = startMs + options.maxWaitSeconds * 1000;
  let polls = 0;
  let consecutiveErrors = 0;
  let lastRun = null;

  while (true) {
    polls += 1;
    let run;
    try {
      run = await fetchRun({ repository: options.repository, runId: options.runId });
      validateRunShape(run);
      verifyRunIdentity(run, options);
      consecutiveErrors = 0;
      lastRun = run;
    } catch (error) {
      if (error instanceof IdentityMismatchError) {
        throw error;
      }
      consecutiveErrors += 1;
      const elapsedSeconds = Math.max(0, Math.round((now() - startMs) / 1000));
      if (consecutiveErrors >= maxErrors) {
        return {
          exitCode: EXIT_UNKNOWN,
          result: buildResult('UNKNOWN', options, lastRun, polls, elapsedSeconds, error.message),
        };
      }
      const remainingMs = deadlineMs - now();
      if (remainingMs <= 0) {
        return {
          exitCode: EXIT_UNKNOWN,
          result: buildResult('UNKNOWN', options, lastRun, polls, elapsedSeconds, error.message),
        };
      }
      await sleep(Math.min(options.pollIntervalSeconds * 1000, remainingMs));
      continue;
    }

    const elapsedSeconds = Math.max(0, Math.round((now() - startMs) / 1000));
    if (run.status === 'completed') {
      const exitCode = run.conclusion === 'success' ? EXIT_SUCCESS : EXIT_FAILED;
      return {
        exitCode,
        result: buildResult('COMPLETED', options, run, polls, elapsedSeconds),
      };
    }

    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) {
      return {
        exitCode: EXIT_IN_PROGRESS,
        result: buildResult('IN_PROGRESS', options, run, polls, elapsedSeconds),
      };
    }

    await sleep(Math.min(options.pollIntervalSeconds * 1000, remainingMs));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { exitCode, result } = await waitForWorkflowRun(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = exitCode;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = EXIT_FAILED;
  });
}
