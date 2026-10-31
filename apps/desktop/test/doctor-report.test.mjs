import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const execFileAsync = promisify(execFile);

async function importTsModule(relativePath, outputName) {
  const sourcePath = path.join(desktopDir, ...relativePath);
  const source = await fs.readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccem-doctor-report-test-'));
  const outputPath = path.join(tempDir, outputName);
  await fs.writeFile(outputPath, output.outputText, 'utf8');
  return import(pathToFileURL(outputPath).href);
}

async function importPerfLog() {
  return importTsModule(['src', 'lib', 'perf-log.ts'], 'perf-log.mjs');
}

async function importDoctorPerfSmoke() {
  return importTsModule(['src', 'lib', 'doctor-perf-smoke.ts'], 'doctor-perf-smoke.mjs');
}

test('doctor report combines frontend perf data and backend diagnostics', async () => {
  const perfLog = await importPerfLog();
  perfLog._resetPerfLogForTests();
  perfLog.recordPerfMark('doctor-test', { source: 'unit' });

  const report = JSON.parse(perfLog.exportDoctorReportAsJson({
    backend: {
      appVersion: '0.0.0-test',
      commands: [{ name: 'node', installed: true }],
    },
  }));

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'ccem-doctor-report');
  assert.equal(report.backend.appVersion, '0.0.0-test');
  assert.equal(report.frontend.summary.mark.count, 1);
  assert.ok(report.frontend.events.some((event) => event.name === 'doctor-test'));
});

test('doctor report preserves backend collection errors', async () => {
  const perfLog = await importPerfLog();
  perfLog._resetPerfLogForTests();

  const report = JSON.parse(perfLog.exportDoctorReportAsJson({
    backendError: 'collect_doctor_report failed',
  }));

  assert.equal(report.kind, 'ccem-doctor-report');
  assert.equal(report.backendError, 'collect_doctor_report failed');
  assert.equal(Object.hasOwn(report, 'backend'), false);
});

test('perf logger does not crash when Tauri invoke is read-only', async () => {
  const perfLog = await importPerfLog();
  perfLog._resetPerfLogForTests();
  const internals = {};
  Object.defineProperty(internals, 'invoke', {
    value: async () => undefined,
    configurable: false,
    writable: false,
  });

  const fakeWindow = {
    __TAURI_INTERNALS__: internals,
    addEventListener: () => undefined,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    setTimeout: () => 1,
  };

  assert.doesNotThrow(() => {
    perfLog.initPerfLog(fakeWindow, { patchTauri: true });
  });

  const events = perfLog.getPerfEvents();
  assert.ok(events.some((event) => event.name === 'perf-log:ipc-patch-skipped'));
  assert.ok(events.some((event) => event.name === 'perf-log:installed'));
});

test('continuous frame drops do not evict marks from the doctor report', async (t) => {
  const perfLog = await importPerfLog();
  perfLog._resetPerfLogForTests();
  let clock = 1_000;
  const originalPerformance = globalThis.performance;
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock },
    configurable: true,
  });
  t.after(() => {
    perfLog._resetPerfLogForTests();
    Object.defineProperty(globalThis, 'performance', { value: originalPerformance, configurable: true });
  });
  let frame = null;
  const fakeWindow = {
    addEventListener: () => undefined,
    requestAnimationFrame: (callback) => { frame = callback; return 1; },
    cancelAnimationFrame: () => undefined,
    setTimeout: () => 1,
  };
  perfLog.initPerfLog(fakeWindow, { patchTauri: false });
  perfLog.recordPerfMark('early-mark');

  // One janky minute: a 120ms frame every time, far beyond the event buffer.
  for (let i = 0; i < 1_000; i += 1) {
    clock += 120;
    frame();
  }
  perfLog.recordPerfMark('late-mark');

  const report = JSON.parse(perfLog.exportDoctorReportAsJson());
  const names = report.frontend.events.map((event) => event.name);
  assert.ok(names.includes('early-mark'), 'marks before the jank must survive');
  assert.ok(names.includes('late-mark'));
  const exportedFrames = report.frontend.events.filter((event) => event.type === 'frame-drop');
  assert.equal(exportedFrames.length, 60);
  assert.equal(report.frontend.summary['frame-drop'].count, 600);
  assert.equal(report.frontend.summary['frame-drop'].p95Ms, 120);
  const times = report.frontend.events.map((event) => event.t);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'events stay chronological');
  assert.equal(typeof report.frontend.longTaskSupported, 'boolean');
});

test('doctor perf smoke skips the long-task budget where WebKit cannot observe it', async () => {
  const perfSmoke = await importDoctorPerfSmoke();
  const invoke = async (command) => {
    if (command === 'get_workspace_overview_snapshot') return { sessions: [], projectNodes: [] };
    if (command === 'get_workspace_session_decorations') return [];
    if (command === 'search_conversation_history') return [];
    throw new Error(`unexpected command ${command}`);
  };
  const report = await perfSmoke.runDoctorPerfSmoke({
    invoke,
    perfSummary: { longtask: undefined, 'frame-drop': { count: 487, p95Ms: 212, maxMs: 684 } },
    longTaskSupported: false,
  });
  const run = report.runs.find((candidate) => candidate.name === 'frontendLongTask');

  assert.equal(run.status, 'skip');
  assert.deepEqual(run.observed, {
    reason: 'longtask-unsupported',
    frameDropCount: 487,
    frameDropP95Ms: 212,
    frameDropMaxMs: 684,
  });
});

test('doctor perf smoke runs live budget checks and is embedded in exports', async () => {
  const perfLog = await importPerfLog();
  const perfSmoke = await importDoctorPerfSmoke();
  perfLog._resetPerfLogForTests();

  const session = {
    id: 'session-1',
    source: 'claude',
    timestamp: Date.now(),
    project: '/tmp/ccem',
    projectName: 'ccem',
    envName: 'dev',
  };
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'get_workspace_overview_snapshot') {
      return {
        sessions: [session],
        projectNodes: [{
          project: session.project,
          projectName: session.projectName,
          sessionKeys: ['claude:session-1'],
          latestTimestamp: session.timestamp,
        }],
        totalSessions: 1,
        totalProjects: 1,
      };
    }
    if (command === 'get_workspace_session_decorations') {
      return [{
        sessionKey: 'claude:session-1',
        visualState: 'identity',
      }];
    }
    if (command === 'search_conversation_history') {
      return [session];
    }
    if (command === 'get_conversation_detail') {
      return {
        messages: [],
        segments: [],
        toolResultsMerged: true,
      };
    }
    throw new Error(`unexpected command ${command}`);
  };

  const smokeReport = await perfSmoke.runDoctorPerfSmoke({
    invoke,
    perfSummary: { longtask: { count: 0 } },
  });
  const exported = JSON.parse(perfLog.exportDoctorReportAsJson({
    backend: { appVersion: '0.0.0-test' },
    perfSmoke: smokeReport,
  }));

  assert.equal(smokeReport.kind, 'ccem-doctor-perf-smoke');
  assert.equal(smokeReport.verdict, 'pass');
  assert.deepEqual(
    smokeReport.runs.map((run) => run.name),
    [
      'workspaceOverview',
      'runtimeDecorations',
      'historySearch',
      'conversationDetail',
      'frontendLongTask',
    ],
  );
  assert.ok(smokeReport.runs.every((run) => run.status === 'pass'));
  assert.equal(smokeReport.runs[0].observed.lightweightProjectNodes, true);
  assert.equal(exported.perfSmoke.kind, 'ccem-doctor-perf-smoke');
  assert.equal(exported.perfSmoke.verdict, 'pass');
  assert.ok(calls.some(([command]) => command === 'get_workspace_overview_snapshot'));
});

test('doctor perf smoke summary reports failed budget runs', async () => {
  const perfSmoke = await importDoctorPerfSmoke();
  const summary = perfSmoke.summarizeDoctorPerfSmoke({
    kind: 'ccem-doctor-perf-smoke',
    verdict: 'fail',
    runs: [{
      name: 'historySearch',
      status: 'fail',
      durationMs: 900,
      budgetMs: 400,
    }],
  });

  assert.equal(summary.ok, false);
  assert.equal(summary.verdict, 'fail');
  assert.equal(summary.failedRuns.length, 1);
});

test('perf smoke script prints shared budgets', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(desktopDir, 'scripts', 'perf-smoke.mjs'),
    '--print-budgets',
  ], { cwd: desktopDir });
  const parsed = JSON.parse(stdout);

  assert.equal(parsed.kind, 'ccem-doctor-perf-smoke-budgets');
  assert.ok(parsed.budgets.some((budget) => (
    budget.name === 'workspaceOverview' && budget.budgetMs === 500
  )));
});
