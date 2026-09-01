import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const currentVersion = JSON.parse(
  await fs.readFile(path.join(repoDir, 'apps', 'cli', 'package.json'), 'utf8'),
).version;
const currentTag = `v${currentVersion}`;
const currentTagPattern = currentTag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const [currentMajor, currentMinor, currentPatch] = currentVersion.split(/[.-]/u).map(Number);
const wrongTag = `v${currentMajor}.${currentMinor}.${currentPatch + 1}`;
const unsupportedPrereleaseTag = `v${currentMajor}.${currentMinor}.${currentPatch}-dev.1`;

async function workflow(name) {
  return fs.readFile(path.join(repoDir, '.github', 'workflows', name), 'utf8');
}

function stepRunScript(source, stepName) {
  const start = source.indexOf(`      - name: ${stepName}`);
  assert.ok(start >= 0, `missing step ${stepName}`);
  const end = source.indexOf('\n      - name:', start + 1);
  const block = source.slice(start, end >= 0 ? end : source.length);
  const marker = '\n        run: |\n';
  const runStart = block.indexOf(marker);
  assert.ok(runStart >= 0, `step ${stepName} must use a block run script`);
  const script = [];
  for (const line of block.slice(runStart + marker.length).split('\n')) {
    if (line.startsWith('          ')) script.push(line.slice(10));
    else if (line.length === 0) script.push('');
    else break;
  }
  return script.join('\n');
}

async function fakeReleaseCommands(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-release-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, 'gh'),
    [
      '#!/bin/sh',
      'case "$*" in',
      '  *"/branches/main"*) printf "%s\\n" "$FAKE_MAIN_PROTECTED" ;;',
      '  *"/releases/latest"*) printf "%s\\n" "$FAKE_LATEST_TAG" ;;',
      '  *) printf "unexpected gh command: %s\\n" "$*" >&2; exit 91 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  await fs.writeFile(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$FAKE_GIT_LOG"',
      'case "$1" in',
      '  fetch)',
      '    case "$*" in',
      '      *"refs/tags/${FAKE_PREVIOUS_TAG}:"*)',
      '        [ "$FAKE_PREVIOUS_TAG_EXISTS" = "true" ] || exit 92',
      '        ;;',
      '    esac',
      '    exit 0',
      '    ;;',
      '  rev-parse)',
      '    if [ "$2" = "HEAD^{commit}" ]; then printf "%s\\n" "$FAKE_SOURCE_COMMIT"',
      '    elif [ "$2" = "${FAKE_SOURCE_COMMIT}^{commit}" ]; then printf "%s\\n" "$FAKE_SOURCE_COMMIT"',
      '    elif [ "$2" = "refs/tags/${FAKE_CURRENT_TAG}^{commit}" ]; then printf "%s\\n" "$FAKE_TAG_COMMIT"',
      '    elif [ "$2" = "refs/tags/${FAKE_PREVIOUS_TAG}^{commit}" ]; then printf "%s\\n" "$FAKE_PREVIOUS_COMMIT"',
      '    else printf "unexpected rev-parse: %s\\n" "$2" >&2; exit 93',
      '    fi',
      '    ;;',
      '  ls-remote)',
      '    if [ "$*" = "ls-remote origin refs/heads/main" ]; then',
      '      printf "%s\\trefs/heads/main\\n" "$FAKE_REMOTE_MAIN_SHA"',
      '      exit 0',
      '    fi',
      '    [ "$FAKE_CANDIDATE_TAG_EXISTS" = "true" ] && printf "%s\\trefs/tags/%s\\n" "$FAKE_SOURCE_COMMIT" "$FAKE_CURRENT_TAG" && exit 0',
      '    exit 2',
      '    ;;',
      '  merge-base)',
      '    [ "$FAKE_ANCESTOR" = "true" ]',
      '    ;;',
      '  log)',
      '    printf "%s\\n" "- verified fixture commit (abc1234)"',
      '    ;;',
      '  *) printf "unexpected git command: %s\\n" "$*" >&2; exit 94 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  await fs.writeFile(
    path.join(bin, 'sed'),
    [
      '#!/bin/sh',
      'if [ -n "${FAKE_DESKTOP_VERSION:-}" ]; then printf "%s\\n" "$FAKE_DESKTOP_VERSION"; else exec /usr/bin/sed "$@"; fi',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  return { root, bin, gitLog: path.join(root, 'git.log') };
}

async function fakeProducerNode(paths) {
  const bin = path.join(paths.root, 'producer-bin');
  await fs.mkdir(bin);
  const nodeLog = path.join(paths.root, 'node.log');
  await fs.writeFile(
    path.join(bin, 'node'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$FAKE_NODE_LOG"',
      'if [ "$1" = "apps/desktop/scripts/prepare-updater-replacement-previous-source.mjs" ]; then exit 0; fi',
      'case "$2" in',
      '  *previousCommit*) printf "%s" "$FAKE_PREVIOUS_COMMIT" ;;',
      '  *provenance-*) printf "%s" "$FAKE_PROVENANCE_PATH" ;;',
      '  *) printf "%s" "$FAKE_PREVIOUS_ROOT" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  return { bin, nodeLog };
}

function fixtureEnvironment(paths, overrides = {}) {
  const sourceCommit = 'a'.repeat(40);
  return {
    ...process.env,
    PATH: `${paths.bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GIT_LOG: paths.gitLog,
    FAKE_MAIN_PROTECTED: 'true',
    FAKE_LATEST_TAG: 'v2.76.0',
    FAKE_CURRENT_TAG: currentTag,
    FAKE_PREVIOUS_TAG: 'v2.76.0',
    FAKE_PREVIOUS_TAG_EXISTS: 'true',
    FAKE_CANDIDATE_TAG_EXISTS: 'false',
    FAKE_SOURCE_COMMIT: sourceCommit,
    FAKE_TAG_COMMIT: sourceCommit,
    FAKE_PREVIOUS_COMMIT: 'b'.repeat(40),
    FAKE_ANCESTOR: 'true',
    GITHUB_REPOSITORY: 'Genuifx/ccem',
    GITHUB_REF: `refs/tags/${currentTag}`,
    GITHUB_REF_NAME: currentTag,
    GITHUB_SHA: sourceCommit,
    SOURCE_COMMIT: sourceCommit,
    EVENT_NAME: 'push',
    REF_PROTECTED: 'true',
    GH_TOKEN: 'read-only-test-token',
    FAKE_DESKTOP_VERSION: '',
    ...overrides,
  };
}

function runBash(script, environment) {
  return spawnSync('bash', ['-c', script], {
    cwd: repoDir,
    env: environment,
    encoding: 'utf8',
  });
}

test('CLI publication accepts only an exact protected tag on protected main', async (t) => {
  const paths = await fakeReleaseCommands(t);
  const source = await workflow('release-cli.yml');
  const script = stepRunScript(source, 'Bind npm publication to a protected release tag');
  const output = path.join(paths.root, 'output');
  const result = runBash(script, fixtureEnvironment(paths, { GITHUB_OUTPUT: output }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(output, 'utf8'), `tag=${currentTag}\nversion=${currentVersion}\n`);
  const gitLog = await fs.readFile(paths.gitLog, 'utf8');
  assert.match(gitLog, new RegExp(`refs/tags/${currentTagPattern}:refs/tags/${currentTagPattern}`, 'u'));
  assert.match(gitLog, /refs\/heads\/main:refs\/remotes\/origin\/main/u);
  assert.match(gitLog, /merge-base --is-ancestor a{40} refs\/remotes\/origin\/main/u);
});

test('CLI publication fails closed on ref, version, protection, or ancestry drift', async (t) => {
  const paths = await fakeReleaseCommands(t);
  const source = await workflow('release-cli.yml');
  const script = stepRunScript(source, 'Bind npm publication to a protected release tag');
  const cases = [
    { name: 'unprotected tag', overrides: { REF_PROTECTED: 'false' }, error: /tag to be protected/u },
    { name: 'unprotected main', overrides: { FAKE_MAIN_PROTECTED: 'false' }, error: /main branch to be protected/u },
    { name: 'wrong version tag', overrides: { GITHUB_REF: `refs/tags/${wrongTag}` }, error: /does not match ccem package version/u },
    { name: 'unsupported prerelease', overrides: { GITHUB_REF: `refs/tags/${unsupportedPrereleaseTag}` }, error: /stable, alpha, beta, or rc/u },
    { name: 'foreign source', overrides: { FAKE_ANCESTOR: 'false' }, error: /not reachable from origin\/main/u },
  ];
  for (const fixture of cases) {
    const result = runBash(
      script,
      fixtureEnvironment(paths, {
        GITHUB_OUTPUT: path.join(paths.root, `${fixture.name}.output`),
        ...fixture.overrides,
      }),
    );
    assert.notEqual(result.status, 0, `${fixture.name} unexpectedly passed`);
    assert.match(result.stderr, fixture.error, result.stderr);
  }
});

test('Desktop release resolves the updater baseline from the latest published release', async (t) => {
  const paths = await fakeReleaseCommands(t);
  const source = await workflow('release-desktop.yml');
  const script = stepRunScript(source, 'Generate release body');
  const output = path.join(paths.root, 'desktop-output');
  const result = runBash(script, fixtureEnvironment(paths, { GITHUB_OUTPUT: output }));
  assert.equal(result.status, 0, result.stderr);
  const contents = await fs.readFile(output, 'utf8');
  assert.match(contents, /^previous_desktop_tag=v2\.76\.0$/mu);
  assert.match(contents, new RegExp(`^current_tag=${currentTagPattern}$`, 'mu'));
  assert.match(contents, new RegExp(`^version=${currentVersion}$`, 'mu'));
  assert.match(contents, /^prerelease=false$/mu);
});

test('Desktop release classifies rc exactly and rejects unsupported prerelease channels', async (t) => {
  const paths = await fakeReleaseCommands(t);
  const source = await workflow('release-desktop.yml');
  const script = stepRunScript(source, 'Generate release body');
  const rcTag = `v${currentMajor}.${currentMinor}.${currentPatch}-rc.1`;
  const rcResult = runBash(
    script,
    fixtureEnvironment(paths, {
      GITHUB_REF: `refs/tags/${rcTag}`,
      GITHUB_REF_NAME: rcTag,
      FAKE_CURRENT_TAG: rcTag,
      GITHUB_OUTPUT: path.join(paths.root, 'desktop-rc-output'),
    }),
  );
  assert.equal(rcResult.status, 0, rcResult.stderr);
  assert.match(await fs.readFile(path.join(paths.root, 'desktop-rc-output'), 'utf8'), /^prerelease=true$/mu);

  const unsupportedResult = runBash(
    script,
    fixtureEnvironment(paths, {
      GITHUB_REF: `refs/tags/${unsupportedPrereleaseTag}`,
      GITHUB_REF_NAME: unsupportedPrereleaseTag,
      FAKE_CURRENT_TAG: unsupportedPrereleaseTag,
      GITHUB_OUTPUT: path.join(paths.root, 'desktop-unsupported-output'),
    }),
  );
  assert.notEqual(unsupportedResult.status, 0, 'unsupported prerelease unexpectedly passed');
  assert.match(unsupportedResult.stderr, /stable, alpha, beta, or rc/u);
});

test('Desktop published-release baseline fails closed on invalid, missing, or foreign tags', async (t) => {
  const paths = await fakeReleaseCommands(t);
  const source = await workflow('release-desktop.yml');
  const script = stepRunScript(source, 'Generate release body');
  const cases = [
    { name: 'invalid latest tag', overrides: { FAKE_LATEST_TAG: 'nightly' }, error: /not a stable semantic-version tag/u },
    { name: 'missing latest tag', overrides: { FAKE_PREVIOUS_TAG_EXISTS: 'false' }, error: /is missing from origin/u },
    { name: 'foreign latest tag', overrides: { FAKE_ANCESTOR: 'false' }, error: /is not an ancestor/u },
  ];
  for (const fixture of cases) {
    const result = runBash(
      script,
      fixtureEnvironment(paths, {
        GITHUB_OUTPUT: path.join(paths.root, `${fixture.name}.output`),
        ...fixture.overrides,
      }),
    );
    assert.notEqual(result.status, 0, `${fixture.name} unexpectedly passed`);
    assert.match(result.stderr, fixture.error, result.stderr);
  }
});

test('pre-tag Desktop readiness rejects a prerelease updater baseline', async (t) => {
  const paths = await fakeReleaseCommands(t);
  const source = await workflow('mode2-signed-readiness.yml');
  const script = stepRunScript(source, 'Require protected main and exact operator-confirmed SHA');
  const sourceCommit = 'a'.repeat(40);
  const baseEnvironment = {
    GITHUB_REF: 'refs/heads/main',
    EXPECTED_SHA: sourceCommit,
    EXPECTED_VERSION: currentVersion,
    SOURCE_COMMIT: sourceCommit,
    GITHUB_OUTPUT: path.join(paths.root, 'readiness-output'),
    FAKE_REMOTE_MAIN_SHA: sourceCommit,
  };
  const stableResult = runBash(script, fixtureEnvironment(paths, baseEnvironment));
  assert.equal(stableResult.status, 0, stableResult.stderr);
  assert.match(await fs.readFile(baseEnvironment.GITHUB_OUTPUT, 'utf8'), /^previous_desktop_tag=v2\.76\.0$/mu);

  const prereleaseResult = runBash(
    script,
    fixtureEnvironment(paths, {
      ...baseEnvironment,
      FAKE_LATEST_TAG: 'v2.76.0-rc.1',
      GITHUB_OUTPUT: path.join(paths.root, 'readiness-prerelease-output'),
    }),
  );
  assert.notEqual(prereleaseResult.status, 0, 'prerelease baseline unexpectedly passed readiness');
  assert.match(prereleaseResult.stderr, /not a stable semantic-version tag/u);

  const unsupportedCandidateResult = runBash(
    script,
    fixtureEnvironment(paths, {
      ...baseEnvironment,
      FAKE_DESKTOP_VERSION: `${currentMajor}.${currentMinor}.${currentPatch}-dev.1`,
      EXPECTED_VERSION: `${currentMajor}.${currentMinor}.${currentPatch}-dev.1`,
      GITHUB_OUTPUT: path.join(paths.root, 'readiness-unsupported-candidate-output'),
    }),
  );
  assert.notEqual(unsupportedCandidateResult.status, 0, 'unsupported candidate channel unexpectedly passed readiness');
  assert.match(unsupportedCandidateResult.stderr, /stable, alpha, beta, or rc/u);

  const wrongVersionResult = runBash(
    script,
    fixtureEnvironment(paths, {
      ...baseEnvironment,
      EXPECTED_VERSION: `${currentMajor}.${currentMinor}.${currentPatch + 1}`,
      GITHUB_OUTPUT: path.join(paths.root, 'readiness-wrong-version-output'),
    }),
  );
  assert.notEqual(wrongVersionResult.status, 0, 'wrong expected version unexpectedly passed readiness');
  assert.match(wrongVersionResult.stderr, /does not match Desktop version/u);

  const staleMainResult = runBash(
    script,
    fixtureEnvironment(paths, {
      ...baseEnvironment,
      FAKE_REMOTE_MAIN_SHA: 'c'.repeat(40),
      GITHUB_OUTPUT: path.join(paths.root, 'readiness-stale-main-output'),
    }),
  );
  assert.notEqual(staleMainResult.status, 0, 'stale main source unexpectedly passed readiness');
  assert.match(staleMainResult.stderr, /no longer the exact origin\/main commit/u);
});

test('signed producer checks out the exact published baseline supplied by its caller', async (t) => {
  const paths = await fakeReleaseCommands(t);
  const producerNode = await fakeProducerNode(paths);
  const source = await workflow('mode2-signed-producer.yml');
  const script = stepRunScript(source, 'Derive fresh instrumented previous release source');
  const environmentFile = path.join(paths.root, 'github-env');
  const previousRoot = path.join(paths.root, 'previous-source');
  const provenancePath = path.join(paths.root, 'provenance.json');
  const result = runBash(
    script,
    fixtureEnvironment(paths, {
      PATH: `${producerNode.bin}${path.delimiter}${paths.bin}${path.delimiter}${process.env.PATH}`,
      CCEM_PREVIOUS_RELEASE_TAG: 'v2.76.0',
      CCEM_RELEASE_TARGET: 'aarch64-apple-darwin',
      GITHUB_WORKSPACE: repoDir,
      GITHUB_RUN_ID: '1234',
      GITHUB_RUN_ATTEMPT: '2',
      RUNNER_TEMP: paths.root,
      GITHUB_ENV: environmentFile,
      FAKE_NODE_LOG: producerNode.nodeLog,
      FAKE_PREVIOUS_ROOT: previousRoot,
      FAKE_PROVENANCE_PATH: provenancePath,
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  const gitLog = await fs.readFile(paths.gitLog, 'utf8');
  assert.match(gitLog, /refs\/tags\/v2\.76\.0:refs\/tags\/v2\.76\.0/u);
  assert.match(gitLog, /merge-base --is-ancestor b{40} a{40}/u);
  const nodeLog = await fs.readFile(producerNode.nodeLog, 'utf8');
  assert.match(nodeLog, /--previous-ref v2\.76\.0/u);
  const environment = await fs.readFile(environmentFile, 'utf8');
  assert.match(environment, new RegExp(`^CCEM_PREVIOUS_SOURCE=${previousRoot}$`, 'mu'));
  assert.match(environment, new RegExp(`^CCEM_PREVIOUS_PROVENANCE=${provenancePath}$`, 'mu'));
  assert.match(environment, /^CCEM_PREVIOUS_COMMIT=b{40}$/mu);
});
