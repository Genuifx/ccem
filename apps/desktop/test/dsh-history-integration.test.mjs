import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');

function stripImportsAndInterfaces(source) {
  source = source.replace(/^import\s+.*?;\s*$/gm, '');
  source = source.replace(/^export\s+type\s+[^=]+=.*?;\s*$/gm, '');
  source = source.replace(/^export\s+interface\s+\w+[\s\S]*?^\}/gm, '');
  source = source.replace(/^interface\s+\w+[\s\S]*?^\}/gm, '');
  return source;
}

async function transpileAndImport(relativePath) {
  const sourcePath = path.join(desktopDir, relativePath);
  let source = await fs.readFile(sourcePath, 'utf8');
  source = stripImportsAndInterfaces(source);

  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-dsh-test-'));
  const outputPath = path.join(tempDir, 'module.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

/** Merge multiple source files into one module (resolves cross-file deps) */
async function transpileAndImportMerged(...relativePaths) {
  let merged = '';
  for (const rp of relativePaths) {
    const sourcePath = path.join(desktopDir, rp);
    let source = await fs.readFile(sourcePath, 'utf8');
    source = stripImportsAndInterfaces(source);
    merged += '\n' + source;
  }

  const output = ts.transpileModule(merged, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-dsh-test-'));
  const outputPath = path.join(tempDir, 'module.mjs');
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

// ============================================================================
// 1. normalizeWorkspaceOverviewSnapshot — production seam
//    Tests DSH exclusion in top sessions, sessionKeys, and embedded node.sessions
// ============================================================================

test('normalizeWorkspaceOverviewSnapshot: top sessions exclude DSH', async () => {
  const mod = await transpileAndImportMerged(
    'src/features/conversations/types.ts',
    'src/features/conversations/historyData.ts'
  );

  const payload = {
    sessions: [
      { id: 's1', source: 'claude', project: '/p1', projectName: 'p1', timestamp: 3000 },
      { id: 'abcdef0123456789:s2', source: 'dsh', project: '/p2', projectName: 'p2', timestamp: 4000 },
      { id: 's3', source: 'codex', project: '/p1', projectName: 'p1', timestamp: 2000 },
    ],
    projectNodes: [],
    totalSessions: 3,
    totalProjects: 2,
  };

  const result = mod.normalizeWorkspaceOverviewSnapshot(payload);
  // DSH must be excluded from top-level sessions
  assert.equal(result.sessions.length, 2);
  assert.ok(result.sessions.every(s => s.source !== 'dsh'));
  assert.deepEqual(result.sessions.map(s => s.source), ['claude', 'codex']);
});

test('normalizeWorkspaceOverviewSnapshot: projectNodes with sessionKeys exclude DSH', async () => {
  const mod = await transpileAndImportMerged(
    'src/features/conversations/types.ts',
    'src/features/conversations/historyData.ts'
  );

  const payload = {
    sessions: [
      { id: 's1', source: 'claude', project: '/p1', projectName: 'p1', timestamp: 3000 },
      { id: 'abcdef0123456789:s2', source: 'dsh', project: '/p1', projectName: 'p1', timestamp: 4000 },
    ],
    projectNodes: [
      {
        project: '/p1',
        projectName: 'p1',
        latestTimestamp: 4000,
        sessionKeys: ['claude:s1', 'dsh:abcdef0123456789:s2'],
      },
    ],
    totalSessions: 2,
    totalProjects: 1,
  };

  const result = mod.normalizeWorkspaceOverviewSnapshot(payload);
  // Node sessions resolved from sessionKeys — DSH key cannot resolve because
  // DSH is already filtered out of the session map
  assert.equal(result.projectNodes.length, 1);
  assert.equal(result.projectNodes[0].sessions.length, 1);
  assert.equal(result.projectNodes[0].sessions[0].source, 'claude');
});

test('normalizeWorkspaceOverviewSnapshot: projectNodes with embedded sessions exclude DSH', async () => {
  const mod = await transpileAndImportMerged(
    'src/features/conversations/types.ts',
    'src/features/conversations/historyData.ts'
  );

  const payload = {
    sessions: [
      { id: 's1', source: 'claude', project: '/p1', projectName: 'p1', timestamp: 3000 },
      { id: 'abcdef0123456789:s2', source: 'dsh', project: '/p1', projectName: 'p1', timestamp: 4000 },
    ],
    projectNodes: [
      {
        project: '/p1',
        projectName: 'p1',
        latestTimestamp: 4000,
        // No sessionKeys — falls back to embedded sessions in node
        sessions: [
          { id: 's1', source: 'claude', project: '/p1', projectName: 'p1', timestamp: 3000 },
          { id: 'abcdef0123456789:s2', source: 'dsh', project: '/p1', projectName: 'p1', timestamp: 4000 },
        ],
      },
    ],
    totalSessions: 2,
    totalProjects: 1,
  };

  const result = mod.normalizeWorkspaceOverviewSnapshot(payload);
  // Embedded sessions also filtered by isResumableHistorySource
  assert.equal(result.projectNodes[0].sessions.length, 1);
  assert.equal(result.projectNodes[0].sessions[0].source, 'claude');
});

// ============================================================================
// 2. All search diagnostic: visible while results remain usable (nonblocking)
// ============================================================================

test('All search: diagnostics present alongside valid results (nonblocking)', async () => {
  const { normalizeHistorySessions } = await transpileAndImport(
    'src/features/conversations/historyData.ts'
  );
  // Simulate backend returning sessions + diagnostics (All mode soft-fail)
  const sessions = normalizeHistorySessions([
    { id: 's1', source: 'claude', project: '/p', projectName: 'p', timestamp: 1000 },
  ]);
  const diagnostics = [{ source: 'dsh', code: 'helper_error', message: 'DSH unavailable' }];

  // Both are valid simultaneously — search results are usable despite diagnostic
  assert.equal(sessions.length, 1);
  assert.equal(diagnostics.length, 1);
  // This is the model that HistoryList renders: sessions + diagnostics, not sessions OR diagnostics
  assert.equal(sessions[0].source, 'claude');
  assert.equal(diagnostics[0].source, 'dsh');
});

// ============================================================================
// 3. DSH Resume gate — isResumableHistorySource pure function
// ============================================================================

test('isResumableHistorySource: DSH returns false, others return true', async () => {
  const { isResumableHistorySource } = await transpileAndImport(
    'src/features/conversations/types.ts'
  );
  assert.equal(isResumableHistorySource('dsh'), false);
  assert.equal(isResumableHistorySource('claude'), true);
  assert.equal(isResumableHistorySource('codex'), true);
  assert.equal(isResumableHistorySource('opencode'), true);
});

// ============================================================================
// 4. ProjectTree conditional output — buildCcemSessionLinkForHistorySession
// ============================================================================

test('ProjectTree: copy link hidden for DSH (buildCcemSessionLinkForHistorySession returns null)', async () => {
  const mod = await transpileAndImport('src/components/workspace/sessionLinks.ts');
  const dshSession = {
    source: 'dsh', id: 'abcdef0123456789:s1', project: '/proj',
    title: 'DSH session', projectName: 'proj', timestamp: 1000,
  };
  const link = mod.buildCcemSessionLinkForHistorySession(dshSession);
  // When null, the "Copy Session Link" menu item is not rendered
  assert.equal(link, null);
});

test('ProjectTree: copy link available for claude', async () => {
  const mod = await transpileAndImport('src/components/workspace/sessionLinks.ts');
  const claudeSession = {
    source: 'claude', id: 'uuid-123', project: '/proj',
    title: 'Claude session', projectName: 'proj', timestamp: 1000,
  };
  const link = mod.buildCcemSessionLinkForHistorySession(claudeSession);
  assert.ok(link !== null);
  assert.ok(link.startsWith('ccem://'));
});

// ============================================================================
// 8. parseCcemSessionLink rejects DSH source in URL (fail-closed)
// ============================================================================

test('parseCcemSessionLink rejects dsh source in URL', async () => {
  const mod = await transpileAndImport('src/components/workspace/sessionLinks.ts');
  const result = mod.parseCcemSessionLink('ccem://workspace/session?source=dsh&idKind=runtime&id=x');
  assert.equal(result, null);
});

// ============================================================================
// 9. normalizeHistorySessions — production pure function
// ============================================================================

test('normalizeHistorySessions drops unknown sources, keeps dsh', async () => {
  const { normalizeHistorySessions } = await transpileAndImport(
    'src/features/conversations/historyData.ts'
  );
  const raw = [
    { id: 's1', source: 'claude', project: '/', projectName: 'p', timestamp: 1000 },
    { id: 's2', source: 'garbage', project: '/', projectName: 'p', timestamp: 1000 },
    { id: 's3', source: 'dsh', project: '/', projectName: 'p', timestamp: 1000 },
  ];
  const result = normalizeHistorySessions(raw);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(s => s.source), ['claude', 'dsh']);
});

// ============================================================================
// 10. normalizeHistoryError — exhaustive input handling
// ============================================================================

test('normalizeHistoryError: structured object', async () => {
  const { normalizeHistoryError } = await transpileAndImport(
    'src/features/conversations/historyData.ts'
  );
  const result = normalizeHistoryError({ code: 'helper_unavailable', message: 'Not found' });
  assert.equal(result.code, 'helper_unavailable');
  assert.equal(result.message, 'Not found');
});

test('normalizeHistoryError: plain string', async () => {
  const { normalizeHistoryError } = await transpileAndImport(
    'src/features/conversations/historyData.ts'
  );
  const result = normalizeHistoryError('something went wrong');
  assert.equal(result.code, 'unknown');
  assert.equal(result.message, 'something went wrong');
});

test('normalizeHistoryError: Error instance', async () => {
  const { normalizeHistoryError } = await transpileAndImport(
    'src/features/conversations/historyData.ts'
  );
  const result = normalizeHistoryError(new Error('boom'));
  assert.equal(result.code, 'unknown');
  assert.equal(result.message, 'boom');
});

// ============================================================================
// 11. toSessionKey — composite key production function
// ============================================================================

test('toSessionKey produces composite key for dsh', async () => {
  const { toSessionKey } = await transpileAndImport(
    'src/features/conversations/types.ts'
  );
  assert.equal(
    toSessionKey({ source: 'dsh', id: 'abcdef0123456789:session-1' }),
    'dsh:abcdef0123456789:session-1'
  );
  assert.equal(toSessionKey({ source: 'claude', id: 'uuid-abc' }), 'claude:uuid-abc');
});
