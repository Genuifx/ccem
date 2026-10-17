#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const VERSION_FILES = [
  'apps/cli/package.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/src-tauri/Cargo.toml',
  'apps/desktop/src-tauri/Cargo.lock',
];

function fail(message) {
  throw new Error(`[release-candidate] ${message}`);
}

function versionFromSource(file, source) {
  if (file.endsWith('.json')) return JSON.parse(source).version;
  const block = source.split(/\[\[?package\]?\]/u)
    .find((entry) => /^name\s*=\s*"ccem-desktop"\s*$/mu.test(entry));
  return block?.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
}

function isNewer(version, baseline) {
  const left = version.split('.').map(BigInt);
  const right = baseline.split('.').map(BigInt);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

// Resolve the untagged version on current main, not the historical bump commit.
// This is read-only source selection; baseline delivery and readiness are separate gates.
export function resolveReleaseCandidate({ cwd = process.cwd() } = {}) {
  function git(args, allowedStatuses = [0]) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
    if (result.error || !allowedStatuses.includes(result.status)) {
      fail(`git ${args[0]} failed; refresh origin/main and tags or check remote access`);
    }
    return { status: result.status, output: result.stdout.trim() };
  }

  const sourceCommit = git(['rev-parse', 'refs/remotes/origin/main^{commit}']).output;
  const versions = Object.fromEntries(VERSION_FILES.map((file) => [
    file, versionFromSource(file, git(['show', `${sourceCommit}:${file}`]).output),
  ]));
  const version = versions[VERSION_FILES[0]];
  if (!STABLE_VERSION.test(version ?? '')) fail('stable release recovery requires an exact X.Y.Z version');
  if (Object.values(versions).some((value) => value !== version)) {
    fail(`release versions differ at ${sourceCommit}: ${JSON.stringify(versions)}`);
  }

  const previousTag = git(['tag', '--merged', sourceCommit, '--sort=-version:refname', '--list', 'v*'])
    .output.split('\n').find((tag) => tag.startsWith('v') && STABLE_VERSION.test(tag.slice(1)));
  if (!previousTag) fail('no reachable stable baseline tag; fetch origin tags first');
  if (!isNewer(version, previousTag.slice(1))) {
    fail(`no unpublished candidate: main version ${version} is not newer than ${previousTag}`);
  }

  const candidateTag = `v${version}`;
  if (git(['show-ref', '--verify', '--quiet', `refs/tags/${candidateTag}`], [0, 1]).status === 0) {
    fail(`${candidateTag} already exists locally; never move or overwrite a candidate tag`);
  }
  if (git(['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${candidateTag}`], [0, 2]).status === 0) {
    fail(`${candidateTag} already exists on origin; reconcile its delivery before recovery`);
  }
  const previousCommit = git(['rev-parse', `refs/tags/${previousTag}^{commit}`]).output;
  const remoteBaseline = git([
    'ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${previousTag}`, `refs/tags/${previousTag}^{}`,
  ]).output.split('\n').map((line) => line.split(/\s+/u));
  const remotePreviousCommit = remoteBaseline.find(([, ref]) => ref.endsWith('^{}'))?.[0]
    ?? remoteBaseline.find(([, ref]) => ref === `refs/tags/${previousTag}`)?.[0];
  if (remotePreviousCommit !== previousCommit) fail(`${previousTag} does not match origin; reconcile baseline tags`);

  const remoteMain = git(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).output.split(/\s+/u)[0];
  if (remoteMain !== sourceCommit) fail('origin/main moved; fetch and resolve again before starting fresh readiness');

  return { version, candidateTag, sourceCommit, previousTag, previousCommit };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('usage: node scripts/ci/resolve-release-candidate.mjs');
    console.log(JSON.stringify(resolveReleaseCandidate(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
