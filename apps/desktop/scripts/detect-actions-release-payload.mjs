import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const API_ORIGIN = 'https://api.github.com';
const MAX_PAGES = 100;

function fail(message) {
  throw new Error(`[detect-actions-release-payload] ${message}`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value.trim();
}

function validateIdentity(repository, runId, target) {
  const exactRepository = required(repository, 'GitHub repository');
  const exactRunId = required(runId, 'GitHub run id');
  const exactTarget = required(target, 'release target');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(exactRepository)) fail('invalid GitHub repository');
  if (!/^[1-9][0-9]*$/u.test(exactRunId)) fail('GitHub run id must be a positive decimal string');
  if (!/^(?:aarch64|x86_64)-apple-darwin$|^x86_64-pc-windows-msvc$/u.test(exactTarget)) {
    fail('unsupported release target');
  }
  return {
    repository: exactRepository,
    runId: exactRunId,
    target: exactTarget,
    artifactName: `mode2-release-payload-${exactRunId}-${exactTarget}`,
  };
}

function safeDetail(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 500);
}

export async function detectActionsReleasePayload({
  repository,
  runId,
  target,
  token,
  fetchImpl = globalThis.fetch,
}) {
  const identity = validateIdentity(repository, runId, target);
  const exactToken = required(token, 'GitHub token');
  const matches = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${API_ORIGIN}/repos/${identity.repository}/actions/runs/${identity.runId}/artifacts?per_page=100&page=${page}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${exactToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response?.ok) fail(`GitHub Actions artifact lookup failed (${response?.status ?? 'unknown'}): ${safeDetail(await response?.text?.())}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.artifacts)) fail('GitHub Actions artifact lookup returned invalid JSON');
    matches.push(...payload.artifacts.filter((artifact) => artifact?.name === identity.artifactName));
    if (payload.artifacts.length < 100) break;
    if (page === MAX_PAGES) fail('Actions artifact pagination exceeded the strict 10,000-item bound');
  }
  if (matches.length > 1) fail(`duplicate immutable payload artifacts exist: ${identity.artifactName}`);
  if (matches.length === 0) return { ...identity, reuse: false };
  const artifact = matches[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0) fail('immutable payload artifact has an invalid id');
  if (artifact.expired === true) fail(`immutable payload artifact is expired: ${identity.artifactName}`);
  if (artifact.expired !== false) fail(`immutable payload artifact has an invalid expiry state: ${identity.artifactName}`);
  return { ...identity, artifactId: artifact.id, reuse: true };
}

async function main() {
  const result = await detectActionsReleasePayload({
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    target: process.env.CCEM_RELEASE_TARGET,
    token: process.env.GITHUB_TOKEN,
  });
  if (!process.env.GITHUB_OUTPUT) fail('GITHUB_OUTPUT is required');
  await appendFile(process.env.GITHUB_OUTPUT, `reuse=${result.reuse}\n`, { mode: 0o600 });
  process.stdout.write(`[detect-actions-release-payload] ${result.artifactName}: ${result.reuse ? 'reuse' : 'build required'}\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
