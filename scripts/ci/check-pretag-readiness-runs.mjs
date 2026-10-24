#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { requestJson } from './release-http.mjs';

const API_ORIGIN = 'https://api.github.com';
export const REQUIRED_WORKFLOWS = Object.freeze([
  Object.freeze({
    workflow: 'release-cli.yml',
    requiredJob: 'Preflight npm Trusted Publisher',
  }),
  Object.freeze({
    workflow: 'mode2-signed-readiness.yml',
    requiredJob: 'Confirm Desktop Release Readiness',
  }),
]);
const PAGE_SIZE = 100;
const MAX_JOB_PAGES = 100;

function fail(message) {
  throw new Error(`[pretag-readiness] ${message}`);
}

function exactRepository(value) {
  if (
    typeof value !== 'string'
    || value.length > 200
    || !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/u
      .test(value)
  ) {
    fail('GITHUB_REPOSITORY must be an exact owner/name pair');
  }
  return value;
}

function exactToken(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 4096
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    fail('CCEM_RELEASE_READINESS_TOKEN has an invalid format');
  }
  return value;
}

function exactSourceCommit(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/u.test(value)) {
    fail('CCEM_RELEASE_SOURCE_COMMIT must be a full lowercase Git SHA');
  }
  return value;
}

function workflowRunsUrl(repository, workflow, sourceCommit) {
  const url = new URL(
    `${API_ORIGIN}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
  );
  url.searchParams.set('branch', 'main');
  // Both pre-tag workflows support protected-main dispatch after candidate fixes.
  // Keep the event allowlist below; filtering to push here hides that evidence.
  url.searchParams.set('status', 'success');
  url.searchParams.set('head_sha', sourceCommit);
  url.searchParams.set('per_page', String(PAGE_SIZE));
  return url.href;
}

function workflowJobsUrl(repository, runId, runAttempt, page) {
  const url = new URL(
    `${API_ORIGIN}/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs`,
  );
  url.searchParams.set('per_page', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  return url.href;
}

async function responseJson(fetchImpl, url, token, label, sleepImpl) {
  return requestJson({ fetchImpl, url, token, label: `[pretag-readiness] ${label}`, sleepImpl });
}

function successfulExactRun(body, workflow, sourceCommit) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.workflow_runs)) {
    fail(`${workflow} runs response is malformed`);
  }
  const expectedPath = `.github/workflows/${workflow}`;
  return body.workflow_runs.find((run) => (
    run
    && typeof run === 'object'
    && run.path === expectedPath
    && run.head_sha === sourceCommit
    && run.head_branch === 'main'
    && (run.event === 'push' || run.event === 'workflow_dispatch')
    && run.status === 'completed'
    && run.conclusion === 'success'
    && Number.isSafeInteger(run.id)
    && run.id > 0
    && Number.isSafeInteger(run.run_attempt)
    && run.run_attempt > 0
  ));
}

async function loadExactAttemptJobs({
  repository,
  token,
  run,
  workflow,
  fetchImpl,
  sleepImpl,
}) {
  const jobs = [];
  let expectedTotal = null;
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const body = await responseJson(
      fetchImpl,
      workflowJobsUrl(repository, run.id, run.run_attempt, page),
      token,
      `${workflow} run ${run.id} attempt ${run.run_attempt} jobs`,
      sleepImpl,
    );
    if (
      !body
      || typeof body !== 'object'
      || !Number.isSafeInteger(body.total_count)
      || body.total_count < 0
      || !Array.isArray(body.jobs)
      || body.jobs.length > PAGE_SIZE
    ) {
      fail(`${workflow} jobs response is malformed`);
    }
    if (expectedTotal == null) expectedTotal = body.total_count;
    if (body.total_count !== expectedTotal) {
      fail(`${workflow} jobs total changed while readiness was verified`);
    }
    jobs.push(...body.jobs);
    if (jobs.length > expectedTotal) fail(`${workflow} jobs response exceeded total_count`);
    if (jobs.length === expectedTotal) return jobs;
    if (body.jobs.length < PAGE_SIZE) {
      fail(`${workflow} jobs response ended before total_count`);
    }
  }
  fail(`${workflow} jobs pagination exceeded ${MAX_JOB_PAGES} pages`);
}

function hasSuccessfulRequiredJob(jobs, run, requiredJob) {
  return jobs.some((job) => (
    job
    && typeof job === 'object'
    && job.run_id === run.id
    && job.name === requiredJob
    && job.status === 'completed'
    && job.conclusion === 'success'
  ));
}

export async function verifyPretagReadinessRuns({
  repository,
  token,
  sourceCommit,
  fetchImpl = globalThis.fetch,
  selectedRuns,
  sleepImpl,
}) {
  const exactRepo = exactRepository(repository);
  const exactReadinessToken = exactToken(token);
  const exactSha = exactSourceCommit(sourceCommit);
  if (typeof fetchImpl !== 'function') fail('fetch implementation is unavailable');

  const runIds = {};
  for (const requirement of REQUIRED_WORKFLOWS) {
    const { workflow, requiredJob } = requirement;
    let run;
    if (selectedRuns) {
      const selected = selectedRuns[workflow];
      if (!Number.isSafeInteger(selected?.id) || selected.id <= 0
        || !Number.isSafeInteger(selected.run_attempt) || selected.run_attempt <= 0) {
        fail(`${workflow} selected run identity is malformed`);
      }
      const current = await responseJson(fetchImpl,
        `${API_ORIGIN}/repos/${exactRepo}/actions/runs/${selected.id}`, exactReadinessToken, workflow, sleepImpl);
      if (current?.id !== selected.id || current?.run_attempt !== selected.run_attempt) {
        fail(`${workflow} selected run ${selected.id} attempt changed; inspect current readiness again`);
      }
      run = successfulExactRun({ workflow_runs: [current] }, workflow, exactSha);
    } else {
      const body = await responseJson(fetchImpl, workflowRunsUrl(exactRepo, workflow, exactSha),
        exactReadinessToken, workflow, sleepImpl);
      run = successfulExactRun(body, workflow, exactSha);
    }
    if (!run) {
      fail(`${workflow} has no successful main push or workflow_dispatch run for exact source ${exactSha}`);
    }
    const jobs = await loadExactAttemptJobs({
      repository: exactRepo,
      token: exactReadinessToken,
      run,
      workflow,
      fetchImpl,
      sleepImpl,
    });
    if (!hasSuccessfulRequiredJob(jobs, run, requiredJob)) {
      fail(`${workflow} run ${run.id} did not complete required job ${requiredJob}`);
    }
    runIds[workflow] = run.id;
  }
  if (selectedRuns) {
    // Re-read after all job bodies: a rerun can advance the attempt while jobs
    // for the previous successful attempt remain available.
    for (const { workflow } of REQUIRED_WORKFLOWS) {
      const selected = selectedRuns[workflow];
      const current = await responseJson(fetchImpl,
        `${API_ORIGIN}/repos/${exactRepo}/actions/runs/${selected.id}`, exactReadinessToken, workflow, sleepImpl);
      if (current?.id !== selected.id || current?.run_attempt !== selected.run_attempt) {
        fail(`${workflow} selected run ${selected.id} attempt changed during verification`);
      }
      if (!successfulExactRun({ workflow_runs: [current] }, workflow, exactSha)) {
        fail(`${workflow} selected run ${selected.id} is no longer successful`);
      }
    }
  }
  return { repository: exactRepo, sourceCommit: exactSha, runIds };
}

async function main() {
  const result = await verifyPretagReadinessRuns({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.CCEM_RELEASE_READINESS_TOKEN,
    sourceCommit: process.env.CCEM_RELEASE_SOURCE_COMMIT,
  });
  process.stdout.write(
    `[pretag-readiness] ${result.sourceCommit}: Release CLI run `
    + `${result.runIds['release-cli.yml']}, Desktop run `
    + `${result.runIds['mode2-signed-readiness.yml']}\n`,
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

// Read all exact-source attempts before deciding whether a workflow is absent. In
// particular, a green automatic run with skipped jobs is not release evidence.
export async function inspectPretagWorkflow({
  repository, token, sourceCommit, workflow, fetchImpl = globalThis.fetch, sleepImpl,
}) {
  exactRepository(repository);
  exactToken(token);
  exactSourceCommit(sourceCommit);
  const requirement = REQUIRED_WORKFLOWS.find((entry) => entry.workflow === workflow);
  if (!requirement) fail(`unsupported readiness workflow ${workflow}`);
  const runs = [];
  let expectedTotal;
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(workflowRunsUrl(repository, workflow, sourceCommit));
    url.searchParams.delete('status');
    url.searchParams.set('page', String(page));
    const body = await responseJson(fetchImpl, url.href, token, workflow, sleepImpl);
    if (!body || !Number.isSafeInteger(body.total_count) || body.total_count < 0
      || !Array.isArray(body.workflow_runs) || body.workflow_runs.length > PAGE_SIZE) {
      fail(`${workflow} runs response is malformed`);
    }
    if (expectedTotal == null) expectedTotal = body.total_count;
    if (body.total_count !== expectedTotal) fail(`${workflow} runs changed during pagination; inspect again`);
    runs.push(...body.workflow_runs);
    if (runs.length > expectedTotal) fail(`${workflow} runs response exceeded total_count`);
    if (runs.length === expectedTotal) break;
    if (body.workflow_runs.length < PAGE_SIZE) fail(`${workflow} runs response ended before total_count`);
    if (page === 10) fail(`${workflow} runs exceed the 1000-run API search window; inspect manually`);
  }
  const exactRuns = runs.filter((run) => run && run.path === `.github/workflows/${workflow}`
    && run.head_sha === sourceCommit && run.head_branch === 'main'
    && ['push', 'workflow_dispatch'].includes(run.event));
  for (const run of exactRuns) {
    if (!Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) {
      fail(`${workflow} run identity is malformed`);
    }
  }
  function attemptTime(run) {
    const values = [run.updated_at, ...(run.run_started_at == null ? [] : [run.run_started_at])];
    if (values.some((value) => typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
      || !Number.isFinite(Date.parse(value)))) {
      fail(`${workflow} run ${run.id} attempt timestamp is missing or malformed`);
    }
    return Math.max(...values.map((value) => Date.parse(value)));
  }
  function blockerPriority(run) {
    if (run.status !== 'completed') return 3;
    if (run.conclusion === 'skipped' && run.event === 'push') return 0;
    return run.conclusion === 'success' ? 1 : 4;
  }
  // A rerun retains its old run ID. Use attempt activity, and conservatively
  // prefer a blocker if GitHub's second-resolution timestamps are tied.
  for (const run of exactRuns) attemptTime(run);
  exactRuns.sort((a, b) => attemptTime(b) - attemptTime(a)
    || blockerPriority(b) - blockerPriority(a) || b.id - a.id);
  const base = { ...requirement, runs: exactRuns };
  for (const run of exactRuns) {
    if (run.status === 'completed' && run.conclusion === 'success') {
      const jobs = await loadExactAttemptJobs({ repository, token, run, workflow, fetchImpl, sleepImpl });
      if (hasSuccessfulRequiredJob(jobs, run, requirement.requiredJob)) return { ...base, state: 'ready', run };
      const skippedAutomatic = run.event === 'push' && (jobs.length === 0
        || jobs.every((job) => job.status === 'completed' && job.conclusion === 'skipped'));
      if (!skippedAutomatic) return { ...base, state: 'failed', run, reason: `required job ${requirement.requiredJob} did not succeed` };
    } else if (['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status) && run.conclusion == null) {
      return { ...base, state: 'pending', run };
    } else if (run.status === 'completed' && run.conclusion === 'skipped' && run.event === 'push') {
      // The workflow's release-message filter intentionally skipped an ordinary fix.
    } else if (run.status === 'completed' && typeof run.conclusion === 'string') {
      return { ...base, state: 'failed', run, reason: `workflow concluded ${run.conclusion}` };
    } else {
      fail(`${workflow} run ${run.id} has an unknown status; inspect manually`);
    }
  }
  return { ...base, state: 'missing' };
}
