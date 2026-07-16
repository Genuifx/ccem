import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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

const mutationSurface = /(?:contents:\s*write|write-all|GITHUB_TOKEN|github\.token|api\.github\.com|uploads\.github\.com|ensure-draft-github-release|upload-draft-release-assets|publish-draft-github-release|github-draft-release-api|create-latest-from-release-payload|verify-immutable-releases-enabled|detect-actions-release-payload|gh\s+(?:api|release))/u;

test('signed producer is a fresh read-only three-target evidence pipeline', async () => {
  const source = await workflow('mode2-signed-producer.yml');
  assert.match(source, /^name: Mode 2 Signed Producer$/mu);
  assert.match(source, /^on:\n  workflow_call:/mu);
  assert.doesNotMatch(source, /^  (?:push|workflow_dispatch):/mu);
  assert.match(source, /^permissions: \{\}$/mu);
  assert.equal(source.match(/^\s+environment: mode2-signing$/gmu)?.length, 2);
  assert.equal(source.match(/^\s+required: false$/gmu)?.length, 13);
  assert.doesNotMatch(source, mutationSurface);
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
  assert.match(source, /name: Build Desktop \(\$\{\{ matrix\.target \}\}\)/u);
  for (const target of [
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
  ]) {
    assert.equal(source.match(new RegExp(`target: ${target}`, 'gu'))?.length, 1);
  }
  assert.match(source, /Run signed installed Windows Mode 2 production smoke/u);
  assert.match(source, /Prove signed macOS Mode 2 Safe Storage isolation and persistence/u);
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
