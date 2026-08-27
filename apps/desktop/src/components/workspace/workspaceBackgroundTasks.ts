import type {
  NativeBackgroundTask,
  NativeBackgroundTaskStatus,
  NativeSessionSummary,
  SessionEventRecord,
} from '@/lib/tauri-ipc';

const TERMINAL_STATUSES = new Set<NativeBackgroundTaskStatus>([
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);

export const MAX_RECENT_BACKGROUND_TASKS = 20;

export interface WorkspaceBackgroundTaskModel {
  active: NativeBackgroundTask[];
  recent: NativeBackgroundTask[];
}

export function isTerminalBackgroundTaskStatus(status: NativeBackgroundTaskStatus) {
  return TERMINAL_STATUSES.has(status);
}

export function canStopBackgroundTask(task: NativeBackgroundTask) {
  return task.status === 'pending' || task.status === 'running' || task.status === 'paused';
}

export function backgroundTaskDurationMs(task: NativeBackgroundTask, nowMs: number) {
  if (task.usage) {
    return task.usage.duration_ms;
  }
  const startedAt = new Date(task.started_at).getTime();
  const endedAt = isTerminalBackgroundTaskStatus(task.status)
    ? new Date(task.updated_at).getTime()
    : nowMs;
  return Math.max(0, endedAt - startedAt);
}

function sortActive(tasks: NativeBackgroundTask[]) {
  return tasks.sort((left, right) => left.started_at.localeCompare(right.started_at));
}

function sortRecent(tasks: NativeBackgroundTask[]) {
  return tasks
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, MAX_RECENT_BACKGROUND_TASKS);
}

function enrichTerminalTask(
  current: NativeBackgroundTask,
  incoming: NativeBackgroundTask,
) {
  const next = { ...current };
  const fillIfMissing = <K extends keyof NativeBackgroundTask>(key: K) => {
    if (next[key] == null && incoming[key] != null) {
      next[key] = incoming[key] as NativeBackgroundTask[K];
    }
  };
  fillIfMissing('tool_use_id');
  fillIfMissing('task_type');
  fillIfMissing('subagent_type');
  fillIfMissing('workflow_name');
  fillIfMissing('progress_summary');
  fillIfMissing('last_tool_name');
  fillIfMissing('usage');
  fillIfMissing('output_file');
  fillIfMissing('skip_transcript');
  if ((!next.description || next.description === next.task_id) && incoming.description) {
    next.description = incoming.description;
  }
  return next;
}

export function deriveWorkspaceBackgroundTasks(
  session: Pick<NativeSessionSummary, 'background_tasks' | 'last_event_seq'>,
  events: SessionEventRecord[],
): WorkspaceBackgroundTaskModel {
  const hasLiveSummary = Array.isArray(session.background_tasks);
  const hasAuthoritativeNoLiveSummary = hasLiveSummary && session.last_event_seq == null;
  const summarySeq = hasLiveSummary ? (session.last_event_seq ?? 0) : 0;
  const active = new Map<string, NativeBackgroundTask>();
  const recent = new Map<string, NativeBackgroundTask>();
  const terminalIds = new Set<string>();

  for (const task of session.background_tasks ?? []) {
    if (!isTerminalBackgroundTaskStatus(task.status)) {
      active.set(task.task_id, task);
    }
  }

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const payload = event.payload;
    if (payload.type === 'background_task_updated'
      && isTerminalBackgroundTaskStatus(payload.task.status)) {
      if (terminalIds.has(payload.task.task_id)) {
        const current = recent.get(payload.task.task_id);
        if (current) {
          recent.set(payload.task.task_id, enrichTerminalTask(current, payload.task));
        }
        continue;
      }
      terminalIds.add(payload.task.task_id);
      active.delete(payload.task.task_id);
      recent.set(payload.task.task_id, payload.task);
      continue;
    }

    if (hasAuthoritativeNoLiveSummary) {
      continue;
    }

    if (event.seq <= summarySeq) {
      continue;
    }

    if (payload.type === 'background_tasks_changed') {
      active.clear();
      for (const task of payload.tasks) {
        if (!isTerminalBackgroundTaskStatus(task.status) && !terminalIds.has(task.task_id)) {
          active.set(task.task_id, task);
        }
      }
      continue;
    }

    if (payload.type === 'background_task_updated'
      && !terminalIds.has(payload.task.task_id)) {
      active.set(payload.task.task_id, payload.task);
    }
  }

  for (const taskId of terminalIds) {
    active.delete(taskId);
  }

  return {
    active: sortActive([...active.values()]),
    recent: sortRecent([...recent.values()]),
  };
}
