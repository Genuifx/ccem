import test from 'node:test';
import assert from 'node:assert/strict';

import {
  githubRefPatternMatches,
  verifyReleaseRepositorySettings,
} from './check-release-repository-settings.mjs';

const repository = 'Genuifx/ccem';
const token = 'github_pat_fixture_settings_token';
const candidateTag = 'v2.78.1';

function response(status, body, { link = null, invalidJson = false } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return name.toLowerCase() === 'link' ? link : null;
      },
    },
    async json() {
      if (invalidJson) throw new SyntaxError('fixture invalid JSON');
      return body;
    },
  };
}

function branchRuleset(overrides = {}) {
  return {
    id: 101,
    name: 'protect main',
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: {
        include: ['refs/heads/main'],
        exclude: [],
      },
    },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
    ...overrides,
  };
}

function tagRuleset(overrides = {}) {
  return {
    id: 202,
    name: 'protect releases',
    target: 'tag',
    enforcement: 'active',
    conditions: {
      ref_name: {
        include: ['refs/tags/v*'],
        exclude: [],
      },
    },
    rules: [{ type: 'deletion' }, { type: 'update' }],
    ...overrides,
  };
}

function fixtureFetch({
  branch = branchRuleset(),
  tag = tagRuleset(),
  summaries = null,
} = {}) {
  const requests = [];
  const details = new Map(
    [branch, tag].filter(Boolean).map((ruleset) => [ruleset.id, ruleset]),
  );
  const list = summaries ?? [...details.values()].map(({ id, name, enforcement }) => ({
    id,
    name,
    enforcement,
  }));
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const parsed = new URL(url);
    if (parsed.pathname === `/repos/${repository}/rulesets`) return response(200, list);
    const detailMatch = parsed.pathname.match(new RegExp(`^/repos/${repository}/rulesets/([0-9]+)$`, 'u'));
    if (detailMatch) {
      const detail = details.get(Number(detailMatch[1]));
      return detail ? response(200, detail) : response(404, { message: 'Not Found' });
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  };
  return { fetchImpl, requests };
}

async function verify(overrides = {}) {
  const fixture = fixtureFetch(overrides);
  const result = await verifyReleaseRepositorySettings({
    repository,
    token,
    candidateTag,
    fetchImpl: fixture.fetchImpl,
  });
  return { result, requests: fixture.requests };
}

test('happy path resolves full protected release ruleset details', async () => {
  const { result, requests } = await verify();
  assert.deepEqual(result, {
    repository,
    candidateTag,
    mainRef: 'refs/heads/main',
    candidateRef: `refs/tags/${candidateTag}`,
    branchRulesetId: 101,
    tagRulesetId: 202,
  });
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
    assert.equal(request.options.headers['X-GitHub-Api-Version'], '2026-03-10');
  }
  const list = new URL(requests[0].url);
  assert.equal(list.searchParams.get('includes_parents'), 'true');
  assert.equal(list.searchParams.get('per_page'), '100');
  assert.equal(list.searchParams.get('page'), '1');
  assert.equal(new URL(requests[1].url).searchParams.get('includes_parents'), 'true');
});

test('GitHub ref patterns cover release wildcards without crossing slash boundaries', () => {
  assert.equal(githubRefPatternMatches('refs/tags/v*', 'refs/tags/v2.78.1'), true);
  assert.equal(githubRefPatternMatches('refs/tags/v*', 'refs/tags/releases/v2.78.1'), false);
  assert.equal(githubRefPatternMatches('refs/tags/**', 'refs/tags/releases/v2.78.1'), true);
  assert.equal(githubRefPatternMatches('~DEFAULT_BRANCH', 'refs/heads/main'), true);
  assert.equal(githubRefPatternMatches('~ALL', 'refs/tags/v2.78.1'), true);
});

test('fails closed when no active branch ruleset covers main', async () => {
  const branch = branchRuleset({
    conditions: { ref_name: { include: ['refs/heads/develop'], exclude: [] } },
  });
  const fixture = fixtureFetch({ branch });
  await assert.rejects(
    verifyReleaseRepositorySettings({ repository, token, candidateTag, fetchImpl: fixture.fetchImpl }),
    /no active branch ruleset covers refs\/heads\/main/u,
  );
});

test('fails closed when no active tag ruleset covers the candidate', async () => {
  const tag = tagRuleset({
    conditions: { ref_name: { include: ['refs/tags/v3*'], exclude: [] } },
  });
  const fixture = fixtureFetch({ tag });
  await assert.rejects(
    verifyReleaseRepositorySettings({ repository, token, candidateTag, fetchImpl: fixture.fetchImpl }),
    /no active tag ruleset covers refs\/tags\/v2\.78\.1/u,
  );
});

test('fails closed when an exclusion overrides the candidate include', async () => {
  const tag = tagRuleset({
    conditions: {
      ref_name: {
        include: ['refs/tags/v*'],
        exclude: [`refs/tags/${candidateTag}`],
      },
    },
  });
  const fixture = fixtureFetch({ tag });
  await assert.rejects(
    verifyReleaseRepositorySettings({ repository, token, candidateTag, fetchImpl: fixture.fetchImpl }),
    /no active tag ruleset covers refs\/tags\/v2\.78\.1/u,
  );
});

test('main protection requires deletion and non_fast_forward in the same ruleset', async (t) => {
  for (const missing of ['deletion', 'non_fast_forward']) {
    await t.test(`missing ${missing}`, async () => {
      const branch = branchRuleset({
        rules: [{ type: missing === 'deletion' ? 'non_fast_forward' : 'deletion' }],
      });
      const fixture = fixtureFetch({ branch });
      await assert.rejects(
        verifyReleaseRepositorySettings({
          repository,
          token,
          candidateTag,
          fetchImpl: fixture.fetchImpl,
        }),
        /with deletion and non_fast_forward restrictions/u,
      );
    });
  }
});

test('tag protection requires deletion and update restrictions in the same ruleset', async (t) => {
  for (const missing of ['deletion', 'update']) {
    await t.test(`missing ${missing}`, async () => {
      const tag = tagRuleset({
        rules: [{ type: missing === 'deletion' ? 'update' : 'deletion' }],
      });
      const fixture = fixtureFetch({ tag });
      await assert.rejects(
        verifyReleaseRepositorySettings({
          repository,
          token,
          candidateTag,
          fetchImpl: fixture.fetchImpl,
        }),
        /with deletion and update restrictions/u,
      );
    });
  }
});

test('follows bounded same-repository ruleset pagination', async () => {
  const branch = branchRuleset();
  const tag = tagRuleset();
  const requests = [];
  const next = `https://api.github.com/repos/${repository}/rulesets?includes_parents=true&per_page=100&page=2`;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const parsed = new URL(url);
    if (parsed.pathname === `/repos/${repository}/rulesets`) {
      if (parsed.searchParams.get('page') === '1') {
        return response(200, [{ id: branch.id }], { link: `<${next}>; rel="next"` });
      }
      return response(200, [{ id: tag.id }]);
    }
    if (parsed.pathname.endsWith(`/rulesets/${branch.id}`)) return response(200, branch);
    if (parsed.pathname.endsWith(`/rulesets/${tag.id}`)) return response(200, tag);
    throw new Error(`unexpected fixture URL: ${url}`);
  };
  const result = await verifyReleaseRepositorySettings({
    repository,
    token,
    candidateTag,
    fetchImpl,
  });
  assert.equal(result.branchRulesetId, branch.id);
  assert.equal(result.tagRulesetId, tag.id);
  assert.equal(new URL(requests[1].url).searchParams.get('page'), '2');
});

test('rejects malformed inputs, HTTP responses, JSON, and unsafe pagination', async (t) => {
  const valid = { repository, token, candidateTag };
  const neverFetch = async () => { throw new Error('must not fetch'); };
  await assert.rejects(
    verifyReleaseRepositorySettings({ ...valid, repository: 'Genuifx', fetchImpl: neverFetch }),
    /exact owner\/name pair/u,
  );
  await assert.rejects(
    verifyReleaseRepositorySettings({ ...valid, token: 'bad token', fetchImpl: neverFetch }),
    /invalid format/u,
  );
  await assert.rejects(
    verifyReleaseRepositorySettings({ ...valid, candidateTag: 'release-latest', fetchImpl: neverFetch }),
    /exact vX\.Y\.Z/u,
  );
  await assert.rejects(
    verifyReleaseRepositorySettings({ ...valid, candidateTag: 'v2.78.1-alpha..01', fetchImpl: neverFetch }),
    /exact vX\.Y\.Z/u,
  );

  await t.test('HTTP failure', async () => {
    await assert.rejects(
      verifyReleaseRepositorySettings({
        ...valid,
        fetchImpl: async () => response(403, { message: token }),
      }),
      (error) => {
        assert.match(error.message, /rulesets read failed \(403\)/u);
        assert.doesNotMatch(error.message, new RegExp(token, 'u'));
        return true;
      },
    );
  });

  await t.test('invalid JSON', async () => {
    await assert.rejects(
      verifyReleaseRepositorySettings({
        ...valid,
        fetchImpl: async () => response(200, null, { invalidJson: true }),
      }),
      /repository rulesets returned invalid JSON/u,
    );
  });

  await t.test('unsafe next URL', async () => {
    const malicious = `https://example.invalid/repos/${repository}/rulesets?includes_parents=true&per_page=100&page=2`;
    await assert.rejects(
      verifyReleaseRepositorySettings({
        ...valid,
        fetchImpl: async () => response(200, [], { link: `<${malicious}>; rel="next"` }),
      }),
      /pagination escaped/u,
    );
  });

  await t.test('network error cannot leak token', async () => {
    await assert.rejects(
      verifyReleaseRepositorySettings({
        ...valid,
        fetchImpl: async () => { throw new Error(`Authorization: Bearer ${token}`); },
      }),
      (error) => {
        assert.match(error.message, /request failed/u);
        assert.doesNotMatch(error.message, new RegExp(token, 'u'));
        return true;
      },
    );
  });
});
