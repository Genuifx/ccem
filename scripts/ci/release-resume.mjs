#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolveReleaseCandidate } from './resolve-release-candidate.mjs';
import { inspectPretagWorkflow, REQUIRED_WORKFLOWS, verifyPretagReadinessRuns } from './check-pretag-readiness-runs.mjs';
import { githubHeaders, safeTransportCause, TRANSIENT_HTTP_STATUSES } from './release-http.mjs';

function stop(code, message, cause) {
  const error = new Error(`[release-resume] ${message}`, { cause });
  error.code = code;
  throw error;
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.error || result.status !== 0) {
    // Git/gh output can contain authenticated URLs; do not copy it to reports.
    stop('LOCAL_COMMAND_FAILED', `${command} ${args[0]} failed; check existing authentication and repository access`);
  }
  return result.stdout.trim();
}

async function refreshCandidate({ cwd }) {
  // Fetch existing refs only. Never force, push, bump, or create a candidate tag.
  runCommand('git', ['fetch', '--no-recurse-submodules', 'origin', 'main', '--tags'], cwd);
}

function runUrl(repository, run) {
  return `https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
}

function assertNoFailure(repository, states) {
  const failed = states.find((state) => state.state === 'failed');
  if (!failed) return;
  const { workflow, run, reason } = failed;
  stop('WORKFLOW_FAILED', `${workflow} run ${run.id} attempt ${run.run_attempt}: ${reason}. `
    + `${runUrl(repository, run)}. Inspect with gh run view ${run.id} --repo ${repository} --attempt ${run.run_attempt} --log-failed. `
    + 'No automatic workflow rerun was attempted; repair deterministic failures before resuming.');
}

async function dispatchOnce({ repository, token, candidate, workflow, fetchImpl }) {
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: {
        expected_sha: candidate.sourceCommit, expected_version: candidate.version,
      } }),
    });
  } catch (error) {
    // This request could have reached GitHub. Reconcile; never retry this POST.
    return { uncertain: true, cause: safeTransportCause(error) };
  }
  if (response?.status === 204 && response.ok === true) return { uncertain: false };
  if (response?.status >= 400 && response.status < 500 && !TRANSIENT_HTTP_STATUSES.has(response.status)) {
    stop('DISPATCH_REJECTED', `${workflow} dispatch rejected (${response.status}); check existing access and workflow inputs`);
  }
  return { uncertain: true, cause: new Error(`HTTP ${Number.isInteger(response?.status) ? response.status : 'invalid response'}`) };
}

// This command establishes only pre-tag evidence. Baseline delivery, release
// approval, and the final pre-tag race check remain the existing separate gates.
export async function resumeRelease({
  repository, token, cwd = process.cwd(), fetchImpl = globalThis.fetch,
  resolveCandidate = resolveReleaseCandidate, refreshCandidate: refresh = refreshCandidate,
  sleepImpl = sleep, now = Date.now, onProgress = () => {},
  pollIntervalMs = 15_000, dispatchPollIntervalMs = 5_000, dispatchPolls = 12,
  timeoutMs = 2 * 60 * 60 * 1000,
  journal = { read: () => null, write: () => {}, clear: () => {} },
}) {
  if (![pollIntervalMs, dispatchPollIntervalMs, dispatchPolls, timeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
    stop('INVALID_OPTIONS', 'polling and timeout options must be positive safe integers');
  }
  await refresh({ cwd });
  const candidate = Object.freeze({ ...await resolveCandidate({ cwd }) });
  onProgress(`Pinned ${candidate.candidateTag} at ${candidate.sourceCommit}; baseline delivery is not checked by this command.`);
  const started = now();
  const common = { repository, token, sourceCommit: candidate.sourceCommit, fetchImpl, sleepImpl };
  const inspect = (workflow) => inspectPretagWorkflow({ ...common, workflow });
  for (const intent of journal.pending?.() ?? []) {
    if (!Array.isArray(intent.observedIds) || !intent.observedIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
      stop('INVALID_JOURNAL', 'saved dispatch observations are malformed; keep them and inspect local state');
    }
    const prior = await inspectPretagWorkflow({ ...common, sourceCommit: intent.sourceCommit, workflow: intent.workflow });
    if (prior.runs.some((run) => run.event === 'workflow_dispatch' && !intent.observedIds.includes(run.id))) {
      // Remote identity resolves uncertainty even when its actual outcome failed.
      journal.clear(intent);
    } else if (intent.sourceCommit !== candidate.sourceCommit) {
      stop('UNKNOWN_DISPATCH', `unresolved dispatch for ${intent.workflow} on previous source ${intent.sourceCommit}; `
        + `reconcile its remote state at https://github.com/${repository}/actions before starting this candidate. Keep the intent file until reconciled.`);
    }
  }
  async function assertPinned() {
    const current = await resolveCandidate({ cwd });
    if (['sourceCommit', 'version', 'candidateTag', 'previousTag', 'previousCommit'].some((key) => current[key] !== candidate[key])) {
      stop('CANDIDATE_CHANGED', `candidate changed from ${candidate.candidateTag} at ${candidate.sourceCommit}; `
        + 'stop and inspect main/tag changes, then start a new invocation.');
    }
  }
  let states = await Promise.all(REQUIRED_WORKFLOWS.map(({ workflow }) => inspect(workflow)));
  assertNoFailure(repository, states);
  const dispatched = new Set();
  for (const { workflow } of REQUIRED_WORKFLOWS) {
    const journalKey = { repository, sourceCommit: candidate.sourceCommit, workflow };
    const previousIntent = journal.read(journalKey);
    if (!previousIntent && states.find((state) => state.workflow === workflow).state !== 'missing') continue;
    await assertPinned();
    // Another operator or an automatic run may have supplied evidence meanwhile.
    const before = await inspect(workflow);
    assertNoFailure(repository, [before]);
    if (!previousIntent && before.state !== 'missing') continue;
    if (previousIntent && (previousIntent.version !== candidate.version
      || previousIntent.repository !== repository || previousIntent.sourceCommit !== candidate.sourceCommit
      || previousIntent.workflow !== workflow || !Array.isArray(previousIntent.observedIds)
      || !previousIntent.observedIds.every((id) => Number.isSafeInteger(id) && id > 0))) {
      stop('INVALID_JOURNAL', `${workflow} saved dispatch intent is malformed; inspect local state before continuing`);
    }
    const observedIds = new Set(previousIntent?.observedIds ?? before.runs.map((run) => run.id));
    await assertPinned();
    let dispatch;
    if (previousIntent) {
      dispatch = { uncertain: true, cause: new Error('Unresolved dispatch intent from an earlier invocation') };
    } else {
      // Persist before the mutation, including before an interruption or lost response.
      journal.write({ ...journalKey, version: candidate.version, observedIds: [...observedIds] });
      try {
        dispatch = await dispatchOnce({ repository, token, candidate, workflow, fetchImpl });
      } catch (error) {
        if (error.code === 'DISPATCH_REJECTED') journal.clear(journalKey);
        throw error;
      }
    }
    dispatched.add(workflow);
    onProgress(`${workflow}: ${dispatch.uncertain ? 'dispatch outcome uncertain; reconciling' : 'dispatch accepted; locating exact run'}.`);
    let discovered;
    for (let poll = 0; poll < dispatchPolls; poll += 1) {
      await assertPinned();
      const current = await inspect(workflow);
      const newRuns = current.runs.filter((run) => run.event === 'workflow_dispatch' && !observedIds.has(run.id));
      if (newRuns.length > 0) {
        discovered = current;
        journal.clear(journalKey);
        onProgress(`${workflow}: observed ${runUrl(repository, newRuns[0])}.`);
        assertNoFailure(repository, [current]);
        break;
      }
      if (poll + 1 < dispatchPolls) await sleepImpl(dispatchPollIntervalMs);
    }
    if (!discovered) {
      stop('UNKNOWN_DISPATCH', `${workflow}: no matching new run for ${candidate.sourceCommit} after dispatch; `
        + 'do not dispatch again until remote state is reconciled. Inspect '
        + `https://github.com/${repository}/actions/workflows/${workflow}; `
        + `expected_version=${candidate.version}, expected_sha=${candidate.sourceCommit}`
        + `${dispatch.cause ? `; ${dispatch.cause.message}` : ''}.`, dispatch.cause);
    }
  }

  let lastStatus;
  for (;;) {
    await assertPinned();
    states = await Promise.all(REQUIRED_WORKFLOWS.map(({ workflow }) => inspect(workflow)));
    assertNoFailure(repository, states);
    const status = states.map(({ workflow, state, run }) => `${workflow}: ${state}${run ? ` (run ${run.id}, attempt ${run.run_attempt})` : ''}`).join('; ');
    if (status !== lastStatus) onProgress(status);
    lastStatus = status;
    if (states.every((state) => state.state === 'ready')) break;
    const missing = states.find((state) => state.state === 'missing');
    if (missing) {
      stop('UNKNOWN_READINESS', `${missing.workflow} evidence is missing${dispatched.has(missing.workflow) ? ' after dispatch' : ''}; `
        + 'inspect remote runs before a new invocation. No replacement was dispatched.');
    }
    if (now() - started >= timeoutMs) {
      stop('READINESS_PENDING', `${status}; still pending after the observation window. `
        + 'Inspect the active runs or resume later to reuse them; no replacement was dispatched.');
    }
    await sleepImpl(pollIntervalMs);
  }
  const selectedRuns = Object.fromEntries(states.map((state) => [state.workflow, state.run]));
  const verified = await verifyPretagReadinessRuns({ ...common, selectedRuns });
  await assertPinned();
  return {
    status: 'PRETAG_READINESS_VERIFIED', ...candidate, ...verified,
    readiness: Object.fromEntries(states.map(({ workflow, run }) => [workflow, {
      id: run.id, runAttempt: run.run_attempt, url: runUrl(repository, run),
    }])),
    baselineDelivery: 'NOT_CHECKED', releaseEligible: false,
    nextStep: 'Reconcile baseline delivery separately. Before any authorized tag action, recheck exact main and candidate-tag absence.',
  };
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Usage: pnpm release:resume\nResumes non-publishing CLI/Desktop readiness for the stable untagged version on current origin/main.\n'
      + 'Uses existing CCEM_RELEASE_READINESS_TOKEN, GH_TOKEN, GITHUB_TOKEN, or gh authentication.\n'
      + 'Fetches existing origin refs; dispatches only missing readiness; waits up to two hours.\n'
      + 'Does not verify baseline delivery or authorize publishing. Does not bump, push, tag, merge, or change credentials.');
    return;
  }
  if (process.argv.length !== 2) stop('USAGE', 'usage: pnpm release:resume [--help]');
  const cwd = process.cwd();
  const origin = runCommand('git', ['remote', 'get-url', 'origin'], cwd);
  const match = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u);
  if (!match) stop('INVALID_ORIGIN', 'origin must be an exact github.com repository URL; no credentials or query strings');
  const repository = match[1];
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY.toLowerCase() !== repository.toLowerCase()) {
    stop('REPOSITORY_MISMATCH', 'GITHUB_REPOSITORY does not match origin');
  }
  const token = process.env.CCEM_RELEASE_READINESS_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    || runCommand('gh', ['auth', 'token', '--hostname', 'github.com'], cwd);
  const commonGitDirectory = path.resolve(cwd, runCommand('git', ['rev-parse', '--git-common-dir'], cwd));
  const journal = openResumeJournal({ directory: path.join(commonGitDirectory, 'ccem-release-resume'), repository });
  try {
    const result = await resumeRelease({ repository, token, cwd, journal,
      onProgress: (message) => console.error(`[release-resume] ${message}`) });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    journal.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${error.code ? `${error.code}: ` : ''}${error.message}`);
    process.exitCode = 1;
  });
}

// Shared by linked worktrees in one clone. This is local recovery metadata only;
// never store credentials, logs, or a claim of release eligibility here.
export function openResumeJournal({ directory, repository }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) stop('INVALID_JOURNAL', 'invalid journal repository');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = path.join(directory, repository.replace('/', '--').toLowerCase());
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, 'operator.lock');
  const owner = JSON.stringify({ pid: process.pid, hostname: hostname(), nonce: randomUUID() });
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    stop('RESUME_LOCKED', `release recovery is already locked at ${lockPath}. `
      + 'Check its recorded host/PID and wait for the owner; if that process has stopped, remove only this lock file. Keep all dispatch-intent files.');
  }
  try { writeFileSync(lock, owner); fsyncSync(lock); } finally { closeSync(lock); }
  let closed = false;
  function fileFor({ repository: target, sourceCommit, workflow }) {
    if (closed || target !== repository || !/^[a-f0-9]{40}$/u.test(sourceCommit)
      || !REQUIRED_WORKFLOWS.some((entry) => entry.workflow === workflow)) {
      stop('INVALID_JOURNAL', 'invalid or closed dispatch journal request');
    }
    return path.join(root, `${sourceCommit}-${workflow}.json`);
  }
  return {
    pending() {
      return readdirSync(root).filter((file) => file.endsWith('.json')).map((file) => {
        let intent;
        try { intent = JSON.parse(readFileSync(path.join(root, file), 'utf8')); } catch {
          stop('INVALID_JOURNAL', 'could not read saved dispatch intent; keep it and inspect local state');
        }
        fileFor(intent);
        if (file !== `${intent.sourceCommit}-${intent.workflow}.json`) stop('INVALID_JOURNAL', 'dispatch intent filename does not match its source');
        return intent;
      });
    },
    read(key) {
      try { return JSON.parse(readFileSync(fileFor(key), 'utf8')); } catch (error) {
        if (error.code === 'ENOENT') return null;
        stop('INVALID_JOURNAL', 'could not read saved dispatch intent; keep it and inspect local state');
      }
    },
    write(record) {
      const file = openSync(fileFor(record), 'wx', 0o600);
      try { writeFileSync(file, JSON.stringify(record)); fsyncSync(file); } finally { closeSync(file); }
    },
    clear(key) {
      try { unlinkSync(fileFor(key)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    close() {
      if (closed) return;
      // Do not remove another process's lock if local metadata was changed.
      if (readFileSync(lockPath, 'utf8') !== owner) stop('RESUME_LOCKED', `lock ownership changed at ${lockPath}`);
      unlinkSync(lockPath);
      closed = true;
    },
  };
}
