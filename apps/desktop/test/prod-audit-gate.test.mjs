import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  NPM_BULK_AUDIT_ENDPOINT,
  PNPM_PRODUCTION_LIST_ARGS,
  auditProductionDependencies,
  buildProductionDependencyIndex,
  decodeBulkHttpResponse,
  evaluateAuditReport,
  requestBulkAdvisories,
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
  const source = await readFile(path.join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.equal(source.match(/^\s+run: pnpm audit:prod:high$/gmu)?.length, 1);
  assert.match(source, /\n  production-audit:\n    name: Production Dependency Audit\n/u);
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

test('bulk audit fails closed on operational, HTTP, encoding, and response-shape failures', async () => {
  const index = dependencyIndex({
    target: dependency('target', '1.0.0', 'target-1'),
  });

  await assert.rejects(
    auditProductionDependencies(index, {
      maxRoundAttempts: 1,
      retryDelayMs: 0,
      requestRound: async () => {
        throw new Error('registry unavailable');
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
        throw new Error('temporary registry timeout');
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
        throw new Error('registry unavailable');
      },
    }),
    /round 1\/1 failed after 2 attempts: registry unavailable/u,
  );
  assert.equal(failedAttempts, 2);
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
