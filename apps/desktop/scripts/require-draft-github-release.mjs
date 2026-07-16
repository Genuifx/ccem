import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { DraftReleaseClient } from './github-draft-release-api.mjs';

function fail(message) {
  throw new Error(`[require-draft-github-release] ${message}`);
}

export async function requireDraftGithubRelease({
  repository,
  tag,
  token,
  expectedReleaseId,
  expectedOwnerRunId,
  allowMissing = false,
  fetchImpl = globalThis.fetch,
}) {
  const client = new DraftReleaseClient({
    repository,
    tag,
    token,
    expectedReleaseId,
    expectedOwnerRunId,
    fetchImpl,
  });
  const release = await client.requireDraft({ allowMissing });
  return release
    ? { state: 'draft', tag: client.tag, releaseId: release.id }
    : { state: 'missing', tag: client.tag };
}

function parseCli(args) {
  const options = { allowMissing: false, json: false };
  for (const arg of args) {
    if (arg === '--allow-missing') options.allowMissing = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help') options.help = true;
    else fail(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/require-draft-github-release.mjs [--allow-missing] [--json]\n');
    return;
  }
  const result = await requireDraftGithubRelease({
    repository: process.env.GITHUB_REPOSITORY ?? process.env.REPO,
    tag: process.env.TAG_NAME,
    token: process.env.GITHUB_TOKEN,
    expectedReleaseId: process.env.EXPECTED_RELEASE_ID,
    expectedOwnerRunId: process.env.GITHUB_RUN_ID,
    allowMissing: options.allowMissing,
  });
  process.stdout.write(options.json
    ? `${JSON.stringify(result)}\n`
    : `[require-draft-github-release] ${result.tag}: ${result.state}\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
