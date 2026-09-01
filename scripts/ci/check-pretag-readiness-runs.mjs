#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REQUIRED_WORKFLOWS = Object.freeze([
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
  url.searchParams.set('event', 'push');
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

async function responseJson(fetchImpl, url, token, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
      },
    });
  } catch {
    fail(`${label} request failed`);
  }
  if (!response || response.status !== 200 || response.ok !== true) {
    fail(`${label} read failed (${response?.status ?? 'invalid response'})`);
  }
  try {
    return await response.json();
  } catch {
    fail(`${label} returned invalid JSON`);
  }
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
    && run.event === 'push'
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
}) {
  const jobs = [];
  let expectedTotal = null;
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const body = await responseJson(
      fetchImpl,
      workflowJobsUrl(repository, run.id, run.run_attempt, page),
      token,
      `${workflow} run ${run.id} attempt ${run.run_attempt} jobs`,
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
}) {
  const exactRepo = exactRepository(repository);
  const exactReadinessToken = exactToken(token);
  const exactSha = exactSourceCommit(sourceCommit);
  if (typeof fetchImpl !== 'function') fail('fetch implementation is unavailable');

  const runIds = {};
  for (const requirement of REQUIRED_WORKFLOWS) {
    const { workflow, requiredJob } = requirement;
    const body = await responseJson(
      fetchImpl,
      workflowRunsUrl(exactRepo, workflow, exactSha),
      exactReadinessToken,
      workflow,
    );
    const run = successfulExactRun(body, workflow, exactSha);
    if (!run) {
      fail(`${workflow} has no successful main-push run for exact source ${exactSha}`);
    }
    const jobs = await loadExactAttemptJobs({
      repository: exactRepo,
      token: exactReadinessToken,
      run,
      workflow,
      fetchImpl,
    });
    if (!hasSuccessfulRequiredJob(jobs, run, requiredJob)) {
      fail(`${workflow} run ${run.id} did not complete required job ${requiredJob}`);
    }
    runIds[workflow] = run.id;
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
