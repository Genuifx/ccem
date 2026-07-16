import path from 'node:path';
import process from 'node:process';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  DraftReleaseClient,
  releaseOwnerMarker,
  releaseOwnerRunId,
  releaseSourceCommit,
  releaseSourceMarker,
} from './github-draft-release-api.mjs';

function fail(message) {
  throw new Error(`[ensure-draft-github-release] ${message}`);
}

export async function ensureDraftGithubRelease({
  repository,
  tag,
  token,
  name,
  body,
  commitish,
  prerelease,
  runId,
  allowStaleDraftRecovery = false,
  fetchImpl = globalThis.fetch,
}) {
  if (allowStaleDraftRecovery !== true && allowStaleDraftRecovery !== false) {
    fail('stale draft recovery must be an explicit boolean');
  }
  const marker = releaseOwnerMarker(runId);
  const sourceMarker = releaseSourceMarker(commitish);
  const releaseBody = `${typeof body === 'string' ? body.trimEnd() : ''}\n\n${marker}\n${sourceMarker}`;
  const discoveryClient = new DraftReleaseClient({
    repository,
    tag,
    token,
    fetchImpl,
  });
  const existing = await discoveryClient.requireDraft({ allowMissing: true });
  const recovered = false;
  if (existing) {
    const ownerRunId = releaseOwnerRunId(existing.body);
    const sourceCommit = releaseSourceCommit(existing.body);
    if (ownerRunId === String(runId)) {
      if (sourceCommit !== commitish) {
        fail('current-run draft source marker does not match the exact release commit');
      }
      return {
        state: 'draft', releaseId: existing.id, releaseOwnerRunId: ownerRunId, created: false, recovered: false,
      };
    }
    if (!allowStaleDraftRecovery) {
      if (ownerRunId == null) {
        fail(`existing draft ${tag} has no unique owner run marker; refusing recovery`);
      }
      fail(
        `draft/assets for ${tag} are owned by GitHub Actions run ${ownerRunId}; `
        + `rerun that workflow or explicitly recover the stale unpublished draft`,
      );
    }
    if (ownerRunId == null || sourceCommit == null) {
      fail('stale draft recovery requires unique CCEM owner and source markers');
    }
    if (sourceCommit !== commitish) {
      fail('stale draft source marker does not match the exact release commit');
    }
    // Keep the old owner identity as the guard for every later API read. The
    // uploader may resume only byte-identical assets and fails closed on any
    // collision; this workflow never deletes a release or release asset.
    return {
      state: 'draft',
      releaseId: existing.id,
      releaseOwnerRunId: ownerRunId,
      created: false,
      recovered: true,
    };
  }
  const client = new DraftReleaseClient({
    repository,
    tag,
    token,
    expectedOwnerRunId: runId,
    expectedSourceCommit: commitish,
    fetchImpl,
  });
  try {
    const created = await client.createDraft({ name, body: releaseBody, commitish, prerelease });
    const locked = await client.requireDraft();
    if (locked.id !== created.id) throw new Error('created draft release id changed during lock verification');
    return {
      state: 'draft', releaseId: locked.id, releaseOwnerRunId: String(runId), created: true, recovered,
    };
  } catch (error) {
    // Matrix jobs never create releases. This only handles another authorized
    // workflow winning the one-time draft creation race.
    if (error.status !== 422) throw error;
    const raced = await client.requireDraft();
    return {
      state: 'draft', releaseId: raced.id, releaseOwnerRunId: String(runId), created: false, recovered,
    };
  }
}

async function main() {
  const result = await ensureDraftGithubRelease({
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.TAG_NAME,
    token: process.env.GITHUB_TOKEN,
    name: process.env.RELEASE_NAME,
    body: process.env.RELEASE_BODY,
    commitish: process.env.SOURCE_COMMIT,
    prerelease: process.env.PRERELEASE === 'true',
    runId: process.env.GITHUB_RUN_ID,
    allowStaleDraftRecovery: process.env.ALLOW_STALE_DRAFT_RECOVERY === 'true',
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `release_id=${result.releaseId}\nrelease_owner_run_id=${result.releaseOwnerRunId}\n`,
      { mode: 0o600 },
    );
  }
  process.stdout.write(
    `[ensure-draft-github-release] ${process.env.TAG_NAME}: `
    + `${result.recovered ? 'recovered and ' : ''}${result.created ? 'created' : 'existing draft'}\n`,
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
