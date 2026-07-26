import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(desktopDir, '..', '..');

async function workflow(name) {
  return fs.readFile(path.join(repoDir, '.github', 'workflows', name), 'utf8');
}

function assertExternalActionsPinned(source) {
  const refs = [...source.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/gmu)]
    .map((match) => match[1]);
  assert.ok(refs.length > 0, 'workflow must use at least one pinned action');
  for (const ref of refs) {
    if (ref.startsWith('./.github/workflows/')) continue;
    assert.match(ref, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u);
  }
}

function jobBlock(source, jobName, nextJobName = null) {
  const start = source.indexOf(`  ${jobName}:`);
  assert.ok(start >= 0, `missing job ${jobName}`);
  if (nextJobName === null) return source.slice(start);
  const end = source.indexOf(`  ${nextJobName}:`, start + 1);
  assert.ok(end > start, `missing job ${nextJobName} after ${jobName}`);
  return source.slice(start, end);
}

function stepBlock(source, stepName) {
  const start = source.indexOf(`      - name: ${stepName}`);
  assert.ok(start >= 0, `missing step ${stepName}`);
  const end = source.indexOf('\n      - name:', start + 1);
  return source.slice(start, end >= 0 ? end : source.length);
}

function stepRunScript(source, stepName) {
  const block = stepBlock(source, stepName);
  const marker = '\n        run: |\n';
  const start = block.indexOf(marker);
  assert.ok(start >= 0, `step ${stepName} must use a block run script`);
  const lines = block.slice(start + marker.length).split('\n');
  const script = [];
  for (const line of lines) {
    if (line.startsWith('          ')) {
      script.push(line.slice(10));
    } else if (line.length === 0) {
      script.push('');
    } else {
      break;
    }
  }
  return script.join('\n');
}

function assertReadOnlyMainProtectionApi(block) {
  assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(
    block,
    /if ! main_protection_verified="\$\([\s\S]*?gh api --method GET[\s\S]*?"\/repos\/\$\{GITHUB_REPOSITORY\}\/branches\/main"[\s\S]*?--jq '\.protected == true'[\s\S]*?\)"; then/u,
  );
  assert.match(block, /\[\[ "\$main_protection_verified" == "true" \]\]/u);
  assert.doesNotMatch(block, /branches\/main\/protection/u);
  assert.doesNotMatch(block, /gh api --method (?:POST|PUT|PATCH|DELETE)/u);
}

async function fakeProtectionCommands(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-main-protection-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, 'gh'),
    '#!/bin/sh\nprintf "false\\n"\n',
    { mode: 0o700 },
  );
  await fs.writeFile(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      'if [ "$1" = "rev-parse" ]; then',
      '  printf "%s\\n" "$TEST_SOURCE_COMMIT"',
      '  exit 0',
      'fi',
      'printf "unexpected git command after failed main-protection gate: %s\\n" "$*" >&2',
      'exit 97',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  return bin;
}

const mutationSurface = /(?:contents:\s*write|write-all|GITHUB_TOKEN|api\.github\.com|uploads\.github\.com|ensure-draft-github-release|upload-draft-release-assets|publish-draft-github-release|github-draft-release-api|create-latest-from-release-payload|verify-immutable-releases-enabled|detect-actions-release-payload|gh\s+release)/u;

test('signed producer is a fresh read-only three-target evidence pipeline', async () => {
  const source = await workflow('mode2-signed-producer.yml');
  assert.match(source, /^name: Mode 2 Signed Producer$/mu);
  assert.match(source, /^on:\n  workflow_call:/mu);
  assert.doesNotMatch(source, /^  (?:push|workflow_dispatch):/mu);
  assert.match(source, /^permissions: \{\}$/mu);
  assert.equal(source.match(/^\s+environment: mode2-signing$/gmu)?.length, 2);
  assert.equal(source.match(/^\s+required: false$/gmu)?.length, 13);
  assert.doesNotMatch(source, mutationSurface);
  assert.equal(source.match(/GH_TOKEN: \$\{\{ github\.token \}\}/gu)?.length, 1);
  assert.equal(source.match(/gh api --method GET/gu)?.length, 1);
  assert.doesNotMatch(source, /gh api --method (?:POST|PUT|PATCH|DELETE)/u);
  assert.doesNotMatch(source, /secrets:\s*inherit/u);
  assert.doesNotMatch(source, /Preview-only|unsignedArgs/u);
  assert.match(source, /export_release_payload:[\s\S]*default: false/u);
  assert.match(
    source,
    /- name: Require a fresh current-attempt signed build\n\s+id: release-payload\n\s+shell: bash\n\s+run: echo "reuse=false" >> "\$GITHUB_OUTPUT"/u,
  );
  for (const stepName of [
    'Prepare updater replacement challenge payload',
    'Seal updater replacement receipt into target inventory',
    "Prepare this verified target's immutable current-run payload",
  ]) {
    assert.match(stepBlock(source, stepName), /\n\s+shell: bash\n/u);
  }
  assert.match(source, /Require complete production signing/u);
  assert.match(source, /steps\.release-mode\.outputs\.production != 'true'/u);
  assert.match(source, /PRODUCER_WORKFLOW_REF: \$\{\{ job\.workflow_ref \}\}/u);
  assert.match(source, /PRODUCER_WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/u);
  assert.match(source, /mode2-signed-producer\.yml@\$\{GITHUB_REF\}/u);
  assert.match(
    source,
    /expected_caller_ref="\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/release-desktop\.yml@\$\{GITHUB_REF\}"/u,
  );
  assert.match(
    source,
    /expected_caller_ref="\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/mode2-signed-readiness\.yml@\$\{GITHUB_REF\}"/u,
  );
  assert.match(source, /REF_PROTECTED: \$\{\{ github\.ref_protected \}\}/u);
  assert.match(source, /\[\[ "\$REF_PROTECTED" == "true" \]\]/u);
  assertReadOnlyMainProtectionApi(stepBlock(source, 'Bind producer to the exact caller source'));
  assert.match(source, /refs\/heads\/main:refs\/remotes\/origin\/main/u);
  assert.match(
    source,
    /git merge-base --is-ancestor "\$source_commit" refs\/remotes\/origin\/main/u,
  );
  assert.match(source, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+/u);
  assert.equal(
    source.match(/CCEM_MODE2_PRODUCER_WORKFLOW_REF: \$\{\{ job\.workflow_ref \}\}/gu)?.length,
    6,
  );
  assert.match(source, /--producer-workflow-ref "\$\{\{ job\.workflow_ref \}\}"/u);
  assert.match(source, /name: Build Desktop \(\$\{\{ matrix\.target \}\}\)/u);
  for (const target of [
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
  ]) {
    assert.equal(source.match(new RegExp(`target: ${target}`, 'gu'))?.length, 1);
  }
  assert.match(source, /Run signed installed Windows Mode 2 production smoke/u);
  assert.match(source, /Prove signed macOS Mode 2 Safe Storage and production behavior/u);
  assert.match(source, /Prove real previous-to-current updater replacement/u);
  assert.match(source, /Verify signed evidence set/u);
  const finalTagGate = stepBlock(source, 'Reconfirm non-publishing candidate tag remains absent');
  assert.match(finalTagGate, /if: \$\{\{ inputs\.export_release_payload != true \}\}/u);
  assert.match(finalTagGate, /git ls-remote --exit-code --tags origin/u);
  assert.match(source, /mode2-signed-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.target \}\}/u);
  assert.match(source, /mode2-release-payload-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.target \}\}/u);
  assert.match(source, /inputs\.export_release_payload == true/u);
  assert.match(source, /prepare-updater-replacement-payload\.mjs/u);
  assert.doesNotMatch(source, /Prepare updater replacement challenge payload[\s\S]{0,500}--tag/u);
  assertExternalActionsPinned(source);

  const tauriBlocks = source.match(/uses: tauri-apps\/tauri-action@[\s\S]*?(?=\n\s{6}- name:)/gu) ?? [];
  assert.equal(tauriBlocks.length, 1);
  assert.doesNotMatch(
    tauriBlocks[0],
    /GITHUB_TOKEN|tagName:|releaseId:|releaseName:|releaseBody:|releaseDraft:|includeUpdaterJson:/u,
  );
  for (const appleSecret of [
    'APPLE_SIGNING_IDENTITY',
    'APPLE_TEAM_ID',
    'APPLE_ID',
    'APPLE_PASSWORD',
  ]) {
    assert.match(
      tauriBlocks[0],
      new RegExp(`${appleSecret}: \\$\\{\\{ matrix\\.appleSigning && secrets\\.${appleSecret} \\|\\| '' \\}\\}`, 'u'),
    );
  }
});

test('manual readiness caller is main-and-SHA-bound and has no release capability', async () => {
  const source = await workflow('mode2-signed-readiness.yml');
  assert.match(source, /^name: Mode 2 Signed Readiness$/mu);
  assert.match(source, /^on:\n  workflow_dispatch:/mu);
  assert.doesNotMatch(source, /^  (?:push|workflow_call):/mu);
  assert.match(source, /expected_sha:[\s\S]*required: true/u);
  assert.match(source, /refs\/heads\/main/u);
  assert.match(source, /REF_PROTECTED: \$\{\{ github\.ref_protected \}\}/u);
  assert.match(source, /\[\[ "\$REF_PROTECTED" == "true" \]\]/u);
  assert.match(source, /EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}/u);
  assert.match(source, /SOURCE_COMMIT: \$\{\{ github\.sha \}\}/u);
  assert.match(source, /git ls-remote --exit-code --tags origin/u);
  assert.match(source, /^permissions: \{\}$/mu);
  assert.doesNotMatch(source, mutationSurface);
  assert.doesNotMatch(source, /secrets:\s*inherit/u);
  assert.match(source, /uses: \.\/\.github\/workflows\/mode2-signed-producer\.yml/u);
  assert.match(source, /export_release_payload: false/u);
  assert.doesNotMatch(source, /^\s+secrets:/mu);
  assert.match(source, /permissions:\n\s+actions: read\n\s+contents: read/u);
  assertExternalActionsPinned(source);
});

test('release caller keeps the only write token behind the shared producer', async () => {
  const source = await workflow('release-desktop.yml');
  assert.match(source, /^name: Release Desktop$/mu);
  assert.match(source, /^  push:\n\s+tags:\n\s+- 'v\*'/mu);
  assert.equal(source.match(/REF_PROTECTED: \$\{\{ github\.ref_protected \}\}/gu)?.length, 2);
  assert.equal(source.match(/\[\[ "\$REF_PROTECTED" == "true" \]\]/gu)?.length, 2);
  assertReadOnlyMainProtectionApi(
    stepBlock(source, 'Require protected release ref and main ancestry'),
  );
  assertReadOnlyMainProtectionApi(
    stepBlock(source, 'Revalidate protected release source and exact tag'),
  );
  assert.equal(
    source.match(/"\/repos\/\$\{GITHUB_REPOSITORY\}\/branches\/main"/gu)?.length,
    2,
  );
  assert.equal(
    source.match(/refs\/heads\/main:refs\/remotes\/origin\/main/gu)?.length,
    2,
  );
  assert.equal(
    source.match(/git merge-base --is-ancestor "\$source_commit" refs\/remotes\/origin\/main/gu)
      ?.length,
    2,
  );
  assert.match(source, /Manual desktop release may run only from protected main\./u);
  assert.match(source, /Automatic desktop release requires a formal v\* tag push\./u);
  assert.equal(
    source.match(/Desktop release requires a formal semantic-version tag\./gu)?.length,
    2,
  );
  assert.match(source, /uses: \.\/\.github\/workflows\/mode2-signed-producer\.yml/u);
  assert.match(source, /export_release_payload: true/u);
  assert.doesNotMatch(source, /^\s+secrets:/mu);
  assert.doesNotMatch(source, /secrets:\s*inherit/u);
  assert.equal(source.match(/contents: write/gu)?.length, 1);
  assert.doesNotMatch(source, /tauri-apps\/tauri-action|stage-cef-(?:macos|windows)|run-updater-replacement-smoke/u);
  const producer = jobBlock(source, 'signed-producer', 'publish-updater-manifest');
  assert.match(producer, /actions: read\n\s+contents: read/u);
  assert.doesNotMatch(producer, /contents: write/u);
  const publisher = jobBlock(source, 'publish-updater-manifest', 'create-universal');
  assert.match(publisher, /needs: \[prepare-release, signed-producer\]/u);
  assert.match(publisher, /needs\.signed-producer\.result == 'success'/u);
  assert.match(publisher, /actions: read\n\s+contents: write/u);
  assert.match(publisher, /pattern: mode2-release-payload-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\*/u);
  assert.match(publisher, /ensure-draft-github-release\.mjs/u);
  assert.match(publisher, /upload-draft-release-assets\.mjs --mode payload/u);
  assert.match(publisher, /publish-draft-github-release\.mjs/u);
  assertExternalActionsPinned(source);
});

test('protected tag cannot enter prepare, producer, or publish when main is unprotected', async (t) => {
  const [releaseSource, producerSource] = await Promise.all([
    workflow('release-desktop.yml'),
    workflow('mode2-signed-producer.yml'),
  ]);
  const bin = await fakeProtectionCommands(t);
  const sourceCommit = 'a'.repeat(40);
  const repository = 'Genuifx/claude-code-env-manager';
  const tag = 'v2.58.0';
  const tagRef = `refs/tags/${tag}`;
  const callerWorkflowRef =
    `${repository}/.github/workflows/release-desktop.yml@${tagRef}`;
  const commonEnvironment = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TEST_SOURCE_COMMIT: sourceCommit,
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: tagRef,
    GITHUB_SHA: sourceCommit,
    EVENT_NAME: 'push',
    REF_PROTECTED: 'true',
    SOURCE_COMMIT: sourceCommit,
    TAG_NAME: tag,
    GH_TOKEN: 'read-only-test-token',
  };
  const cases = [
    {
      name: 'release prepare',
      script: stepRunScript(
        releaseSource,
        'Require protected release ref and main ancestry',
      ),
      environment: commonEnvironment,
    },
    {
      name: 'reusable producer',
      script: stepRunScript(
        producerSource,
        'Bind producer to the exact caller source',
      ),
      environment: {
        ...commonEnvironment,
        EXPECTED_SOURCE_COMMIT: sourceCommit,
        EXPECTED_CALLER_WORKFLOW_REF: callerWorkflowRef,
        EXPECTED_VERSION: tag.slice(1),
        EXPORT_RELEASE_PAYLOAD: 'true',
        RELEASE_TAG: tag,
        GITHUB_WORKFLOW_REF: callerWorkflowRef,
        PRODUCER_WORKFLOW_REF:
          `${repository}/.github/workflows/mode2-signed-producer.yml@${tagRef}`,
        PRODUCER_WORKFLOW_SHA: sourceCommit,
      },
    },
    {
      name: 'release publish',
      script: stepRunScript(
        releaseSource,
        'Revalidate protected release source and exact tag',
      ),
      environment: commonEnvironment,
    },
  ];

  for (const fixture of cases) {
    const result = spawnSync('bash', ['-c', fixture.script], {
      cwd: repoDir,
      env: fixture.environment,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `${fixture.name} unexpectedly accepted unprotected main`);
    assert.match(
      result.stderr,
      /requires the main branch to (?:be|remain) protected/u,
      `${fixture.name} did not fail at the main protection gate: ${result.stderr}`,
    );
    assert.doesNotMatch(result.stderr, /unexpected git command/u);
  }
});
