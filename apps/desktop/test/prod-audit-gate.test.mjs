import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  GITHUB_GLOBAL_ADVISORIES_ENDPOINT,
  NPM_BULK_AUDIT_ENDPOINT,
  PNPM_PRODUCTION_LIST_ARGS,
  auditProductionDependencies,
  auditProductionDependenciesWithFallback,
  auditProductionDependenciesWithGithubAdvisories,
  buildProductionDependencyIndex,
  decodeBulkHttpResponse,
  evaluateAuditReport,
  requestBulkAdvisories,
  requestGithubAdvisories,
} from '../../../scripts/ci/check-prod-audit.mjs';
import { loadExpectedWorkspacePaths } from '../../../scripts/ci/prod-audit-workspaces.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(desktopDir, '..', '..');

function dependency(packageName, version, physicalKey, dependencies) {
  const tarballName = packageName.includes('/')
    ? packageName.slice(packageName.lastIndexOf('/') + 1)
    : packageName;
  return {
    from: packageName,
    version,
    resolved: `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`,
    path: path.join(repoDir, '.audit-fixture', physicalKey),
    ...(dependencies ? { dependencies } : {}),
  };
}

function dependencyIndex(dependencies) {
  return buildProductionDependencyIndex([
    {
      name: '@ccem/desktop',
      path: desktopDir,
      dependencies,
    },
  ], repoDir);
}

function advisory({
  id = 1100001,
  ghsa = 'GHSA-1111-2222-3333',
  severity = 'high',
  title = 'fixture advisory',
  vulnerableVersions = '<2.0.0',
  extra = {},
} = {}) {
  return {
    id,
    url: `https://github.com/advisories/${ghsa}`,
    title,
    severity,
    vulnerable_versions: vulnerableVersions,
    ...extra,
  };
}

function transientAuditError(message) {
  const error = new Error(message);
  error.auditTransient = true;
  return error;
}

test('production dependency listing is recursive, prod-only, unbounded-depth, and lockfile-only', () => {
  assert.deepEqual(PNPM_PRODUCTION_LIST_ARGS, [
    'list',
    '--recursive',
    '--prod',
    '--json',
    '--depth',
    'Infinity',
    '--lockfile-only',
  ]);
});

test('CI runs the production audit once and gates bundle smoke on it', async () => {
  const source = (
    await readFile(path.join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8')
  ).replace(/\r\n?/gu, '\n');
  assert.equal(source.match(/^\s+run: pnpm audit:prod:high$/gmu)?.length, 1);
  assert.match(source, /\n  production-audit:\n    name: Production Dependency Audit\n/u);
  assert.match(
    source,
    /\n  production-audit:\n[\s\S]*?    permissions:\n      contents: read\n/u,
  );
  assert.match(
    source,
    /      - name: Audit production dependencies\n        env:\n          GITHUB_TOKEN: \$\{\{ github\.token \}\}\n        run: pnpm audit:prod:high\n/u,
  );
  assert.match(
    source,
    /\n  desktop-bundle-smoke:\n[\s\S]*?    needs:\n      - production-audit\n      - test\n/u,
  );
});

test('workspace discovery binds pnpm output to every configured lockfile importer', async () => {
  const expectedWorkspacePaths = await loadExpectedWorkspacePaths(repoDir);
  assert.deepEqual([...expectedWorkspacePaths].sort(), [
    '.',
    'apps/cli',
    'apps/desktop',
    'packages/core',
    'packages/native-runtime-helper',
    'server',
  ]);

  assert.throws(
    () => buildProductionDependencyIndex([
      {
        name: '@ccem/desktop',
        path: desktopDir,
        dependencies: {
          target: dependency('target', '1.0.0', 'target-1'),
        },
      },
    ], repoDir, expectedWorkspacePaths),
    /missing: \., apps\/cli, packages\/core, packages\/native-runtime-helper, server/u,
  );
});

test('lockfile-only registry nodes do not require an installed package path', () => {
  const chalk = dependency('chalk', '5.6.2', 'chalk-5');
  delete chalk.path;

  const index = dependencyIndex({ chalk });
  assert.deepEqual(
    [...index.get('chalk').get('5.6.2')],
    ['apps/desktop>chalk'],
  );

  const linked = dependency('@ccem/core', 'link:../../packages/core', 'linked-core');
  delete linked.path;
  assert.throws(
    () => dependencyIndex({ '@ccem/core': linked }),
    /omitted the absolute linked package path/u,
  );
});

test('bulk audit fails closed on operational, HTTP, encoding, and response-shape failures', async () => {
  const index = dependencyIndex({
    target: dependency('target', '1.0.0', 'target-1'),
  });

  await assert.rejects(
    auditProductionDependencies(index, {
      maxRoundAttempts: 1,
      retryDelayMs: 0,
      requestRound: async () => {
        throw transientAuditError('registry unavailable');
      },
    }),
    /round 1\/1 failed after 1 attempt: registry unavailable/u,
  );
  await assert.rejects(
    auditProductionDependencies(index, {
      requestRound: async () => ({ target: { advisories: [] } }),
    }),
    /response for target must be an array/u,
  );
  await assert.rejects(
    auditProductionDependencies(index, {
      requestRound: async () => ({
        target: [advisory({ severity: 'unknown' })],
      }),
    }),
    /severity is unknown/u,
  );

  assert.throws(
    () => decodeBulkHttpResponse({
      statusCode: 503,
      body: Buffer.from('{}'),
    }),
    /HTTP 503/u,
  );
  assert.throws(
    () => decodeBulkHttpResponse({
      statusCode: 200,
      headers: { 'content-encoding': 'br' },
      body: Buffer.from('{}'),
    }),
    /unsupported content-encoding br/u,
  );
  assert.throws(
    () => decodeBulkHttpResponse({
      statusCode: 200,
      body: Buffer.alloc((8 * 1024 * 1024) + 1),
    }),
    /compressed size limit/u,
  );
  assert.throws(
    () => decodeBulkHttpResponse({
      statusCode: 200,
      body: gzipSync(Buffer.alloc((32 * 1024 * 1024) + 1)),
    }),
    /invalid or oversized gzip response/u,
  );

  assert.throws(
    () => dependencyIndex({}),
    /no auditable registry packages/u,
  );
  const privateDependency = dependency('private-package', '1.0.0', 'private-1');
  privateDependency.resolved = 'https://private.example/private-package-1.0.0.tgz';
  assert.throws(
    () => dependencyIndex({ 'private-package': privateDependency }),
    /non-public-registry dependency/u,
  );
  await assert.rejects(
    auditProductionDependencies(index, {
      requestRound: async () => new Promise(() => {}),
      overallTimeoutMs: 5,
    }),
    /exceeded its 5ms overall timeout/u,
  );
});

test('bulk audit retries transient round failures but remains bounded and fail-closed', async () => {
  const index = dependencyIndex({
    target: dependency('target', '1.0.0', 'target-1'),
  });
  let recoveredAttempts = 0;
  const report = await auditProductionDependencies(index, {
    maxRoundAttempts: 3,
    retryDelayMs: 0,
    requestRound: async () => {
      recoveredAttempts += 1;
      if (recoveredAttempts < 3) {
        throw transientAuditError('temporary registry timeout');
      }
      return {};
    },
  });
  assert.equal(recoveredAttempts, 3);
  assert.deepEqual(report.metadata.vulnerabilities, {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  });

  let failedAttempts = 0;
  await assert.rejects(
    auditProductionDependencies(index, {
      maxRoundAttempts: 2,
      retryDelayMs: 0,
      requestRound: async () => {
        failedAttempts += 1;
        throw transientAuditError('registry unavailable');
      },
    }),
    /round 1\/1 failed after 2 attempts: registry unavailable/u,
  );
  assert.equal(failedAttempts, 2);
});

test('GitHub Advisory fallback preserves exact versions and dependency paths', async () => {
  const index = dependencyIndex({
    'parent-a': dependency('parent-a', '1.0.0', 'parent-a', {
      target: dependency('target', '1.2.3', 'target'),
    }),
    'parent-b': dependency('parent-b', '1.0.0', 'parent-b', {
      target: dependency('target', '1.2.3', 'target'),
    }),
  });
  const payloads = [];
  const report = await auditProductionDependenciesWithGithubAdvisories(index, {
    requestAdvisories: async packageVersions => {
      payloads.push(packageVersions);
      return {
        advisories: packageVersions.includes('target@1.2.3')
          ? [{
              ghsa_id: 'GHSA-1111-2222-3333',
              html_url: 'https://github.com/advisories/GHSA-1111-2222-3333',
              summary: 'fixture high advisory',
              type: 'reviewed',
              severity: 'high',
              withdrawn_at: null,
              vulnerabilities: [{
                package: { ecosystem: 'npm', name: 'target' },
                vulnerable_version_range: '<2.0.0',
              }],
            }]
          : [],
        link: '',
      };
    },
  });

  assert.ok(payloads.flat().every(value => /@\d+\.\d+\.\d+/u.test(value)));
  assert.deepEqual(report.advisories, [{
    id: 'GHSA-1111-2222-3333',
    module_name: 'target',
    title: 'fixture high advisory',
    severity: 'high',
    url: 'https://github.com/advisories/GHSA-1111-2222-3333',
    vulnerable_versions: '<2.0.0',
    github_advisory_id: 'GHSA-1111-2222-3333',
    findings: [{
      version: '1.2.3',
      paths: [
        'apps/desktop>parent-a>target',
        'apps/desktop>parent-b>target',
      ],
    }],
    paths: [
      'apps/desktop>parent-a>target',
      'apps/desktop>parent-b>target',
    ],
  }]);
  assert.equal(report.metadata.vulnerabilities.high, 1);
});

test('audit falls back only after transient npm failure and fails closed when GitHub also fails', async () => {
  const index = dependencyIndex({
    target: dependency('target', '1.0.0', 'target-1'),
  });
  const expected = {
    advisories: [],
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
    },
  };
  const fallbackMessages = [];
  assert.equal(
    await auditProductionDependenciesWithFallback(index, {
      auditNpm: async () => {
        throw transientAuditError('npm unavailable');
      },
      auditGithub: async () => expected,
      onFallback: message => fallbackMessages.push(message),
    }),
    expected,
  );
  assert.deepEqual(fallbackMessages, [
    'npm production audit unavailable (npm unavailable); using GitHub Advisory exact-version fallback.',
  ]);

  await assert.rejects(
    auditProductionDependenciesWithFallback(index, {
      auditNpm: async () => {
        throw transientAuditError('npm unavailable');
      },
      auditGithub: async () => {
        throw new Error('GitHub unavailable');
      },
    }),
    /npm production audit failed: npm unavailable; GitHub Advisory fallback failed: GitHub unavailable/u,
  );

  let githubCalled = false;
  await assert.rejects(
    auditProductionDependenciesWithFallback(index, {
      auditNpm: async () => {
        throw new Error('invalid npm evidence');
      },
      auditGithub: async () => {
        githubCalled = true;
        return expected;
      },
    }),
    /invalid npm evidence/u,
  );
  assert.equal(githubCalled, false);
});

test('npm audit does not retry or fall back after invalid evidence', async () => {
  const index = dependencyIndex({
    target: dependency('target', '1.0.0', 'target-1'),
  });
  let npmCalls = 0;
  let githubCalled = false;

  await assert.rejects(
    auditProductionDependenciesWithFallback(index, {
      auditNpm: dependencyIndexValue => auditProductionDependencies(dependencyIndexValue, {
        maxRoundAttempts: 2,
        retryDelayMs: 0,
        requestRound: async () => {
          npmCalls += 1;
          if (npmCalls === 1) {
            throw new Error('invalid npm evidence');
          }
          throw transientAuditError('npm unavailable');
        },
      }),
      auditGithub: async () => {
        githubCalled = true;
        throw new Error('GitHub must not be called');
      },
    }),
    /invalid npm evidence/u,
  );
  assert.equal(npmCalls, 1);
  assert.equal(githubCalled, false);
});

test('GitHub Advisory fallback rejects pagination, unknown severity, and unbound evidence', async () => {
  const index = dependencyIndex({
    target: dependency('target', '1.0.0', 'target-1'),
  });
  await assert.rejects(
    auditProductionDependenciesWithGithubAdvisories(index, {
      requestAdvisories: async () => ({
        advisories: [],
        link: '<https://api.github.com/advisories?after=cursor>; rel="next"',
      }),
    }),
    /paginated response/u,
  );
  await assert.rejects(
    auditProductionDependenciesWithGithubAdvisories(index, {
      requestAdvisories: async () => ({
        advisories: [{
          ghsa_id: 'GHSA-abcd-2222-3333',
          html_url: 'https://github.com/advisories/GHSA-abcd-2222-3333',
          summary: 'fixture advisory',
          type: 'reviewed',
          severity: 'unknown',
          withdrawn_at: null,
          vulnerabilities: [{
            package: { ecosystem: 'npm', name: 'target' },
            vulnerable_version_range: '<2.0.0',
          }],
        }],
        link: '',
      }),
    }),
    /severity is unknown/u,
  );
  await assert.rejects(
    auditProductionDependenciesWithGithubAdvisories(index, {
      requestAdvisories: async () => ({
        advisories: [{
          ghsa_id: 'GHSA-abcd-2222-3333',
          html_url: 'https://github.com/advisories/GHSA-abcd-2222-3333',
          summary: 'unbound fixture advisory',
          type: 'reviewed',
          severity: 'medium',
          withdrawn_at: null,
          vulnerabilities: [{
            package: { ecosystem: 'npm', name: 'other-package' },
            vulnerable_version_range: '<2.0.0',
          }],
        }],
        link: '',
      }),
    }),
    /returned unbound evidence/u,
  );
});

test('GitHub Advisory request uses the fixed endpoint without authorization', async () => {
  const captured = {};
  const requestImpl = (url, options, callback) => {
    captured.url = url;
    captured.options = options;
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = body => {
      captured.body = body;
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {};
        response.destroy = () => {};
        callback(response);
        response.emit('data', Buffer.from('[]'));
        response.emit('end');
      });
    };
    return request;
  };
  assert.deepEqual(
    await requestGithubAdvisories(
      ['target@1.0.0'],
      { requestImpl, timeoutMs: 100, token: '' },
    ),
    { advisories: [], link: '' },
  );
  const requestUrl = new URL(captured.url);
  assert.equal(requestUrl.origin + requestUrl.pathname, GITHUB_GLOBAL_ADVISORIES_ENDPOINT);
  assert.equal(requestUrl.searchParams.get('type'), 'reviewed');
  assert.equal(requestUrl.searchParams.get('ecosystem'), 'npm');
  assert.equal(requestUrl.searchParams.get('affects'), 'target@1.0.0');
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.headers.authorization, undefined);
  assert.equal(captured.body, undefined);
});

test('bulk request uses only the fixed official endpoint, no auth, and an overall timeout', async () => {
  const captured = {};
  const requestImpl = (url, options, callback) => {
    captured.url = url;
    captured.options = options;
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = body => {
      captured.body = body;
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {};
        response.destroy = () => {};
        callback(response);
        response.emit('data', Buffer.from('{}'));
        response.emit('end');
      });
    };
    return request;
  };

  const response = await requestBulkAdvisories(
    { target: ['1.0.0'] },
    { requestImpl, timeoutMs: 100 },
  );
  assert.deepEqual(response, {});
  assert.equal(captured.url, NPM_BULK_AUDIT_ENDPOINT);
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.authorization, undefined);
  assert.equal(captured.options.headers['accept-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(captured.body), { target: ['1.0.0'] });

  const hangingRequest = () => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {};
    return request;
  };
  await assert.rejects(
    requestBulkAdvisories(
      { target: ['1.0.0'] },
      { requestImpl: hangingRequest, timeoutMs: 5 },
    ),
    /timed out after 5ms/u,
  );
});

test('bulk response decodes bounded gzip even when the registry omits Content-Encoding', () => {
  const document = {
    target: [
      advisory({
        severity: 'moderate',
        extra: {
          cwe: ['CWE-400'],
          cvss: {
            score: 5.3,
            vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L',
          },
        },
      }),
    ],
  };
  const decoded = decodeBulkHttpResponse({
    statusCode: 200,
    headers: {},
    body: gzipSync(Buffer.from(JSON.stringify(document))),
  });
  assert.deepEqual(decoded, document);
});

test('low and moderate production advisories pass while preserving official extra metadata', async () => {
  const index = dependencyIndex({
    target: dependency('target', '1.0.0', 'target-1'),
  });
  const report = await auditProductionDependencies(index, {
    requestRound: async () => ({
      target: [
        advisory({
          id: 1100002,
          ghsa: 'GHSA-aaaa-bbbb-cccc',
          severity: 'low',
          extra: { updated: '2026-07-26T00:00:00.000Z' },
        }),
        advisory({
          id: 1100003,
          ghsa: 'GHSA-dddd-eeee-ffff',
          severity: 'moderate',
          extra: {
            cwe: ['CWE-400'],
            cvss: {
              score: 5.3,
              vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L',
            },
          },
        }),
      ],
    }),
  });

  assert.deepEqual(report.metadata.vulnerabilities, {
    info: 0,
    low: 1,
    moderate: 1,
    high: 0,
    critical: 0,
  });
  assert.deepEqual(evaluateAuditReport(report, []), []);
});

test('an unsuppressed high advisory fails with its derived GHSA and exact path', async () => {
  const index = dependencyIndex({
    target: dependency('target', '1.0.0', 'target-1'),
  });
  const report = await auditProductionDependencies(index, {
    requestRound: async () => ({
      target: [advisory()],
    }),
  });

  const failures = evaluateAuditReport(report, []);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /HIGH target GHSA-1111-2222-3333/u);
  assert.match(failures[0], /apps\/desktop>target/u);
});

test('rounds map a vulnerable package version only to its exact dependency paths', async () => {
  const sharedOld = dependency('shared', '1.0.0', 'shared-1');
  const sharedNew = dependency('shared', '2.0.0', 'shared-2');
  const index = dependencyIndex({
    'new-parent': dependency('new-parent', '1.0.0', 'new-parent', {
      shared: sharedNew,
    }),
    'old-parent-a': dependency('old-parent-a', '1.0.0', 'old-parent-a', {
      shared: sharedOld,
    }),
    'old-parent-b': dependency('old-parent-b', '1.0.0', 'old-parent-b', {
      shared: sharedOld,
    }),
  });
  const payloads = [];
  let activeRequests = 0;
  let maximumActiveRequests = 0;

  const report = await auditProductionDependencies(index, {
    maxConcurrentRounds: 2,
    requestRound: async payload => {
      payloads.push(payload);
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      for (const versions of Object.values(payload)) {
        assert.equal(versions.length, 1);
      }
      await new Promise(resolve => setImmediate(resolve));
      const response = payload.shared?.[0] === '1.0.0'
        ? {
            shared: [
              advisory({
                id: 1100004,
                ghsa: 'GHSA-1234-5678-9abc',
                vulnerableVersions: '<2.0.0',
              }),
            ],
          }
        : {};
      activeRequests -= 1;
      return response;
    },
  });

  assert.equal(payloads.length, 2);
  assert.equal(maximumActiveRequests, 2);
  assert.deepEqual(
    report.advisories.find(value => value.module_name === 'shared')?.paths,
    [
      'apps/desktop>old-parent-a>shared',
      'apps/desktop>old-parent-b>shared',
    ],
  );
  assert.ok(
    report.advisories.every(value =>
      !value.paths.includes('apps/desktop>new-parent>shared')
    ),
  );
});

test('one GHSA may merge official per-range ids without losing exact version paths', async () => {
  const index = dependencyIndex({
    'parent-eleven': dependency('parent-eleven', '1.0.0', 'parent-eleven', {
      uuid: dependency('uuid', '11.1.0', 'uuid-11'),
    }),
    'parent-thirteen': dependency('parent-thirteen', '1.0.0', 'parent-thirteen', {
      uuid: dependency('uuid', '13.0.0', 'uuid-13'),
    }),
  });
  const report = await auditProductionDependencies(index, {
    requestRound: async payload => {
      const version = payload.uuid?.[0];
      if (!version) {
        return {};
      }
      return {
        uuid: [
          advisory({
            id: version === '11.1.0' ? 1119441 : 1119442,
            ghsa: 'GHSA-w5hq-g745-h8pq',
            severity: 'moderate',
            vulnerableVersions:
              version === '11.1.0' ? '<11.1.1' : '>=13.0.0 <13.0.1',
          }),
        ],
      };
    },
  });

  const uuidAdvisories = report.advisories.filter(value => value.module_name === 'uuid');
  assert.equal(uuidAdvisories.length, 1);
  assert.equal(
    uuidAdvisories[0].vulnerable_versions,
    '<11.1.1 || >=13.0.0 <13.0.1',
  );
  assert.deepEqual(uuidAdvisories[0].paths, [
    'apps/desktop>parent-eleven>uuid',
    'apps/desktop>parent-thirteen>uuid',
  ]);
});

test('suppression remains exact-path scoped and becomes stale when its advisory disappears', async () => {
  const index = dependencyIndex({
    target: dependency('target', '1.0.0', 'target-1'),
  });
  const report = await auditProductionDependencies(index, {
    requestRound: async () => ({
      target: [advisory()],
    }),
  });
  const suppression = {
    id: 'GHSA-1111-2222-3333',
    package: 'target',
    reason: 'fixture only',
    owner: 'security',
    reviewCondition: 'remove after upgrade',
    expires: '2099-01-01',
    paths: ['apps/desktop>target'],
  };

  assert.deepEqual(evaluateAuditReport(report, [suppression]), []);
  assert.match(
    evaluateAuditReport(report, [{
      ...suppression,
      paths: [...suppression.paths, 'apps/cli>target'],
    }])[0],
    /includes inactive paths/u,
  );
  assert.throws(
    () => evaluateAuditReport(report, [{
      ...suppression,
      expires: '2099-02-30',
    }]),
    /expires must be an ISO date/u,
  );
  assert.match(
    evaluateAuditReport({
      advisories: [],
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
        },
      },
    }, [suppression])[0],
    /Stale production audit suppressions/u,
  );
});
