export type DoctorPerfSmokeVerdict = 'pass' | 'fail';
export type DoctorPerfSmokeRunStatus = 'pass' | 'fail' | 'skip';

export interface DoctorPerfSmokeBudget {
  name: DoctorPerfSmokeRunName;
  budgetMs: number;
}

export interface DoctorPerfSmokeRun {
  name: DoctorPerfSmokeRunName;
  label: string;
  status: DoctorPerfSmokeRunStatus;
  durationMs?: number;
  budgetMs?: number;
  observed?: Record<string, unknown>;
  error?: string;
}

export interface DoctorPerfSmokeReport {
  schemaVersion: 1;
  kind: 'ccem-doctor-perf-smoke';
  generatedAt: string;
  verdict: DoctorPerfSmokeVerdict;
  totalDurationMs: number;
  budgets: DoctorPerfSmokeBudget[];
  input: {
    historyLimit: number;
    searchLimit: number;
    searchQuery: string;
  };
  runs: DoctorPerfSmokeRun[];
}

export interface DoctorPerfSmokeSummary {
  ok: boolean;
  verdict: DoctorPerfSmokeVerdict | 'missing';
  failedRuns: DoctorPerfSmokeRun[];
  skippedRuns: DoctorPerfSmokeRun[];
}

type DoctorPerfSmokeRunName =
  | 'workspaceOverview'
  | 'runtimeDecorations'
  | 'historySearch'
  | 'conversationDetail'
  | 'frontendLongTask';

type InvokeLike = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface PerfSummaryEntryLike {
  count?: number;
  avgMs?: number;
  p95Ms?: number;
  maxMs?: number;
}

interface PerfSummaryLike {
  longtask?: PerfSummaryEntryLike;
  'frame-drop'?: PerfSummaryEntryLike;
}

interface HistorySessionLike {
  id?: unknown;
  source?: unknown;
  timestamp?: unknown;
  project?: unknown;
  projectName?: unknown;
  envName?: unknown;
}

interface WorkspaceOverviewSnapshotLike {
  sessions?: HistorySessionLike[];
  projectNodes?: Array<{
    sessionKeys?: unknown;
    sessions?: unknown;
  }>;
  totalSessions?: unknown;
  totalProjects?: unknown;
}

interface ConversationDetailLike {
  messages?: unknown[];
  segments?: unknown[];
  toolResultsMerged?: unknown;
}

export const DOCTOR_PERF_SMOKE_HISTORY_LIMIT = 240;
export const DOCTOR_PERF_SMOKE_SEARCH_LIMIT = 120;
export const DOCTOR_PERF_SMOKE_SEARCH_QUERY = 'workspace';

export const DOCTOR_PERF_SMOKE_BUDGETS: DoctorPerfSmokeBudget[] = [
  { name: 'workspaceOverview', budgetMs: 500 },
  { name: 'runtimeDecorations', budgetMs: 50 },
  { name: 'historySearch', budgetMs: 400 },
  { name: 'conversationDetail', budgetMs: 800 },
  { name: 'frontendLongTask', budgetMs: 50 },
];

const RUN_LABELS: Record<DoctorPerfSmokeRunName, string> = {
  workspaceOverview: 'Workspace overview',
  runtimeDecorations: 'Runtime decorations',
  historySearch: 'History search',
  conversationDetail: 'Conversation detail',
  frontendLongTask: 'Frontend long task',
};

const budgetByName = Object.fromEntries(
  DOCTOR_PERF_SMOKE_BUDGETS.map((budget) => [budget.name, budget.budgetMs])
) as Record<DoctorPerfSmokeRunName, number>;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function statusForDuration(durationMs: number, budgetMs: number): DoctorPerfSmokeRunStatus {
  return durationMs <= budgetMs ? 'pass' : 'fail';
}

function normalizeSessionForDecorations(session: HistorySessionLike) {
  return {
    id: String(session.id ?? ''),
    source: String(session.source ?? 'claude'),
    timestamp: Number(session.timestamp ?? 0),
    project: String(session.project ?? ''),
    projectName: String(session.projectName ?? ''),
    envName: typeof session.envName === 'string' ? session.envName : null,
  };
}

async function timedRun<T>(
  name: DoctorPerfSmokeRunName,
  action: () => Promise<T>,
  observed: (value: T) => Record<string, unknown> = () => ({}),
): Promise<{ run: DoctorPerfSmokeRun; value?: T }> {
  const budgetMs = budgetByName[name];
  const startedAt = nowMs();
  try {
    const value = await action();
    const durationMs = roundMs(nowMs() - startedAt);
    return {
      value,
      run: {
        name,
        label: RUN_LABELS[name],
        status: statusForDuration(durationMs, budgetMs),
        durationMs,
        budgetMs,
        observed: observed(value),
      },
    };
  } catch (error) {
    const durationMs = roundMs(nowMs() - startedAt);
    return {
      run: {
        name,
        label: RUN_LABELS[name],
        status: 'fail',
        durationMs,
        budgetMs,
        error: String(error),
      },
    };
  }
}

function skippedRun(
  name: DoctorPerfSmokeRunName,
  reason: string,
): DoctorPerfSmokeRun {
  return {
    name,
    label: RUN_LABELS[name],
    status: 'skip',
    budgetMs: budgetByName[name],
    observed: { reason },
  };
}

function frontendLongTaskRun(
  summary?: PerfSummaryLike,
  longTaskSupported = true,
): DoctorPerfSmokeRun {
  const budgetMs = budgetByName.frontendLongTask;
  if (!longTaskSupported) {
    // WebKit has no longtask entries: "0" would read as a pass. Show the
    // rAF gaps instead, which still expose a busy main thread.
    const frames = summary?.['frame-drop'];
    return {
      name: 'frontendLongTask',
      label: RUN_LABELS.frontendLongTask,
      status: 'skip',
      budgetMs,
      observed: {
        reason: 'longtask-unsupported',
        frameDropCount: frames?.count ?? 0,
        frameDropP95Ms: frames?.p95Ms,
        frameDropMaxMs: frames?.maxMs,
      },
    };
  }
  const longtask = summary?.longtask;
  const maxMs = longtask?.maxMs;
  const durationMs = typeof maxMs === 'number' && Number.isFinite(maxMs)
    ? roundMs(maxMs)
    : 0;

  return {
    name: 'frontendLongTask',
    label: RUN_LABELS.frontendLongTask,
    status: statusForDuration(durationMs, budgetMs),
    durationMs,
    budgetMs,
    observed: {
      count: longtask?.count ?? 0,
      avgMs: longtask?.avgMs,
      p95Ms: longtask?.p95Ms,
      maxMs: longtask?.maxMs,
    },
  };
}

function buildReport(runs: DoctorPerfSmokeRun[], totalDurationMs: number): DoctorPerfSmokeReport {
  const verdict: DoctorPerfSmokeVerdict = runs.some((run) => run.status === 'fail')
    ? 'fail'
    : 'pass';

  return {
    schemaVersion: 1,
    kind: 'ccem-doctor-perf-smoke',
    generatedAt: new Date().toISOString(),
    verdict,
    totalDurationMs: roundMs(totalDurationMs),
    budgets: DOCTOR_PERF_SMOKE_BUDGETS,
    input: {
      historyLimit: DOCTOR_PERF_SMOKE_HISTORY_LIMIT,
      searchLimit: DOCTOR_PERF_SMOKE_SEARCH_LIMIT,
      searchQuery: DOCTOR_PERF_SMOKE_SEARCH_QUERY,
    },
    runs,
  };
}

export async function runDoctorPerfSmoke(options: {
  invoke: InvokeLike;
  perfSummary?: PerfSummaryLike;
  /** From perf-log; false on WebKit, where long tasks are not observable. */
  longTaskSupported?: boolean;
}): Promise<DoctorPerfSmokeReport> {
  const startedAt = nowMs();
  const runs: DoctorPerfSmokeRun[] = [];

  const overviewResult = await timedRun<WorkspaceOverviewSnapshotLike>(
    'workspaceOverview',
    () => options.invoke('get_workspace_overview_snapshot', {
      limit: DOCTOR_PERF_SMOKE_HISTORY_LIMIT,
    }),
    (snapshot) => {
      const projectNodes = Array.isArray(snapshot.projectNodes) ? snapshot.projectNodes : [];
      return {
        sessions: Array.isArray(snapshot.sessions) ? snapshot.sessions.length : 0,
        projectNodes: projectNodes.length,
        totalSessions: snapshot.totalSessions,
        totalProjects: snapshot.totalProjects,
        lightweightProjectNodes: projectNodes.every((node) => (
          Array.isArray(node.sessionKeys) && node.sessions === undefined
        )),
      };
    },
  );
  runs.push(overviewResult.run);

  const sessions = Array.isArray(overviewResult.value?.sessions)
    ? overviewResult.value.sessions
    : [];
  const decorationSessions = sessions.map(normalizeSessionForDecorations);

  if (decorationSessions.length > 0) {
    const decorationsResult = await timedRun<unknown[]>(
      'runtimeDecorations',
      () => options.invoke('get_workspace_session_decorations', {
        sessions: decorationSessions,
      }),
      (decorations) => ({
        sessions: decorationSessions.length,
        decorations: Array.isArray(decorations) ? decorations.length : 0,
      }),
    );
    runs.push(decorationsResult.run);
  } else {
    runs.push(skippedRun('runtimeDecorations', 'No recent sessions available'));
  }

  const searchResult = await timedRun<unknown[]>(
    'historySearch',
    () => options.invoke('search_conversation_history', {
      query: DOCTOR_PERF_SMOKE_SEARCH_QUERY,
      source: null,
      limit: DOCTOR_PERF_SMOKE_SEARCH_LIMIT,
    }),
    (results) => ({
      query: DOCTOR_PERF_SMOKE_SEARCH_QUERY,
      results: Array.isArray(results) ? results.length : 0,
    }),
  );
  runs.push(searchResult.run);

  const detailSession = sessions.find((session) => (
    typeof session.id === 'string' && typeof session.source === 'string'
  ));

  if (detailSession) {
    const detailResult = await timedRun<ConversationDetailLike>(
      'conversationDetail',
      () => options.invoke('get_conversation_detail', {
        sessionId: detailSession.id,
        source: detailSession.source,
      }),
      (detail) => ({
        sessionId: detailSession.id,
        source: detailSession.source,
        messages: Array.isArray(detail.messages) ? detail.messages.length : 0,
        segments: Array.isArray(detail.segments) ? detail.segments.length : 0,
        toolResultsMerged: detail.toolResultsMerged === true,
      }),
    );
    runs.push(detailResult.run);
  } else {
    runs.push(skippedRun('conversationDetail', 'No recent session detail target available'));
  }

  runs.push(frontendLongTaskRun(options.perfSummary, options.longTaskSupported));

  return buildReport(runs, nowMs() - startedAt);
}

export function summarizeDoctorPerfSmoke(value: unknown): DoctorPerfSmokeSummary {
  const report = value as Partial<DoctorPerfSmokeReport> | null | undefined;
  if (!report || report.kind !== 'ccem-doctor-perf-smoke' || !Array.isArray(report.runs)) {
    return {
      ok: false,
      verdict: 'missing',
      failedRuns: [],
      skippedRuns: [],
    };
  }

  const failedRuns = report.runs.filter((run) => run.status === 'fail');
  const skippedRuns = report.runs.filter((run) => run.status === 'skip');
  return {
    ok: report.verdict === 'pass' && failedRuns.length === 0,
    verdict: report.verdict === 'fail' ? 'fail' : 'pass',
    failedRuns,
    skippedRuns,
  };
}
