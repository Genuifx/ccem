import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

const API_ORIGIN = 'https://api.github.com';
const UPLOAD_ORIGIN = 'https://uploads.github.com';
const MAX_RELEASE_PAGES = 100;
const MAX_TRANSIENT_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1_000;

function fail(message) {
  throw new Error(`[github-draft-release-api] ${message}`);
}

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is required`);
  return value.trim();
}

function validateRepository(value) {
  const repository = required(value, 'GitHub repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail('GitHub repository must be an exact owner/name pair');
  }
  return repository;
}

function validateTag(value) {
  const tag = required(value, 'release tag');
  if (tag.length > 255 || /[\u0000-\u001f\u007f]/u.test(tag)) fail('release tag is invalid');
  return tag;
}

function validateExpectedReleaseId(value) {
  if (value == null || value === '') return null;
  const id = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || (typeof value === 'string' && !/^[1-9][0-9]*$/u.test(value))) {
    fail('expected GitHub release id must be a positive safe integer');
  }
  return id;
}

function validateRunId(value, label = 'GitHub Actions owner run id') {
  if (value == null || value === '') return null;
  const runId = typeof value === 'number' ? String(value) : value;
  if (typeof runId !== 'string' || !/^[1-9][0-9]*$/u.test(runId)) fail(`${label} must be a positive decimal string`);
  return runId;
}

function validateSourceCommit(value) {
  const sourceCommit = required(value, 'release source commit');
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    fail('release source commit must be a lowercase 40-character SHA');
  }
  return sourceCommit;
}

function validateOptionalSourceCommit(value) {
  return value == null || value === '' ? null : validateSourceCommit(value);
}

export function releaseOwnerMarker(runId) {
  const exactRunId = validateRunId(runId);
  if (exactRunId == null) fail('GitHub Actions owner run id is required');
  return `<!-- ccem-release-owner-run: ${exactRunId} -->`;
}

export function releaseOwnerRunId(body) {
  const matches = [...String(body ?? '').matchAll(/<!-- ccem-release-owner-run: ([1-9][0-9]*) -->/gu)];
  if (matches.length !== 1) return null;
  return matches[0][1];
}

export function releaseSourceMarker(sourceCommit) {
  return `<!-- ccem-release-source: ${validateSourceCommit(sourceCommit)} -->`;
}

export function releaseSourceCommit(body) {
  const matches = [...String(body ?? '').matchAll(/<!-- ccem-release-source: ([a-f0-9]{40}) -->/gu)];
  if (matches.length !== 1) return null;
  return matches[0][1];
}

function safeErrorDetail(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 500);
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function requestError(method, status, detail, cause) {
  const error = new Error(
    `[github-draft-release-api] ${method} request failed (${status}): ${safeErrorDetail(detail)}`,
    cause === undefined ? undefined : { cause },
  );
  error.status = status === 'network' ? undefined : status;
  error.transient = status === 'network'
    || status === 408
    || status === 429
    || (Number.isInteger(status) && status >= 500 && status <= 599);
  return error;
}

export function isTransientGitHubError(error) {
  return error?.transient === true
    || error?.status === 408
    || error?.status === 429
    || (Number.isInteger(error?.status) && error.status >= 500 && error.status <= 599);
}

function exactAssetPath(repository, releaseId) {
  return `/repos/${repository}/releases/${releaseId}/assets`;
}

function releaseAssetIdentity(assets) {
  if (!Array.isArray(assets)) fail('release has an invalid asset inventory');
  return assets.map((asset) => ({
    id: asset?.id,
    name: asset?.name,
    size: asset?.size,
    digest: asset?.digest,
    state: asset?.state,
  })).sort((left, right) => {
    if (left.id !== right.id) return Number(left.id) - Number(right.id);
    return String(left.name).localeCompare(String(right.name));
  });
}

export class DraftReleaseClient {
  constructor({
    repository,
    tag,
    token,
    expectedReleaseId,
    expectedOwnerRunId,
    expectedSourceCommit,
    fetchImpl = globalThis.fetch,
    sleepImpl = defaultSleep,
  }) {
    this.repository = validateRepository(repository);
    this.tag = validateTag(tag);
    this.token = required(token, 'GitHub token');
    this.expectedReleaseId = validateExpectedReleaseId(expectedReleaseId);
    this.expectedOwnerRunId = validateRunId(expectedOwnerRunId);
    this.expectedSourceCommit = validateOptionalSourceCommit(expectedSourceCommit);
    if (typeof fetchImpl !== 'function') fail('fetch implementation is unavailable');
    if (typeof sleepImpl !== 'function') fail('sleep implementation is unavailable');
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
  }

  async waitBeforeRetry(attempt) {
    if (!Number.isInteger(attempt) || attempt < 1 || attempt >= MAX_TRANSIENT_ATTEMPTS) {
      fail('retry attempt is outside the bounded retry contract');
    }
    await this.sleepImpl(RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
  }

  validateOwner(release) {
    if (this.expectedOwnerRunId == null) return;
    const ownerRunId = releaseOwnerRunId(release?.body);
    if (ownerRunId == null) {
      fail(`existing draft ${this.tag} has no unique owner run marker; refusing to claim it; rerun the workflow run that originally created it`);
    }
    if (ownerRunId !== this.expectedOwnerRunId) {
      fail(
        `draft/assets for ${this.tag} are owned by GitHub Actions run ${ownerRunId}; `
        + `rerun owning run https://github.com/${this.repository}/actions/runs/${ownerRunId}`,
      );
    }
  }

  validateSource(release) {
    if (this.expectedSourceCommit == null) return;
    const sourceCommit = releaseSourceCommit(release?.body);
    if (sourceCommit == null) {
      fail(`release ${this.tag} has no unique source marker`);
    }
    if (sourceCommit !== this.expectedSourceCommit) {
      fail(`release ${this.tag} source marker changed from the expected commit`);
    }
  }

  validateMarkers(release) {
    this.validateOwner(release);
    this.validateSource(release);
  }

  async request(url, { method = 'GET', headers = {}, body } = {}) {
    const options = {
      method,
      redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...headers,
      },
    };
    if (body !== undefined) {
      options.body = body;
      if (!Buffer.isBuffer(body) && typeof body !== 'string') options.duplex = 'half';
    }
    const safeToRetry = method === 'GET' && body === undefined;
    let response;
    for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
      try {
        response = await this.fetchImpl(url, options);
      } catch (cause) {
        const error = requestError(method, 'network', cause?.message ?? cause, cause);
        if (!safeToRetry || attempt === MAX_TRANSIENT_ATTEMPTS) throw error;
        await this.waitBeforeRetry(attempt);
        continue;
      }
      if (!response?.ok) {
        let detail = '';
        try {
          detail = typeof response?.text === 'function' ? await response.text() : '';
        } catch (cause) {
          const error = requestError(method, 'network', cause?.message ?? cause, cause);
          if (!safeToRetry || attempt === MAX_TRANSIENT_ATTEMPTS) throw error;
          await this.waitBeforeRetry(attempt);
          continue;
        }
        const error = requestError(method, response?.status ?? 'unknown', detail);
        if (!safeToRetry || !isTransientGitHubError(error) || attempt === MAX_TRANSIENT_ATTEMPTS) {
          throw error;
        }
        await this.waitBeforeRetry(attempt);
        continue;
      }
      break;
    }
    if (!response?.ok) fail(`${method} request exhausted without a successful response`);
    if (response.status === 204) return null;
    const result = await response.json();
    if (!result || typeof result !== 'object') fail(`${method} request returned invalid JSON`);
    return result;
  }

  async findExactRelease() {
    let matched = null;
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      const url = `${API_ORIGIN}/repos/${this.repository}/releases?per_page=100&page=${page}`;
      const releases = await this.request(url);
      if (!Array.isArray(releases)) fail(`GitHub release page ${page} did not return an array`);
      for (const release of releases) {
        if (release?.tag_name !== this.tag) continue;
        if (matched) fail(`duplicate releases exist for tag ${this.tag}`);
        matched = release;
      }
      if (releases.length < 100) break;
      if (page === MAX_RELEASE_PAGES) fail('release pagination exceeded the strict 10,000-item bound');
    }
    return matched;
  }

  async requireDraft({ allowMissing = false } = {}) {
    const listed = await this.findExactRelease();
    if (!listed) {
      if (allowMissing) return null;
      fail(`draft release not found for ${this.tag}`);
    }
    if (!Number.isSafeInteger(listed.id) || listed.id <= 0) fail('listed release has an invalid id');
    if (this.expectedReleaseId != null && listed.id !== this.expectedReleaseId) {
      fail(`draft release id changed after preparation for ${this.tag}`);
    }
    // Resolve the list match through the exact release-id endpoint. Every
    // caller uses this as its last read before a mutation, binding id + tag.
    const release = await this.request(
      `${API_ORIGIN}/repos/${this.repository}/releases/${listed.id}`,
    );
    if (
      release.id !== listed.id
      || (this.expectedReleaseId != null && release.id !== this.expectedReleaseId)
      || release.tag_name !== this.tag
    ) {
      fail('exact release id no longer binds the requested tag');
    }
    if (typeof release.draft !== 'boolean') fail(`release ${this.tag} returned an invalid draft state`);
    if (!release.draft) {
      fail(`release ${this.tag} is already published; refusing to unpublish or mutate it`);
    }
    if (!Array.isArray(release.assets)) fail('draft release has an invalid asset inventory');
    this.validateMarkers(release);
    return release;
  }

  async createDraft({ name, body, commitish, prerelease }) {
    if (this.expectedOwnerRunId != null && releaseOwnerRunId(body) !== this.expectedOwnerRunId) {
      fail('draft release body must contain the exact current-run owner marker');
    }
    const payload = {
      tag_name: this.tag,
      name: required(name, 'release name'),
      body: typeof body === 'string' ? body : '',
      target_commitish: required(commitish, 'release source commit'),
      draft: true,
      prerelease: prerelease === true,
    };
    const release = await this.request(`${API_ORIGIN}/repos/${this.repository}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (release.tag_name !== this.tag || release.draft !== true) {
      fail('created release did not preserve the exact draft tag contract');
    }
    return release;
  }

  uploadUrl(release, fileName) {
    const template = required(release.upload_url, 'draft release upload URL').replace(/\{.*$/u, '');
    const url = new URL(template);
    if (
      url.origin !== UPLOAD_ORIGIN
      || url.username
      || url.password
      || url.pathname !== exactAssetPath(this.repository, release.id)
      || url.search
      || url.hash
    ) {
      fail('draft release upload URL does not match the official GitHub asset endpoint');
    }
    url.searchParams.set('name', fileName);
    return url.href;
  }

  async uploadAsset(release, candidate) {
    return this.request(this.uploadUrl(release, candidate.fileName), {
      method: 'POST',
      headers: {
        'Content-Length': String(candidate.size),
        'Content-Type': candidate.contentType,
      },
      body: createReadStream(candidate.path),
    });
  }

  async downloadAssetFingerprint(asset) {
    if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) fail('release asset has an invalid id');
    const url = `${API_ORIGIN}/repos/${this.repository}/releases/assets/${asset.id}`;
    const options = {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: 'application/octet-stream',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };
    let response;
    for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
      try {
        response = await this.fetchImpl(url, options);
      } catch (cause) {
        const error = requestError('GET', 'network', cause?.message ?? cause, cause);
        if (attempt === MAX_TRANSIENT_ATTEMPTS) throw error;
        await this.waitBeforeRetry(attempt);
        continue;
      }
      if (!response?.ok) {
        const detail = typeof response?.text === 'function' ? await response.text() : '';
        const error = requestError('GET', response?.status ?? 'unknown', detail);
        if (!isTransientGitHubError(error) || attempt === MAX_TRANSIENT_ATTEMPTS) throw error;
        await this.waitBeforeRetry(attempt);
        continue;
      }
      break;
    }
    if (!response?.ok) fail('asset byte verification exhausted without a successful response');
    if (typeof response.arrayBuffer !== 'function') fail('asset byte verification returned an invalid body');
    const bytes = Buffer.from(await response.arrayBuffer());
    return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async publish(release) {
    if (
      !Number.isSafeInteger(release?.id)
      || release.id <= 0
      || (this.expectedReleaseId != null && release.id !== this.expectedReleaseId)
      || release.tag_name !== this.tag
    ) {
      fail('cannot publish a release that is not bound to the exact draft id and tag');
    }
    const exactUrl = `${API_ORIGIN}/repos/${this.repository}/releases/${release.id}`;
    let published;
    for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
      try {
        published = await this.request(exactUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft: false }),
        });
        break;
      } catch (error) {
        if (!isTransientGitHubError(error)) throw error;
        const observed = await this.request(exactUrl);
        if (observed?.draft === false) {
          this.validatePublishedIdentity(observed, release.id, 'ambiguous publication recovery');
          return { published: observed, confirmed: observed };
        }
        this.validateDraftRetryIdentity(observed, release);
        if (attempt === MAX_TRANSIENT_ATTEMPTS) throw error;
        await this.waitBeforeRetry(attempt);
      }
    }
    if (!published) fail('publication retry exhausted without a response');
    this.validatePublishedIdentity(published, release.id, 'publication response');
    const confirmed = await this.request(exactUrl);
    this.validatePublishedIdentity(confirmed, release.id, 'post-publication exact release');
    return { published, confirmed };
  }

  validateDraftRetryIdentity(observed, original) {
    if (
      observed?.id !== original.id
      || (this.expectedReleaseId != null && observed.id !== this.expectedReleaseId)
      || observed.tag_name !== this.tag
      || observed.draft !== true
      || observed.immutable === true
    ) {
      fail('publication retry did not preserve the exact mutable draft');
    }
    this.validateMarkers(observed);
    const before = releaseAssetIdentity(original.assets);
    const after = releaseAssetIdentity(observed.assets);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail('draft asset identity changed before publication retry');
    }
  }

  validatePublishedIdentity(release, releaseId, label) {
    if (
      release?.id !== releaseId
      || (this.expectedReleaseId != null && release.id !== this.expectedReleaseId)
      || release.tag_name !== this.tag
      || release.draft !== false
      || release.immutable !== true
      || !Array.isArray(release.assets)
    ) {
      fail(`${label} did not preserve the exact immutable published release`);
    }
    this.validateMarkers(release);
  }

  async requireExpectedTagCommit() {
    if (this.expectedSourceCommit == null) fail('expected release source commit is required');
    const commit = await this.request(
      `${API_ORIGIN}/repos/${this.repository}/commits/${encodeURIComponent(this.tag)}`,
    );
    if (commit.sha !== this.expectedSourceCommit) {
      fail(`release tag ${this.tag} no longer resolves to the expected source commit`);
    }
    return commit;
  }
}

export function exactAssetsNamed(release, fileName) {
  return release.assets.filter((asset) => asset?.name === fileName);
}
