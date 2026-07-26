import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2026-03-10';

function fail(message) {
  throw new Error(`[verify-immutable-releases-enabled] ${message}`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value.trim();
}

function exactRepository(value) {
  const repository = required(value, 'GitHub repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail('GitHub repository must be an exact owner/name pair');
  }
  return repository;
}

function safeDetail(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 500);
}

export async function verifyImmutableReleasesEnabled({
  repository,
  token,
  fetchImpl = globalThis.fetch,
}) {
  const exactRepo = exactRepository(repository);
  const exactToken = required(token, 'CCEM_RELEASE_SETTINGS_TOKEN');
  if (typeof fetchImpl !== 'function') fail('fetch implementation is unavailable');
  const url = `${API_ORIGIN}/repos/${exactRepo}/immutable-releases`;
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${exactToken}`,
      'X-GitHub-Api-Version': API_VERSION,
    },
  });
  if (response?.status === 404) {
    fail(`immutable releases are not enabled for ${exactRepo}`);
  }
  if (!response?.ok) {
    const detail = typeof response?.text === 'function' ? safeDetail(await response.text()) : '';
    fail(`immutable release settings read failed (${response?.status ?? 'unknown'}): ${detail}`);
  }
  const settings = await response.json();
  if (!settings || typeof settings !== 'object' || settings.enabled !== true) {
    fail(`immutable releases did not return enabled:true for ${exactRepo}`);
  }
  return { repository: exactRepo, enabled: true };
}

async function main() {
  const result = await verifyImmutableReleasesEnabled({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.CCEM_RELEASE_SETTINGS_TOKEN,
  });
  process.stdout.write(`[verify-immutable-releases-enabled] ${result.repository}: enabled\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
