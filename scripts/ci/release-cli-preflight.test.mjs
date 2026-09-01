#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = join(repoRoot, '.github/workflows/release-cli.yml');
const workflowSource = readFileSync(workflowPath, 'utf8');
const packageVersion = JSON.parse(
  readFileSync(join(repoRoot, 'apps/cli/package.json'), 'utf8'),
).version;

function stepRunScript(stepName) {
  const lines = workflowSource.split('\n');
  const nameIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(nameIndex, -1, `missing workflow step: ${stepName}`);

  const runIndex = lines.findIndex(
    (line, index) => index > nameIndex && /^\s+run:\s*\|\s*$/u.test(line),
  );
  assert.notEqual(runIndex, -1, `missing block run script for: ${stepName}`);
  const runIndent = lines[runIndex].match(/^\s*/u)[0].length;
  const body = [];

  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== '' && line.match(/^\s*/u)[0].length <= runIndent) break;
    body.push(line.slice(Math.min(line.length, runIndent + 2)));
  }

  assert.ok(body.length > 0, `empty run script for: ${stepName}`);
  return `${body.join('\n')}\n`;
}

const preflightScript = stepRunScript('Validate exact candidate and npm trusted publisher');
const authGuardScript = stepRunScript('Reject legacy npm token configuration');
const repositorySettingsScript = stepRunScript(
  'Recheck protected release refs before CLI build',
);

function writeExecutable(path, source) {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function runPreflight(overrides = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ccem-release-cli-preflight-'));
  const binDir = join(fixtureRoot, 'bin');
  const mkdir = spawnSync('mkdir', ['-p', binDir]);
  assert.equal(mkdir.status, 0, mkdir.stderr?.toString());

  writeExecutable(
    join(binDir, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  rev-parse)
    [[ "\${2:-}" == "HEAD^{commit}" ]] || exit 64
    printf '%s\\n' "\${FAKE_CHECKOUT_SHA:?}"
    ;;
  ls-remote)
    if [[ "$*" == *"--exit-code --tags origin refs/tags/v"* ]]; then
      exit "\${FAKE_TAG_STATUS:-2}"
    fi
    if [[ "$*" == "ls-remote origin refs/heads/main" ]]; then
      printf '%s\\trefs/heads/main\\n' "\${FAKE_REMOTE_MAIN_SHA:?}"
      exit 0
    fi
    exit 64
    ;;
  *)
    exit 64
    ;;
esac
`,
  );

  writeExecutable(
    join(binDir, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
arguments="$*"
if [[ "$arguments" == *"oidc.example.test/token?api-version=2.0&audience=npm:registry.npmjs.org"* ]]; then
  [[ "$arguments" == *"Authorization: bearer runner-request-token"* ]] || exit 65
  [[ "\${FAKE_OIDC_STATUS:-200}" == "200" ]] || exit 22
  if [[ -n "\${FAKE_OIDC_BODY+x}" ]]; then
    printf '%s' "$FAKE_OIDC_BODY"
  else
    printf '%s' '{"value":"fixture-oidc-token-must-stay-secret"}'
  fi
  exit 0
fi
if [[ "$arguments" == *"https://registry.npmjs.org/ccem/"* ]]; then
  [[ "$arguments" == *"--output /dev/null"* ]] || exit 70
  printf '%s' "\${FAKE_NPM_VERSION_STATUS:-404}"
  exit 0
fi
if [[ "$arguments" == *"https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/ccem"* ]]; then
  [[ "$arguments" == *"--request POST"* ]] || exit 66
  [[ "$arguments" == *"Authorization: Bearer fixture-oidc-token-must-stay-secret"* ]] || exit 67
  [[ "$arguments" == *"--output /dev/null"* ]] || exit 68
  printf '%s' "\${FAKE_NPM_STATUS:-201}"
  exit 0
fi
exit 69
`,
  );

  const sourceSha = 'a'.repeat(40);
  const result = spawnSync('bash', ['-c', preflightScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'Genuifx/ccem',
      EVENT_NAME: 'workflow_dispatch',
      REF_PROTECTED: 'true',
      EXPECTED_SHA_INPUT: sourceSha,
      EXPECTED_VERSION_INPUT: packageVersion,
      SOURCE_COMMIT: sourceSha,
      FAKE_CHECKOUT_SHA: sourceSha,
      FAKE_REMOTE_MAIN_SHA: sourceSha,
      FAKE_TAG_STATUS: '2',
      FAKE_OIDC_STATUS: '200',
      FAKE_NPM_STATUS: '201',
      FAKE_NPM_VERSION_STATUS: '404',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token?api-version=2.0',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token',
      ...overrides,
    },
  });

  rmSync(fixtureRoot, { recursive: true, force: true });
  return result;
}

function assertFailed(result, pattern) {
  assert.notEqual(result.status, 0, `expected failure, received stdout:\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

function runAuthGuard({
  nodeAuthToken,
  npmrc,
  globalNpmrc,
  lowercaseGlobalNpmrc,
  effectiveGlobalNpmrc,
  npmConfigFailure = false,
  emptyEffectiveConfigs = false,
} = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ccem-release-cli-auth-guard-'));
  const workspace = join(fixtureRoot, 'workspace');
  const binDir = join(fixtureRoot, 'bin');
  const userconfig = join(fixtureRoot, 'user.npmrc');
  const upperGlobalconfig = join(fixtureRoot, 'upper-global.npmrc');
  const lowerGlobalconfig = join(fixtureRoot, 'lower-global.npmrc');
  const effectiveGlobalconfig = join(fixtureRoot, 'effective-global.npmrc');
  const mkdir = spawnSync('mkdir', ['-p', workspace, binDir]);
  assert.equal(mkdir.status, 0, mkdir.stderr?.toString());
  if (npmrc !== undefined) writeFileSync(userconfig, npmrc, 'utf8');
  if (globalNpmrc !== undefined) writeFileSync(upperGlobalconfig, globalNpmrc, 'utf8');
  if (lowercaseGlobalNpmrc !== undefined) {
    writeFileSync(lowerGlobalconfig, lowercaseGlobalNpmrc, 'utf8');
  }
  if (effectiveGlobalNpmrc !== undefined) {
    writeFileSync(effectiveGlobalconfig, effectiveGlobalNpmrc, 'utf8');
  }

  writeExecutable(
    join(binDir, 'npm'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == "config" && "\${2:-}" == "get" ]] || exit 64
[[ "\${FAKE_NPM_CONFIG_FAILURE:-0}" != "1" ]] || exit 65
case "\${3:-}" in
  userconfig)
    printf '%s\\n' "\${FAKE_EFFECTIVE_USERCONFIG-}"
    ;;
  globalconfig)
    printf '%s\\n' "\${FAKE_EFFECTIVE_GLOBALCONFIG-}"
    ;;
  *)
    exit 64
    ;;
esac
`,
  );

  const env = {
    ...process.env,
    HOME: fixtureRoot,
    GITHUB_WORKSPACE: workspace,
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_EFFECTIVE_USERCONFIG: emptyEffectiveConfigs
      ? ''
      : join(fixtureRoot, 'effective-user.npmrc'),
    FAKE_EFFECTIVE_GLOBALCONFIG:
      emptyEffectiveConfigs
        ? ''
        : effectiveGlobalNpmrc === undefined
        ? join(fixtureRoot, 'clean-effective-global.npmrc')
        : effectiveGlobalconfig,
    FAKE_NPM_CONFIG_FAILURE: npmConfigFailure ? '1' : '0',
  };
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_CONFIG_USERCONFIG;
  delete env.npm_config_userconfig;
  delete env.NPM_CONFIG_GLOBALCONFIG;
  delete env.npm_config_globalconfig;
  if (nodeAuthToken !== undefined) env.NODE_AUTH_TOKEN = nodeAuthToken;
  if (npmrc !== undefined) env.NPM_CONFIG_USERCONFIG = userconfig;
  if (globalNpmrc !== undefined) env.NPM_CONFIG_GLOBALCONFIG = upperGlobalconfig;
  if (lowercaseGlobalNpmrc !== undefined) {
    env.npm_config_globalconfig = lowerGlobalconfig;
  }

  const result = spawnSync('bash', ['-c', authGuardScript], {
    cwd: workspace,
    encoding: 'utf8',
    env,
  });

  rmSync(fixtureRoot, { recursive: true, force: true });
  return result;
}

function runRepositorySettingsGuard({
  token = 'fixture-release-settings-token',
  candidateTag = `v${packageVersion}`,
  githubRef = `refs/tags/v${packageVersion}`,
  settingsStatus = '0',
} = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'ccem-release-cli-settings-'));
  const binDir = join(fixtureRoot, 'bin');
  const nodeLog = join(fixtureRoot, 'node.log');
  const mkdir = spawnSync('mkdir', ['-p', binDir]);
  assert.equal(mkdir.status, 0, mkdir.stderr?.toString());

  writeExecutable(
    join(binDir, 'node'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${FAKE_NODE_LOG:?}"
exit "\${FAKE_SETTINGS_STATUS:-0}"
`,
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    GITHUB_REF: githubRef,
    CCEM_RELEASE_CANDIDATE_TAG: candidateTag,
    FAKE_NODE_LOG: nodeLog,
    FAKE_SETTINGS_STATUS: settingsStatus,
  };
  delete env.GITHUB_TOKEN;
  if (token !== null) env.GITHUB_TOKEN = token;

  const result = spawnSync('bash', ['-c', repositorySettingsScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
  const log = readFileSync(nodeLog, { encoding: 'utf8', flag: 'a+' });
  rmSync(fixtureRoot, { recursive: true, force: true });
  return { ...result, log };
}

test('workflow keeps the preflight on fixed actions and minimum OIDC permissions', () => {
  assert.match(workflowSource, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+expected_sha:/u);
  assert.match(workflowSource, /\n\s+expected_version:/u);
  assert.match(workflowSource, /push:\s*\n\s+branches:\s*\n\s+- main\s*\n\s+tags:\s*\n\s+- 'v\*'\s*\n\s+paths:\s*\n\s+- 'apps\/cli\/package\.json'/u);
  assert.match(workflowSource, /permissions:\s*\n\s+actions:\s*read\s*\n\s+contents:\s*read\s*\n\s+id-token:\s*write/u);
  assert.doesNotMatch(workflowSource, /contents:\s*write|write-all/u);
  assert.doesNotMatch(workflowSource, /registry-url/u);
  assert.match(
    workflowSource,
    /actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/u,
  );
  assert.match(
    workflowSource,
    /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/u,
  );
  assert.match(workflowSource, /node-version:\s*'22'/u);
  assert.match(workflowSource, /NPM_CONFIG_REGISTRY: https:\/\/registry\.npmjs\.org\//u);
  assert.match(workflowSource, /npm_config_registry: https:\/\/registry\.npmjs\.org\//u);
  assert.match(
    workflowSource,
    /npm install (?:--global|-g) npm@11\.5\.1 --registry=https:\/\/registry\.npmjs\.org\//u,
  );
  assert.match(
    workflowSource,
    /npm publish[\s\S]*--registry=https:\/\/registry\.npmjs\.org\/[\s\S]*--tag \$\{\{ steps\.npm-tag\.outputs\.tag \}\}/u,
  );
});

test('routes main package pushes to preflight and tag pushes to publish in the same workflow', () => {
  assert.match(
    workflowSource,
    /- name: Validate exact candidate and npm trusted publisher\s*\n\s+if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main' \}\}/u,
  );
  assert.match(
    workflowSource,
    /- name: Publish ccem \(CLI\)\s*\n\s+if: \$\{\{ github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/'\) \}\}/u,
  );
});

test('CLI publish rechecks repository settings before install, build, and publish', () => {
  const readinessIndex = workflowSource.indexOf(
    '- name: Require successful pre-tag readiness for exact source',
  );
  const settingsIndex = workflowSource.indexOf(
    '- name: Recheck protected release refs before CLI build',
  );
  assert.ok(readinessIndex >= 0);
  assert.ok(settingsIndex >= 0);
  assert.ok(readinessIndex < settingsIndex);
  assert.match(
    workflowSource.slice(readinessIndex, workflowSource.indexOf('\n      - name:', readinessIndex + 1)),
    /CCEM_RELEASE_READINESS_TOKEN:\s*\$\{\{ github\.token \}\}[\s\S]*CCEM_RELEASE_SOURCE_COMMIT:\s*\$\{\{ github\.sha \}\}[\s\S]*check-pretag-readiness-runs\.mjs/u,
  );
  assert.ok(settingsIndex < workflowSource.indexOf('- name: Install dependencies'));
  assert.ok(settingsIndex < workflowSource.indexOf('- name: Build CLI and dependencies'));
  assert.ok(settingsIndex < workflowSource.indexOf('- name: Publish ccem (CLI)'));
  assert.match(
    workflowSource.slice(settingsIndex, workflowSource.indexOf('\n      - name:', settingsIndex + 1)),
    /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}[\s\S]*CCEM_RELEASE_CANDIDATE_TAG:\s*\$\{\{ steps\.release-source\.outputs\.tag \}\}/u,
  );
});

test('CLI repository settings recheck passes the exact tag to the checker', () => {
  const result = runRepositorySettingsGuard();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    result.log,
    `scripts/ci/check-release-repository-settings.mjs --candidate-tag v${packageVersion}\n`,
  );
});

test('CLI repository settings recheck fails closed on missing token, tag drift, or checker rejection', () => {
  const cases = [
    {
      name: 'missing token',
      input: { token: null },
      error: /GITHUB_TOKEN.*required/u,
    },
    {
      name: 'tag drift',
      input: { candidateTag: 'v9.9.9' },
      error: /candidate tag.*selected release tag/iu,
    },
    {
      name: 'settings rejection',
      input: { settingsStatus: '1' },
      error: null,
    },
  ];
  for (const fixture of cases) {
    const result = runRepositorySettingsGuard(fixture.input);
    assert.notEqual(result.status, 0, `${fixture.name} unexpectedly passed`);
    if (fixture.error) assert.match(`${result.stdout}\n${result.stderr}`, fixture.error);
  }
});

test('legacy npm auth guard accepts a clean runner', () => {
  const result = runAuthGuard();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('legacy npm auth guard rejects NODE_AUTH_TOKEN without exposing it', () => {
  const result = runAuthGuard({ nodeAuthToken: 'legacy-env-token-must-stay-secret' });
  assertFailed(result, /NODE_AUTH_TOKEN/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /legacy-env-token-must-stay-secret/u);
});

test('legacy npm auth guard rejects registry npmrc auth without exposing it', () => {
  const result = runAuthGuard({
    npmrc: '//registry.npmjs.org/:_authToken=legacy-npmrc-token-must-stay-secret\n',
  });
  assertFailed(result, /npmrc.*auth token|auth token.*npmrc/iu);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /legacy-npmrc-token-must-stay-secret/u);
});

test('legacy npm auth guard rejects NPM_CONFIG_GLOBALCONFIG auth without exposing it', () => {
  const result = runAuthGuard({
    globalNpmrc:
      '//registry.npmjs.org/:_authToken=legacy-upper-global-token-must-stay-secret\n',
  });
  assertFailed(result, /npmrc.*auth token|auth token.*npmrc/iu);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /legacy-upper-global-token-must-stay-secret/u,
  );
});

test('legacy npm auth guard rejects lowercase npm_config_globalconfig auth', () => {
  const result = runAuthGuard({
    lowercaseGlobalNpmrc:
      '//registry.npmjs.org/:_authToken=legacy-lower-global-token-must-stay-secret\n',
  });
  assertFailed(result, /npmrc.*auth token|auth token.*npmrc/iu);
});

test('legacy npm auth guard rejects the effective npm globalconfig path', () => {
  const result = runAuthGuard({
    effectiveGlobalNpmrc:
      '//registry.npmjs.org/:_authToken=legacy-effective-global-token-must-stay-secret\n',
  });
  assertFailed(result, /npmrc.*auth token|auth token.*npmrc/iu);
});

test('legacy npm auth guard fails closed when npm config path resolution fails', () => {
  const result = runAuthGuard({ npmConfigFailure: true });
  assertFailed(result, /could not resolve.*npmrc path/iu);
});

test('legacy npm auth guard safely ignores empty effective config paths', () => {
  const result = runAuthGuard({ emptyEffectiveConfigs: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('happy path exchanges OIDC without exposing either response token', () => {
  const result = runPreflight();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /Trusted Publisher preflight passed/u);
  assert.doesNotMatch(output, /fixture-oidc-token-must-stay-secret|runner-request-token/u);
});

test('main package push automatically derives the exact SHA and version for preflight', () => {
  const result = runPreflight({
    EVENT_NAME: 'push',
    EXPECTED_SHA_INPUT: '',
    EXPECTED_VERSION_INPUT: '',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Trusted Publisher preflight passed/u);
});

test('rejects exact SHA drift before requesting OIDC', () => {
  assertFailed(runPreflight({ EXPECTED_SHA_INPUT: 'b'.repeat(40) }), /expected_sha must exactly match/u);
});

test('rejects origin/main moving after dispatch', () => {
  assertFailed(
    runPreflight({ FAKE_REMOTE_MAIN_SHA: 'b'.repeat(40) }),
    /no longer the exact origin\/main commit/u,
  );
});

test('rejects package version drift before requesting OIDC', () => {
  assertFailed(runPreflight({ EXPECTED_VERSION_INPUT: '9.9.9' }), /does not match ccem package version/u);
});

test('rejects a non-main ref', () => {
  assertFailed(runPreflight({ GITHUB_REF: 'refs/tags/v9.9.9' }), /protected main/u);
});

test('rejects an unprotected main ref', () => {
  assertFailed(runPreflight({ REF_PROTECTED: 'false' }), /branch protection or a ruleset/u);
});

test('rejects a candidate tag that appeared after version selection', () => {
  assertFailed(runPreflight({ FAKE_TAG_STATUS: '0' }), /already exists/u);
});

test('automatic main preflight also rejects a candidate tag that already exists', () => {
  assertFailed(
    runPreflight({ EVENT_NAME: 'push', EXPECTED_SHA_INPUT: '', EXPECTED_VERSION_INPUT: '', FAKE_TAG_STATUS: '0' }),
    /already exists/u,
  );
});

test('rejects GitHub/npm skew when the candidate version already exists on npm', () => {
  assertFailed(
    runPreflight({ FAKE_NPM_VERSION_STATUS: '200' }),
    /ccem@.*already published/u,
  );
});

test('fails closed when npm cannot prove the candidate version is absent', () => {
  assertFailed(
    runPreflight({ FAKE_NPM_VERSION_STATUS: '503' }),
    /Could not prove.*absent from npm/u,
  );
});

test('rejects a non-successful GitHub OIDC response', () => {
  assertFailed(runPreflight({ FAKE_OIDC_STATUS: '500' }), /request GitHub OIDC token/u);
});

test('rejects malformed GitHub OIDC JSON without exposing its sensitive body', () => {
  const secret = 'malformed-oidc-secret-must-stay-hidden';
  const result = runPreflight({ FAKE_OIDC_BODY: `{"value":"${secret}` });
  assertFailed(result, /did not contain a token/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret, 'u'));
});

test('rejects a non-201 npm OIDC exchange without printing a response token', () => {
  const result = runPreflight({ FAKE_NPM_STATUS: '401' });
  assertFailed(result, /returned HTTP 401/u);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /fixture-oidc-token-must-stay-secret|runner-request-token/u,
  );
});
