#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const PAGE_SIZE = 100;
const MAX_RULESET_PAGES = 100;

function fail(message) {
  throw new Error(`[release-repository-settings] ${message}`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value.trim();
}

function exactRepository(value) {
  const repository = required(value, 'GITHUB_REPOSITORY');
  if (
    repository.length > 200
    || !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/u
      .test(repository)
  ) {
    fail('GITHUB_REPOSITORY must be an exact owner/name pair');
  }
  return repository;
}

function exactToken(value) {
  const token = required(value, 'GITHUB_TOKEN');
  if (token.length > 4096 || /[\u0000-\u0020\u007f]/u.test(token)) {
    fail('GITHUB_TOKEN has an invalid format');
  }
  return token;
}

function exactCandidateTag(value) {
  const candidateTag = required(value, 'candidate tag');
  const match = candidateTag.match(
    /^v(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})(?:-([0-9A-Za-z.-]+))?$/u,
  );
  const prerelease = match?.[1]?.split('.') ?? [];
  if (
    candidateTag.length > 128
    || !match
    || prerelease.some((identifier) => (
      identifier === ''
      || !/^[0-9A-Za-z-]+$/u.test(identifier)
      || (/^[0-9]+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))
    ))
  ) {
    fail('candidate tag must be an exact vX.Y.Z semantic-version tag');
  }
  return candidateTag;
}

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
  };
}

async function fetchResponse(fetchImpl, url, token, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: headers(token),
    });
  } catch {
    fail(`${label} request failed`);
  }
  if (!response || !Number.isInteger(response.status)) {
    fail(`${label} returned an invalid HTTP response`);
  }
  return response;
}

async function responseJson(response, label) {
  if (response.status !== 200 || response.ok !== true) {
    fail(`${label} read failed (${response.status})`);
  }
  if (typeof response.json !== 'function') fail(`${label} returned an invalid JSON response`);
  try {
    return await response.json();
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

function rulesetsUrl(repository, page) {
  const url = new URL(`${API_ORIGIN}/repos/${repository}/rulesets`);
  url.searchParams.set('includes_parents', 'true');
  url.searchParams.set('per_page', String(PAGE_SIZE));
  url.searchParams.set('page', String(page));
  return url.href;
}

function rulesetUrl(repository, id) {
  const url = new URL(`${API_ORIGIN}/repos/${repository}/rulesets/${id}`);
  url.searchParams.set('includes_parents', 'true');
  return url.href;
}

function nextPageFromLink(response, repository, currentPage) {
  const link = typeof response.headers?.get === 'function'
    ? response.headers.get('link')
    : null;
  if (link == null || link === '') return null;
  if (typeof link !== 'string' || link.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(link)) {
    fail('rulesets pagination returned an invalid Link header');
  }
  const next = link
    .split(',')
    .map((entry) => entry.trim())
    .find((entry) => /;\s*rel="next"(?:\s*;|$)/u.test(entry));
  if (!next) return null;
  const match = next.match(/^<([^>]+)>/u);
  if (!match) fail('rulesets pagination returned an invalid next link');

  let url;
  try {
    url = new URL(match[1]);
  } catch {
    fail('rulesets pagination returned an invalid next URL');
  }
  if (
    url.origin !== API_ORIGIN
    || url.username
    || url.password
    || url.hash
    || url.pathname !== `/repos/${repository}/rulesets`
    || url.searchParams.get('includes_parents') !== 'true'
    || url.searchParams.get('per_page') !== String(PAGE_SIZE)
  ) {
    fail('rulesets pagination escaped the expected repository endpoint');
  }
  const page = Number(url.searchParams.get('page'));
  if (!Number.isSafeInteger(page) || page <= currentPage) {
    fail('rulesets pagination did not advance monotonically');
  }
  return page;
}

function rulesetId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} has an invalid id`);
  return value;
}

async function listRulesetSummaries({ repository, token, fetchImpl }) {
  const summaries = [];
  const seenIds = new Set();
  let page = 1;
  for (let requestCount = 0; requestCount < MAX_RULESET_PAGES; requestCount += 1) {
    const response = await fetchResponse(
      fetchImpl,
      rulesetsUrl(repository, page),
      token,
      'repository rulesets',
    );
    const body = await responseJson(response, 'repository rulesets');
    if (!Array.isArray(body)) fail('repository rulesets response must be an array');
    if (body.length > PAGE_SIZE) fail('repository rulesets page exceeds the requested page size');
    for (const summary of body) {
      if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
        fail('repository rulesets response contains an invalid summary');
      }
      const id = rulesetId(summary.id, 'repository ruleset summary');
      if (seenIds.has(id)) fail(`repository ruleset ${id} was returned more than once`);
      seenIds.add(id);
      summaries.push(summary);
    }

    const linkedPage = nextPageFromLink(response, repository, page);
    if (linkedPage != null) {
      page = linkedPage;
      continue;
    }
    if (body.length === PAGE_SIZE) {
      page += 1;
      continue;
    }
    return summaries;
  }
  fail(`repository rulesets pagination exceeded ${MAX_RULESET_PAGES} pages`);
}

function hasFullRulesetDetails(value) {
  return value
    && typeof value === 'object'
    && typeof value.target === 'string'
    && value.conditions
    && typeof value.conditions === 'object'
    && Array.isArray(value.rules);
}

async function loadRulesetDetails({ repository, token, fetchImpl, summaries }) {
  const details = [];
  for (const summary of summaries) {
    const id = rulesetId(summary.id, 'repository ruleset summary');
    let detail = summary;
    if (!hasFullRulesetDetails(summary)) {
      const response = await fetchResponse(
        fetchImpl,
        rulesetUrl(repository, id),
        token,
        `repository ruleset ${id}`,
      );
      detail = await responseJson(response, `repository ruleset ${id}`);
    }
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      fail(`repository ruleset ${id} details must be an object`);
    }
    if (rulesetId(detail.id, `repository ruleset ${id}`) !== id) {
      fail(`repository ruleset ${id} detail id does not match its summary`);
    }
    if (typeof detail.target !== 'string' || typeof detail.enforcement !== 'string') {
      fail(`repository ruleset ${id} details are incomplete`);
    }
    if (!Array.isArray(detail.rules)) fail(`repository ruleset ${id} rules must be an array`);
    for (const rule of detail.rules) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule) || typeof rule.type !== 'string') {
        fail(`repository ruleset ${id} contains an invalid rule`);
      }
    }
    details.push(detail);
  }
  return details;
}

function boundedRefPatterns(value, label) {
  if (!Array.isArray(value) || value.some((entry) => (
    typeof entry !== 'string'
    || entry.length === 0
    || entry.length > 1024
    || /[\u0000-\u001f\u007f\\]/u.test(entry)
  ))) {
    fail(`${label} must be an array of bounded GitHub ref patterns`);
  }
  return value;
}

function patternRegExp(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    }
  }
  expression += '$';
  return new RegExp(expression, 'u');
}

export function githubRefPatternMatches(pattern, ref, { defaultBranch = 'main' } = {}) {
  if (pattern === '~ALL') return true;
  if (pattern === '~DEFAULT_BRANCH') return ref === `refs/heads/${defaultBranch}`;
  return patternRegExp(pattern).test(ref);
}

function rulesetCoversRef(ruleset, ref, id) {
  const condition = ruleset.conditions?.ref_name;
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    fail(`repository ruleset ${id} has no ref_name condition`);
  }
  const include = boundedRefPatterns(condition.include, `repository ruleset ${id} include`);
  const exclude = boundedRefPatterns(condition.exclude, `repository ruleset ${id} exclude`);
  return include.some((pattern) => githubRefPatternMatches(pattern, ref))
    && !exclude.some((pattern) => githubRefPatternMatches(pattern, ref));
}

function findRequiredRulesets(rulesets, candidateTag) {
  const mainRef = 'refs/heads/main';
  const candidateRef = `refs/tags/${candidateTag}`;
  let branchRuleset = null;
  let tagRuleset = null;

  for (const ruleset of rulesets) {
    if (ruleset.enforcement !== 'active') continue;
    const id = rulesetId(ruleset.id, 'repository ruleset');
    if (ruleset.target === 'branch' && rulesetCoversRef(ruleset, mainRef, id)) {
      const types = new Set(ruleset.rules.map((rule) => rule.type));
      if (types.has('deletion') && types.has('non_fast_forward')) branchRuleset ??= ruleset;
    }
    if (ruleset.target === 'tag' && rulesetCoversRef(ruleset, candidateRef, id)) {
      const types = new Set(ruleset.rules.map((rule) => rule.type));
      if (types.has('deletion') && types.has('update')) tagRuleset ??= ruleset;
    }
  }

  if (!branchRuleset) {
    fail(
      'no active branch ruleset covers refs/heads/main with deletion and non_fast_forward restrictions',
    );
  }
  if (!tagRuleset) {
    fail(`no active tag ruleset covers ${candidateRef} with deletion and update restrictions`);
  }
  return { branchRuleset, tagRuleset, mainRef, candidateRef };
}

export async function verifyReleaseRepositorySettings({
  repository,
  token,
  candidateTag,
  fetchImpl = globalThis.fetch,
}) {
  const exactRepo = exactRepository(repository);
  const exactSettingsToken = exactToken(token);
  const exactTag = exactCandidateTag(candidateTag);
  if (typeof fetchImpl !== 'function') fail('fetch implementation is unavailable');

  const summaries = await listRulesetSummaries({
    repository: exactRepo,
    token: exactSettingsToken,
    fetchImpl,
  });
  const rulesets = await loadRulesetDetails({
    repository: exactRepo,
    token: exactSettingsToken,
    fetchImpl,
    summaries,
  });
  const required = findRequiredRulesets(rulesets, exactTag);

  return {
    repository: exactRepo,
    candidateTag: exactTag,
    mainRef: required.mainRef,
    candidateRef: required.candidateRef,
    branchRulesetId: required.branchRuleset.id,
    tagRulesetId: required.tagRuleset.id,
  };
}

function candidateTagFromArgs(argv, environment) {
  if (argv.length === 0) return environment.CCEM_RELEASE_CANDIDATE_TAG;
  if (argv.length === 1 && !argv[0].startsWith('--')) return argv[0];
  if (argv.length === 2 && argv[0] === '--candidate-tag') return argv[1];
  fail('usage: check-release-repository-settings.mjs [--candidate-tag] <vX.Y.Z>');
}

async function main() {
  const result = await verifyReleaseRepositorySettings({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    candidateTag: candidateTagFromArgs(process.argv.slice(2), process.env),
  });
  process.stdout.write(
    `[release-repository-settings] ${result.repository} ${result.candidateTag}: `
    + `main ruleset ${result.branchRulesetId}, tag ruleset ${result.tagRulesetId}\n`,
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
