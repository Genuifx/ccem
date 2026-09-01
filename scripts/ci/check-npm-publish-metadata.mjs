#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = new URL('../../', import.meta.url);

export function githubRepositoryFromUrl(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.match(
    /^(?:git\+)?https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u,
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

export function validateNpmPublishMetadata(packageJson, expectedRepository) {
  if (!/^[^/]+\/[^/]+$/u.test(expectedRepository ?? '')) {
    throw new Error('Expected GitHub repository must use the owner/name format.');
  }

  const repositoryUrl =
    typeof packageJson.repository === 'string'
      ? packageJson.repository
      : packageJson.repository?.url;
  const actualRepository = githubRepositoryFromUrl(repositoryUrl);

  if (actualRepository !== expectedRepository) {
    throw new Error(
      `apps/cli/package.json repository.url resolves to ${actualRepository ?? 'an unsupported URL'}, ` +
        `but publishing runs from ${expectedRepository}. Update the package metadata and the npm ` +
        'Trusted Publisher configuration before creating a release tag.',
    );
  }

  return actualRepository;
}

function main() {
  const expectedRepository = process.argv[2] ?? process.env.GITHUB_REPOSITORY;
  const packageJson = JSON.parse(
    readFileSync(new URL('apps/cli/package.json', repoRoot), 'utf8'),
  );

  try {
    const repository = validateNpmPublishMetadata(packageJson, expectedRepository);
    console.log(`npm publish metadata matches ${repository}.`);
  } catch (error) {
    console.error(`::error title=npm trusted publishing identity mismatch::${error.message}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
