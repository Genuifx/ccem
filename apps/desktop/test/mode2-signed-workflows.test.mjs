import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(desktopDir, '..', '..');

function normalizeRepoText(source) {
  return source.replace(/\r\n?/g, '\n');
}

async function readRepoText(filePath) {
  return normalizeRepoText(await fs.readFile(filePath, 'utf8'));
}

async function workflow(name) {
  return readRepoText(path.join(repoDir, '.github', 'workflows', name));
}

test('repo source reader normalizes CRLF and lone CR boundaries', () => {
  assert.equal(normalizeRepoText('before\r\nmarker\rafter'), 'before\nmarker\nafter');
});

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

function fakeProtectionCommandPrelude() {
  return [
    'gh() {',
    '  printf "false\\n"',
    '}',
    'git() {',
    'if [ "$1" = "rev-parse" ]; then',
    '  printf "%s\\n" "$TEST_SOURCE_COMMIT"',
    '  return 0',
    'fi',
    'printf "unexpected git command after failed main-protection gate: %s\\n" "$*" >&2',
    'return 97',
    '}',
  ].join('\n');
}

const mutationSurface = /(?:contents:\s*write|write-all|api\.github\.com|uploads\.github\.com|ensure-draft-github-release|upload-draft-release-assets|publish-draft-github-release|github-draft-release-api|create-latest-from-release-payload|verify-immutable-releases-enabled|detect-actions-release-payload|gh\s+release)/u;

test('desktop producer is a fresh read-only mode-aware three-target evidence pipeline', async () => {
  const source = await workflow('mode2-signed-producer.yml');
  assert.match(source, /^name: Desktop Release Producer$/mu);
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
    /- name: Require a fresh current-attempt Desktop build\n\s+id: release-payload\n\s+shell: bash\n\s+run: echo "reuse=false" >> "\$GITHUB_OUTPUT"/u,
  );
  for (const stepName of [
    'Prepare updater replacement challenge payload',
    'Seal updater replacement receipt into target inventory',
    "Prepare this verified target's immutable current-run payload",
  ]) {
    assert.match(stepBlock(source, stepName), /\n\s+shell: bash\n/u);
  }
  assert.match(source, /Detect complete cross-platform production signing/u);
  assert.match(source, /release_mode: \$\{\{ steps\.release-mode\.outputs\.mode \}\}/u);
  assert.match(source, /production: \$\{\{ steps\.release-mode\.outputs\.production \}\}/u);
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
  assert.match(source, /remote_main="\$\(git rev-parse refs\/remotes\/origin\/main\^\{commit\}\)"/u);
  assert.match(source, /Signed readiness source is no longer the exact origin\/main commit/u);
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
  const finalTagGate = stepBlock(source, 'Reconfirm non-publishing source and candidate remain current');
  assert.match(finalTagGate, /if: \$\{\{ inputs\.export_release_payload != true \}\}/u);
  assert.match(finalTagGate, /SOURCE_COMMIT: \$\{\{ inputs\.source_commit \}\}/u);
  assert.match(finalTagGate, /git ls-remote origin refs\/heads\/main/u);
  assert.match(finalTagGate, /remote_main.*SOURCE_COMMIT/u);
  assert.match(finalTagGate, /git ls-remote --exit-code --tags origin/u);
  assert.match(source, /mode2-signed-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.target \}\}/u);
  assert.match(source, /mode2-release-payload-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.target \}\}/u);
  assert.match(source, /inputs\.export_release_payload == true/u);
  assert.match(source, /prepare-updater-replacement-payload\.mjs/u);
  assert.doesNotMatch(source, /Prepare updater replacement challenge payload[\s\S]{0,500}--tag/u);
  assertExternalActionsPinned(source);

  const tauriBlocks = source.match(/uses: tauri-apps\/tauri-action@[\s\S]*?(?=\n\s{6}- name:)/gu) ?? [];
  assert.equal(tauriBlocks.length, 2);
  for (const block of tauriBlocks) {
    assert.doesNotMatch(
      block,
      /GITHUB_TOKEN|tagName:|releaseId:|releaseName:|releaseBody:|releaseDraft:|includeUpdaterJson:/u,
    );
  }
  const productionBuild = stepBlock(source, 'Build production bundles without release access');
  const legacyBuild = stepBlock(source, 'Build legacy unsigned bundles with Mode 2 excluded');
  const canonicalizeMacUpdater = stepBlock(source, 'Canonicalize macOS updater release asset names');
  assert.match(productionBuild, /needs\.release-mode\.outputs\.production == 'true'/u);
  assert.doesNotMatch(productionBuild, /legacyArgs|continue-on-error|failure\(\)/u);
  assert.match(legacyBuild, /needs\.release-mode\.outputs\.production != 'true'/u);
  assert.match(legacyBuild, /args: \$\{\{ matrix\.legacyArgs \}\}/u);
  assert.doesNotMatch(
    legacyBuild,
    /steps\.[^.]+\.(?:outcome|conclusion)|continue-on-error|failure\(\)|always\(\)/u,
    'legacy mode must be selected before the matrix and cannot be a production failure fallback',
  );
  assert.match(
    canonicalizeMacUpdater,
    /if: \$\{\{ steps\.release-payload\.outputs\.reuse != 'true' && matrix\.appleSigning \}\}/u,
  );
  assert.match(canonicalizeMacUpdater, /canonicalize-macos-release-assets\.mjs/u);
  assert.match(canonicalizeMacUpdater, /--target "\$CCEM_RELEASE_TARGET"/u);
  assert.doesNotMatch(
    canonicalizeMacUpdater,
    /needs\.release-mode\.outputs\.production|always\(\)|continue-on-error/u,
  );
  const productionBuildIndex = source.indexOf('      - name: Build production bundles without release access');
  const legacyBuildIndex = source.indexOf('      - name: Build legacy unsigned bundles with Mode 2 excluded');
  const canonicalizeIndex = source.indexOf('      - name: Canonicalize macOS updater release asset names');
  const signedMacProofIndex = source.indexOf('      - name: Prove signed macOS Mode 2 Safe Storage and production behavior');
  const legacyMacProofIndex = source.indexOf('      - name: Prove legacy macOS bundles exclude Mode 2');
  assert.ok(productionBuildIndex < legacyBuildIndex);
  assert.ok(legacyBuildIndex < canonicalizeIndex);
  assert.ok(canonicalizeIndex < signedMacProofIndex);
  assert.ok(canonicalizeIndex < legacyMacProofIndex);
  for (const appleSecret of [
    'APPLE_SIGNING_IDENTITY',
    'APPLE_TEAM_ID',
    'APPLE_ID',
    'APPLE_PASSWORD',
  ]) {
    assert.match(
      productionBuild,
      new RegExp(`${appleSecret}: \\$\\{\\{ matrix\\.appleSigning && secrets\\.${appleSecret} \\|\\| '' \\}\\}`, 'u'),
    );
  }
  assert.doesNotMatch(
    legacyBuild,
    /APPLE_SIGNING_IDENTITY|APPLE_TEAM_ID|APPLE_ID|APPLE_PASSWORD|CCEM_CEF_TARGET_TRIPLE/u,
  );
  const legacyArgs = source.match(/^\s+legacyArgs:.*$/gmu) ?? [];
  assert.equal(legacyArgs.length, 3);
  for (const args of legacyArgs) {
    assert.doesNotMatch(args, /tauri\.cef\.conf\.json|tauri\.windows-signing\.conf\.json/u);
  }
  for (const stepName of [
    'Prove legacy macOS bundles exclude Mode 2',
    'Prove legacy Windows bundle excludes Mode 2',
  ]) {
    const verifier = stepBlock(source, stepName);
    assert.match(verifier, /verify-legacy-release-inventory\.mjs/u);
    assert.match(verifier, /--updater-signature/u);
    assert.match(verifier, /needs\.release-mode\.outputs\.production != 'true'/u);
  }
  assert.match(
    stepBlock(source, 'Prove legacy Windows bundle excludes Mode 2'),
    /--app 'src-tauri\/target\/x86_64-pc-windows-msvc\/release\/ccem-desktop\.exe'/u,
  );
  const legacyVerifierSource = await readRepoText(
    path.join(desktopDir, 'scripts', 'verify-legacy-release-inventory.mjs'),
  );
  assert.match(legacyVerifierSource, /import \{ verifyTauriUpdaterSignature \}/u);
  assert.match(legacyVerifierSource, /updaterSignatureVerification: signature\.algorithm/u);
  assert.match(legacyVerifierSource, /minisign-ed25519-blake2b/u);
  assert.match(legacyVerifierSource, /Mode 2\/CEF runtime path is forbidden/u);
});

test('final non-publishing gate rejects readiness evidence after origin/main moves', async () => {
  const source = await workflow('mode2-signed-producer.yml');
  const script = stepRunScript(
    source,
    'Reconfirm non-publishing source and candidate remain current',
  );
  const testScript = [
    'git() {',
    'if [ "$*" = "ls-remote origin refs/heads/main" ]; then',
    '  printf "%s\\trefs/heads/main\\n" "$TEST_REMOTE_MAIN"',
    '  return 0',
    'fi',
    'case "$*" in',
    '  "ls-remote --exit-code --tags origin refs/tags/v2.78.1") return 2 ;;',
    'esac',
    'printf "unexpected git command: %s\\n" "$*" >&2',
    'return 97',
    '}',
    script,
  ].join('\n');
  const sourceCommit = 'a'.repeat(40);
  const environment = {
    ...process.env,
    SOURCE_COMMIT: sourceCommit,
    VERSION: '2.78.1',
    TEST_REMOTE_MAIN: sourceCommit,
  };
  const current = spawnSync('bash', ['-c', testScript], {
    cwd: repoDir,
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(current.status, 0, current.stderr);

  const stale = spawnSync('bash', ['-c', testScript], {
    cwd: repoDir,
    env: { ...environment, TEST_REMOTE_MAIN: 'b'.repeat(40) },
    encoding: 'utf8',
  });
  assert.notEqual(stale.status, 0, 'stale readiness evidence unexpectedly passed');
  assert.match(stale.stderr, /no longer the exact origin\/main commit/u);
});

test('readiness caller is release-commit-or-manual, main-and-SHA-bound, and has no release capability', async () => {
  const source = await workflow('mode2-signed-readiness.yml');
  assert.match(source, /^name: Desktop Release Readiness$/mu);
  assert.match(source, /concurrency:\n  group: mode2-signed-readiness\n  cancel-in-progress: true/u);
  assert.match(source, /^on:\n  push:\n\s+branches:\n\s+- main/mu);
  assert.doesNotMatch(
    source.slice(source.indexOf('on:'), source.indexOf('  workflow_dispatch:')),
    /\n\s+paths:/u,
  );
  assert.match(source, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(source, /^  workflow_call:/mu);
  assert.match(source, /startsWith\(github\.event\.head_commit\.message, 'chore: release v'\)/u);
  assert.match(source, /expected_sha:[\s\S]*required: true/u);
  assert.match(source, /expected_version:[\s\S]*required: true/u);
  assert.match(source, /previous_desktop_tag: \$\{\{ steps\.source\.outputs\.previous_desktop_tag \}\}/u);
  assert.match(source, /refs\/heads\/main/u);
  assert.match(source, /REF_PROTECTED: \$\{\{ github\.ref_protected \}\}/u);
  assert.match(source, /\[\[ "\$REF_PROTECTED" == "true" \]\]/u);
  assert.match(source, /EXPECTED_SHA: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.expected_sha \|\| github\.sha \}\}/u);
  assert.match(source, /SOURCE_COMMIT: \$\{\{ github\.sha \}\}/u);
  assert.match(source, /git ls-remote --exit-code --tags origin/u);
  const settingsGate = stepBlock(
    source,
    'Require protected release refs before desktop build',
  );
  assert.match(settingsGate, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(settingsGate, /CCEM_RELEASE_SETTINGS_TOKEN/u);
  assert.match(settingsGate, /CCEM_RELEASE_CANDIDATE_TAG: v\$\{\{ steps\.source\.outputs\.version \}\}/u);
  assert.match(settingsGate, /check-release-repository-settings\.mjs/u);
  assert.match(source, /^permissions: \{\}$/mu);
  assert.doesNotMatch(source, mutationSurface);
  assert.doesNotMatch(source, /secrets:\s*inherit/u);
  assert.match(source, /uses: \.\/\.github\/workflows\/mode2-signed-producer\.yml/u);
  assert.match(source, /export_release_payload: false/u);
  assert.match(
    source,
    /previous_release_tag: \$\{\{ needs\.prepare-readiness\.outputs\.previous_desktop_tag \}\}/u,
  );
  assert.match(source, /readiness-complete:[\s\S]*name: Confirm Desktop Release Readiness/u);
  assert.match(source, /needs: \[prepare-readiness, signed-producer\]/u);
  assert.match(source, /needs\.signed-producer\.result == 'success'/u);
  assert.match(source, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/u);
  assert.match(source, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/u);
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
  const readinessGate = stepBlock(
    source,
    'Require successful pre-tag readiness for exact source',
  );
  assert.match(readinessGate, /CCEM_RELEASE_READINESS_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(readinessGate, /CCEM_RELEASE_SOURCE_COMMIT: \$\{\{ github\.sha \}\}/u);
  assert.match(readinessGate, /check-pretag-readiness-runs\.mjs/u);
  assert.match(source, /Manual desktop release may run only from protected main\./u);
  assert.match(source, /Automatic desktop release requires a formal v\* tag push\./u);
  assert.equal(
    source.match(/Desktop release requires a stable, alpha, beta, or rc semantic-version tag\./gu)?.length,
    2,
  );
  assert.match(source, /uses: \.\/\.github\/workflows\/mode2-signed-producer\.yml/u);
  assert.match(source, /export_release_payload: true/u);
  assert.match(
    source,
    /previous_release_tag: \$\{\{ needs\.prepare-release\.outputs\.previous_desktop_tag \}\}/u,
  );
  assert.match(source, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/u);
  assert.match(source, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/u);
  assert.doesNotMatch(source, /secrets:\s*inherit/u);
  assert.equal(source.match(/contents: write/gu)?.length, 1);
  assert.doesNotMatch(source, /tauri-apps\/tauri-action|stage-cef-(?:macos|windows)|run-updater-replacement-smoke/u);
  const producer = jobBlock(source, 'signed-producer', 'publish-updater-manifest');
  assert.match(producer, /actions: read\n\s+contents: read/u);
  assert.doesNotMatch(producer, /contents: write/u);
  const publisher = jobBlock(source, 'publish-updater-manifest', 'verify-published-updater');
  assert.match(publisher, /needs: \[prepare-release, signed-producer, dsh_bundle_smoke\]/u);
  assert.match(publisher, /needs\.signed-producer\.result == 'success'/u);
  assert.match(publisher, /needs\.dsh_bundle_smoke\.result == 'success'/u);
  assert.match(publisher, /actions: read\n\s+contents: write/u);
  assert.match(publisher, /pattern: mode2-release-payload-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\*/u);
  assert.match(publisher, /ensure-draft-github-release\.mjs/u);
  assert.match(publisher, /upload-draft-release-assets\.mjs --mode payload/u);
  assert.match(publisher, /publish-draft-github-release\.mjs/u);
  const publishedUpdaterVerifier = jobBlock(source, 'verify-published-updater', 'create-universal');
  assert.match(publishedUpdaterVerifier, /needs: \[prepare-release, publish-updater-manifest\]/u);
  assert.match(publishedUpdaterVerifier, /permissions: \{\}/u);
  assert.match(publishedUpdaterVerifier, /inputs\.draft == 'false'/u);
  assert.doesNotMatch(publishedUpdaterVerifier, /GITHUB_TOKEN|contents: write|secrets\./u);
  assertExternalActionsPinned(source);
});

test('release workflows use the latest published Desktop release as the upgrade baseline', async () => {
  const [releaseSource, readinessSource, producerSource] = await Promise.all([
    workflow('release-desktop.yml'),
    workflow('mode2-signed-readiness.yml'),
    workflow('mode2-signed-producer.yml'),
  ]);
  for (const caller of [releaseSource, readinessSource]) {
    assert.match(caller, /\/repos\/\$\{GITHUB_REPOSITORY\}\/releases\/latest/u);
    assert.match(caller, /--jq '\.tag_name'/u);
    assert.match(caller, /previous_desktop_tag=/u);
  }
  assert.match(
    producerSource,
    /previous_release_tag:[\s\S]*required: true[\s\S]*type: string/u,
  );
  assert.match(
    producerSource,
    /CCEM_PREVIOUS_RELEASE_TAG: \$\{\{ inputs\.previous_release_tag \}\}/u,
  );
  assert.match(producerSource, /previous_tag="\$CCEM_PREVIOUS_RELEASE_TAG"/u);
  assert.doesNotMatch(
    `${releaseSource}\n${readinessSource}\n${producerSource}`,
    /git describe --tags/u,
  );
});

test('protected tag cannot enter prepare, producer, or publish when main is unprotected', async (t) => {
  const [releaseSource, producerSource] = await Promise.all([
    workflow('release-desktop.yml'),
    workflow('mode2-signed-producer.yml'),
  ]);
  const commandPrelude = fakeProtectionCommandPrelude();
  const sourceCommit = 'a'.repeat(40);
  const repository = 'Genuifx/ccem';
  const tag = 'v2.58.0';
  const tagRef = `refs/tags/${tag}`;
  const callerWorkflowRef =
    `${repository}/.github/workflows/release-desktop.yml@${tagRef}`;
  const commonEnvironment = {
    ...process.env,
    TEST_SOURCE_COMMIT: sourceCommit,
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: tagRef,
    GITHUB_SHA: sourceCommit,
    EVENT_NAME: 'push',
    REF_PROTECTED: 'true',
    SOURCE_COMMIT: sourceCommit,
    TAG_NAME: tag,
    PREVIOUS_RELEASE_TAG: 'v2.57.0',
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
    const result = spawnSync('bash', ['-c', `${commandPrelude}\n${fixture.script}`], {
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
