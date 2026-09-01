import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectActionsReleasePayload } from '../scripts/detect-actions-release-payload.mjs';
import { createLatestFromReleasePayload } from '../scripts/create-latest-from-release-payload.mjs';
import {
  DraftReleaseClient,
  releaseOwnerMarker,
  releaseSourceMarker,
} from '../scripts/github-draft-release-api.mjs';
import { ensureDraftGithubRelease } from '../scripts/ensure-draft-github-release.mjs';
import {
  loadExpectedReleaseAssets,
  publishDraftGithubRelease,
} from '../scripts/publish-draft-github-release.mjs';
import {
  uploadCandidateIdempotently,
  uploadDraftTargetAssets,
  uploadLatestJson,
  uploadVerifiedPayloadContract,
} from '../scripts/upload-draft-release-assets.mjs';
import { verifyImmutableReleasesEnabled } from '../scripts/verify-immutable-releases-enabled.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(desktopDir, '..', '..');
const repository = 'fixture-owner/fixture-repo';
const appVersion = '2.53.0';
const tag = `v${appVersion}`;
const runId = '123456789';
const runAttempt = '7';
const sourceCommit = 'a'.repeat(40);
const exactReleasePath = `/repos/${repository}/releases/42`;
const exactCommitPath = `/repos/${repository}/commits/${encodeURIComponent(tag)}`;

function response(status, value = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => (value == null ? '' : JSON.stringify(value)),
  };
}

function releaseFixture(overrides = {}) {
  return {
    id: 42,
    tag_name: tag,
    draft: true,
    immutable: false,
    body: `${releaseOwnerMarker(runId)}\n${releaseSourceMarker(sourceCommit)}`,
    upload_url: `https://uploads.github.com/repos/${repository}/releases/42/assets{?name,label}`,
    assets: [],
    ...overrides,
  };
}

function copyRelease(release) {
  return release == null
    ? null
    : { ...release, assets: release.assets.map((asset) => ({ ...asset })) };
}

async function bodyBytes(body) {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === 'string' || Buffer.isBuffer(body)) return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function fakeGitHub({
  initialRelease = releaseFixture(),
  publishAfterUploads = null,
  patchResponseOverride = null,
  postPublishExactOverride = null,
  tagCommitSha = sourceCommit,
} = {}) {
  let release = copyRelease(initialRelease);
  let nextAssetId = 100;
  let uploadCount = 0;
  let publicationCompleted = false;
  const requests = [];

  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const method = options.method ?? 'GET';
    requests.push({ method, url: url.href, path: url.pathname });

    if (url.origin === 'https://api.github.com' && method === 'GET'
      && url.pathname === `/repos/${repository}/releases`) {
      return response(200, release == null ? [] : [copyRelease(release)]);
    }
    if (url.origin === 'https://api.github.com' && method === 'GET'
      && url.pathname === exactReleasePath) {
      if (release == null) return response(404, { message: 'missing' });
      const value = publicationCompleted && postPublishExactOverride
        ? { ...copyRelease(release), ...postPublishExactOverride }
        : copyRelease(release);
      return response(200, value);
    }
    if (url.origin === 'https://api.github.com' && method === 'GET'
      && url.pathname === exactCommitPath) {
      return response(200, { sha: tagCommitSha });
    }
    if (url.origin === 'https://api.github.com' && method === 'POST'
      && url.pathname === `/repos/${repository}/releases`) {
      if (release != null) return response(422, { message: 'already exists' });
      const payload = JSON.parse(options.body);
      release = releaseFixture({
        tag_name: payload.tag_name,
        draft: payload.draft,
        prerelease: payload.prerelease,
        body: payload.body,
        target_commitish: payload.target_commitish,
      });
      return response(201, copyRelease(release));
    }
    if (url.origin === 'https://uploads.github.com' && method === 'POST'
      && url.pathname === `/repos/${repository}/releases/42/assets`) {
      const bytes = await bodyBytes(options.body);
      const asset = {
        id: nextAssetId,
        name: url.searchParams.get('name'),
        size: bytes.length,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        state: 'uploaded',
      };
      nextAssetId += 1;
      release.assets.push(asset);
      uploadCount += 1;
      if (publishAfterUploads === uploadCount) {
        release.draft = false;
        release.immutable = true;
      }
      return response(201, { ...asset });
    }
    if (url.origin === 'https://api.github.com' && method === 'DELETE'
      && url.pathname.startsWith(`/repos/${repository}/releases/assets/`)) {
      const id = Number(url.pathname.split('/').at(-1));
      const index = release.assets.findIndex((asset) => asset.id === id);
      if (index < 0) return response(404, { message: 'missing asset' });
      release.assets.splice(index, 1);
      return response(204);
    }
    if (url.origin === 'https://api.github.com' && method === 'PATCH'
      && url.pathname === exactReleasePath) {
      const payload = JSON.parse(options.body);
      if (payload.draft !== false) return response(422, { message: 'invalid transition' });
      release.draft = false;
      release.immutable = true;
      publicationCompleted = true;
      return response(200, patchResponseOverride
        ? { ...copyRelease(release), ...patchResponseOverride }
        : copyRelease(release));
    }
    return response(404, { message: `${method} ${url.href}` });
  };

  return {
    fetchImpl,
    requests,
    release: () => copyRelease(release),
  };
}

function clientFor(api, overrides = {}) {
  return new DraftReleaseClient({
    repository,
    tag,
    token: 'fixture-token',
    expectedReleaseId: 42,
    expectedOwnerRunId: runId,
    expectedSourceCommit: sourceCommit,
    fetchImpl: api.fetchImpl,
    ...overrides,
  });
}

function immutablePolicyFor(api, { enabled = true } = {}) {
  return () => verifyImmutableReleasesEnabled({
    repository,
    token: 'settings-token',
    fetchImpl: async (rawUrl, options = {}) => {
      const url = new URL(rawUrl);
      api.requests.push({
        method: options.method ?? 'GET',
        url: url.href,
        path: url.pathname,
      });
      return response(200, { enabled });
    },
  });
}

function publicationContract() {
  const names = [...Array.from({ length: 8 }, (_, index) => `target-${index}.bin`), 'latest.json'];
  const expectedAssets = names.map((fileName, index) => {
    const bytes = Buffer.from(`publication-${index}`);
    return {
      fileName,
      assetId: 200 + index,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  return {
    expectedAssets,
    assets: expectedAssets.map(({ fileName, assetId: id, size, sha256 }) => ({
      id,
      name: fileName,
      size,
      digest: `sha256:${sha256}`,
      state: 'uploaded',
    })),
  };
}

function assertExactReadImmediatelyBefore(requests, mutation) {
  const index = requests.indexOf(mutation);
  assert.ok(index > 0, `missing request before ${mutation.method} ${mutation.url}`);
  assert.deepEqual(
    { method: requests[index - 1].method, path: requests[index - 1].path },
    { method: 'GET', path: exactReleasePath },
  );
}

async function metadata(root, fileName, contents, contentType = 'application/octet-stream') {
  const candidatePath = path.join(root, fileName);
  const bytes = Buffer.from(contents);
  await fs.mkdir(path.dirname(candidatePath), { recursive: true });
  await fs.writeFile(candidatePath, bytes);
  return {
    path: candidatePath,
    fileName,
    contentType,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function verifiedPayloadFixture(root) {
  const payloadRoot = path.join(root, 'release-payloads');
  const rolesByTarget = new Map([
    ['aarch64-apple-darwin', ['dmg', 'updater', 'updaterSignature']],
    ['x86_64-apple-darwin', ['dmg', 'updater', 'updaterSignature']],
    ['x86_64-pc-windows-msvc', ['updater', 'updaterSignature']],
  ]);
  const targets = [];
  for (const [target, roles] of rolesByTarget) {
    const assetsRoot = path.join(
      payloadRoot,
      `mode2-release-payload-${runId}-${runAttempt}-${target}`,
      'assets',
    );
    const assets = {};
    for (const role of roles) {
      const fileName = `${target}-${role}.bin`;
      assets[role] = await metadata(assetsRoot, fileName, `${target}:${role}`);
    }
    targets.push({ target, assets });
  }
  const contract = {
    schemaVersion: 1,
    runId,
    runAttempt,
    tag,
    sourceCommit,
    appVersion,
    targets,
  };
  const contractPath = path.join(payloadRoot, 'verified-payload-contract.json');
  await fs.writeFile(contractPath, JSON.stringify(contract));
  return { contract, contractPath, payloadRoot };
}

function stepBlock(workflow, name) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing workflow step: ${name}`);
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, next < 0 ? workflow.length : next);
}

test('latest.json uses unique stable tag download URLs for every updater payload', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-stable-updater-urls-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await verifiedPayloadFixture(root);
  const outputPath = path.join(root, 'latest.json');
  const latest = await createLatestFromReleasePayload({
    contractPath: fixture.contractPath,
    outputPath,
    repository,
    tag,
    version: appVersion,
    pubDate: '2026-08-28T00:00:00Z',
    runId,
  });

  const targetByPlatform = {
    'darwin-aarch64': 'aarch64-apple-darwin',
    'darwin-x86_64': 'x86_64-apple-darwin',
    'windows-x86_64': 'x86_64-pc-windows-msvc',
  };
  const expectedUrls = Object.entries(targetByPlatform).map(([platform, target]) => {
    const targetContract = fixture.contract.targets.find((candidate) => candidate.target === target);
    const expected = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(targetContract.assets.updater.fileName)}`;
    assert.equal(latest.platforms[platform].url, expected);
    return expected;
  });
  assert.equal(new Set(expectedUrls).size, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(outputPath, 'utf8')), latest);
});

test('immutable release preflight is read-only and fails closed unless enabled is true', async () => {
  const requests = [];
  const enabled = await verifyImmutableReleasesEnabled({
    repository,
    token: 'settings-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(200, { enabled: true, enforced_by_owner: false });
    },
  });
  assert.deepEqual(enabled, { repository, enabled: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer settings-token');
  assert.equal(requests[0].options.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(requests[0].url, `https://api.github.com/repos/${repository}/immutable-releases`);

  await assert.rejects(verifyImmutableReleasesEnabled({
    repository,
    token: '',
    fetchImpl: async () => response(200, { enabled: true }),
  }), /CCEM_RELEASE_SETTINGS_TOKEN is required/u);
  await assert.rejects(verifyImmutableReleasesEnabled({
    repository,
    token: 'settings-token',
    fetchImpl: async () => response(404, { message: 'Not Found' }),
  }), /immutable releases are not enabled/u);
  await assert.rejects(verifyImmutableReleasesEnabled({
    repository,
    token: 'settings-token',
    fetchImpl: async () => response(403, { message: 'Forbidden' }),
  }), /settings read failed \(403\)/u);
  await assert.rejects(verifyImmutableReleasesEnabled({
    repository,
    token: 'settings-token',
    fetchImpl: async () => response(200, { enabled: false }),
  }), /did not return enabled:true/u);
  await assert.rejects(verifyImmutableReleasesEnabled({
    repository,
    token: 'settings-token',
    fetchImpl: async () => response(200, null),
  }), /did not return enabled:true/u);
});

test('release DAG keeps builders read-only and defers one privileged transaction until payload verification', async () => {
  const [releaseWorkflow, producerWorkflow] = await Promise.all([
    fs.readFile(path.join(repoDir, '.github', 'workflows', 'release-desktop.yml'), 'utf8'),
    fs.readFile(path.join(repoDir, '.github', 'workflows', 'mode2-signed-producer.yml'), 'utf8'),
  ]);
  const productionAction = stepBlock(producerWorkflow, 'Build production bundles without release access');
  assert.match(productionAction, /tauri-apps\/tauri-action@[a-f0-9]{40}/u);
  assert.doesNotMatch(
    productionAction,
    /GITHUB_TOKEN|tagName:|releaseId:|releaseName:|releaseBody:|releaseDraft:|prerelease:|includeUpdaterJson:/u,
  );
  assert.deepEqual(
    [...productionAction.matchAll(/^\s{10}([A-Za-z][A-Za-z0-9]*):/gmu)].map((match) => match[1]),
    ['projectPath', 'args'],
  );
  assert.doesNotMatch(producerWorkflow, /contents: write|detect-actions-release-payload/u);
  assert.match(producerWorkflow, /Build legacy unsigned bundles with Mode 2 excluded/u);
  assert.match(producerWorkflow, /verify-legacy-release-inventory\.mjs/u);
  assert.match(producerWorkflow, /Require a fresh current-attempt Desktop build/u);
  assert.match(producerWorkflow, /inputs\.export_release_payload == true/u);
  assert.match(producerWorkflow, /name: mode2-release-payload-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ matrix\.target \}\}/u);

  assert.match(releaseWorkflow, /concurrency:\n  group: release-desktop\n  cancel-in-progress: false/u);
  assert.match(releaseWorkflow, /recover_stale_draft:[\s\S]*default: 'false'/u);
  assert.match(releaseWorkflow, /git fetch --force --no-tags origin "refs\/tags\/\$\{current_tag\}:refs\/tags\/\$\{current_tag\}"/u);
  assert.match(releaseWorkflow, /Release tag \$\{current_tag\} must exist before desktop release builds start/u);
  const protectedRefsGate = stepBlock(
    releaseWorkflow,
    'Require protected release refs before desktop build',
  );
  assert.match(protectedRefsGate, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(protectedRefsGate, /CCEM_RELEASE_CANDIDATE_TAG: \$\{\{ steps\.release-notes\.outputs\.current_tag \}\}/u);
  assert.match(protectedRefsGate, /check-release-repository-settings\.mjs/u);
  assert.doesNotMatch(protectedRefsGate, /CCEM_RELEASE_SETTINGS_TOKEN/u);
  const readinessGate = stepBlock(
    releaseWorkflow,
    'Require successful pre-tag readiness for exact source',
  );
  assert.match(readinessGate, /CCEM_RELEASE_READINESS_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(readinessGate, /CCEM_RELEASE_SOURCE_COMMIT: \$\{\{ github\.sha \}\}/u);
  assert.match(readinessGate, /check-pretag-readiness-runs\.mjs/u);
  const producerIndex = releaseWorkflow.indexOf('  signed-producer:');
  const transactionIndex = releaseWorkflow.indexOf('  publish-updater-manifest:');
  const universalIndex = releaseWorkflow.indexOf('  create-universal:');
  assert.ok(producerIndex > 0 && producerIndex < transactionIndex && transactionIndex < universalIndex);
  const callJob = releaseWorkflow.slice(producerIndex, transactionIndex);
  assert.match(callJob, /permissions:\n\s+actions: read\n\s+contents: read/u);
  assert.match(callJob, /uses: \.\/\.github\/workflows\/mode2-signed-producer\.yml/u);
  assert.match(callJob, /export_release_payload: true/u);
  assert.match(callJob, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/u);
  assert.match(callJob, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/u);
  assert.doesNotMatch(callJob, /contents: write|secrets:\s*inherit/u);

  const transaction = releaseWorkflow.slice(transactionIndex, universalIndex);
  assert.match(transaction, /needs: \[prepare-release, signed-producer, dsh_bundle_smoke\]/u);
  assert.match(transaction, /needs\.dsh_bundle_smoke\.result == 'success'/u);
  assert.match(transaction, /actions: read\n\s+contents: write/u);
  assert.equal(releaseWorkflow.match(/contents: write/gu)?.length, 1);
  assert.match(transaction, /pattern: mode2-release-payload-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\*/u);
  const verifyIndex = transaction.indexOf('- name: Verify exact three immutable payloads and eight assets');
  const draftIndex = transaction.indexOf('- name: Create or resume the exact current-run draft release');
  const uploadEightIndex = transaction.indexOf('- name: Upload the exact eight verified target assets');
  const generateLatestIndex = transaction.indexOf('- name: Generate latest.json from verified current-run payload');
  const uploadLatestIndex = transaction.indexOf('- name: Upload exact latest.json');
  const publishIndex = transaction.indexOf('- name: Verify exact nine assets and publish the locked draft');
  assert.ok(verifyIndex >= 0 && verifyIndex < draftIndex);
  assert.ok(draftIndex < uploadEightIndex && uploadEightIndex < generateLatestIndex);
  assert.ok(generateLatestIndex < uploadLatestIndex && uploadLatestIndex < publishIndex);
  const publishStep = stepBlock(
    releaseWorkflow,
    'Verify exact nine assets and publish the locked draft',
  );
  assert.doesNotMatch(publishStep, /CCEM_RELEASE_SETTINGS_TOKEN/u);
  assert.doesNotMatch(releaseWorkflow, /CCEM_RELEASE_SETTINGS_TOKEN/u);
  assert.match(releaseWorkflow, /ensure-draft-github-release\.mjs/u);
  assert.match(transaction, /ALLOW_STALE_DRAFT_RECOVERY: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.recover_stale_draft \|\| 'false' \}\}/u);
  assert.equal(releaseWorkflow.match(/EXPECTED_RELEASE_ID: \$\{\{ steps\.draft-release\.outputs\.release_id \}\}/gu)?.length, 3);
  assert.equal(releaseWorkflow.match(/EXPECTED_RELEASE_OWNER_RUN_ID: \$\{\{ steps\.draft-release\.outputs\.release_owner_run_id \}\}/gu)?.length, 3);
  assert.equal(releaseWorkflow.match(/EXPECTED_RELEASE_SOURCE_COMMIT: \$\{\{ github\.sha \}\}/gu)?.length, 3);
  assert.match(releaseWorkflow, /upload-draft-release-assets\.mjs --mode payload/u);
  assert.doesNotMatch(releaseWorkflow, /--mode replace-dmg/u);
  assert.match(releaseWorkflow, /upload-draft-release-assets\.mjs --mode latest/u);
  assert.match(releaseWorkflow, /publish-draft-github-release\.mjs/u);
  assert.match(releaseWorkflow, /CCEM_RELEASE_LATEST_RECEIPT_PATH/u);
  assert.match(releaseWorkflow, /CCEM_RELEASE_RECEIPTS_DIR/u);
  assert.doesNotMatch(releaseWorkflow, /require-draft-github-release\.mjs/u);
  assert.doesNotMatch(`${releaseWorkflow}\n${producerWorkflow}`, /curl[\s\S]{0,180}-H ["']Authorization:/u);
  assert.doesNotMatch(`${releaseWorkflow}\n${producerWorkflow}`, /curl[\s\S]{0,180}(?:-X|--request) (?:POST|DELETE|PATCH)/u);
  const uploaderSource = await fs.readFile(
    path.join(desktopDir, 'scripts', 'upload-draft-release-assets.mjs'),
    'utf8',
  );
  assert.doesNotMatch(uploaderSource, /DELETE|deleteAsset|replaceVerifiedDmg/u);
  const releaseApiSource = await fs.readFile(
    path.join(desktopDir, 'scripts', 'github-draft-release-api.mjs'),
    'utf8',
  );
  assert.doesNotMatch(releaseApiSource, /method:\s*['"]DELETE['"]/u);
  const fileSizeGate = await fs.readFile(path.join(repoDir, 'scripts', 'check-file-size.sh'), 'utf8');
  assert.match(fileSizeGate, /-name "\*\.mjs"/u);
  assert.match(fileSizeGate, /-name "\*\.cjs"/u);
});

test('release workflow has no duplicate YAML mapping keys', async (t) => {
  const checker = path.join(repoDir, 'scripts', 'ci', 'check-yaml-duplicate-keys.rb');
  const workflow = path.join(repoDir, '.github', 'workflows', 'release-desktop.yml');
  const valid = spawnSync('ruby', [checker, workflow], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-yaml-duplicate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const duplicate = path.join(root, 'duplicate.yml');
  await fs.writeFile(duplicate, 'job:\n  uses: first\n  uses: second\n');
  const rejected = spawnSync('ruby', [checker, duplicate], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /duplicate YAML key "uses"/u);
});

test('target uploader stops when the exact release becomes published', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-draft-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = 'aarch64-apple-darwin';
  const bundle = path.join(root, 'src-tauri', 'target', target, 'release', 'bundle');
  await metadata(path.join(bundle, 'dmg'), 'CCEM_aarch64.dmg', 'initial-dmg');
  await metadata(path.join(bundle, 'macos'), 'CCEM_aarch64.app.tar.gz', 'updater');
  await metadata(path.join(bundle, 'macos'), 'CCEM_aarch64.app.tar.gz.sig', 'signature');
  const receipt = path.join(root, 'receipt.json');
  const api = fakeGitHub({ publishAfterUploads: 1 });

  await assert.rejects(
    uploadDraftTargetAssets({
      client: clientFor(api),
      desktopDir: root,
      target,
      receiptPath: receipt,
      runId,
    }),
    /already published; refusing to unpublish or mutate it/u,
  );
  const uploads = api.requests.filter((request) => request.method === 'POST'
    && request.url.startsWith('https://uploads.github.com/'));
  assert.equal(uploads.length, 1);
  assertExactReadImmediatelyBefore(api.requests, uploads[0]);
  await assert.rejects(fs.access(receipt));
});

test('verified target uploader records final asset ids for the stable run only after success', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-draft-target-success-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = 'aarch64-apple-darwin';
  const bundle = path.join(root, 'src-tauri', 'target', target, 'release', 'bundle');
  await metadata(path.join(bundle, 'dmg'), 'CCEM_aarch64.dmg', 'final-stapled-dmg');
  await metadata(path.join(bundle, 'macos'), 'CCEM_aarch64.app.tar.gz', 'final-updater');
  await metadata(path.join(bundle, 'macos'), 'CCEM_aarch64.app.tar.gz.sig', 'final-signature');
  const receiptPath = path.join(root, 'receipt.json');
  const api = fakeGitHub();
  const receipt = await uploadDraftTargetAssets({
    client: clientFor(api),
    desktopDir: root,
    target,
    receiptPath,
    runId,
  });
  assert.equal(receipt.runId, runId);
  assert.equal('runAttempt' in receipt, false);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(Object.keys(receipt.assets).length, 3);
  const uploads = api.requests.filter((request) => request.method === 'POST'
    && request.url.startsWith('https://uploads.github.com/'));
  assert.equal(uploads.length, 3);
  for (const upload of uploads) assertExactReadImmediatelyBefore(api.requests, upload);
  assert.deepEqual(JSON.parse(await fs.readFile(receiptPath, 'utf8')), receipt);
});

test('verified payload uploader rebinds attempt, source, version, and exact payload roots before mutation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-verified-payload-upload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await verifiedPayloadFixture(root);
  const receiptsDir = path.join(root, 'receipts');
  const options = {
    contractPath: fixture.contractPath,
    payloadRoot: fixture.payloadRoot,
    receiptsDir,
    runId,
    runAttempt,
    sourceCommit,
    appVersion,
  };

  const validApi = fakeGitHub();
  const receipts = await uploadVerifiedPayloadContract({
    client: clientFor(validApi),
    ...options,
  });
  assert.equal(receipts.length, 3);
  assert.equal(
    validApi.requests.filter(({ method, url }) => method === 'POST' && url.startsWith('https://uploads.github.com/')).length,
    8,
  );

  const mutations = [
    [(contract) => { contract.runAttempt = '8'; }, /verified payload contract/iu],
    [(contract) => { contract.sourceCommit = 'b'.repeat(40); }, /verified payload contract/iu],
    [(contract) => { contract.appVersion = '2.54.0'; }, /verified payload contract/iu],
    [(contract) => {
      contract.targets[0].assets.dmg.path = path.join(root, contract.targets[0].assets.dmg.fileName);
    }, /payload root/iu],
  ];
  for (const [mutate, expectedError] of mutations) {
    const contract = structuredClone(fixture.contract);
    mutate(contract);
    await fs.writeFile(fixture.contractPath, JSON.stringify(contract));
    const api = fakeGitHub();
    await assert.rejects(
      uploadVerifiedPayloadContract({ client: clientFor(api), ...options }),
      expectedError,
    );
    assert.equal(api.requests.some(({ method }) => method === 'POST'), false);
  }
});

test('idempotent upload accepts only an exact digest and never deletes collisions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-draft-collision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = await metadata(root, 'latest.json', '{"version":"2.53.0"}\n', 'application/json');
  const exactAsset = {
    id: 77,
    name: candidate.fileName,
    size: candidate.size,
    digest: `sha256:${candidate.sha256}`,
    state: 'uploaded',
  };
  const exactApi = fakeGitHub({ initialRelease: releaseFixture({ assets: [exactAsset] }) });
  const latestReceiptPath = path.join(root, 'latest-upload-receipt.json');
  const exact = await uploadLatestJson({
    client: clientFor(exactApi),
    latestPath: candidate.path,
    receiptPath: latestReceiptPath,
    runId,
  });
  assert.equal(exact.uploaded, false);
  assert.equal(exact.asset.id, 77);
  assert.equal(exactApi.requests.some(({ method }) => ['POST', 'DELETE'].includes(method)), false);
  assert.deepEqual(JSON.parse(await fs.readFile(latestReceiptPath, 'utf8')), {
    schemaVersion: 2,
    tag,
    target: 'latest',
    runId,
    assets: {
      'latest.json': { assetId: 77, size: candidate.size, sha256: candidate.sha256 },
    },
  });

  const mismatchApi = fakeGitHub({
    initialRelease: releaseFixture({ assets: [{ ...exactAsset, digest: `sha256:${'0'.repeat(64)}` }] }),
  });
  await assert.rejects(
    uploadCandidateIdempotently(clientFor(mismatchApi), candidate),
    /collision does not match current bytes/u,
  );
  assert.equal(mismatchApi.requests.some(({ method }) => ['POST', 'DELETE'].includes(method)), false);
});

test('draft reads retry bounded transient network and server failures', async () => {
  const api = fakeGitHub();
  let attempts = 0;
  const client = clientFor({
    ...api,
    fetchImpl: async (rawUrl, options) => {
      const url = new URL(rawUrl);
      if ((options?.method ?? 'GET') === 'GET'
        && url.pathname === `/repos/${repository}/releases`
        && attempts < 3) {
        attempts += 1;
        if (attempts === 1) throw new TypeError('fixture connection reset');
        return response(attempts === 2 ? 429 : 503, { message: 'fixture unavailable' });
      }
      attempts += 1;
      return api.fetchImpl(rawUrl, options);
    },
  }, { sleepImpl: async () => {} });

  assert.equal((await client.requireDraft()).id, 42);
  assert.equal(attempts, 5);

  let requestTimeoutAttempts = 0;
  const requestTimeout = clientFor({
    ...api,
    fetchImpl: async (rawUrl, options) => {
      const url = new URL(rawUrl);
      if ((options?.method ?? 'GET') === 'GET'
        && url.pathname === `/repos/${repository}/releases`
        && requestTimeoutAttempts === 0) {
        requestTimeoutAttempts += 1;
        return response(408, { message: 'fixture request timeout' });
      }
      requestTimeoutAttempts += 1;
      return api.fetchImpl(rawUrl, options);
    },
  }, { sleepImpl: async () => {} });
  assert.equal((await requestTimeout.requireDraft()).id, 42);
  assert.equal(requestTimeoutAttempts, 3);

  let exhausted = 0;
  const unavailable = clientFor({
    ...api,
    fetchImpl: async () => {
      exhausted += 1;
      return response(502, { message: 'fixture unavailable' });
    },
  }, { sleepImpl: async () => {} });
  await assert.rejects(unavailable.requireDraft(), /GET request failed \(502\)/u);
  assert.equal(exhausted, 4);
});

test('upload recovers an exact persisted asset after a client error without overwriting it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-draft-upload-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = await metadata(root, 'recovered.dmg', 'persisted-before-client-error');
  const api = fakeGitHub();
  let uploadAttempts = 0;
  const fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    if ((options?.method ?? 'GET') === 'POST' && url.origin === 'https://uploads.github.com') {
      uploadAttempts += 1;
      const persisted = await api.fetchImpl(rawUrl, options);
      assert.equal(persisted.status, 201);
      throw new TypeError('fixture socket closed after upload');
    }
    return api.fetchImpl(rawUrl, options);
  };

  const result = await uploadCandidateIdempotently(clientFor({ ...api, fetchImpl }, {
    sleepImpl: async () => {},
  }), candidate);
  assert.equal(result.uploaded, true);
  assert.equal(result.asset.name, candidate.fileName);
  assert.equal(result.asset.size, candidate.size);
  assert.equal(result.asset.digest, `sha256:${candidate.sha256}`);
  assert.equal(uploadAttempts, 1);
  assert.equal(api.release().assets.length, 1);
  assert.equal(api.requests.some(({ method }) => method === 'DELETE'), false);
});

test('upload retries a transient 5xx only after proving the named asset is still absent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-draft-upload-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = await metadata(root, 'retry.dmg', 'retry-after-503');
  const api = fakeGitHub();
  let uploadAttempts = 0;
  const fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    if ((options?.method ?? 'GET') === 'POST' && url.origin === 'https://uploads.github.com') {
      uploadAttempts += 1;
      if (uploadAttempts === 1) return response(503, { message: 'fixture unavailable' });
    }
    return api.fetchImpl(rawUrl, options);
  };

  const result = await uploadCandidateIdempotently(clientFor({ ...api, fetchImpl }, {
    sleepImpl: async () => {},
  }), candidate);
  assert.equal(result.uploaded, true);
  assert.equal(uploadAttempts, 2);
  assert.equal(api.release().assets.length, 1);
  assert.equal(api.requests.some(({ method }) => method === 'DELETE'), false);
});

test('publication contract joins exact eight inventory assets with upload ids and latest.json', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-publication-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rolesByTarget = new Map([
    ['aarch64-apple-darwin', ['dmg', 'updater', 'updaterSignature']],
    ['x86_64-apple-darwin', ['dmg', 'updater', 'updaterSignature']],
    ['x86_64-pc-windows-msvc', ['updater', 'updaterSignature']],
  ]);
  const targets = [];
  let assetId = 300;
  for (const [target, roles] of rolesByTarget) {
    const artifacts = {};
    const assets = {};
    for (const role of roles) {
      const bytes = Buffer.from(`${target}:${role}`);
      const fileName = `${target}-${role}.bin`;
      const artifact = {
        fileName,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      artifacts[role] = artifact;
      assets[fileName] = { assetId, size: artifact.size, sha256: artifact.sha256 };
      assetId += 1;
    }
    targets.push({ platform: target, artifacts });
    await fs.writeFile(path.join(root, `draft-upload-${target}.json`), JSON.stringify({
      schemaVersion: 2,
      tag,
      target,
      runId,
      assets,
    }));
  }
  const inventoryPath = path.join(root, 'verified-release-inventory.json');
  await fs.writeFile(inventoryPath, JSON.stringify({ targets }));
  const latest = await metadata(root, 'latest.json', '{"version":"2.53.0"}\n', 'application/json');
  const latestReceiptPath = path.join(root, 'latest-upload-receipt.json');
  await fs.writeFile(latestReceiptPath, JSON.stringify({
    schemaVersion: 2,
    tag,
    target: 'latest',
    runId,
    assets: {
      'latest.json': { assetId, size: latest.size, sha256: latest.sha256 },
    },
  }));

  const expected = await loadExpectedReleaseAssets({
    inventoryPath,
    receiptsDir: root,
    latestReceiptPath,
    latestPath: latest.path,
    tag,
    runId,
  });
  assert.equal(expected.length, 9);
  assert.equal(new Set(expected.map(({ assetId: id }) => id)).size, 9);
  assert.equal(expected.filter(({ fileName }) => fileName === 'latest.json').length, 1);

  const staleTarget = 'aarch64-apple-darwin';
  const staleReceiptPath = path.join(root, `draft-upload-${staleTarget}.json`);
  const staleReceipt = JSON.parse(await fs.readFile(staleReceiptPath, 'utf8'));
  await fs.writeFile(staleReceiptPath, JSON.stringify({ ...staleReceipt, runId: '987654321' }));
  await assert.rejects(
    loadExpectedReleaseAssets({
      inventoryPath,
      receiptsDir: root,
      latestReceiptPath,
      latestPath: latest.path,
      tag,
      runId,
    }),
    /does not bind the current run/u,
  );
});

test('publication rechecks exact draft and has no unpublish transition', async () => {
  const contract = publicationContract();
  const api = fakeGitHub({ initialRelease: releaseFixture({ assets: contract.assets }) });
  const result = await publishDraftGithubRelease({
    client: clientFor(api),
    desiredDraft: false,
    expectedAssets: contract.expectedAssets,
    requireImmutableReleasePolicy: immutablePolicyFor(api),
  });
  assert.deepEqual(result, { state: 'published', releaseId: 42 });
  const patch = api.requests.find(({ method }) => method === 'PATCH');
  assert.ok(patch);
  assertExactReadImmediatelyBefore(api.requests, patch);
  const immutableRead = api.requests.find(({ path: requestPath }) => (
    requestPath === `/repos/${repository}/immutable-releases`
  ));
  assert.ok(immutableRead);
  assert.deepEqual(
    api.requests.slice(api.requests.indexOf(immutableRead), api.requests.indexOf(patch))
      .map(({ method, path: requestPath }) => ({ method, path: requestPath })),
    [
      { method: 'GET', path: `/repos/${repository}/immutable-releases` },
      { method: 'GET', path: `/repos/${repository}/releases` },
      { method: 'GET', path: exactReleasePath },
    ],
  );
  const tagReads = api.requests.filter(({ method, path: requestPath }) => (
    method === 'GET' && requestPath === exactCommitPath
  ));
  assert.equal(tagReads.length, 2);
  assert.ok(api.requests.indexOf(tagReads[0]) < api.requests.indexOf(patch));
  assert.deepEqual(
    { method: api.requests.at(-1).method, path: api.requests.at(-1).path },
    { method: 'GET', path: exactCommitPath },
  );

  const changedPatchAssets = contract.assets.map((asset, index) => (
    index === 0 ? { ...asset, id: 999 } : asset
  ));
  const changedPatchApi = fakeGitHub({
    initialRelease: releaseFixture({ assets: contract.assets }),
    patchResponseOverride: { assets: changedPatchAssets },
  });
  await assert.rejects(publishDraftGithubRelease({
    client: clientFor(changedPatchApi),
    desiredDraft: false,
    expectedAssets: contract.expectedAssets,
    requireImmutableReleasePolicy: immutablePolicyFor(changedPatchApi),
  }), /asset identity changed before publication/u);

  const nonImmutableApi = fakeGitHub({
    initialRelease: releaseFixture({ assets: contract.assets }),
    patchResponseOverride: { immutable: false },
  });
  await assert.rejects(publishDraftGithubRelease({
    client: clientFor(nonImmutableApi),
    desiredDraft: false,
    expectedAssets: contract.expectedAssets,
    requireImmutableReleasePolicy: immutablePolicyFor(nonImmutableApi),
  }), /did not preserve the exact immutable published release/u);

  const changedExactApi = fakeGitHub({
    initialRelease: releaseFixture({ assets: contract.assets }),
    postPublishExactOverride: { assets: changedPatchAssets },
  });
  await assert.rejects(publishDraftGithubRelease({
    client: clientFor(changedExactApi),
    desiredDraft: false,
    expectedAssets: contract.expectedAssets,
    requireImmutableReleasePolicy: immutablePolicyFor(changedExactApi),
  }), /asset identity changed before publication/u);

  const changedSourceApi = fakeGitHub({
    initialRelease: releaseFixture({ assets: contract.assets }),
    patchResponseOverride: { body: releaseOwnerMarker(runId) },
  });
  await assert.rejects(publishDraftGithubRelease({
    client: clientFor(changedSourceApi),
    desiredDraft: false,
    expectedAssets: contract.expectedAssets,
    requireImmutableReleasePolicy: immutablePolicyFor(changedSourceApi),
  }), /has no unique source marker/u);

  const movedTagApi = fakeGitHub({
    initialRelease: releaseFixture({ assets: contract.assets }),
    tagCommitSha: 'b'.repeat(40),
  });
  await assert.rejects(publishDraftGithubRelease({
    client: clientFor(movedTagApi),
    desiredDraft: false,
    expectedAssets: contract.expectedAssets,
    requireImmutableReleasePolicy: immutablePolicyFor(movedTagApi),
  }), /no longer resolves to the expected source commit/u);
  assert.equal(movedTagApi.requests.some(({ method }) => method === 'PATCH'), false);

  const keepDraftApi = fakeGitHub({ initialRelease: releaseFixture({ assets: contract.assets }) });
  let draftPolicyCalled = false;
  assert.deepEqual(
    await publishDraftGithubRelease({
      client: clientFor(keepDraftApi),
      desiredDraft: true,
      expectedAssets: contract.expectedAssets,
      requireImmutableReleasePolicy: async () => {
        draftPolicyCalled = true;
      },
    }),
    { state: 'draft', releaseId: 42 },
  );
  assert.equal(draftPolicyCalled, false);
  assert.equal(keepDraftApi.requests.some(({ method }) => method === 'PATCH'), false);

  const noAdminTokenApi = fakeGitHub({
    initialRelease: releaseFixture({ assets: contract.assets }),
  });
  assert.deepEqual(
    await publishDraftGithubRelease({
      client: clientFor(noAdminTokenApi),
      desiredDraft: false,
      expectedAssets: contract.expectedAssets,
    }),
    { state: 'published', releaseId: 42 },
  );
  assert.equal(noAdminTokenApi.requests.some(({ method }) => method === 'PATCH'), true);

  const disabledPolicyApi = fakeGitHub({
    initialRelease: releaseFixture({ assets: contract.assets }),
  });
  await assert.rejects(
    publishDraftGithubRelease({
      client: clientFor(disabledPolicyApi),
      desiredDraft: false,
      expectedAssets: contract.expectedAssets,
      requireImmutableReleasePolicy: immutablePolicyFor(disabledPolicyApi, { enabled: false }),
    }),
    /did not return enabled:true/u,
  );
  assert.equal(disabledPolicyApi.requests.some(({ method }) => method === 'PATCH'), false);

  const publishedApi = fakeGitHub({
    initialRelease: releaseFixture({ draft: false, assets: contract.assets }),
  });
  await assert.rejects(
    publishDraftGithubRelease({
      client: clientFor(publishedApi),
      desiredDraft: false,
      expectedAssets: contract.expectedAssets,
      requireImmutableReleasePolicy: immutablePolicyFor(publishedApi),
    }),
    /already published; refusing to unpublish or mutate it/u,
  );
  assert.equal(publishedApi.requests.some(({ method }) => method === 'PATCH'), false);

  const changedApi = fakeGitHub({
    initialRelease: releaseFixture({ assets: contract.assets.map((asset, index) => (
      index === 0 ? { ...asset, id: 999 } : asset
    )) }),
  });
  await assert.rejects(
    publishDraftGithubRelease({
      client: clientFor(changedApi),
      desiredDraft: false,
      expectedAssets: contract.expectedAssets,
      requireImmutableReleasePolicy: immutablePolicyFor(changedApi),
    }),
    /asset identity changed before publication/u,
  );
  assert.equal(changedApi.requests.some(({ method }) => method === 'PATCH'), false);

  const replacedReleaseApi = fakeGitHub({
    initialRelease: releaseFixture({ id: 43, assets: contract.assets }),
  });
  await assert.rejects(
    publishDraftGithubRelease({
      client: clientFor(replacedReleaseApi),
      desiredDraft: false,
      expectedAssets: contract.expectedAssets,
      requireImmutableReleasePolicy: immutablePolicyFor(replacedReleaseApi),
    }),
    /draft release id changed after preparation/u,
  );
  assert.equal(replacedReleaseApi.requests.some(({ method }) => method === 'PATCH'), false);
});

test('publication recovers when GitHub commits the exact immutable release before a client error', async () => {
  const contract = publicationContract();
  const api = fakeGitHub({ initialRelease: releaseFixture({ assets: contract.assets }) });
  let patchAttempts = 0;
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if ((options.method ?? 'GET') === 'PATCH' && url.pathname === exactReleasePath) {
      patchAttempts += 1;
      const committed = await api.fetchImpl(rawUrl, options);
      assert.equal(committed.status, 200);
      throw new TypeError('fixture socket closed after publication');
    }
    return api.fetchImpl(rawUrl, options);
  };

  const result = await publishDraftGithubRelease({
    client: clientFor({ ...api, fetchImpl }, { sleepImpl: async () => {} }),
    desiredDraft: false,
    expectedAssets: contract.expectedAssets,
    requireImmutableReleasePolicy: immutablePolicyFor(api),
  });

  assert.deepEqual(result, { state: 'published', releaseId: 42 });
  assert.equal(patchAttempts, 1);
  assert.equal(api.release().draft, false);
  assert.equal(api.release().immutable, true);
  assert.equal(api.requests.some(({ method }) => method === 'DELETE'), false);
});

test('publication retries only after an exact draft reread and remains bounded', async () => {
  const contract = publicationContract();
  const api = fakeGitHub({ initialRelease: releaseFixture({ assets: contract.assets }) });
  let patchAttempts = 0;
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if ((options.method ?? 'GET') === 'PATCH' && url.pathname === exactReleasePath) {
      patchAttempts += 1;
      if (patchAttempts < 3) return response(503, { message: 'fixture unavailable' });
    }
    return api.fetchImpl(rawUrl, options);
  };

  assert.deepEqual(await publishDraftGithubRelease({
    client: clientFor({ ...api, fetchImpl }, { sleepImpl: async () => {} }),
    desiredDraft: false,
    expectedAssets: contract.expectedAssets,
    requireImmutableReleasePolicy: immutablePolicyFor(api),
  }), { state: 'published', releaseId: 42 });
  assert.equal(patchAttempts, 3);

  const unavailableApi = fakeGitHub({ initialRelease: releaseFixture({ assets: contract.assets }) });
  let exhaustedAttempts = 0;
  await assert.rejects(publishDraftGithubRelease({
    client: clientFor({
      ...unavailableApi,
      fetchImpl: async (rawUrl, options = {}) => {
        const url = new URL(rawUrl);
        if ((options.method ?? 'GET') === 'PATCH' && url.pathname === exactReleasePath) {
          exhaustedAttempts += 1;
          return response(503, { message: 'fixture unavailable' });
        }
        return unavailableApi.fetchImpl(rawUrl, options);
      },
    }, { sleepImpl: async () => {} }),
    desiredDraft: false,
    expectedAssets: contract.expectedAssets,
    requireImmutableReleasePolicy: immutablePolicyFor(unavailableApi),
  }), /PATCH request failed \(503\)/u);
  assert.equal(exhaustedAttempts, 4);
  assert.equal(unavailableApi.release().draft, true);
});

test('publication reconciles a non-transient retry response after an earlier ambiguous failure', async () => {
  const contract = publicationContract();
  const api = fakeGitHub({ initialRelease: releaseFixture({ assets: contract.assets }) });
  let patchAttempts = 0;
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if ((options.method ?? 'GET') === 'PATCH' && url.pathname === exactReleasePath) {
      patchAttempts += 1;
      if (patchAttempts === 1) return response(503, { message: 'fixture unavailable' });
      const committed = await api.fetchImpl(rawUrl, options);
      assert.equal(committed.status, 200);
      return response(422, { message: 'already published' });
    }
    return api.fetchImpl(rawUrl, options);
  };

  assert.deepEqual(await publishDraftGithubRelease({
    client: clientFor({ ...api, fetchImpl }, { sleepImpl: async () => {} }),
    desiredDraft: false,
    expectedAssets: contract.expectedAssets,
    requireImmutableReleasePolicy: immutablePolicyFor(api),
  }), { state: 'published', releaseId: 42 });
  assert.equal(patchAttempts, 2);
  assert.equal(api.release().immutable, true);
});

test('ambiguous publication fails closed when the recovered immutable release drifts', async () => {
  const contract = publicationContract();
  const changedAssets = contract.assets.map((asset, index) => (
    index === 0 ? { ...asset, digest: `sha256:${'f'.repeat(64)}` } : asset
  ));
  const api = fakeGitHub({
    initialRelease: releaseFixture({ assets: contract.assets }),
    postPublishExactOverride: { assets: changedAssets },
  });
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if ((options.method ?? 'GET') === 'PATCH' && url.pathname === exactReleasePath) {
      const committed = await api.fetchImpl(rawUrl, options);
      assert.equal(committed.status, 200);
      throw new TypeError('fixture socket closed after publication');
    }
    return api.fetchImpl(rawUrl, options);
  };

  await assert.rejects(publishDraftGithubRelease({
    client: clientFor({ ...api, fetchImpl }, { sleepImpl: async () => {} }),
    desiredDraft: false,
    expectedAssets: contract.expectedAssets,
    requireImmutableReleasePolicy: immutablePolicyFor(api),
  }), /asset identity changed before publication/u);
  assert.equal(api.requests.some(({ method }) => method === 'DELETE'), false);
});

test('dedicated preparation creates once and locks the exact draft id', async () => {
  const api = fakeGitHub({ initialRelease: null });
  const result = await ensureDraftGithubRelease({
    repository,
    tag,
    token: 'fixture-token',
    name: 'CCEM v2.53.0',
    body: 'fixture notes',
    commitish: 'a'.repeat(40),
    prerelease: false,
    runId,
    fetchImpl: api.fetchImpl,
  });
  assert.deepEqual(result, {
    state: 'draft', releaseId: 42, releaseOwnerRunId: runId, created: true, recovered: false,
  });
  const create = api.requests.find(({ method, path: requestPath }) => (
    method === 'POST' && requestPath === `/repos/${repository}/releases`
  ));
  assert.ok(create);
  assert.equal(api.requests.at(-1).method, 'GET');
  assert.equal(api.requests.at(-1).path, exactReleasePath);
  assert.equal(api.release().draft, true);
  assert.match(api.release().body, new RegExp(releaseOwnerMarker(runId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(api.release().body, new RegExp(releaseSourceMarker('a'.repeat(40)).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('draft creation recovers when the server committed before the client error', async () => {
  const api = fakeGitHub({ initialRelease: null });
  let createAttempts = 0;
  const fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    if ((options?.method ?? 'GET') === 'POST'
      && url.pathname === `/repos/${repository}/releases`) {
      createAttempts += 1;
      const committed = await api.fetchImpl(rawUrl, options);
      assert.equal(committed.status, 201);
      throw new TypeError('fixture socket closed after create');
    }
    return api.fetchImpl(rawUrl, options);
  };

  assert.deepEqual(await ensureDraftGithubRelease({
    repository,
    tag,
    token: 'fixture-token',
    name: 'CCEM v2.53.0',
    body: 'fixture notes',
    commitish: sourceCommit,
    prerelease: false,
    runId,
    fetchImpl,
    sleepImpl: async () => {},
  }), {
    state: 'draft', releaseId: 42, releaseOwnerRunId: runId, created: false, recovered: false,
  });
  assert.equal(createAttempts, 1);
  assert.equal(api.release().assets.length, 0);
  assert.equal(api.requests.some(({ method }) => ['PATCH', 'DELETE'].includes(method)), false);
});

test('draft creation retries bounded transient 5xx after exact rediscovery stays missing', async () => {
  const api = fakeGitHub({ initialRelease: null });
  let createAttempts = 0;
  const fetchImpl = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    if ((options?.method ?? 'GET') === 'POST'
      && url.pathname === `/repos/${repository}/releases`) {
      createAttempts += 1;
      if (createAttempts < 3) return response(503, { message: 'fixture unavailable' });
    }
    return api.fetchImpl(rawUrl, options);
  };

  assert.deepEqual(await ensureDraftGithubRelease({
    repository,
    tag,
    token: 'fixture-token',
    name: 'CCEM v2.53.0',
    body: 'fixture notes',
    commitish: sourceCommit,
    prerelease: false,
    runId,
    fetchImpl,
    sleepImpl: async () => {},
  }), {
    state: 'draft', releaseId: 42, releaseOwnerRunId: runId, created: true, recovered: false,
  });
  assert.equal(createAttempts, 3);
  assert.equal(api.requests.some(({ method }) => ['PATCH', 'DELETE'].includes(method)), false);

  let exhaustedAttempts = 0;
  const unavailableApi = fakeGitHub({ initialRelease: null });
  await assert.rejects(ensureDraftGithubRelease({
    repository,
    tag,
    token: 'fixture-token',
    name: 'CCEM v2.53.0',
    body: 'fixture notes',
    commitish: sourceCommit,
    prerelease: false,
    runId,
    fetchImpl: async (rawUrl, options) => {
      const url = new URL(rawUrl);
      if ((options?.method ?? 'GET') === 'POST'
        && url.pathname === `/repos/${repository}/releases`) {
        exhaustedAttempts += 1;
        return response(500, { message: 'fixture unavailable' });
      }
      return unavailableApi.fetchImpl(rawUrl, options);
    },
    sleepImpl: async () => {},
  }), /POST request failed \(500\)/u);
  assert.equal(exhaustedAttempts, 4);
});

test('draft ownership is stable across rerun attempts and fails closed across run ids', async () => {
  const sourceCommit = 'a'.repeat(40);
  const owned = releaseFixture({
    body: `fixture notes\n\n${releaseOwnerMarker(runId)}\n${releaseSourceMarker(sourceCommit)}`,
  });
  const sameRunApi = fakeGitHub({ initialRelease: owned });
  assert.deepEqual(await ensureDraftGithubRelease({
    repository,
    tag,
    token: 'fixture-token',
    name: 'CCEM v2.53.0',
    body: 'fixture notes',
    commitish: sourceCommit,
    prerelease: false,
    runId,
    fetchImpl: sameRunApi.fetchImpl,
  }), {
    state: 'draft', releaseId: 42, releaseOwnerRunId: runId, created: false, recovered: false,
  });
  assert.equal(sameRunApi.requests.some(({ method }) => ['POST', 'PATCH', 'DELETE'].includes(method)), false);

  const otherRunId = '987654321';
  const crossRunApi = fakeGitHub({ initialRelease: owned });
  await assert.rejects(ensureDraftGithubRelease({
    repository,
    tag,
    token: 'fixture-token',
    name: 'CCEM v2.53.0',
    body: 'fixture notes',
    commitish: sourceCommit,
    prerelease: false,
    runId: otherRunId,
    fetchImpl: crossRunApi.fetchImpl,
  }), /owned by GitHub Actions run 123456789/u);
  assert.equal(crossRunApi.requests.some(({ method }) => ['POST', 'PATCH', 'DELETE'].includes(method)), false);

  const unownedApi = fakeGitHub({ initialRelease: releaseFixture({ body: 'legacy draft' }) });
  await assert.rejects(ensureDraftGithubRelease({
    repository,
    tag,
    token: 'fixture-token',
    name: 'CCEM v2.53.0',
    body: 'fixture notes',
    commitish: 'a'.repeat(40),
    prerelease: false,
    runId,
    fetchImpl: unownedApi.fetchImpl,
  }), /has no unique owner run marker/u);
});

test('explicit recovery resumes only a marked unpublished draft for the same source without deletion', async () => {
  const sourceCommit = 'a'.repeat(40);
  const oldRunId = '987654321';
  const owned = releaseFixture({
    body: `fixture notes\n\n${releaseOwnerMarker(oldRunId)}\n${releaseSourceMarker(sourceCommit)}`,
    assets: [{ id: 88, name: 'partial.dmg', size: 7, digest: `sha256:${'b'.repeat(64)}` }],
  });
  const api = fakeGitHub({ initialRelease: owned });
  const result = await ensureDraftGithubRelease({
    repository,
    tag,
    token: 'fixture-token',
    name: 'CCEM v2.53.0',
    body: 'fresh notes',
    commitish: sourceCommit,
    prerelease: false,
    runId,
    allowStaleDraftRecovery: true,
    fetchImpl: api.fetchImpl,
  });
  assert.deepEqual(result, {
    state: 'draft', releaseId: 42, releaseOwnerRunId: oldRunId, created: false, recovered: true,
  });
  assert.equal(api.requests.some(({ method }) => ['DELETE', 'POST', 'PATCH'].includes(method)), false);
  assert.equal(api.release().assets.length, 1);
  assert.match(api.release().body, new RegExp(releaseOwnerMarker(oldRunId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(api.release().body, new RegExp(releaseSourceMarker(sourceCommit).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

  const mismatched = fakeGitHub({ initialRelease: releaseFixture({
    body: `fixture notes\n\n${releaseOwnerMarker(oldRunId)}\n${releaseSourceMarker('b'.repeat(40))}`,
  }) });
  await assert.rejects(ensureDraftGithubRelease({
    repository,
    tag,
    token: 'fixture-token',
    name: 'CCEM v2.53.0',
    body: 'fresh notes',
    commitish: sourceCommit,
    prerelease: false,
    runId,
    allowStaleDraftRecovery: true,
    fetchImpl: mismatched.fetchImpl,
  }), /source marker does not match/u);
  assert.equal(mismatched.requests.some(({ method }) => method === 'DELETE'), false);

  const unmarked = fakeGitHub({ initialRelease: releaseFixture({ body: 'legacy draft' }) });
  await assert.rejects(ensureDraftGithubRelease({
    repository,
    tag,
    token: 'fixture-token',
    name: 'CCEM v2.53.0',
    body: 'fresh notes',
    commitish: sourceCommit,
    prerelease: false,
    runId,
    allowStaleDraftRecovery: true,
    fetchImpl: unmarked.fetchImpl,
  }), /requires unique CCEM owner and source markers/u);
  assert.equal(unmarked.requests.some(({ method }) => method === 'DELETE'), false);
});

test('same-run payload lookup reuses only one live stable run-id artifact', async () => {
  const target = 'aarch64-apple-darwin';
  const artifactName = `mode2-release-payload-${runId}-${target}`;
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return response(200, {
      artifacts: [{ id: 77, name: artifactName, expired: false }],
    });
  };
  assert.deepEqual(await detectActionsReleasePayload({
    repository,
    runId,
    target,
    token: 'fixture-token',
    fetchImpl,
  }), {
    repository,
    runId,
    target,
    artifactName,
    artifactId: 77,
    reuse: true,
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0], new RegExp(`/actions/runs/${runId}/artifacts\\?`, 'u'));
  assert.equal(urls[0].includes('run_attempt'), false);

  await assert.rejects(detectActionsReleasePayload({
    repository,
    runId,
    target,
    token: 'fixture-token',
    fetchImpl: async () => response(200, {
      artifacts: [
        { id: 77, name: artifactName, expired: false },
        { id: 78, name: artifactName, expired: false },
      ],
    }),
  }), /duplicate immutable payload artifacts/u);
});
