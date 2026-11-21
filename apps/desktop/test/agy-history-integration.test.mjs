import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop as stopEsbuild } from 'esbuild';

const desktopDir = path.resolve(import.meta.dirname, '..');
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];

async function resolveDesktopSource(importPath) {
  const basePath = path.join(desktopDir, 'src', importPath.slice(2));
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

const aliasPlugin = {
  name: 'ccem-desktop-alias',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = await resolveDesktopSource(args.path);
      if (!resolved) return { errors: [{ text: `Could not resolve ${args.path}` }] };
      return { path: resolved };
    });
    builder.onResolve({ filter: /^@tauri-apps\/api/ }, () => ({
      path: 'tauri-stub',
      namespace: 'agy-history-stubs',
    }));
    builder.onLoad({ filter: /^tauri-stub$/, namespace: 'agy-history-stubs' }, () => ({
      loader: 'js',
      contents: `export function invoke() { return Promise.resolve(null); }`,
    }));
  },
};

let tempDir;
let historyData;
let messageContentUtils;
let sessionLinks;
let sidebarSessions;

test.before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-agy-history-test-'));
  const entry = path.join(tempDir, 'entry.ts');
  await fs.writeFile(
    entry,
    `
      export * as historyData from ${JSON.stringify(path.join(desktopDir, 'src/features/conversations/historyData.ts'))};
      export * as messageContentUtils from ${JSON.stringify(path.join(desktopDir, 'src/components/conversation/messageContentUtils.ts'))};
      export * as sessionLinks from ${JSON.stringify(path.join(desktopDir, 'src/components/workspace/sessionLinks.ts'))};
      export * as sidebarSessions from ${JSON.stringify(path.join(desktopDir, 'src/components/workspace/workspaceSidebarSessions.ts'))};
    `,
    'utf8',
  );
  const outfile = path.join(tempDir, 'bundle.mjs');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins: [aliasPlugin],
  });
  const mod = await import(pathToFileURL(outfile).href);
  historyData = mod.historyData;
  messageContentUtils = mod.messageContentUtils;
  sessionLinks = mod.sessionLinks;
  sidebarSessions = mod.sidebarSessions;
});

test.after(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  stopEsbuild();
});

test('normalizeHistorySource and normalizeHistorySessions retain agy sessions', () => {
  assert.equal(historyData.normalizeHistorySource('agy'), 'agy');
  assert.equal(historyData.normalizeHistorySource('AGY'), 'agy');
  assert.equal(historyData.normalizeHistorySource('unknown'), null);

  const normalized = historyData.normalizeHistorySessions([
    {
      id: 'c031dd2e-2892-48f2-9960-754a920072b9',
      source: 'agy',
      display: 'Ccem Add Agy Session Token Stats',
      timestamp: 1795240730000,
      project: '/Users/wzt/G/Github/claude-code-env-manager',
      projectName: 'claude-code-env-manager',
    },
    {
      id: 'bad-1',
      source: 'mystery',
      display: 'Should drop',
      timestamp: 1,
      project: '/tmp',
      projectName: 'tmp',
    },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].source, 'agy');
  assert.equal(normalized[0].id, 'c031dd2e-2892-48f2-9960-754a920072b9');
});

test('normalizeWorkspaceOverviewSnapshot retains resumable agy sessions in project tree', () => {
  const snapshot = historyData.normalizeWorkspaceOverviewSnapshot({
    sessions: [
      {
        id: 'agy-conv-1',
        source: 'agy',
        display: 'Antigravity Thread',
        timestamp: 1795240730000,
        project: '/repo/demo',
        projectName: 'demo',
      },
      {
        id: 'dsh-1',
        source: 'dsh',
        display: 'DSH Read-Only',
        timestamp: 1795240720000,
        project: '/repo/demo',
        projectName: 'demo',
      },
    ],
    projectNodes: [
      {
        project: '/repo/demo',
        projectName: 'demo',
        latestTimestamp: 1795240730000,
        sessionKeys: ['agy:agy-conv-1', 'dsh:dsh-1'],
      },
    ],
    totalSessions: 2,
    totalProjects: 1,
  });

  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].source, 'agy');
  assert.equal(snapshot.projectNodes[0].sessions.length, 1);
  assert.equal(snapshot.projectNodes[0].sessions[0].id, 'agy-conv-1');
});

test('extractToolSummary formats Antigravity tool calls concisely', () => {
  assert.equal(
    messageContentUtils.extractToolSummary('read_file', {
      Path: '/Users/wzt/repo/src/agy_history.rs',
    }),
    'src/agy_history.rs',
  );
  assert.equal(
    messageContentUtils.extractToolSummary('run_command', {
      CommandLine: 'cargo test --locked',
      toolSummary: 'Run Rust tests',
    }),
    'Run Rust tests',
  );
  assert.equal(
    messageContentUtils.extractToolSummary('search_web', {
      query: 'antigravity cli transcript.jsonl',
    }),
    'antigravity cli transcript.jsonl',
  );
  assert.equal(
    messageContentUtils.extractToolSummary('invoke_subagent', {
      Role: 'Backend Auditor',
      Prompt: 'Inspect history module',
    }),
    'Backend Auditor',
  );
  // Non-string unwrapped JSON values must never throw TypeError
  assert.equal(
    messageContentUtils.extractToolSummary('read_file', {
      Path: 12345,
      summary: '/repo/fallback.rs',
    }),
    'repo/fallback.rs',
  );
  assert.equal(
    messageContentUtils.extractToolSummary('run_command', {
      CommandLine: { cmd: 'ls' },
    }),
    '',
  );
});

test('disk-discovered agy sessions resolve providerSessionId and history deep links', () => {
  const session = {
    id: '1932ebed-861d-495d-b0bb-c22fafeb5f13',
    source: 'agy',
    display: 'CCEM and Agy Subscription Integration',
    timestamp: 1795240730000,
    project: '/Users/wzt/G/Github/claude-code-env-manager',
    projectName: 'claude-code-env-manager',
  };

  assert.equal(
    sidebarSessions.resolveWorkspaceReviewProviderSessionId(session),
    session.id,
  );
  const link = sessionLinks.buildCcemSessionLinkForHistorySession(session);
  assert.ok(link?.includes('source=agy'));
  assert.ok(link?.includes('idKind=provider'));
  assert.ok(link?.includes('focus=history'));
});
