#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import {
  assertExactWorkspacePaths,
  loadExpectedWorkspacePaths,
} from './prod-audit-workspaces.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(scriptPath), '../..');
const suppressionPath = path.join(rootDir, 'docs/security/production-audit-suppressions.json');

export const NPM_BULK_AUDIT_ENDPOINT =
  'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
export const GITHUB_GLOBAL_ADVISORIES_ENDPOINT = 'https://api.github.com/advisories';
export const PNPM_PRODUCTION_LIST_ARGS = Object.freeze([
  'list',
  '--recursive',
  '--prod',
  '--json',
  '--depth',
  'Infinity',
  '--lockfile-only',
]);

const LIST_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 15_000;
const AUDIT_TOTAL_TIMEOUT_MS = 90_000;
const AUDIT_MAX_ROUND_ATTEMPTS = 2;
const AUDIT_RETRY_DELAY_MS = 1_000;
const AUDIT_MAX_CONCURRENT_ROUNDS = 3;
const GITHUB_HTTP_TIMEOUT_MS = 15_000;
const GITHUB_OVERALL_TIMEOUT_MS = 90_000;
const GITHUB_MAX_INITIAL_URL_BYTES = 5_500;
const GITHUB_MAX_URL_BYTES = 6_000;
const GITHUB_MAX_BATCH_SPECS = 1_000;
const GITHUB_MAX_PAGES = 10;
const GITHUB_MAX_ADVISORIES = 10_000;
const GITHUB_MAX_CONCURRENT_VERIFICATIONS = 8;
const MAX_LIST_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_LIST_STDERR_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_COMPRESSED_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_DECOMPRESSED_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_DEPENDENCY_OCCURRENCES = 250_000;
const MAX_TREE_DEPTH = 256;
const MAX_ADVISORIES = 100_000;
const MAX_TOTAL_ADVISORY_RECORDS = 100_000;
const MAX_AUDIT_ROUNDS = 32;
const exactSemverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const severityRank = Object.freeze({
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
});

function transientAuditError(message) {
  const error = new Error(message);
  error.auditTransient = true;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePackageName(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 512
    || /[\u0000-\u001f\u007f\s>]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function dependencyMap(value, label) {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function stableWorkspacePath(workspacePath, repoRoot) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) {
    throw new Error('pnpm list returned a workspace without an absolute path.');
  }
  const relative = path.relative(repoRoot, path.resolve(workspacePath));
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('pnpm list returned a workspace outside the repository.');
  }
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}

function collectBoundedProcessOutput(child, {
  timeoutMs,
  maxStdoutBytes,
  maxStderrBytes,
  commandLabel,
}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (error) => {
      finish(reject, error);
      child.kill?.();
    };
    const timer = setTimeout(() => {
      fail(new Error(`${commandLabel} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.on('error', error => {
      fail(new Error(`${commandLabel} failed to start: ${error.message}`));
    });
    child.stdout.on('data', chunk => {
      if (settled) {
        return;
      }
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > maxStdoutBytes) {
        fail(new Error(`${commandLabel} exceeded its stdout limit.`));
        return;
      }
      stdout.push(bytes);
    });
    child.stderr.on('data', chunk => {
      if (settled) {
        return;
      }
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.length;
      if (stderrBytes > maxStderrBytes) {
        fail(new Error(`${commandLabel} exceeded its stderr limit.`));
        return;
      }
      stderr.push(bytes);
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 2_000);
        const status = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`;
        fail(new Error(
          `${commandLabel} failed with ${status}${detail ? `: ${detail}` : '.'}`,
        ));
        return;
      }
      finish(resolve, Buffer.concat(stdout).toString('utf8'));
    });
  });
}

export function runPnpmProductionList({ spawnImpl = spawn } = {}) {
  const child = spawnImpl('pnpm', PNPM_PRODUCTION_LIST_ARGS, {
    cwd: rootDir,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return collectBoundedProcessOutput(child, {
    timeoutMs: LIST_TIMEOUT_MS,
    maxStdoutBytes: MAX_LIST_STDOUT_BYTES,
    maxStderrBytes: MAX_LIST_STDERR_BYTES,
    commandLabel: 'pnpm production dependency listing',
  });
}

export function parsePnpmProductionList(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`pnpm production dependency listing did not return JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('pnpm production dependency listing must contain workspace roots.');
  }
  return parsed;
}

export function buildProductionDependencyIndex(
  listDocument,
  repoRoot = rootDir,
  expectedWorkspacePaths,
) {
  if (!Array.isArray(listDocument) || listDocument.length === 0) {
    throw new Error('pnpm production dependency listing must contain workspace roots.');
  }

  const index = new Map();
  const physicalIdentities = new Map();
  const workspacePaths = new Set();
  let occurrenceCount = 0;

  const visit = (dependencies, pathSegments, depth) => {
    if (depth > MAX_TREE_DEPTH) {
      throw new Error('pnpm production dependency tree exceeded its depth limit.');
    }
    const entries = Object.entries(dependencyMap(dependencies, 'dependency map'))
      .sort(([left], [right]) => compareStrings(left, right));
    for (const [dependencyName, node] of entries) {
      validatePackageName(dependencyName, 'dependency name');
      if (!isRecord(node)) {
        throw new Error(`pnpm list returned an invalid node for ${dependencyName}.`);
      }
      occurrenceCount += 1;
      if (occurrenceCount > MAX_DEPENDENCY_OCCURRENCES) {
        throw new Error('pnpm production dependency tree exceeded its node limit.');
      }

      const packageName = validatePackageName(
        node.from === undefined ? dependencyName : node.from,
        `${dependencyName} package name`,
      );
      if (typeof node.version !== 'string' || node.version.length === 0) {
        throw new Error(`pnpm list omitted the installed version for ${dependencyName}.`);
      }
      const stablePath = [...pathSegments, dependencyName].join('>');
      const isLinked = node.version.startsWith('link:');
      if (isLinked) {
        if (node.path === undefined) {
          throw new Error(`pnpm list omitted the absolute linked package path at ${stablePath}.`);
        }
        if (typeof node.path !== 'string' || !path.isAbsolute(node.path)) {
          throw new Error(`pnpm list returned a non-absolute linked package path at ${stablePath}.`);
        }
        const physicalPath = path.resolve(node.path);
        const physicalIdentity = physicalIdentities.get(physicalPath);
        if (
          physicalIdentity
          && (
            physicalIdentity.packageName !== packageName
            || physicalIdentity.version !== node.version
          )
        ) {
          throw new Error(`pnpm list returned conflicting identities for ${physicalPath}.`);
        }
        physicalIdentities.set(physicalPath, { packageName, version: node.version });
        const linkedRelative = path.relative(repoRoot, physicalPath);
        if (
          linkedRelative.startsWith(`..${path.sep}`)
          || linkedRelative === '..'
          || path.isAbsolute(linkedRelative)
        ) {
          throw new Error(`pnpm list returned an external linked dependency at ${stablePath}.`);
        }
      } else {
        if (!exactSemverPattern.test(node.version)) {
          throw new Error(
            `pnpm list returned a non-registry production version at ${stablePath}.`,
          );
        }
        let resolvedUrl;
        try {
          resolvedUrl = new URL(node.resolved);
        } catch {
          throw new Error(`pnpm list omitted the registry URL at ${stablePath}.`);
        }
        if (
          resolvedUrl.origin !== 'https://registry.npmjs.org'
          || resolvedUrl.username
          || resolvedUrl.password
        ) {
          throw new Error(
            `pnpm list returned a non-public-registry dependency at ${stablePath}.`,
          );
        }
        let versions = index.get(packageName);
        if (!versions) {
          versions = new Map();
          index.set(packageName, versions);
        }
        let paths = versions.get(node.version);
        if (!paths) {
          paths = new Set();
          versions.set(node.version, paths);
        }
        paths.add(stablePath);
      }

      visit(node.dependencies, [...pathSegments, dependencyName], depth + 1);
    }
  };

  for (const [rootIndex, workspace] of listDocument.entries()) {
    if (!isRecord(workspace)) {
      throw new Error(`pnpm list workspace[${rootIndex}] is invalid.`);
    }
    const workspacePath = stableWorkspacePath(workspace.path, repoRoot);
    if (workspacePaths.has(workspacePath)) {
      throw new Error(`pnpm list returned duplicate workspace root ${workspacePath}.`);
    }
    workspacePaths.add(workspacePath);
    visit(workspace.dependencies, [workspacePath], 1);
  }

  if (expectedWorkspacePaths !== undefined) {
    assertExactWorkspacePaths(
      workspacePaths,
      expectedWorkspacePaths,
      'pnpm production dependency listing and configured workspace roots',
    );
  }
  if (index.size === 0) {
    throw new Error('pnpm production dependency tree contained no auditable registry packages.');
  }
  return index;
}

export function buildAuditRounds(index) {
  const packages = [...index.entries()]
    .map(([packageName, versions]) => [
      packageName,
      [...versions.entries()]
        .map(([version, paths]) => [version, [...paths].sort(compareStrings)])
        .sort(([left], [right]) => compareStrings(left, right)),
    ])
    .sort(([left], [right]) => compareStrings(left, right));
  const roundCount = packages.reduce(
    (maximum, [, versions]) => Math.max(maximum, versions.length),
    0,
  );
  if (roundCount === 0 || roundCount > MAX_AUDIT_ROUNDS) {
    throw new Error('pnpm production dependency versions exceeded the audit round limit.');
  }

  return Array.from({ length: roundCount }, (_, roundIndex) => {
    const payload = Object.create(null);
    const exactVersions = new Map();
    for (const [packageName, versions] of packages) {
      const versionEntry = versions[roundIndex];
      if (!versionEntry) {
        continue;
      }
      const [version, paths] = versionEntry;
      payload[packageName] = [version];
      exactVersions.set(packageName, { version, paths });
    }
    return { payload, exactVersions };
  });
}

function responseHeader(headers, name) {
  const value = headers?.[name];
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`npm bulk audit returned an invalid ${name} header.`);
  }
  return value.trim().toLowerCase();
}

export function decodeBulkHttpResponse({ statusCode, headers = {}, body }) {
  if (statusCode !== 200) {
    const message = `npm bulk audit returned HTTP ${statusCode ?? 'unknown'}.`;
    if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
      throw transientAuditError(message);
    }
    throw new Error(message);
  }
  if (!Buffer.isBuffer(body)) {
    throw new Error('npm bulk audit returned an invalid response body.');
  }
  if (body.length > MAX_COMPRESSED_RESPONSE_BYTES) {
    throw new Error('npm bulk audit response exceeded its compressed size limit.');
  }

  const contentEncoding = responseHeader(headers, 'content-encoding');
  if (!['', 'identity', 'gzip', 'x-gzip'].includes(contentEncoding)) {
    throw new Error(`npm bulk audit returned unsupported content-encoding ${contentEncoding}.`);
  }
  const hasGzipMagic = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
  const shouldGunzip =
    contentEncoding === 'gzip'
    || contentEncoding === 'x-gzip'
    || hasGzipMagic;

  let decoded = body;
  if (shouldGunzip) {
    try {
      decoded = gunzipSync(body, { maxOutputLength: MAX_DECOMPRESSED_RESPONSE_BYTES });
    } catch {
      throw new Error('npm bulk audit returned an invalid or oversized gzip response.');
    }
  }
  if (decoded.length > MAX_DECOMPRESSED_RESPONSE_BYTES) {
    throw new Error('npm bulk audit response exceeded its decoded size limit.');
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    throw new Error('npm bulk audit response was not valid UTF-8.');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`npm bulk audit response was not JSON: ${error.message}`);
  }
}

export function requestBulkAdvisories(
  payload,
  {
    requestImpl = https.request,
    timeoutMs = HTTP_TIMEOUT_MS,
  } = {},
) {
  const body = Buffer.from(JSON.stringify(payload));
  if (body.length > MAX_REQUEST_BYTES) {
    throw new Error('npm bulk audit request exceeded its size limit.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (error) => {
      finish(reject, error);
      request?.destroy?.();
    };
    const timer = setTimeout(() => {
      fail(transientAuditError(`npm bulk audit timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    try {
      request = requestImpl(
        NPM_BULK_AUDIT_ENDPOINT,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'accept-encoding': 'gzip',
            'content-type': 'application/json',
            'content-length': String(body.length),
            'user-agent': 'ccem-production-audit',
          },
        },
        response => {
          const chunks = [];
          let responseBytes = 0;
          response.on('data', chunk => {
            const bytes = Buffer.from(chunk);
            responseBytes += bytes.length;
            if (responseBytes > MAX_COMPRESSED_RESPONSE_BYTES) {
              response.destroy?.();
              fail(new Error('npm bulk audit response exceeded its compressed size limit.'));
              return;
            }
            chunks.push(bytes);
          });
          response.on('aborted', () => {
            fail(transientAuditError('npm bulk audit response was aborted.'));
          });
          response.on('error', error => {
            fail(transientAuditError(`npm bulk audit response failed: ${error.message}`));
          });
          response.on('end', () => {
            if (settled) {
              return;
            }
            try {
              finish(resolve, decodeBulkHttpResponse({
                statusCode: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
              }));
            } catch (error) {
              fail(error);
            }
          });
        },
      );
    } catch (error) {
      fail(transientAuditError(`npm bulk audit request failed: ${error.message}`));
      return;
    }
    request.on('error', error => {
      fail(transientAuditError(`npm bulk audit request failed: ${error.message}`));
    });
    request.end(body);
  });
}

function parseGithubAdvisoryResponse({ statusCode, headers = {}, body }) {
  if (statusCode !== 200) {
    throw new Error(`GitHub Advisory API returned HTTP ${statusCode ?? 'unknown'}.`);
  }
  if (!Buffer.isBuffer(body) || body.length > MAX_DECOMPRESSED_RESPONSE_BYTES) {
    throw new Error('GitHub Advisory API returned an invalid or oversized response body.');
  }
  const contentEncoding = headers['content-encoding'];
  if (
    contentEncoding !== undefined
    && (
      typeof contentEncoding !== 'string'
      || !['', 'identity'].includes(contentEncoding.trim().toLowerCase())
    )
  ) {
    throw new Error('GitHub Advisory API returned an unsupported content encoding.');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new Error('GitHub Advisory API response was not valid UTF-8.');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`GitHub Advisory API response was not JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('GitHub Advisory API response must be an array.');
  }
  const link = headers.link;
  if (link !== undefined && typeof link !== 'string') {
    throw new Error('GitHub Advisory API returned an invalid Link header.');
  }
  return { advisories: parsed, link: link ?? '' };
}

function githubAdvisoryRequestUrl(packageVersions, { ghsaId } = {}) {
  const url = new URL(GITHUB_GLOBAL_ADVISORIES_ENDPOINT);
  url.searchParams.set('type', 'reviewed');
  url.searchParams.set('ecosystem', 'npm');
  url.searchParams.set('is_withdrawn', 'false');
  url.searchParams.set('per_page', '100');
  url.searchParams.set('affects', packageVersions.join(','));
  if (ghsaId !== undefined) {
    url.searchParams.set('ghsa_id', ghsaId);
  }
  return url;
}

function validateGithubPackageVersion(value) {
  if (typeof value !== 'string') {
    throw new Error('GitHub Advisory package version is invalid.');
  }
  const separator = value.lastIndexOf('@');
  if (separator <= 0) {
    throw new Error('GitHub Advisory package version is invalid.');
  }
  validatePackageName(value.slice(0, separator), 'GitHub Advisory package name');
  if (!exactSemverPattern.test(value.slice(separator + 1))) {
    throw new Error('GitHub Advisory package version is invalid.');
  }
}

function nextGithubAdvisoryUrl(link, initialUrl) {
  if (link === '') {
    return undefined;
  }
  const nextMatch = /<([^>]+)>;\s*rel="next"/iu.exec(link);
  if (!nextMatch) {
    return undefined;
  }
  const nextUrl = new URL(nextMatch[1]);
  if (
    nextUrl.origin + nextUrl.pathname !== GITHUB_GLOBAL_ADVISORIES_ENDPOINT
    || nextUrl.username
    || nextUrl.password
    || Buffer.byteLength(nextUrl.toString()) > GITHUB_MAX_URL_BYTES
  ) {
    throw new Error('GitHub Advisory API returned an unsafe pagination URL.');
  }
  for (const name of ['type', 'ecosystem', 'is_withdrawn', 'per_page', 'affects', 'ghsa_id']) {
    if (nextUrl.searchParams.get(name) !== initialUrl.searchParams.get(name)) {
      throw new Error('GitHub Advisory API pagination changed the audit query.');
    }
  }
  return nextUrl;
}

function requestGithubAdvisoryPage(
  url,
  {
    requestImpl,
    timeoutMs,
    token,
  },
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = error => {
      finish(reject, error);
      request?.destroy?.();
    };
    const timer = setTimeout(() => {
      fail(new Error(`GitHub Advisory API timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'ccem-production-audit',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };

    try {
      request = requestImpl(url.toString(), { method: 'GET', headers }, response => {
        const chunks = [];
        let responseBytes = 0;
        response.on('data', chunk => {
          const bytes = Buffer.from(chunk);
          responseBytes += bytes.length;
          if (responseBytes > MAX_DECOMPRESSED_RESPONSE_BYTES) {
            response.destroy?.();
            fail(new Error('GitHub Advisory API response exceeded its size limit.'));
            return;
          }
          chunks.push(bytes);
        });
        response.on('aborted', () => {
          fail(new Error('GitHub Advisory API response was aborted.'));
        });
        response.on('error', error => {
          fail(new Error(`GitHub Advisory API response failed: ${error.message}`));
        });
        response.on('end', () => {
          if (settled) {
            return;
          }
          try {
            finish(resolve, parseGithubAdvisoryResponse({
              statusCode: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }));
          } catch (error) {
            fail(error);
          }
        });
      });
    } catch (error) {
      fail(new Error(`GitHub Advisory API request failed: ${error.message}`));
      return;
    }
    request.on('error', error => {
      fail(new Error(`GitHub Advisory API request failed: ${error.message}`));
    });
    request.end();
  });
}

export async function requestGithubAdvisories(
  packageVersions,
  {
    ghsaId,
    requestImpl = https.request,
    timeoutMs = GITHUB_HTTP_TIMEOUT_MS,
    token = process.env.GITHUB_TOKEN ?? '',
  } = {},
) {
  if (
    !Array.isArray(packageVersions)
    || packageVersions.length === 0
    || packageVersions.length > GITHUB_MAX_BATCH_SPECS
    || new Set(packageVersions).size !== packageVersions.length
  ) {
    throw new Error('GitHub Advisory package-version batch is invalid.');
  }
  packageVersions.forEach(validateGithubPackageVersion);
  if (
    ghsaId !== undefined
    && !/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/iu.test(ghsaId)
  ) {
    throw new Error('GitHub Advisory id is invalid.');
  }
  if (typeof token !== 'string') {
    throw new Error('GitHub Advisory token is invalid.');
  }

  const initialUrl = githubAdvisoryRequestUrl(packageVersions, { ghsaId });
  if (Buffer.byteLength(initialUrl.toString()) > GITHUB_MAX_INITIAL_URL_BYTES) {
    throw new Error('GitHub Advisory request URL exceeded its size limit.');
  }
  const advisories = [];
  let pageUrl = initialUrl;
  for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
    const response = await requestGithubAdvisoryPage(pageUrl, {
      requestImpl,
      timeoutMs,
      token,
    });
    advisories.push(...response.advisories);
    if (advisories.length > GITHUB_MAX_ADVISORIES) {
      throw new Error('GitHub Advisory API exceeded its advisory limit.');
    }
    const nextUrl = nextGithubAdvisoryUrl(response.link, initialUrl);
    if (!nextUrl) {
      return { advisories, link: '' };
    }
    pageUrl = nextUrl;
  }
  throw new Error('GitHub Advisory API exceeded its pagination limit.');
}

function githubAdvisoryId(url) {
  const match = /^https:\/\/github\.com\/advisories\/(GHSA-[0-9a-z-]+)$/iu.exec(url);
  return match?.[1].toUpperCase();
}

function validateKnownAdvisoryMetadata(advisory, label) {
  if (advisory.cwe !== undefined) {
    if (
      !Array.isArray(advisory.cwe)
      || advisory.cwe.some(value => typeof value !== 'string' || value.length === 0)
    ) {
      throw new Error(`${label}.cwe is invalid.`);
    }
  }
  if (advisory.cvss !== undefined && advisory.cvss !== null) {
    if (
      !isRecord(advisory.cvss)
      || !Number.isFinite(advisory.cvss.score)
      || advisory.cvss.score < 0
      || advisory.cvss.score > 10
      || !(
        typeof advisory.cvss.vectorString === 'string'
        || advisory.cvss.vectorString === null
      )
    ) {
      throw new Error(`${label}.cvss is invalid.`);
    }
  }
}

function normalizeAdvisory(packageName, advisory, index) {
  const label = `${packageName} advisory[${index}]`;
  if (!isRecord(advisory)) {
    throw new Error(`${label} is invalid.`);
  }
  const validId =
    (Number.isSafeInteger(advisory.id) && advisory.id > 0)
    || (
      typeof advisory.id === 'string'
      && advisory.id.length > 0
      && advisory.id.length <= 200
    );
  if (!validId) {
    throw new Error(`${label}.id is invalid.`);
  }
  for (const field of ['url', 'title', 'severity', 'vulnerable_versions']) {
    if (
      typeof advisory[field] !== 'string'
      || advisory[field].length === 0
      || advisory[field].length > 4_096
    ) {
      throw new Error(`${label}.${field} is invalid.`);
    }
  }
  if (!Object.hasOwn(severityRank, advisory.severity)) {
    throw new Error(`${label}.severity is unknown.`);
  }
  let advisoryUrl;
  try {
    advisoryUrl = new URL(advisory.url);
  } catch {
    throw new Error(`${label}.url is invalid.`);
  }
  if (advisoryUrl.protocol !== 'https:' || advisoryUrl.username || advisoryUrl.password) {
    throw new Error(`${label}.url must be a credential-free HTTPS URL.`);
  }
  if (advisory.name !== undefined && advisory.name !== packageName) {
    throw new Error(`${label}.name does not match its response package.`);
  }
  if (
    advisory.github_advisory_id !== undefined
    && (
      typeof advisory.github_advisory_id !== 'string'
      || advisory.github_advisory_id.length === 0
    )
  ) {
    throw new Error(`${label}.github_advisory_id is invalid.`);
  }
  validateKnownAdvisoryMetadata(advisory, label);

  const derivedGhsa = githubAdvisoryId(advisory.url);
  if (
    advisory.github_advisory_id !== undefined
    && derivedGhsa !== undefined
    && advisory.github_advisory_id.toUpperCase() !== derivedGhsa
  ) {
    throw new Error(`${label}.github_advisory_id does not match its URL.`);
  }
  return {
    id: advisory.id,
    module_name: packageName,
    title: advisory.title,
    severity: advisory.severity,
    url: advisory.url,
    vulnerable_versions: advisory.vulnerable_versions,
    ...(derivedGhsa || advisory.github_advisory_id
      ? { github_advisory_id: derivedGhsa ?? advisory.github_advisory_id }
      : {}),
  };
}

export function validateBulkAdvisoryDocument(document, expectedPackages) {
  if (!isRecord(document)) {
    throw new Error('npm bulk audit returned an invalid top-level document.');
  }
  const normalized = new Map();
  let advisoryCount = 0;

  for (const [packageName, advisories] of Object.entries(document)) {
    validatePackageName(packageName, 'npm bulk audit response package');
    if (!expectedPackages.has(packageName)) {
      throw new Error(`npm bulk audit returned an unrequested package ${packageName}.`);
    }
    if (!Array.isArray(advisories)) {
      throw new Error(`npm bulk audit response for ${packageName} must be an array.`);
    }
    const seenIds = new Set();
    const normalizedAdvisories = advisories.map((advisory, index) => {
      advisoryCount += 1;
      if (advisoryCount > MAX_ADVISORIES) {
        throw new Error('npm bulk audit response exceeded its advisory limit.');
      }
      const value = normalizeAdvisory(packageName, advisory, index);
      const id = value.github_advisory_id ?? String(value.id);
      if (seenIds.has(id)) {
        throw new Error(`npm bulk audit returned duplicate advisory ${id} for ${packageName}.`);
      }
      seenIds.add(id);
      return value;
    });
    normalized.set(packageName, normalizedAdvisories);
  }

  return normalized;
}

function advisoryIdentity(advisory) {
  return `${advisory.module_name}\u0000${advisory.github_advisory_id ?? advisory.id}`;
}

function sameAdvisory(left, right) {
  return left.module_name === right.module_name
    && left.title === right.title
    && left.severity === right.severity
    && left.url === right.url
    && left.github_advisory_id === right.github_advisory_id;
}

export async function auditProductionDependencies(
  dependencyIndex,
  {
    requestRound = requestBulkAdvisories,
    overallTimeoutMs = AUDIT_TOTAL_TIMEOUT_MS,
    maxRoundAttempts = AUDIT_MAX_ROUND_ATTEMPTS,
    retryDelayMs = AUDIT_RETRY_DELAY_MS,
    maxConcurrentRounds = AUDIT_MAX_CONCURRENT_ROUNDS,
  } = {},
) {
  const rounds = buildAuditRounds(dependencyIndex);
  const merged = new Map();
  if (!Number.isSafeInteger(overallTimeoutMs) || overallTimeoutMs <= 0) {
    throw new Error('npm bulk audit overall timeout is invalid.');
  }
  if (!Number.isSafeInteger(maxRoundAttempts) || maxRoundAttempts < 1 || maxRoundAttempts > 5) {
    throw new Error('npm bulk audit round attempt count is invalid.');
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) {
    throw new Error('npm bulk audit retry delay is invalid.');
  }
  if (
    !Number.isSafeInteger(maxConcurrentRounds)
    || maxConcurrentRounds < 1
    || maxConcurrentRounds > 8
  ) {
    throw new Error('npm bulk audit round concurrency is invalid.');
  }

  const startedAt = Date.now();
  const requestAuditRound = async (round, roundIndex) => {
    let document;
    for (let attempt = 1; attempt <= maxRoundAttempts; attempt += 1) {
      const remainingMs = overallTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw transientAuditError(
          `npm bulk audit exceeded its ${overallTimeoutMs}ms overall timeout.`,
        );
      }
      const overallTimeoutError =
        transientAuditError(`npm bulk audit exceeded its ${overallTimeoutMs}ms overall timeout.`);
      let timeout;
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(overallTimeoutError), remainingMs);
      });
      try {
        document = await Promise.race([
          Promise.resolve().then(() => requestRound(round.payload)),
          timeoutPromise,
        ]);
        break;
      } catch (error) {
        if (error === overallTimeoutError) {
          throw error;
        }
        if (error?.auditTransient !== true) {
          throw error;
        }
        if (attempt === maxRoundAttempts) {
          const attemptLabel = maxRoundAttempts === 1 ? 'attempt' : 'attempts';
          const roundError = new Error(
            `npm bulk audit round ${roundIndex + 1}/${rounds.length} failed after `
            + `${maxRoundAttempts} ${attemptLabel}: ${error.message}`,
          );
          roundError.auditTransient = true;
          throw roundError;
        }
        const delayMs = retryDelayMs * (2 ** (attempt - 1));
        const remainingAfterFailureMs = overallTimeoutMs - (Date.now() - startedAt);
        if (remainingAfterFailureMs <= delayMs) {
          throw transientAuditError(
            `npm bulk audit exceeded its ${overallTimeoutMs}ms overall timeout.`,
          );
        }
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    return document;
  };

  const documents = new Array(rounds.length);
  let nextRoundIndex = 0;
  const worker = async () => {
    while (nextRoundIndex < rounds.length) {
      const roundIndex = nextRoundIndex;
      nextRoundIndex += 1;
      documents[roundIndex] = await requestAuditRound(rounds[roundIndex], roundIndex);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(maxConcurrentRounds, rounds.length) },
      () => worker(),
    ),
  );

  let totalAdvisoryRecords = 0;
  for (const [roundIndex, round] of rounds.entries()) {
    const response = validateBulkAdvisoryDocument(
      documents[roundIndex],
      new Set(Object.keys(round.payload)),
    );
    totalAdvisoryRecords += [...response.values()]
      .reduce((count, advisories) => count + advisories.length, 0);
    if (totalAdvisoryRecords > MAX_TOTAL_ADVISORY_RECORDS) {
      throw new Error('npm bulk audit exceeded its aggregate advisory limit.');
    }
    for (const [packageName, advisories] of response) {
      const exactVersion = round.exactVersions.get(packageName);
      if (!exactVersion) {
        throw new Error(`npm bulk audit returned unbound evidence for ${packageName}.`);
      }
      for (const advisory of advisories) {
        const identity = advisoryIdentity(advisory);
        let record = merged.get(identity);
        if (!record) {
          record = {
            advisory,
            findings: new Map(),
            ids: new Set([advisory.id]),
            vulnerableVersions: new Set([advisory.vulnerable_versions]),
          };
          merged.set(identity, record);
        } else if (!sameAdvisory(record.advisory, advisory)) {
          throw new Error(
            `npm bulk audit returned inconsistent advisory ${advisory.github_advisory_id ?? advisory.id}.`,
          );
        } else {
          record.ids.add(advisory.id);
          record.vulnerableVersions.add(advisory.vulnerable_versions);
        }
        record.findings.set(exactVersion.version, new Set(exactVersion.paths));
      }
    }
  }

  const advisories = [...merged.values()]
    .map(({ advisory, findings, ids, vulnerableVersions }) => {
      const normalizedFindings = [...findings.entries()]
        .map(([version, paths]) => ({
          version,
          paths: [...paths].sort(compareStrings),
        }))
        .sort((left, right) => compareStrings(left.version, right.version));
      return {
        ...advisory,
        id: [...ids].sort((left, right) =>
          compareStrings(String(left), String(right))
        )[0],
        vulnerable_versions: [...vulnerableVersions]
          .sort(compareStrings)
          .join(' || '),
        findings: normalizedFindings,
        paths: [...new Set(normalizedFindings.flatMap(finding => finding.paths))]
          .sort(compareStrings),
      };
    })
    .sort((left, right) =>
      compareStrings(left.module_name, right.module_name)
      || compareStrings(
        left.github_advisory_id ?? String(left.id),
        right.github_advisory_id ?? String(right.id),
      )
    );

  const vulnerabilities = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const advisory of advisories) {
    vulnerabilities[advisory.severity] += 1;
  }
  return { advisories, metadata: { vulnerabilities } };
}

function githubAdvisoryBatches(dependencyIndex) {
  const batches = [];
  for (const round of buildAuditRounds(dependencyIndex)) {
    let entries = [];
    for (const [packageName, exactVersion] of round.exactVersions) {
      const entry = {
        packageName,
        version: exactVersion.version,
        paths: exactVersion.paths,
        spec: `${packageName}@${exactVersion.version}`,
      };
      const candidate = [...entries, entry];
      const candidateUrl = githubAdvisoryRequestUrl(candidate.map(value => value.spec));
      if (
        entries.length > 0
        && (
          candidate.length > GITHUB_MAX_BATCH_SPECS
          || Buffer.byteLength(candidateUrl.toString()) > GITHUB_MAX_INITIAL_URL_BYTES
        )
      ) {
        batches.push(entries);
        entries = [entry];
      } else {
        entries = candidate;
      }
      if (
        Buffer.byteLength(
          githubAdvisoryRequestUrl(entries.map(value => value.spec)).toString(),
        ) > GITHUB_MAX_INITIAL_URL_BYTES
      ) {
        throw new Error(`GitHub Advisory package version ${entry.spec} exceeds the URL limit.`);
      }
    }
    if (entries.length > 0) {
      batches.push(entries);
    }
  }
  if (batches.length === 0 || batches.length > 256) {
    throw new Error('GitHub Advisory audit produced an invalid batch count.');
  }
  return batches;
}

function normalizeGithubAdvisory(document, index) {
  const label = `GitHub Advisory response[${index}]`;
  if (!isRecord(document)) {
    throw new Error(`${label} is invalid.`);
  }
  if (
    typeof document.ghsa_id !== 'string'
    || !/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/iu.test(document.ghsa_id)
  ) {
    throw new Error(`${label}.ghsa_id is invalid.`);
  }
  const ghsaId = document.ghsa_id.toUpperCase();
  if (document.type !== 'reviewed') {
    throw new Error(`${label} must be GitHub-reviewed.`);
  }
  if (document.withdrawn_at !== null) {
    throw new Error(`${label} must not be withdrawn.`);
  }
  if (
    typeof document.summary !== 'string'
    || document.summary.length === 0
    || document.summary.length > 4_096
  ) {
    throw new Error(`${label}.summary is invalid.`);
  }
  if (githubAdvisoryId(document.html_url) !== ghsaId) {
    throw new Error(`${label}.html_url is invalid.`);
  }
  const severity = document.severity === 'medium' ? 'moderate' : document.severity;
  if (!Object.hasOwn(severityRank, severity) || severity === 'info') {
    throw new Error(`${label}.severity is unknown.`);
  }
  if (!Array.isArray(document.vulnerabilities) || document.vulnerabilities.length === 0) {
    throw new Error(`${label}.vulnerabilities is invalid.`);
  }

  const rangesByPackage = new Map();
  for (const [vulnerabilityIndex, vulnerability] of document.vulnerabilities.entries()) {
    if (!isRecord(vulnerability) || !isRecord(vulnerability.package)) {
      throw new Error(`${label}.vulnerabilities[${vulnerabilityIndex}] is invalid.`);
    }
    if (vulnerability.package.ecosystem !== 'npm') {
      continue;
    }
    const packageName = validatePackageName(
      vulnerability.package.name,
      `${label}.vulnerabilities[${vulnerabilityIndex}].package.name`,
    );
    if (
      typeof vulnerability.vulnerable_version_range !== 'string'
      || vulnerability.vulnerable_version_range.length === 0
      || vulnerability.vulnerable_version_range.length > 4_096
    ) {
      throw new Error(
        `${label}.vulnerabilities[${vulnerabilityIndex}].vulnerable_version_range is invalid.`,
      );
    }
    let ranges = rangesByPackage.get(packageName);
    if (!ranges) {
      ranges = new Set();
      rangesByPackage.set(packageName, ranges);
    }
    ranges.add(vulnerability.vulnerable_version_range);
  }
  if (rangesByPackage.size === 0) {
    throw new Error(`${label} has no npm vulnerability records.`);
  }
  return {
    ghsaId,
    title: document.summary,
    severity,
    url: document.html_url,
    rangesByPackage,
  };
}

function sameGithubAdvisory(left, right) {
  return left.ghsaId === right.ghsaId
    && left.title === right.title
    && left.severity === right.severity
    && left.url === right.url;
}

function validateGithubAdvisoryResponse(response) {
  if (!isRecord(response) || !Array.isArray(response.advisories)) {
    throw new Error('GitHub Advisory request returned an invalid response.');
  }
  if (response.link !== '') {
    throw new Error('GitHub Advisory request returned an unconsumed paginated response.');
  }
  return response.advisories;
}

async function runGithubAdvisoryAudit(
  dependencyIndex,
  { requestAdvisories },
) {
  const catalog = new Map();
  for (const batch of githubAdvisoryBatches(dependencyIndex)) {
    const packageVersions = batch.map(entry => entry.spec);
    const batchEntries = new Map(batch.map(entry => [entry.packageName, entry]));
    const advisories = validateGithubAdvisoryResponse(
      await requestAdvisories(packageVersions),
    );
    for (const [index, document] of advisories.entries()) {
      const advisory = normalizeGithubAdvisory(document, index);
      let catalogEntry = catalog.get(advisory.ghsaId);
      if (!catalogEntry) {
        catalogEntry = { advisory, candidates: new Map() };
        catalog.set(advisory.ghsaId, catalogEntry);
      } else if (!sameGithubAdvisory(catalogEntry.advisory, advisory)) {
        throw new Error(`GitHub Advisory ${advisory.ghsaId} returned inconsistent metadata.`);
      }
      let boundCandidates = 0;
      for (const packageName of advisory.rangesByPackage.keys()) {
        const entry = batchEntries.get(packageName);
        if (entry) {
          catalogEntry.candidates.set(entry.spec, entry);
          boundCandidates += 1;
        }
      }
      if (boundCandidates === 0) {
        throw new Error(`GitHub Advisory ${advisory.ghsaId} returned unbound evidence.`);
      }
    }
  }

  const verifiedHighSpecs = new Map();
  const verificationTasks = [];
  for (const { advisory, candidates } of catalog.values()) {
    if (severityRank[advisory.severity] < severityRank.high) {
      continue;
    }
    for (const entry of candidates.values()) {
      verificationTasks.push({ advisory, entry });
    }
  }
  let nextVerification = 0;
  const verifyWorker = async () => {
    while (nextVerification < verificationTasks.length) {
      const taskIndex = nextVerification;
      nextVerification += 1;
      const { advisory, entry } = verificationTasks[taskIndex];
      const documents = validateGithubAdvisoryResponse(
        await requestAdvisories([entry.spec], { ghsaId: advisory.ghsaId }),
      );
      if (documents.length === 0) {
        continue;
      }
      if (documents.length !== 1) {
        throw new Error(`GitHub Advisory ${advisory.ghsaId} exact verification was ambiguous.`);
      }
      const verified = normalizeGithubAdvisory(documents[0], 0);
      if (
        !sameGithubAdvisory(advisory, verified)
        || !verified.rangesByPackage.has(entry.packageName)
      ) {
        throw new Error(`GitHub Advisory ${advisory.ghsaId} exact verification was inconsistent.`);
      }
      let specs = verifiedHighSpecs.get(advisory.ghsaId);
      if (!specs) {
        specs = new Set();
        verifiedHighSpecs.set(advisory.ghsaId, specs);
      }
      specs.add(entry.spec);
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          GITHUB_MAX_CONCURRENT_VERIFICATIONS,
          Math.max(1, verificationTasks.length),
        ),
      },
      () => verifyWorker(),
    ),
  );

  const merged = new Map();
  for (const { advisory, candidates } of catalog.values()) {
    const verifiedSpecs = verifiedHighSpecs.get(advisory.ghsaId);
    if (
      severityRank[advisory.severity] >= severityRank.high
      && (!verifiedSpecs || verifiedSpecs.size === 0)
    ) {
      throw new Error(`GitHub Advisory ${advisory.ghsaId} could not bind an exact version.`);
    }
    for (const entry of candidates.values()) {
      if (
        severityRank[advisory.severity] >= severityRank.high
        && !verifiedSpecs.has(entry.spec)
      ) {
        continue;
      }
      const key = `${entry.packageName}\u0000${advisory.ghsaId}`;
      let record = merged.get(key);
      if (!record) {
        const ranges = advisory.rangesByPackage.get(entry.packageName);
        record = {
          advisory: normalizeAdvisory(entry.packageName, {
            id: advisory.ghsaId,
            github_advisory_id: advisory.ghsaId,
            title: advisory.title,
            severity: advisory.severity,
            url: advisory.url,
            vulnerable_versions: [...ranges].sort(compareStrings).join(' || '),
          }, 0),
          findings: new Map(),
        };
        merged.set(key, record);
      }
      record.findings.set(entry.version, new Set(entry.paths));
    }
  }

  const advisories = [...merged.values()]
    .map(({ advisory, findings }) => {
      const normalizedFindings = [...findings.entries()]
        .map(([version, paths]) => ({
          version,
          paths: [...paths].sort(compareStrings),
        }))
        .sort((left, right) => compareStrings(left.version, right.version));
      return {
        ...advisory,
        findings: normalizedFindings,
        paths: [...new Set(normalizedFindings.flatMap(finding => finding.paths))]
          .sort(compareStrings),
      };
    })
    .sort((left, right) =>
      compareStrings(left.module_name, right.module_name)
      || compareStrings(left.github_advisory_id, right.github_advisory_id)
    );
  const vulnerabilities = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const advisory of advisories) {
    vulnerabilities[advisory.severity] += 1;
  }
  return { advisories, metadata: { vulnerabilities } };
}

export async function auditProductionDependenciesWithGithubAdvisories(
  dependencyIndex,
  {
    requestAdvisories = requestGithubAdvisories,
    overallTimeoutMs = GITHUB_OVERALL_TIMEOUT_MS,
  } = {},
) {
  if (!Number.isSafeInteger(overallTimeoutMs) || overallTimeoutMs <= 0) {
    throw new Error('GitHub Advisory overall timeout is invalid.');
  }
  let timer;
  const timeoutError =
    new Error(`GitHub Advisory audit exceeded its ${overallTimeoutMs}ms overall timeout.`);
  try {
    return await Promise.race([
      runGithubAdvisoryAudit(dependencyIndex, { requestAdvisories }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), overallTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function auditProductionDependenciesWithFallback(
  dependencyIndex,
  {
    auditNpm = auditProductionDependencies,
    auditGithub = auditProductionDependenciesWithGithubAdvisories,
    onFallback = () => {},
  } = {},
) {
  try {
    return await auditNpm(dependencyIndex);
  } catch (npmError) {
    if (npmError?.auditTransient !== true) {
      throw npmError;
    }
    onFallback(
      `npm production audit unavailable (${npmError.message}); `
      + 'using GitHub Advisory exact-version fallback.',
    );
    try {
      return await auditGithub(dependencyIndex);
    } catch (githubError) {
      throw new Error(
        `npm production audit failed: ${npmError.message}; `
        + `GitHub Advisory fallback failed: ${githubError.message}`,
      );
    }
  }
}

async function readSuppressions() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(suppressionPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read ${path.relative(rootDir, suppressionPath)}: ${error.message}`);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.suppressions)) {
    throw new Error('Audit suppression file must contain a top-level suppressions array.');
  }
  return parsed.suppressions;
}

function advisoryId(advisory) {
  return advisory.github_advisory_id || String(advisory.id);
}

function validateSuppression(suppression, index, now = new Date()) {
  const prefix = `suppression[${index}]`;
  if (!isRecord(suppression)) {
    throw new Error(`${prefix} must be an object.`);
  }
  for (const field of ['id', 'package', 'reason', 'owner', 'reviewCondition', 'expires']) {
    if (typeof suppression[field] !== 'string' || suppression[field].trim() === '') {
      throw new Error(`${prefix}.${field} is required.`);
    }
  }
  if (!Array.isArray(suppression.paths) || suppression.paths.length === 0) {
    throw new Error(`${prefix}.paths must list every accepted advisory path.`);
  }
  for (const advisoryPath of suppression.paths) {
    if (typeof advisoryPath !== 'string' || advisoryPath.trim() === '') {
      throw new Error(`${prefix}.paths contains an empty path.`);
    }
  }
  if (new Set(suppression.paths).size !== suppression.paths.length) {
    throw new Error(`${prefix}.paths must not contain duplicates.`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/u.test(suppression.expires)) {
    throw new Error(`${prefix}.expires must be an ISO date.`);
  }
  const expires = new Date(`${suppression.expires}T23:59:59Z`);
  if (
    Number.isNaN(expires.getTime())
    || expires.toISOString().slice(0, 10) !== suppression.expires
  ) {
    throw new Error(`${prefix}.expires must be an ISO date.`);
  }
  if (expires < now) {
    throw new Error(`${prefix} expired on ${suppression.expires}. Review or remove it.`);
  }
}

function matchingSuppression(advisory, suppressions) {
  const id = advisoryId(advisory);
  return suppressions.find(suppression =>
    suppression.id === id
    && suppression.package === advisory.module_name
  );
}

function formatAdvisory(advisory, paths = advisory.paths) {
  const formattedPaths = paths.map(auditPath => `    - ${auditPath}`).join('\n');
  return `${advisory.severity.toUpperCase()} ${advisory.module_name} ${advisoryId(advisory)}\n`
    + `  ${advisory.title}\n`
    + `  ${advisory.url}\n`
    + formattedPaths;
}

export function evaluateAuditReport(report, suppressions, { now = new Date() } = {}) {
  if (
    !isRecord(report)
    || !Array.isArray(report.advisories)
    || !isRecord(report.metadata?.vulnerabilities)
  ) {
    throw new Error('Production audit report is invalid.');
  }
  suppressions.forEach((suppression, index) => validateSuppression(suppression, index, now));

  const failures = [];
  const usedSuppressions = new Set();
  const highAdvisories = report.advisories.filter(
    advisory => severityRank[advisory.severity] >= severityRank.high,
  );
  for (const advisory of highAdvisories) {
    if (!Array.isArray(advisory.paths) || advisory.paths.length === 0) {
      throw new Error(`Production advisory ${advisoryId(advisory)} has no exact paths.`);
    }
    const suppression = matchingSuppression(advisory, suppressions);
    if (!suppression) {
      failures.push(formatAdvisory(advisory));
      continue;
    }

    usedSuppressions.add(suppression);
    const acceptedPaths = new Set(suppression.paths);
    const uncoveredPaths = advisory.paths.filter(auditPath => !acceptedPaths.has(auditPath));
    const currentPaths = new Set(advisory.paths);
    const extraPaths = suppression.paths.filter(auditPath => !currentPaths.has(auditPath));
    if (uncoveredPaths.length > 0) {
      failures.push(formatAdvisory(advisory, uncoveredPaths));
    }
    if (extraPaths.length > 0) {
      const extraList = extraPaths.map(auditPath => `    - ${auditPath}`).join('\n');
      failures.push(
        `Production audit suppression ${advisoryId(advisory)} includes inactive paths:\n`
        + extraList,
      );
    }
  }

  const staleSuppressions = suppressions.filter(suppression => !usedSuppressions.has(suppression));
  if (staleSuppressions.length > 0) {
    const staleList = staleSuppressions
      .map(suppression => `  - ${suppression.id} ${suppression.package}`)
      .join('\n');
    failures.push(`Stale production audit suppressions must be removed:\n${staleList}`);
  }
  return failures;
}

async function main() {
  const suppressions = await readSuppressions();
  const listDocument = parsePnpmProductionList(await runPnpmProductionList());
  const expectedWorkspacePaths = await loadExpectedWorkspacePaths(rootDir);
  const dependencyIndex = buildProductionDependencyIndex(
    listDocument,
    rootDir,
    expectedWorkspacePaths,
  );
  const report = await auditProductionDependenciesWithFallback(dependencyIndex, {
    onFallback: message => process.stderr.write(`${message}\n`),
  });
  const failures = evaluateAuditReport(report, suppressions);

  if (failures.length > 0) {
    process.stderr.write(
      'Production high/critical audit gate failed.\n'
      + 'Upgrade the dependency, add a scoped override, or document a short-term suppression with owner, reason, reviewCondition, expires, and exact paths.\n\n'
      + failures.join('\n\n')
      + '\n',
    );
    process.exitCode = 1;
    return;
  }

  const metadata = report.metadata.vulnerabilities;
  const counts =
    `low=${metadata.low}, moderate=${metadata.moderate}, `
    + `high=${metadata.high}, critical=${metadata.critical}`;
  process.stdout.write(`Production audit gate passed (${counts}).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
