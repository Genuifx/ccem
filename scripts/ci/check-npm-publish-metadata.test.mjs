import assert from 'node:assert/strict';
import test from 'node:test';

import {
  githubRepositoryFromUrl,
  validateNpmPublishMetadata,
} from './check-npm-publish-metadata.mjs';

test('normalizes the npm git+https repository URL', () => {
  assert.equal(
    githubRepositoryFromUrl('git+https://github.com/Genuifx/ccem.git'),
    'Genuifx/ccem',
  );
});

test('accepts package metadata bound to the publishing repository', () => {
  assert.equal(
    validateNpmPublishMetadata(
      {
        repository: {
          type: 'git',
          url: 'git+https://github.com/Genuifx/ccem.git',
          directory: 'apps/cli',
        },
      },
      'Genuifx/ccem',
    ),
    'Genuifx/ccem',
  );
});

test('rejects stale metadata after a GitHub repository rename', () => {
  assert.throws(
    () =>
      validateNpmPublishMetadata(
        {
          repository: {
            type: 'git',
            url: 'git+https://github.com/Genuifx/claude-code-env-manager.git',
          },
        },
        'Genuifx/ccem',
      ),
    /repository\.url resolves to Genuifx\/claude-code-env-manager[\s\S]*publishing runs from Genuifx\/ccem/u,
  );
});
